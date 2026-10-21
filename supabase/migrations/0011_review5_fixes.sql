-- Fifth external review (commit f900e5c / 06d422f):
--  1. "Give us a question" accepted live conversations and inserted a 'mid'
--     question during the opening round, which never completes the round.
--     The action is friend-only; insert_question enforces phase/state; the
--     opening round completes on the count of revealed questions; affected
--     conversations are repaired.
--  2. Push queue: a claimed alert could be sent after a cancellation and then
--     overwrite 'cancelled' with 'sent'; failures were tracked per alert, not
--     per device. Re-check right before each device send; all completion and
--     retry updates are conditional on the row still being 'claimed'; per-device
--     delivery state lives in push_queue.deliveries.

-- ---------------------------------------------------------------------------
-- 1. Questions: friend-only on-demand action; strict phases; round completion
-- ---------------------------------------------------------------------------
create or replace function public.can_request_question(p_conversation uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.conversations%rowtype; v_peer uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  -- live sessions get their questions from the worker on its own schedule
  if v_c.kind <> 'friend' then raise exception 'not available in this conversation' using errcode = 'P0001'; end if;
  if v_c.status = 'ended' then return false; end if;
  if not exists (select 1 from public.connections where id = v_c.connection_id and status = 'active') then return false; end if;
  select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid limit 1;
  if v_peer is not null and public.is_blocked_either_way(v_uid, v_peer) then return false; end if;
  if exists (select 1 from public.conversation_questions where conversation_id = p_conversation and status = 'open') then return false; end if;
  if not public.take_rate_limit('friend_question', 10, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  return true;
end $$;

create or replace function public.insert_question(
  p_conversation uuid, p_phase public.question_phase, p_text text, p_choices text[],
  p_followup_a text, p_followup_b text, p_source text, p_sensitive boolean, p_rationale text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_seq int;
  v_c public.conversations%rowtype;
  v_mult numeric := (public.cfg('question_gap_multiplier', '2'))::numeric;
  v_max int := (public.cfg('question_gap_max_seconds', '600'))::int;
begin
  perform public.assert_service_role();
  select * into v_c from public.conversations where id = p_conversation for update;
  if v_c.id is null or v_c.status = 'ended' then return null; end if;
  -- phase must match the conversation's state: opening questions only during the
  -- opening round of a live session, mid questions only in open chat (live or friend)
  if v_c.kind = 'live' and v_c.status = 'opening' and p_phase <> 'opening' then
    raise exception 'only opening questions during the opening round' using errcode = 'P0001';
  end if;
  if (v_c.kind = 'friend' or v_c.status = 'chatting') and p_phase <> 'mid' then
    raise exception 'only mid questions in open chat' using errcode = 'P0001';
  end if;
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

-- The opening round completes when enough questions have been revealed, whatever
-- their phase or sequence numbers (robust to repaired conversations).
create or replace function public.maybe_reveal_question(p_question uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_q public.conversation_questions%rowtype;
  v_needed int;
  v_have int;
  v_conv public.conversations%rowtype;
  v_acc uuid[];
  v_revealed int;
begin
  select * into v_q from public.conversation_questions where id = p_question for update;
  if v_q.revealed_at is not null or v_q.status = 'closed' then return false; end if;
  select * into v_conv from public.conversations where id = v_q.conversation_id for update;
  select array_agg(account_id) into v_acc from public.participants where conversation_id = v_q.conversation_id;
  if v_conv.status = 'ended'
     or exists (select 1 from public.participants where conversation_id = v_q.conversation_id and left_at is not null)
     or (array_length(v_acc, 1) = 2 and public.is_blocked_either_way(v_acc[1], v_acc[2])) then
    update public.conversation_questions set status = 'closed' where id = p_question;
    return false;
  end if;
  select count(*) into v_needed from public.participants where conversation_id = v_q.conversation_id and left_at is null;
  select count(*) into v_have from public.question_answers
    where question_id = p_question and status in ('approved', 'skipped');
  if v_have < greatest(v_needed, 2) then return false; end if;

  update public.conversation_questions set revealed_at = now(), status = 'revealed' where id = p_question;
  if v_conv.kind = 'live' and v_conv.status = 'opening' then
    select count(*) into v_revealed from public.conversation_questions where conversation_id = v_q.conversation_id and status = 'revealed';
    if v_revealed >= v_conv.opening_question_count then
      update public.conversations set status = 'chatting', chat_started_at = now(), last_activity_at = now()
        where id = v_q.conversation_id;
    end if;
  end if;
  return true;
end $$;

-- Repair: live conversations stuck in 'opening'. A stray open 'mid' question is
-- closed so the worker asks a proper opening question; rounds that already
-- revealed enough questions move on to chat.
update public.conversation_questions q set status = 'closed'
  from public.conversations c
  where c.id = q.conversation_id and c.kind = 'live' and c.status = 'opening' and q.status = 'open' and q.phase = 'mid';
update public.conversations c set status = 'chatting', chat_started_at = coalesce(chat_started_at, now()), last_activity_at = now()
  where c.kind = 'live' and c.status = 'opening'
    and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
    and (select count(*) from public.conversation_questions q where q.conversation_id = c.id and q.status = 'revealed') >= c.opening_question_count;

-- ---------------------------------------------------------------------------
-- 2. Push queue: per-device state, re-check before every send, conditional updates
-- ---------------------------------------------------------------------------
alter table public.push_queue add column if not exists deliveries jsonb not null default '{}'::jsonb;

-- Why an alert should no longer be sent (null = still wanted). Shared by the
-- claim and by the worker's re-check right before each device send.
create or replace function public.push_queue_obsolete_reason(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when c.status = 'ended' then 'conversation ended'
    when not exists (select 1 from public.connections cn where cn.id = c.connection_id and cn.status = 'active') then 'friendship ended'
    when exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id <> q.account_id
                 and public.is_blocked_either_way(q.account_id, p.account_id)) then 'blocked'
    when not exists (select 1 from public.reminder_prefs rp where rp.account_id = q.account_id and rp.friend_push_enabled) then 'opted out'
    when coalesce((select tr.muted from public.thread_reads tr where tr.conversation_id = c.id and tr.account_id = q.account_id), false) then 'muted'
    when not exists (
      select 1 from public.approved_messages m join public.participants p on p.id = m.sender_participant_id
      where m.conversation_id = c.id and m.kind = 'chat' and p.account_id <> q.account_id
        and m.created_at > coalesce((select tr.last_read_at from public.thread_reads tr where tr.conversation_id = c.id and tr.account_id = q.account_id), 'epoch'::timestamptz)
    ) then 'already read'
    else null end
  from public.push_queue q join public.conversations c on c.id = q.conversation_id
  where q.id = p_id
$$;
revoke execute on function public.push_queue_obsolete_reason(uuid) from public, anon, authenticated;

create or replace function public.claim_push_queue(p_limit int default 20)
returns setof public.push_queue language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  perform public.assert_service_role();
  select array_agg(id) into v_ids from (
    select id from public.push_queue
      where (status = 'queued' and next_attempt_at <= now()) or (status = 'claimed' and claimed_at < now() - interval '10 minutes')
      order by created_at for update skip locked limit p_limit
  ) s;
  if v_ids is null then return; end if;
  update public.push_queue q set status = 'skipped', last_error = r.reason
    from (select id, public.push_queue_obsolete_reason(id) as reason from public.push_queue where id = any (v_ids)) r
    where q.id = r.id and r.reason is not null;
  return query
    update public.push_queue q set status = 'claimed', claimed_at = now()
      where q.id = any (v_ids) and q.status in ('queued', 'claimed')
      returning q.*;
end $$;

-- Worker, right before each device send: is this alert still claimed by me and
-- still wanted? Returns the row's status after the check ('claimed' = go ahead).
-- Anything else (cancelled by a mute/read/removal/block, reclaimed, obsolete)
-- means stop; nothing is overwritten.
create or replace function public.recheck_push_queue(p_id uuid, p_claimed_at timestamptz) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_reason text;
begin
  perform public.assert_service_role();
  select status into v_status from public.push_queue where id = p_id and claimed_at = p_claimed_at for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then return v_status; end if;
  v_reason := public.push_queue_obsolete_reason(p_id);
  if v_reason is not null then
    update public.push_queue set status = 'skipped', last_error = v_reason where id = p_id;
    return 'skipped';
  end if;
  return 'claimed';
end $$;
revoke execute on function public.recheck_push_queue(uuid, timestamptz) from public, anon, authenticated;

-- Worker, after its send loop. Applies only while the row is still this
-- worker's claim; a cancellation that happened meanwhile wins. Outcomes:
--   'sent'    every live device got it
--   'retry'   at least one device failed transiently → queued again with backoff
--             (1, 2, 4 min), 'failed' after p_max_attempts; successful devices
--             are remembered in deliveries and not sent again
--   'skipped' nothing to send to
-- Returns the row's resulting status.
create or replace function public.finish_push_queue(p_id uuid, p_claimed_at timestamptz, p_outcome text, p_deliveries jsonb, p_error text default null, p_max_attempts int default 3)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  perform public.assert_service_role();
  select status into v_status from public.push_queue where id = p_id and claimed_at = p_claimed_at for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then
    update public.push_queue set deliveries = coalesce(p_deliveries, deliveries) where id = p_id;  -- keep what was delivered on record
    return v_status;
  end if;
  if p_outcome = 'sent' then
    update public.push_queue set status = 'sent', sent_at = now(), deliveries = coalesce(p_deliveries, deliveries), last_error = null where id = p_id;
    return 'sent';
  elsif p_outcome = 'retry' then
    update public.push_queue set attempts = attempts + 1, last_error = p_error, deliveries = coalesce(p_deliveries, deliveries),
        status = case when attempts + 1 >= p_max_attempts then 'failed' else 'queued' end,
        next_attempt_at = now() + (interval '1 minute' * power(2, attempts))
      where id = p_id returning status into v_status;
    return v_status;
  else
    update public.push_queue set status = 'skipped', last_error = p_error, deliveries = coalesce(p_deliveries, deliveries) where id = p_id;
    return 'skipped';
  end if;
end $$;
revoke execute on function public.finish_push_queue(uuid, timestamptz, text, jsonb, text, int) from public, anon, authenticated;

-- Older entry point kept for compatibility; now conditional on the claim too.
create or replace function public.fail_push_queue(p_id uuid, p_error text, p_max_attempts int default 3) returns text
language plpgsql security definer set search_path = public as $$
declare v_claimed timestamptz;
begin
  perform public.assert_service_role();
  select claimed_at into v_claimed from public.push_queue where id = p_id and status = 'claimed';
  if v_claimed is null then return coalesce((select status from public.push_queue where id = p_id), 'missing'); end if;
  return public.finish_push_queue(p_id, v_claimed, 'retry', null, p_error, p_max_attempts);
end $$;
