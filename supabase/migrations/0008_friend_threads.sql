-- Persistent friend chats, queue lifecycle repair, unique conversation metrics.
--
-- A friend thread is a conversation with kind = 'friend': same moderation
-- pipeline, RLS and realtime as live conversations, but no session gating, no
-- opening round, no presence/abandonment rules, and it never counts as the
-- person's "active conversation" for new-person matching.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.conversations add column if not exists kind text not null default 'live' check (kind in ('live', 'friend'));
alter table public.conversations add column if not exists last_message_at timestamptz;
create unique index if not exists one_friend_thread_per_connection on public.conversations (connection_id) where kind = 'friend';

-- per-person read position and mute for a thread
create table if not exists public.thread_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  last_push_at timestamptz,
  primary key (conversation_id, account_id)
);
alter table public.thread_reads enable row level security;
create policy thread_reads_self on public.thread_reads for select to authenticated using (account_id = auth.uid());

-- friend-message push: separate consent from session reminders
alter table public.reminder_prefs add column if not exists friend_push_enabled boolean not null default false;

-- queued friend-message pushes (neutral text; one row per send, idempotent)
create table if not exists public.push_queue (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  kind text not null default 'friend_message',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'sent', 'failed', 'skipped')),
  last_error text
);
create index if not exists push_queue_status_idx on public.push_queue (status, created_at);
alter table public.push_queue enable row level security;

-- ---------------------------------------------------------------------------
-- "Active conversation" means a LIVE one only
-- ---------------------------------------------------------------------------
create or replace function public.has_active_conversation(p_account uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.participants p join public.conversations c on c.id = p.conversation_id
    where p.account_id = p_account and p.left_at is null and c.status <> 'ended' and c.kind = 'live'
  )
$$;

-- join_queue uses has_active_conversation now (friend threads never block joining)
create or replace function public.join_queue(p_notify_email boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_id uuid;
  v_existing public.availability_requests%rowtype;
  v_win record;
begin
  select * into v_win from public.session_window(now());
  if v_win.session_start is null then raise exception 'The session is not open right now' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.accounts where id = v_uid and onboarding_complete) then raise exception 'onboarding incomplete' using errcode = 'P0001'; end if;
  if public.has_active_conversation(v_uid) then raise exception 'already in a conversation' using errcode = 'P0001'; end if;
  select * into v_existing from public.availability_requests where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_existing.id is not null then
    -- an 'invited' entry whose invitation is no longer pending is inconsistent: repair it
    if v_existing.status = 'invited' and not exists (select 1 from public.match_invitations i where i.id = v_existing.matched_invitation_id and i.status = 'pending' and i.expires_at > now()) then
      update public.availability_requests set status = 'waiting', matched_invitation_id = null, invited_at = null where id = v_existing.id;
      v_existing.status := 'waiting';
    end if;
    if v_existing.session_start = v_win.session_start then
      update public.availability_requests set last_seen_at = now(), paused_at = null, paused_reason = null where id = v_existing.id;
      return v_existing.id;
    end if;
    update public.availability_requests set status = 'expired', ended_at = now() where id = v_existing.id;
  end if;
  if not public.take_rate_limit('join_queue', 20, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.availability_requests (account_id, notify_email, expires_at, session_start, last_seen_at)
    values (v_uid, p_notify_email, v_win.session_end, v_win.session_start, now()) returning id into v_id;
  perform public.log_metric('queue_join', v_uid, v_win.session_start, null);
  if p_notify_email then insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'waiting_email', 'v1', true); end if;
  return v_id;
end $$;

