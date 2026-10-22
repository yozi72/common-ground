-- 0018: question scheduling fairness, reminder release, budget-function grant.

-- ---------------------------------------------------------------------------
-- 1. Fair question scheduling that survives restarts and overlapping workers.
-- Findings: (A) every run interleaved first → successor → mid, so with room for
-- one generation only first questions ever ran while new conversations kept
-- arriving; (B) successor/mid work was ranked by last_activity_at, which moves
-- backwards with every message. Now each item carries a STABLE waiting anchor:
-- a first question waits since the conversation opened; a successor or mid
-- question waits since the previous question was asked (max created_at of the
-- conversation's questions), which no later message changes. Items are ranked
-- within their kind and ordered by rank, then by anchor age, so the slot a
-- short tick can afford goes to the oldest waiting item of any kind. Everything
-- is derived from the database on every call, so it holds across worker
-- restarts; overlapping workers are serialized by insert_question's row lock
-- and the one-open-question rule. Failure backoff (question_retry_at) and the
-- deadline limits in the tick are unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.question_work(p_limit int default 50)
returns table (id uuid, need text) language sql stable security definer set search_path = public as $$
  with w as (
    select c.id, 'first' as need, 0 as prio, c.opened_at as since, c.question_retry_at from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked = 0
    union all
    select c.id, 'successor', 1,
           (select max(q.created_at) from public.conversation_questions q where q.conversation_id = c.id),   -- stable: when the previous question was asked
           c.question_retry_at
      from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked > 0
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
    union all
    select c.id, 'mid', 2,
           (select max(q.created_at) from public.conversation_questions q where q.conversation_id = c.id),
           c.question_retry_at
      from public.conversations c
      where c.kind = 'live' and c.status = 'chatting'
        and c.active_seconds_since_question >= c.question_gap_seconds
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
  ), ranked as (
    select w.*, row_number() over (partition by w.need order by w.since nulls last, w.id) as rk
    from w where coalesce(w.question_retry_at, '-infinity'::timestamptz) <= now()
  )
  select id, need from ranked order by rk, since nulls last, prio limit p_limit
$$;

-- ---------------------------------------------------------------------------
-- 2. Reminder claims released when the provider call never started.
-- Finding: the budget could run out between the claim and the provider call
-- (device lookup, address lookup); within() then refused to start the send
-- and the catch path consumed an attempt with "delivery uncertain". The worker
-- now releases such claims: the claim row goes back to what it was before this
-- claim (removed if the claim created it, 'failed' with the previous attempt
-- count if it re-claimed a failed send), conditional on the claim still being
-- ours (status 'claimed' with the attempt count we set). A stale worker cannot
-- overwrite a newer state.
-- ---------------------------------------------------------------------------
create or replace function public.release_reminder_send(p_id uuid, p_attempts int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_status text; v_attempts int;
begin
  perform public.assert_service_role();
  select status, attempts into v_status, v_attempts from public.reminder_sends where id = p_id for update;
  if v_status is null or v_status <> 'claimed' or v_attempts <> p_attempts then return false; end if;
  if v_attempts <= 1 then
    delete from public.reminder_sends where id = p_id;
  else
    update public.reminder_sends set status = 'failed', attempts = v_attempts - 1, last_error = coalesce(last_error, 'released: out of time') where id = p_id;
  end if;
  return true;
end $$;
revoke execute on function public.release_reminder_send(uuid, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. model_budget_reset_at is worker-only (it was created with the default
-- public EXECUTE). It leaks nothing, but only the moderation worker needs it.
-- ---------------------------------------------------------------------------
revoke execute on function public.model_budget_reset_at() from public, anon, authenticated;
grant execute on function public.model_budget_reset_at() to service_role;
