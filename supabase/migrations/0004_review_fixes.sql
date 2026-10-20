-- Fixes from the 2026-10-20 external review (issues 1-6).

-- 1. CRITICAL: clients could UPDATE their own participants row, including
--    conversation_id, and thereby join any conversation whose id they knew.
--    Heartbeat already goes through the heartbeat() RPC, so clients need no
--    direct write access at all.
drop policy if exists participants_heartbeat on public.participants;
revoke update, insert, delete on public.participants from authenticated, anon;

-- 2. HIGH: bool_and() ignores NULLs, so one acceptance + one undecided
--    opened the conversation. Require every participant to have accepted.
create or replace function public.respond_invitation(p_invitation uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_inv public.match_invitations%rowtype;
  v_mine public.invitation_participants%rowtype;
  v_total int;
  v_accepted int;
  v_conv uuid;
begin
  select * into v_inv from public.match_invitations where id = p_invitation for update;
  if v_inv.id is null then raise exception 'invitation not found' using errcode = 'P0001'; end if;

  select * into v_mine from public.invitation_participants where invitation_id = p_invitation and account_id = v_uid;
  if v_mine.invitation_id is null then raise exception 'not your invitation' using errcode = '42501'; end if;

  if v_inv.status = 'accepted' and v_inv.conversation_id is not null then
    return jsonb_build_object('status', 'opened', 'conversation_id', v_inv.conversation_id);
  end if;
  if v_inv.status = 'declined' then return jsonb_build_object('status', 'declined'); end if;
  if v_inv.status = 'expired' or v_inv.expires_at < now() then
    update public.match_invitations set status = 'expired', resolved_at = coalesce(resolved_at, now()) where id = p_invitation;
    perform public.requeue_after_invitation(p_invitation, null);
    return jsonb_build_object('status', 'expired');
  end if;

  if v_mine.decision is null then
    update public.invitation_participants
      set decision = case when p_accept then 'accepted' else 'declined' end, decided_at = now()
      where invitation_id = p_invitation and account_id = v_uid;
  end if;

  if not p_accept then
    update public.match_invitations set status = 'declined', resolved_at = now() where id = p_invitation;
    perform public.requeue_after_invitation(p_invitation, v_uid);
    return jsonb_build_object('status', 'declined');
  end if;

  select count(*), count(*) filter (where decision = 'accepted')
    into v_total, v_accepted
    from public.invitation_participants where invitation_id = p_invitation;
  if v_total >= 2 and v_accepted = v_total then
    v_conv := public.open_conversation_for_invitation(p_invitation);
    return jsonb_build_object('status', 'opened', 'conversation_id', v_conv);
  end if;
  return jsonb_build_object('status', 'waiting_for_other');
end $$;

-- 3. HIGH: approved custom answers were readable by the other participant
--    before the question was revealed. Answers are visible to the sender
--    always, and to the peer only once the question is revealed. Realtime
--    (postgres_changes) applies the same policy.
drop policy if exists approved_in_conversation on public.approved_messages;
create policy approved_in_conversation on public.approved_messages for select to authenticated using (
  public.is_participant(conversation_id)
  and (
    kind = 'chat'
    or sender_participant_id = public.my_participant_id(conversation_id)
    or exists (select 1 from public.conversation_questions q where q.id = question_id and q.revealed_at is not null)
  )
);

-- 4. HIGH: retention left custom answer text in question_answers (and the
--    questions themselves) after approved messages were purged.
create or replace function public.purge_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d_msg int := (public.cfg('retention_messages_days', '30'))::int;
  d_pending int := (public.cfg('retention_pending_days', '7'))::int;
  d_reports int := (public.cfg('retention_reports_days', '365'))::int;
  n1 int; n2 int; n3 int; n4 int; n5 int;
begin
  perform public.assert_service_role();
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
  update public.question_answers a set custom_text = null
    from public.conversations c
    where a.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg)
      and a.custom_text is not null;
  get diagnostics n5 = row_count;
  delete from public.pending_messages where status <> 'pending' and updated_at < now() - make_interval(days => d_pending)
    and not exists (select 1 from public.appeals a where a.pending_message_id = pending_messages.id and a.status = 'open');
  get diagnostics n2 = row_count;
  delete from public.reports where status in ('resolved', 'dismissed') and resolved_at < now() - make_interval(days => d_reports);
  get diagnostics n3 = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics n4 = row_count;
  delete from public.notifications where created_at < now() - interval '30 days';
  return jsonb_build_object('messages', n1, 'custom_answers', n5, 'pending', n2, 'reports', n3, 'rate_limits', n4);