-- leave_queue also resolves an 'invited' entry (declines the invitation so the
-- other person is requeued) and cancels inconsistent ones.
create or replace function public.leave_queue() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_r public.availability_requests%rowtype;
begin
  select * into v_r from public.availability_requests where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_r.id is null then return; end if;
  if v_r.status = 'invited' and v_r.matched_invitation_id is not null then
    update public.match_invitations set status = 'declined', resolved_at = now() where id = v_r.matched_invitation_id and status = 'pending';
    perform public.requeue_after_invitation(v_r.matched_invitation_id, v_uid);
  end if;
  update public.availability_requests set status = 'cancelled', ended_at = now(), matched_invitation_id = null where id = v_r.id and status <> 'cancelled';
  perform public.log_metric('unmatched_leave', v_uid, v_r.session_start, extract(epoch from (now() - v_r.created_at)));
end $$;

-- open_conversation_for_invitation: competing invitations are declined WITH
-- their partners requeued; metrics: one 'conversation_started' per conversation.
create or replace function public.open_conversation_for_invitation(p_invitation uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.match_invitations%rowtype;
  v_conv uuid;
  v_count int := (public.cfg('opening_question_count', '10'))::int;
  v_gap int := (public.cfg('question_gap_initial_seconds', '90'))::int;
  v_p record;
  v_pid uuid;
  v_alias text;
  v_conn public.connections%rowtype;
  v_accounts uuid[];
  v_a uuid;
  v_other record;
  v_session timestamptz;
begin
  select * into v_inv from public.match_invitations where id = p_invitation for update;
  if v_inv.conversation_id is not null then return v_inv.conversation_id; end if;
  select array_agg(account_id order by account_id) into v_accounts from public.invitation_participants where invitation_id = p_invitation;
  foreach v_a in array v_accounts loop perform pg_advisory_xact_lock(hashtext('cg_account_' || v_a::text)); end loop;
  foreach v_a in array v_accounts loop
    if public.has_active_conversation(v_a) then
      update public.match_invitations set status = 'declined', resolved_at = now() where id = p_invitation;
      perform public.requeue_after_invitation(p_invitation, null);
      raise exception 'already in a conversation' using errcode = 'P0001';
    end if;
  end loop;

  insert into public.conversations (invitation_id, connection_id, opening_question_count, question_gap_seconds, kind)
    values (p_invitation, v_inv.connection_id, v_count, v_gap, 'live') returning id into v_conv;
  if v_inv.connection_id is not null then select * into v_conn from public.connections where id = v_inv.connection_id; end if;
  for v_p in select account_id from public.invitation_participants where invitation_id = p_invitation loop
    insert into public.participants (conversation_id, account_id) values (v_conv, v_p.account_id) returning id into v_pid;
    if v_conn.id is not null then v_alias := case when v_p.account_id = v_conn.account_a then v_conn.alias_a else v_conn.alias_b end;
    else v_alias := public.random_alias(); end if;
    insert into public.participant_aliases (participant_id, conversation_id, alias) values (v_pid, v_conv, v_alias);
    insert into public.notifications (account_id, kind, payload) values (v_p.account_id, 'conversation_opened', jsonb_build_object('conversation_id', v_conv));
  end loop;
  update public.match_invitations set status = 'accepted', conversation_id = v_conv, resolved_at = now() where id = p_invitation;
  select session_start into v_session from public.availability_requests where matched_invitation_id = p_invitation limit 1;
  update public.availability_requests set status = 'matched', ended_at = now() where matched_invitation_id = p_invitation;
  perform public.log_metric('conversation_started', null, v_session, extract(epoch from (now() - v_inv.created_at)), jsonb_build_object('conversation_id', v_conv));

  -- other pending invitations involving these people: decline them and requeue THEIR partners
  for v_other in
    select distinct i.id, ip.account_id as busy
    from public.match_invitations i join public.invitation_participants ip on ip.invitation_id = i.id
    where i.status = 'pending' and i.id <> p_invitation and ip.account_id = any (v_accounts)
  loop
    update public.match_invitations set status = 'declined', resolved_at = now() where id = v_other.id and status = 'pending';
    perform public.requeue_after_invitation(v_other.id, v_other.busy);
  end loop;
  -- the two people are matched: any leftover queue rows of theirs are closed
  update public.availability_requests set status = 'matched', ended_at = now(), matched_invitation_id = null
    where account_id = any (v_accounts) and status in ('waiting', 'invited');
  return v_conv;
end $$;

-- ---------------------------------------------------------------------------
-- Friend threads
-- ---------------------------------------------------------------------------

-- Open (or get) the one thread for a friendship. Idempotent under concurrency:
-- the connection row is locked and the partial unique index is the backstop.
create or replace function public.open_friend_thread(p_connection uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_c public.connections%rowtype;
  v_conv uuid;
  v_pid uuid;
  v_peer uuid;
begin
  if not (public.cfg('friendship_enabled', 'true'))::boolean then raise exception 'friend chats are not enabled' using errcode = 'P0001'; end if;
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid) for update;
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  select id into v_conv from public.conversations where connection_id = p_connection and kind = 'friend';
  if v_conv is not null then return v_conv; end if;
  if v_c.status <> 'active' then raise exception 'this friendship has ended' using errcode = 'P0001'; end if;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  if public.is_blocked_either_way(v_uid, v_peer) then raise exception 'connection not found' using errcode = '42501'; end if;

  insert into public.conversations (connection_id, kind, status, chat_started_at, last_activity_at, opening_question_count, questions_asked)
    values (p_connection, 'friend', 'chatting', now(), now(), 0, 0) returning id into v_conv;
  insert into public.participants (conversation_id, account_id) values (v_conv, v_c.account_a) returning id into v_pid;
  insert into public.participant_aliases (participant_id, conversation_id, alias) values (v_pid, v_conv, v_c.alias_a);
  insert into public.participants (conversation_id, account_id) values (v_conv, v_c.account_b) returning id into v_pid;
  insert into public.participant_aliases (participant_id, conversation_id, alias) values (v_pid, v_conv, v_c.alias_b);
  insert into public.thread_reads (conversation_id, account_id) values (v_conv, v_c.account_a), (v_conv, v_c.account_b) on conflict do nothing;
  return v_conv;
end $$;

create or replace function public.mark_thread_read(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  insert into public.thread_reads (conversation_id, account_id, last_read_at) values (p_conversation, v_uid, now())
    on conflict (conversation_id, account_id) do update set last_read_at = now();
end $$;

create or replace function public.set_thread_muted(p_conversation uuid, p_muted boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  insert into public.thread_reads (conversation_id, account_id, muted) values (p_conversation, v_uid, p_muted)
    on conflict (conversation_id, account_id) do update set muted = excluded.muted;
end $$;

-- Ends a friendship: no new messages either way; history stays readable.
create or replace function public.remove_friend(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_conv uuid;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid) for update;
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  update public.connections set status = 'ended', ended_at = now() where id = p_connection and status = 'active';
  select id into v_conv from public.conversations where connection_id = p_connection and kind = 'friend';
  if v_conv is not null then
    update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = v_conv and status in ('pending', 'review', 'revise');
    update public.conversations set status = 'ended', ended_at = now(), end_reason = 'unfriended' where id = v_conv and status <> 'ended';
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'friendship_ended', jsonb_build_object('conversation_id', v_conv) from public.participants p where p.conversation_id = v_conv and p.account_id <> v_uid;
  end if;
end $$;

-- Unread counts: approved chat messages from the other person after my read mark.
create or replace function public.friend_threads_overview()
returns table (connection_id uuid, conversation_id uuid, peer_alias text, my_alias text, since timestamptz, status text, unread int, last_message_at timestamptz, muted boolean)
language sql stable security definer set search_path = public as $$
  select c.id,
         cv.id,
         case when c.account_a = auth.uid() then c.alias_b else c.alias_a end,
         case when c.account_a = auth.uid() then c.alias_a else c.alias_b end,
         c.created_at, c.status,
         coalesce((
           select count(*)::int from public.approved_messages m
           join public.participants p on p.id = m.sender_participant_id
           where m.conversation_id = cv.id and m.kind = 'chat' and p.account_id <> auth.uid()
             and m.created_at > coalesce((select tr.last_read_at from public.thread_reads tr where tr.conversation_id = cv.id and tr.account_id = auth.uid()), 'epoch'::timestamptz)
         ), 0),
         cv.last_message_at,
         coalesce((select tr.muted from public.thread_reads tr where tr.conversation_id = cv.id and tr.account_id = auth.uid()), false)
  from public.connections c
  left join public.conversations cv on cv.connection_id = c.id and cv.kind = 'friend'
  where c.account_a = auth.uid() or c.account_b = auth.uid()
  order by coalesce(cv.last_message_at, c.created_at) desc
$$;

create or replace function public.friend_unread_total() returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(unread), 0)::int from public.friend_threads_overview()
$$;

-- block_peer: also ends the friend thread (and connection) so nothing more is delivered
create or replace function public.block_peer(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_peer uuid; v_kind text; v_t uuid;
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  if v_peer is null then return; end if;
  insert into public.blocks (blocker_account_id, blocked_account_id, conversation_id) values (v_uid, v_peer, p_conversation) on conflict do nothing;
  update public.connections set status = 'ended', ended_at = now()
    where status = 'active' and ((account_a = v_uid and account_b = v_peer) or (account_a = v_peer and account_b = v_uid));
  -- every thread between the two: cancel anything awaiting moderation and end it
  for v_t in select c.id from public.conversations c where c.status <> 'ended' and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_uid)
    and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_peer) loop
    update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = v_t and status in ('pending', 'review', 'revise');
    select kind into v_kind from public.conversations where id = v_t;
    update public.participants set left_at = now() where conversation_id = v_t and account_id = v_uid and left_at is null;
    perform public.end_conversation(v_t, 'blocked');
  end loop;
end $$;

-- submit_message: friend threads need an active, unblocked friendship; no session gating.
create or replace function public.submit_message(
  p_conversation uuid, p_client_send_id text, p_body text,
  p_kind public.message_kind default 'chat', p_question uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_pid uuid;
  v_id uuid;
  v_c public.conversations%rowtype;
  v_peer uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_c.status = 'ended' then raise exception 'conversation ended' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  if exists (select 1 from public.participants where id = v_pid and left_at is not null) then raise exception 'you left this conversation' using errcode = 'P0001'; end if;
  if v_c.kind = 'friend' then
    if not exists (select 1 from public.connections where id = v_c.connection_id and status = 'active') then raise exception 'this friendship has ended' using errcode = 'P0001'; end if;
    select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
    if public.is_blocked_either_way(v_uid, v_peer) then raise exception 'this friendship has ended' using errcode = 'P0001'; end if;
  elsif p_kind = 'chat' and v_c.status <> 'chatting' then
    raise exception 'chat opens after the opening questions' using errcode = 'P0001';
  end if;
  if p_kind = 'answer' then
    if p_question is null or not exists (select 1 from public.conversation_questions where id = p_question and conversation_id = p_conversation and status = 'open') then
      raise exception 'question not open' using errcode = 'P0001';
    end if;
  end if;
  select id into v_id from public.pending_messages where conversation_id = p_conversation and client_send_id = p_client_send_id;
  if v_id is not null then return v_id; end if;
  if not public.take_rate_limit('send', 30, 60) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.pending_messages (conversation_id, sender_participant_id, client_send_id, kind, question_id, body)
    values (p_conversation, v_pid, p_client_send_id, p_kind, p_question, p_body) returning id into v_id;
  if p_kind = 'answer' then
    insert into public.question_answers (question_id, participant_id, conversation_id, status, pending_message_id)
      values (p_question, v_pid, p_conversation, 'pending', v_id)
      on conflict (question_id, participant_id) do update
        set choice_index = null, custom_text = null, status = 'pending', pending_message_id = v_id, updated_at = now()
        where public.question_answers.status <> 'approved';
  end if;
  return v_id;
end $$;

-- apply_moderation_decision: friend threads — block/ended friendship cancels
-- delivery even after approval; approved friend chat queues a neutral push
-- (if the recipient opted in, isn't muted, and wasn't pushed in the last 10 min).
create or replace function public.apply_moderation_decision(
  p_pending uuid, p_decision text, p_categories text[], p_user_explanation text,
  p_suggested_revision text, p_confidence numeric, p_detector_hits text[],
  p_provider text, p_model text, p_raw_valid boolean, p_latency_ms int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype;
  v_conv public.conversations%rowtype;
  v_quiet_cap int := (public.cfg('quiet_cap_seconds', '60'))::int;
  v_delta int;
  v_due boolean := false;
  v_revealed boolean := false;
  v_sender uuid; v_recipient uuid; v_pushed timestamptz;
begin
  perform public.assert_service_role();
  select * into v_m from public.pending_messages where id = p_pending for update;
  if v_m.id is null then raise exception 'pending not found'; end if;
  if v_m.status not in ('pending', 'review') then return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true); end if;

  insert into public.moderation_decisions (pending_message_id, decision, categories, user_explanation, suggested_revision, confidence, detector_hits, provider, model, raw_valid, latency_ms)
    values (p_pending, p_decision, coalesce(p_categories, '{}'), p_user_explanation, p_suggested_revision, p_confidence, coalesce(p_detector_hits, '{}'), p_provider, p_model, p_raw_valid, p_latency_ms);

  if p_decision = 'allow' then
    select * into v_conv from public.conversations where id = v_m.conversation_id for update;
    select p.account_id into v_sender from public.participants p where p.id = v_m.sender_participant_id;
    select p.account_id into v_recipient from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_sender limit 1;
    if v_conv.status = 'ended'
       or (v_conv.kind = 'friend' and (not exists (select 1 from public.connections where id = v_conv.connection_id and status = 'active') or public.is_blocked_either_way(v_sender, v_recipient))) then
      update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true);
    end if;

    insert into public.approved_messages (conversation_id, sender_participant_id, pending_message_id, kind, question_id, body)
      values (v_m.conversation_id, v_m.sender_participant_id, p_pending, v_m.kind, v_m.question_id, v_m.body);
    update public.pending_messages set status = 'approved', updated_at = now() where id = p_pending;
    update public.conversations set last_message_at = now() where id = v_conv.id;

    if v_m.kind = 'answer' then
      update public.question_answers set status = 'approved', custom_text = v_m.body, updated_at = now() where pending_message_id = p_pending;
      v_revealed := public.maybe_reveal_question(v_m.question_id);
    elsif v_conv.kind = 'live' and v_conv.status = 'chatting' then
      v_delta := least(coalesce(extract(epoch from (now() - v_conv.last_activity_at))::int, 0), v_quiet_cap);
      update public.conversations set active_seconds_since_question = active_seconds_since_question + v_delta, last_activity_at = now()
        where id = v_conv.id returning active_seconds_since_question >= question_gap_seconds into v_due;
      if v_due and exists (select 1 from public.conversation_questions where conversation_id = v_conv.id and status = 'open') then v_due := false; end if;
    elsif v_conv.kind = 'friend' then
      -- neutral push for the recipient (separate consent, mute, 10-minute flood guard)
      select tr.last_push_at into v_pushed from public.thread_reads tr where tr.conversation_id = v_conv.id and tr.account_id = v_recipient;
      if exists (select 1 from public.reminder_prefs rp where rp.account_id = v_recipient and rp.friend_push_enabled)
         and not coalesce((select tr.muted from public.thread_reads tr where tr.conversation_id = v_conv.id and tr.account_id = v_recipient), false)
         and (v_pushed is null or v_pushed < now() - interval '10 minutes') then
        insert into public.push_queue (account_id, conversation_id, kind) values (v_recipient, v_conv.id, 'friend_message');
        insert into public.thread_reads (conversation_id, account_id, last_push_at) values (v_conv.id, v_recipient, now())
          on conflict (conversation_id, account_id) do update set last_push_at = now();
      end if;
      insert into public.notifications (account_id, kind, payload) values (v_recipient, 'friend_message', jsonb_build_object('conversation_id', v_conv.id));
    end if;
  elsif p_decision = 'revise' then
    update public.pending_messages set status = 'revise', user_explanation = p_user_explanation, suggested_revision = p_suggested_revision, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then update public.question_answers set status = 'revise', updated_at = now() where pending_message_id = p_pending; end if;
  elsif p_decision = 'block' then
    update public.pending_messages set status = 'blocked', user_explanation = p_user_explanation, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then update public.question_answers set status = 'blocked', updated_at = now() where pending_message_id = p_pending; end if;
  elsif p_decision = 'review' then
    update public.pending_messages set status = 'review', user_explanation = coalesce(p_user_explanation, 'Held for a human review.'), updated_at = now() where id = p_pending;
  else
    raise exception 'unknown decision %', p_decision;
  end if;
  return jsonb_build_object('question_due', v_due, 'revealed', v_revealed);
end $$;

-- Worker: claim queued friend pushes
create or replace function public.claim_push_queue(p_limit int default 20)
returns setof public.push_queue language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  return query
    update public.push_queue q set status = 'claimed', claimed_at = now()
      where q.id in (select id from public.push_queue where status = 'queued' order by created_at for update skip locked limit p_limit)
      returning q.*;
end $$;

-- "Give us a question" in a friend thread (rate limited; one open at a time is enforced by the index)
create or replace function public.can_request_question(p_conversation uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_kind text; v_status public.conversation_status;
begin
  select kind, status into v_kind, v_status from public.conversations where id = p_conversation;
  if v_kind is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_status = 'ended' then return false; end if;
  if exists (select 1 from public.conversation_questions where conversation_id = p_conversation and status = 'open') then return false; end if;
  if not public.take_rate_limit('friend_question', 10, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Housekeeping scoped to live conversations; friend retention per message
-- ---------------------------------------------------------------------------
create or replace function public.expire_stale() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv record;
  v_grace int := (public.cfg('presence_grace_seconds', '45'))::int;
  v_away int := (public.cfg('partner_away_after_seconds', '120'))::int;
  v_abandon int := (public.cfg('abandon_after_seconds', '600'))::int;
  v_conv record;
  v_win record;
  n_inv int := 0; n_closed int := 0; n_stale int := 0; n_away int := 0; n_abandoned int := 0; n_q int := 0; n_fixed int := 0;
begin
  perform public.assert_service_role();
  select * into v_win from public.session_window(now());

  for v_inv in select id from public.match_invitations where status = 'pending' and expires_at < now() for update skip locked loop
    update public.match_invitations set status = 'expired', resolved_at = now() where id = v_inv.id;
    perform public.requeue_after_invitation(v_inv.id, null);
    n_inv := n_inv + 1;
  end loop;

  -- repair: 'invited' entries whose invitation is not pending go back to waiting (session open) or expire
  update public.availability_requests r set
      status = case when v_win.session_start is not null and r.session_start = v_win.session_start and r.expires_at > now() then 'waiting'::public.availability_status else 'expired'::public.availability_status end,
      matched_invitation_id = null, invited_at = null,
      ended_at = case when v_win.session_start is not null and r.session_start = v_win.session_start and r.expires_at > now() then null else now() end
    where r.status = 'invited' and not exists (select 1 from public.match_invitations i where i.id = r.matched_invitation_id and i.status = 'pending');
  get diagnostics n_fixed = row_count;

  update public.availability_requests set status = 'expired', ended_at = now()
    where status = 'waiting' and (expires_at < now() or session_start is null or session_start is distinct from v_win.session_start);
  get diagnostics n_closed = row_count;

  update public.availability_requests set paused_at = now(), paused_reason = 'stale'
    where status = 'waiting' and paused_at is null and last_seen_at < now() - make_interval(secs => v_grace);
  get diagnostics n_stale = row_count;

  for v_conv in
    select c.id, p.account_id as away_account from public.conversations c join public.participants p on p.conversation_id = c.id
    where c.kind = 'live' and c.status <> 'ended' and c.partner_away_notified_at is null and p.left_at is null and p.last_seen_at < now() - make_interval(secs => v_away)
  loop
    update public.conversations set partner_away_notified_at = now() where id = v_conv.id;
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'partner_away', jsonb_build_object('conversation_id', v_conv.id) from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_conv.away_account;
    n_away := n_away + 1;
  end loop;

  for v_conv in
    select distinct c.id from public.conversations c join public.participants p on p.conversation_id = c.id
    where c.kind = 'live' and c.status <> 'ended' and p.left_at is null and p.last_seen_at < now() - make_interval(secs => v_abandon)
  loop
    perform public.end_conversation(v_conv.id, 'abandoned');
    n_abandoned := n_abandoned + 1;
  end loop;

  update public.conversation_questions q set status = 'closed'
    where q.status = 'open' and q.phase = 'mid' and q.created_at < now() - interval '10 minutes'
      and exists (select 1 from public.conversations c where c.id = q.conversation_id and c.kind = 'live');
  get diagnostics n_q = row_count;

  return jsonb_build_object('invitations_expired', n_inv, 'queue_repaired', n_fixed, 'queue_closed', n_closed, 'paused_stale', n_stale,
    'partner_away', n_away, 'abandoned', n_abandoned, 'questions_closed', n_q, 'session_open', v_win.session_start is not null);
end $$;

create or replace function public.purge_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d_msg int := (public.cfg('retention_messages_days', '30'))::int;
  d_pending int := (public.cfg('retention_pending_days', '7'))::int;
  d_reports int := (public.cfg('retention_reports_days', '365'))::int;
  n1 int; n2 int; n3 int; n4 int; n5 int; n6 int;
begin
  perform public.assert_service_role();
  -- live conversations: 30 days after the conversation ended
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'live' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
  -- friend threads: 30 days after each message was sent
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'friend' and m.created_at < now() - make_interval(days => d_msg);
  get diagnostics n6 = row_count;
  update public.question_answers a set custom_text = null from public.conversations c
    where a.conversation_id = c.id and a.custom_text is not null
      and ((c.kind = 'live' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg)) or (c.kind = 'friend' and a.updated_at < now() - make_interval(days => d_msg)));
  get diagnostics n5 = row_count;
  delete from public.pending_messages where status <> 'pending' and updated_at < now() - make_interval(days => d_pending)
    and not exists (select 1 from public.appeals a where a.pending_message_id = pending_messages.id and a.status = 'open');
  get diagnostics n2 = row_count;
  delete from public.reports where status in ('resolved', 'dismissed') and resolved_at < now() - make_interval(days => d_reports);
  get diagnostics n3 = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics n4 = row_count;
  delete from public.notifications where created_at < now() - interval '30 days';
  delete from public.push_queue where created_at < now() - interval '7 days';
  return jsonb_build_object('messages', n1, 'friend_messages', n6, 'custom_answers', n5, 'pending', n2, 'reports', n3, 'rate_limits', n4);
end $$;

-- ---------------------------------------------------------------------------
-- Metrics: unique conversations from 'conversation_started'; participant-level
-- success from 'conversation_opened'. Friend threads log nothing here.
-- ---------------------------------------------------------------------------
create or replace function public.metrics_summary(p_since timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with e as (select * from public.metric_events where created_at >= p_since),
  joins as (select count(*) n, count(distinct session_start) sessions from e where kind = 'queue_join'),
  inv as (select count(*) n, percentile_cont(0.5) within group (order by value) p50, percentile_cont(0.9) within group (order by value) p90 from e where kind = 'invitation_created'),
  opened_p as (select count(*) n from e where kind = 'conversation_opened'),
  started as (select count(distinct meta->>'conversation_id') n, percentile_cont(0.5) within group (order by value) p50 from e where kind = 'conversation_started'),
  fast as (
    select count(*) n from e j
    where j.kind = 'queue_join' and exists (
      select 1 from e o where o.kind = 'conversation_opened' and o.account_id = j.account_id and o.session_start is not distinct from j.session_start
        and o.created_at <= j.created_at + interval '2 minutes')
  ),
  unmatched as (select count(*) n from e where kind = 'unmatched_leave'),
  missed as (select count(*) n from e where kind = 'invitation_missed'),
  declined as (select count(*) n from e where kind = 'invitation_declined'),
  broaden as (select count(*) n, count(*) filter (where meta->>'level' = 'any') any_n from e where kind = 'broaden_selected'),
  optin as (select count(*) n from e where kind = 'reminder_optin'),
  delivery as (select count(*) filter (where status = 'sent') sent, count(*) filter (where status = 'failed') failed, count(*) filter (where status = 'skipped') skipped from public.reminder_sends where created_at >= p_since)
  select jsonb_build_object(
    'since', p_since,
    'queue_joins', (select n from joins), 'sessions_with_joins', (select sessions from joins),
    'invitations', (select n from inv), 'time_to_invitation_p50_s', (select p50 from inv), 'time_to_invitation_p90_s', (select p90 from inv),
    'successful_participants', (select n from opened_p),
    'conversations_opened', (select n from started), 'time_to_both_accept_p50_s', (select p50 from started),
    'started_within_2min', (select n from fast),
    'started_within_2min_pct', case when (select n from joins) > 0 then round(100.0 * (select n from fast) / (select n from joins), 1) else null end,
    'unmatched_leaves', (select n from unmatched),
    'unmatched_rate_pct', case when (select n from joins) > 0 then round(100.0 * (select n from unmatched) / (select n from joins), 1) else null end,
    'invitations_missed', (select n from missed), 'invitations_declined', (select n from declined),
    'broaden_selected', (select n from broaden), 'broaden_any', (select any_n from broaden),
    'reminder_optins', (select n from optin),
    'reminders_sent', (select sent from delivery), 'reminders_failed', (select failed from delivery), 'reminders_skipped', (select skipped from delivery)
  )
$$;

-- ---------------------------------------------------------------------------
-- Legacy cleanup: timed reconnection invitations are gone; stranded queue rows repaired.
-- ---------------------------------------------------------------------------
drop function if exists public.request_reconnection(uuid);
update public.match_invitations set status = 'expired', resolved_at = now() where kind = 'reconnect' and status = 'pending';
update public.availability_requests r set status = 'expired', ended_at = now(), matched_invitation_id = null, invited_at = null
  where r.status = 'invited' and not exists (select 1 from public.match_invitations i where i.id = r.matched_invitation_id and i.status = 'pending');
-- historical participant-level 'conversation_opened' rows (pre-0008) get a matching 'conversation_started' so unique counts are complete
insert into public.metric_events (kind, account_id, session_start, value, meta, created_at)
  select 'conversation_started', null, i.session_start, i.value, jsonb_build_object('conversation_id', c.id, 'backfilled', true), c.opened_at
  from public.conversations c
  join lateral (select e.session_start, e.value from public.metric_events e join public.participants p on p.account_id = e.account_id and p.conversation_id = c.id
                where e.kind = 'conversation_opened' order by e.created_at limit 1) i on true
  where c.kind = 'live' and not exists (select 1 from public.metric_events m where m.kind = 'conversation_started' and m.meta->>'conversation_id' = c.id::text);

revoke execute on function public.claim_push_queue(int) from public, anon, authenticated;
revoke execute on function public.open_conversation_for_invitation(uuid) from public, anon, authenticated;
revoke execute on function public.has_active_conversation(uuid) from public, anon, authenticated;
revoke execute on function public.expire_stale() from public, anon, authenticated;
revoke execute on function public.purge_retention() from public, anon, authenticated;
revoke execute on function public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int) from public, anon, authenticated;
