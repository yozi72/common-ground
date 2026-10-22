-- 0016: stabilization release (combined ChatGPT + Claude reviews of 703a9d6 / 0015).
-- Sections are independent; each states the finding it answers.

-- ---------------------------------------------------------------------------
-- 1. Model usage limits: check-then-reserve, attribution required.
-- Finding: the SQL accepted p_accounts but the gateway never passed them, and a
-- rejected request still bumped the counters.
-- Semantics now:
--  * The global limit (model_calls_per_day_<task>) caps all calls for a task per day.
--  * The per-account limit (model_calls_per_day_per_account) caps each attributed
--    account's calls per task per day. A shared question is attributed to both
--    participants: one global reservation, one per account.
--  * A call must fit under both limits. A rejected request reserves nothing; a
--    reservation that is taken and then fails at the provider still counts
--    (the attempt happened).
--  * When a per-account limit is enabled, a call without attribution is refused:
--    omitting the accounts cannot bypass the limit.
--  * Attribution rows are written even when no per-account limit is set, so
--    usage per account is visible to operators.
-- ---------------------------------------------------------------------------
create or replace function public.take_model_budget(p_task text, p_accounts uuid[] default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_limit int; v_per int; v_calls int; v_a uuid;
  v_zero uuid := '00000000-0000-0000-0000-000000000000';
  v_accounts uuid[];
begin
  perform public.assert_service_role();
  v_limit := (public.cfg('model_calls_per_day_' || p_task, '0'))::int;
  v_per := (public.cfg('model_calls_per_day_per_account', '0'))::int;
  select array_agg(distinct x) into v_accounts from unnest(coalesce(p_accounts, '{}'::uuid[])) x where x is not null;
  v_accounts := coalesce(v_accounts, '{}'::uuid[]);
  if v_per > 0 and cardinality(v_accounts) = 0 then return false; end if;      -- attribution is required once a per-account limit exists
  perform pg_advisory_xact_lock(hashtext('cg_model_budget_' || p_task));         -- check-then-reserve is atomic per task
  if v_limit > 0 then
    select calls into v_calls from public.model_usage where day = current_date and task = p_task and account_id = v_zero;
    if coalesce(v_calls, 0) + 1 > v_limit then return false; end if;
  end if;
  if v_per > 0 then
    foreach v_a in array v_accounts loop
      select calls into v_calls from public.model_usage where day = current_date and task = p_task and account_id = v_a;
      if coalesce(v_calls, 0) + 1 > v_per then return false; end if;
    end loop;
  end if;
  insert into public.model_usage (day, task, account_id, calls) values (current_date, p_task, v_zero, 1)
    on conflict (day, task, account_id) do update set calls = public.model_usage.calls + 1;
  foreach v_a in array v_accounts loop
    insert into public.model_usage (day, task, account_id, calls) values (current_date, p_task, v_a, 1)
      on conflict (day, task, account_id) do update set calls = public.model_usage.calls + 1;
  end loop;
  return true;
end $$;
revoke execute on function public.take_model_budget(text, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Push queue: one claim-conditional release that preserves history.
-- Finding: the worker released an out-of-time claim with a retry (attempt
-- consumed) followed by an unconditional reset of attempts to 0, erasing
-- genuine earlier failures. release_push_queue hands the claim back untouched:
-- attempts unchanged, per-device deliveries merged (devices already sent stay
-- sent), due now. It never overwrites a cancellation, another worker's claim or
-- a completed delivery.
-- ---------------------------------------------------------------------------
create or replace function public.release_push_queue(p_id uuid, p_claimed_at timestamptz, p_deliveries jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  perform public.assert_service_role();
  select status into v_status from public.push_queue where id = p_id and claimed_at = p_claimed_at for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then
    update public.push_queue set deliveries = coalesce(deliveries, '{}'::jsonb) || coalesce(p_deliveries, '{}'::jsonb) where id = p_id;   -- keep what was delivered on record
    return v_status;
  end if;
  update public.push_queue set status = 'queued', next_attempt_at = now(), last_error = 'released: out of time',
      deliveries = coalesce(deliveries, '{}'::jsonb) || coalesce(p_deliveries, '{}'::jsonb)
    where id = p_id;
  return 'queued';
end $$;
revoke execute on function public.release_push_queue(uuid, timestamptz, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Question generation under backlog.
-- Finding: the tick's question stage could start with 8 s left while every
-- inner loop demanded 20 s, so a 25 s tick moderated and generated nothing.
-- One ordered work list (first questions, opening-round successors, due mid
-- questions) with a per-conversation backoff so a repeatedly failing item cannot
-- monopolize the stage; a successful insert resets the backoff.
-- ---------------------------------------------------------------------------
alter table public.conversations add column if not exists question_retry_at timestamptz;
alter table public.conversations add column if not exists question_failures int not null default 0;

create or replace function public.question_work(p_limit int default 50)
returns table (id uuid, need text) language sql stable security definer set search_path = public as $$
  select c.id, c.need from (
    select c.id, 'first' as need, 0 as prio, c.opened_at as since from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked = 0
    union all
    select c.id, 'successor', 1, c.last_activity_at from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked > 0
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
    union all
    select c.id, 'mid', 2, c.last_activity_at from public.conversations c
      where c.kind = 'live' and c.status = 'chatting'
        and c.active_seconds_since_question >= c.question_gap_seconds
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
  ) c
  join public.conversations cv on cv.id = c.id
  where coalesce(cv.question_retry_at, '-infinity'::timestamptz) <= now()
  order by c.prio, cv.question_retry_at nulls first, c.since
  limit p_limit
$$;
revoke execute on function public.question_work(int) from public, anon, authenticated;

create or replace function public.conversations_due_for_question(p_limit int default 20)
returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.conversations c
  where c.kind = 'live' and c.status = 'chatting'
    and c.active_seconds_since_question >= c.question_gap_seconds
    and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
    and coalesce(c.question_retry_at, '-infinity'::timestamptz) <= now()
  order by c.last_activity_at
  limit p_limit
$$;

create or replace function public.note_question_failure(p_conversation uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  update public.conversations
    set question_failures = question_failures + 1,
        question_retry_at = now() + make_interval(mins => least(power(2, question_failures)::int, 10))
    where id = p_conversation;
  insert into public.metric_events (kind, meta) values ('question_generation_failed', jsonb_build_object('conversation_id', p_conversation, 'error', left(p_error, 300)));
end $$;
revoke execute on function public.note_question_failure(uuid, text) from public, anon, authenticated;

-- a successful insert clears the backoff
create or replace function public.insert_question(p_conversation uuid, p_phase public.question_phase, p_text text, p_choices text[], p_followup_a text, p_followup_b text, p_source text, p_sensitive boolean, p_rationale text)
returns uuid language plpgsql security definer set search_path = public as $$
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
    question_retry_at = null, question_failures = 0,
    question_gap_seconds = case when p_phase = 'mid' then least((question_gap_seconds * v_mult)::int, v_max) else question_gap_seconds end
    where id = p_conversation;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Lock order, verified; appeal eligibility separated from deliverability.
--
-- Actual serialization invariant (mapped across direct statements, nested
-- functions, the one trigger and the foreign keys; see NOTES.md for the map):
--  (1) per-account advisory locks (lock_accounts, sorted)
--  (2) connections row
--  (3) conversations row, FOR NO KEY UPDATE  <-- the serialization point for
--      everything that touches a conversation's questions or pending rows
--  (4)/(5) conversation_questions and pending_messages rows, in either order:
--      every function that touches them holds (3) first, so their relative
--      order cannot form a cycle.
--  Exceptions that hold no (3): the sender's per-row actions (cancel_pending,
--  accept_revision, file_appeal) lock exactly one pending row and then take at
--  most FOR KEY SHARE on the conversation through a foreign key, which is
--  compatible with (3). insert_question takes conversations FOR UPDATE and then
--  only inserts. open_friend_thread takes (2) without (1) and then only inserts.
--  Every function that touches more than one of (1)(2)(3) takes them in that
--  order (report_peer: 1 → 3 → block_peer 1 → 2 → 3; the pair's (1) locks
--  serialize it against remove_friend's 1 → 2 → 3).
-- The one remaining inversion was resolve_appeal: it updated the pending row
-- (5) before apply_moderation_decision took (3), so overturning an appealed
-- revision while the sender ended or cleared the conversation could deadlock
-- (end/clear hold 3 and want 5). It now takes (3) first.
--
-- Appeal eligibility: ending, blocking, leaving, removing or clearing used to
-- cancel 'revise' rows, which also removed the sender's right to challenge the
-- decision (file_appeal accepts blocked/revise only). Now "can no longer be
-- delivered" (pending_messages.undeliverable_reason) is separate from the
-- moderation decision: 'revise'/'blocked' rows keep their status and gain a
-- reason; 'pending'/'review' rows (no decision yet) are cancelled with the
-- reason. An overturned appeal on an undeliverable message records the
-- outcome and explains it to the sender; nothing is delivered into an ended,
-- blocked or cleared conversation.
-- ---------------------------------------------------------------------------
alter table public.pending_messages add column if not exists undeliverable_reason text;

create or replace function public.undeliverable_text(p_reason text)
returns text language sql immutable as $$
  select case p_reason
    when 'left' then 'the conversation ended'
    when 'abandoned' then 'the conversation ended'
    when 'blocked' then 'the conversation was ended with a block'
    when 'unfriended' then 'the chat ended'
    when 'cleared' then 'the chat''s history was cleared'
    else 'the conversation ended' end
$$;

-- Caller must already hold the conversation row lock (3).
create or replace function public.close_pending_delivery(p_conversation uuid, p_reason text, p_sender uuid default null)
returns void language sql security definer set search_path = public as $$
  update public.pending_messages set status = 'cancelled', claim_token = null, undeliverable_reason = coalesce(undeliverable_reason, p_reason), updated_at = now()
    where conversation_id = p_conversation and status in ('pending', 'review') and (p_sender is null or sender_participant_id = p_sender);
  update public.pending_messages set claim_token = null, undeliverable_reason = p_reason, updated_at = now()
    where conversation_id = p_conversation and status in ('revise', 'blocked') and undeliverable_reason is null and (p_sender is null or sender_participant_id = p_sender);
$$;
revoke execute on function public.close_pending_delivery(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.end_conversation(p_conversation uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set status = 'ended', ended_at = now(), end_reason = p_reason
    where id = p_conversation and status <> 'ended';                                   -- 3 (row lock)
  perform public.close_pending_delivery(p_conversation, p_reason);                     -- 5: decided rows keep their decision
  update public.conversation_questions set status = 'closed'
    where conversation_id = p_conversation and status = 'open';                        -- 4
  update public.push_queue set status = 'cancelled', last_error = 'conversation ended'
    where conversation_id = p_conversation and status in ('queued', 'claimed');
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'conversation_ended', jsonb_build_object('conversation_id', p_conversation, 'reason', p_reason)
    from public.participants p where p.conversation_id = p_conversation;
end $$;

create or replace function public.remove_friend(p_connection uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_conv uuid;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  perform public.lock_accounts(v_c.account_a, v_c.account_b);                            -- 1
  select * into v_c from public.connections where id = p_connection for update;         -- 2
  update public.connections set status = 'ended', ended_at = now() where id = p_connection and status = 'active';
  perform public.revoke_connection_consent(v_c.account_a, v_c.account_b);
  select id into v_conv from public.conversations where connection_id = p_connection and kind = 'friend';
  if v_conv is not null then
    update public.conversations set status = 'ended', ended_at = now(), end_reason = 'unfriended' where id = v_conv and status <> 'ended';   -- 3
    update public.conversation_questions set status = 'closed' where conversation_id = v_conv and status = 'open';                           -- 4
    perform public.close_pending_delivery(v_conv, 'unfriended');                                                                            -- 5
    update public.push_queue set status = 'cancelled', last_error = 'friendship ended' where conversation_id = v_conv and status in ('queued', 'claimed');
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'friendship_ended', jsonb_build_object('conversation_id', v_conv) from public.participants p where p.conversation_id = v_conv and p.account_id <> v_uid;
  end if;
end $$;

create or replace function public.clear_thread_history(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.conversations%rowtype; v_pid uuid; n int; v_now timestamptz := clock_timestamp();
begin
  select * into v_c from public.conversations where id = p_conversation for no key update;   -- 3
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_c.kind <> 'friend' then raise exception 'only chats can be cleared' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  v_now := greatest(v_now, coalesce(v_c.history_cleared_at, v_now));
  update public.conversation_questions set status = 'closed', cleared_at = v_now where conversation_id = p_conversation and cleared_at is null;     -- 4
  -- only my own undelivered rows: the other person's submissions are never cancelled by my clear
  perform public.close_pending_delivery(p_conversation, 'cleared', v_pid);                                                                         -- 5
  update public.pending_messages set body = '[cleared]', suggested_revision = null, updated_at = v_now
    where conversation_id = p_conversation and status in ('approved', 'cancelled') and created_at < v_now and body <> '[cleared]';
  delete from public.approved_messages where conversation_id = p_conversation;                                                                     -- 6
  get diagnostics n = row_count;
  delete from public.question_answers where conversation_id = p_conversation;
  update public.conversations set history_cleared_at = v_now where id = p_conversation;
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'history_cleared', jsonb_build_object('conversation_id', p_conversation, 'cleared_at', v_now) from public.participants p where p.conversation_id = p_conversation;
  return jsonb_build_object('deleted', n, 'cleared_at', v_now);
end $$;

create or replace function public.accept_revision(p_pending uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_m public.pending_messages%rowtype := public.owned_pending(p_pending);
begin
  if v_m.status <> 'revise' or v_m.suggested_revision is null then
    raise exception 'no revision to accept' using errcode = 'P0001';
  end if;
  if v_m.undeliverable_reason is not null then
    raise exception 'this message can no longer be delivered: %', public.undeliverable_text(v_m.undeliverable_reason) using errcode = 'P0001';
  end if;
  update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
  return public.submit_message(v_m.conversation_id, v_m.client_send_id || ':rev:' || v_m.attempts, v_m.suggested_revision, v_m.kind, v_m.question_id);
end $$;

create or replace function public.resolve_appeal(p_appeal uuid, p_status text, p_note text, p_resolver uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pending uuid; v_conv uuid; v_m public.pending_messages%rowtype; v_c public.conversations%rowtype; v_out jsonb := '{}'::jsonb; v_reason text;
begin
  perform public.assert_service_role();
  if p_status not in ('upheld', 'overturned') then raise exception 'bad status' using errcode = 'P0001'; end if;
  select pending_message_id into v_pending from public.appeals where id = p_appeal;
  if v_pending is null then raise exception 'appeal not found' using errcode = 'P0001'; end if;
  select conversation_id into v_conv from public.pending_messages where id = v_pending;
  select * into v_c from public.conversations where id = v_conv for no key update;                     -- 3 first, like end/clear/delivery
  update public.appeals set status = p_status, resolution_note = p_note, resolved_by = p_resolver, resolved_at = now()
    where id = p_appeal and status = 'open' returning pending_message_id into v_pending;
  if v_pending is null then raise exception 'appeal not open' using errcode = 'P0001'; end if;
  if p_status = 'overturned' then
    select * into v_m from public.pending_messages where id = v_pending for update;                     -- 5
    if v_m.status not in ('blocked', 'revise') then
      v_out := jsonb_build_object('delivered', false, 'reason', 'no longer held (' || v_m.status || ')');
    elsif v_m.undeliverable_reason is not null or v_c.status = 'ended' then
      v_reason := coalesce(v_m.undeliverable_reason, v_c.end_reason, 'ended');
      update public.pending_messages set status = 'cancelled', claim_token = null, undeliverable_reason = v_reason,
          user_explanation = 'A reviewer accepted your appeal, but the message could not be delivered because ' || public.undeliverable_text(v_reason) || '.', updated_at = now()
        where id = v_pending;
      v_out := jsonb_build_object('delivered', false, 'reason', v_reason);
    else
      update public.pending_messages set status = 'pending', attempts = 0, claim_token = null, updated_at = now() where id = v_pending;
      v_out := public.apply_moderation_decision(v_pending, 'allow', array['appeal_overturned'], null, null, 1, '{}', 'human', null, true, null, null, null);
      if coalesce((v_out ->> 'skipped')::boolean, false) then
        update public.pending_messages set user_explanation = 'A reviewer accepted your appeal, but the message could not be delivered because ' || public.undeliverable_text(coalesce(undeliverable_reason, 'ended')) || '.' where id = v_pending;
        v_out := v_out || jsonb_build_object('delivered', false);
      else
        v_out := v_out || jsonb_build_object('delivered', true);
      end if;
    end if;
  end if;
  return v_out || jsonb_build_object('pending_id', v_pending);
end $$;
