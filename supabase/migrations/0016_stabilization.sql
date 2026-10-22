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
