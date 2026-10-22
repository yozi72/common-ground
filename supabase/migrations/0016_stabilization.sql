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