end $$;

-- 5. HIGH: ownership checks compared against a NULL my_participant_id for
--    outsiders, which never raised. Resolve the caller's participant first and
--    reject explicitly.
create or replace function public.owned_pending(p_pending uuid) returns public.pending_messages
language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype;
  v_pid uuid;
begin
  perform public.assert_user();
  select * into v_m from public.pending_messages where id = p_pending for update;
  if v_m.id is null then raise exception 'not your message' using errcode = '42501'; end if;
  v_pid := public.my_participant_id(v_m.conversation_id);
  if v_pid is null or v_pid is distinct from v_m.sender_participant_id then
    raise exception 'not your message' using errcode = '42501';
  end if;
  return v_m;
end $$;
revoke execute on function public.owned_pending(uuid) from public, anon, authenticated;

create or replace function public.cancel_pending(p_pending uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_m public.pending_messages%rowtype := public.owned_pending(p_pending);
begin
  if v_m.status in ('pending', 'review', 'revise', 'failed', 'blocked') then
    update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then
      delete from public.question_answers where pending_message_id = p_pending and status <> 'approved';
    end if;
  end if;
end $$;

create or replace function public.accept_revision(p_pending uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_m public.pending_messages%rowtype := public.owned_pending(p_pending);
begin
  if v_m.status <> 'revise' or v_m.suggested_revision is null then
    raise exception 'no revision to accept' using errcode = 'P0001';
  end if;
  update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
  return public.submit_message(v_m.conversation_id, v_m.client_send_id || ':rev:' || v_m.attempts, v_m.suggested_revision, v_m.kind, v_m.question_id);
end $$;

create or replace function public.file_appeal(p_pending uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype := public.owned_pending(p_pending);
  v_id uuid;
begin
  if v_m.status not in ('blocked', 'revise') then raise exception 'nothing to appeal' using errcode = 'P0001'; end if;
  if not public.take_rate_limit('appeal', 5, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.appeals (pending_message_id, account_id, note) values (p_pending, auth.uid(), left(p_note, 1000)) returning id into v_id;
  return v_id;
end $$;

-- 6. MEDIUM: overlapping workers could insert two open questions. Lock the
--    conversation, recheck, and back it with a partial unique index.
-- Close any duplicates that already exist (keep the newest), then enforce.
update public.conversation_questions q set status = 'closed'
  where q.status = 'open' and exists (
    select 1 from public.conversation_questions q2
    where q2.conversation_id = q.conversation_id and q2.status = 'open' and q2.seq > q.seq
  );
create unique index if not exists one_open_question_per_conversation
  on public.conversation_questions (conversation_id) where status = 'open';

create or replace function public.insert_question(
  p_conversation uuid, p_phase public.question_phase, p_text text, p_choices text[],
  p_followup_a text, p_followup_b text, p_source text, p_sensitive boolean, p_rationale text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_seq int;
  v_status public.conversation_status;
  v_mult numeric := (public.cfg('question_gap_multiplier', '2'))::numeric;
  v_max int := (public.cfg('question_gap_max_seconds', '600'))::int;
begin
  perform public.assert_service_role();
  select status into v_status from public.conversations where id = p_conversation for update;
  if v_status is null or v_status = 'ended' then return null; end if;
  if exists (select 1 from public.conversation_questions where conversation_id = p_conversation and status = 'open') then
    return null;
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.conversation_questions where conversation_id = p_conversation;
  insert into public.conversation_questions
    (conversation_id, seq, phase, question_text, choices, followup_a, followup_b, source, sensitive_topic_flag, rationale_internal)
    values (p_conversation, v_seq, p_phase, p_text, p_choices, p_followup_a, p_followup_b, p_source, p_sensitive, p_rationale)
    returning id into v_id;
  update public.conversations set
    questions_asked = questions_asked + 1,
    active_seconds_since_question = 0,
    question_gap_seconds = case when p_phase = 'mid' then least((question_gap_seconds * v_mult)::int, v_max) else question_gap_seconds end
    where id = p_conversation;
  return v_id;
end $$;
