-- 0017: focused repair release (combined reviews of 8390c88 / migration 0016).
-- Note on 0016: it defines remove_friend twice (§4 without consent events, §5
-- with them); the later definition is the effective one. It is not edited here.

-- ---------------------------------------------------------------------------
-- 1. Fair question scheduling before the limit; backoff that cannot overflow.
-- Finding: question_work ordered every first question ahead of successors and
-- mid questions and then applied LIMIT, so 50 waiting first questions starved
-- the other kinds for as long as new conversations kept arriving. Now each
-- kind is ranked separately (oldest first) and the ranks are interleaved
-- BEFORE the limit, so the first items of every kind are always present; an
-- older item always precedes a newer one of the same kind across ticks.
-- note_question_failure used power(2, failures)::int, which overflows at 31
-- failures; the exponent is capped first.
-- ---------------------------------------------------------------------------
create or replace function public.question_work(p_limit int default 50)
returns table (id uuid, need text) language sql stable security definer set search_path = public as $$
  with w as (
    select c.id, 'first' as need, 0 as prio, c.opened_at as since, c.question_retry_at from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked = 0
    union all
    select c.id, 'successor', 1, c.last_activity_at, c.question_retry_at from public.conversations c
      where c.kind = 'live' and c.status = 'opening' and c.questions_asked > 0
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
    union all
    select c.id, 'mid', 2, c.last_activity_at, c.question_retry_at from public.conversations c
      where c.kind = 'live' and c.status = 'chatting'
        and c.active_seconds_since_question >= c.question_gap_seconds
        and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
  ), ranked as (
    select w.*, row_number() over (partition by w.need order by w.since nulls last, w.id) as rk
    from w where coalesce(w.question_retry_at, '-infinity'::timestamptz) <= now()
  )
  select id, need from ranked order by rk, prio limit p_limit
$$;

create or replace function public.note_question_failure(p_conversation uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  update public.conversations
    set question_failures = question_failures + 1,
        question_retry_at = now() + make_interval(mins => least(power(2, least(question_failures, 10))::int, 10))
    where id = p_conversation;
  insert into public.metric_events (kind, meta) values ('question_generation_failed', jsonb_build_object('conversation_id', p_conversation, 'error', left(p_error, 300)));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Email outbox: release untouched claims without consuming an attempt.
-- Finding: a short tick claimed up to 20 rows and retried the untouched ones
-- with a consumed attempt and provider-failure backoff, possibly past the
-- invitation's expiry. release_email_outbox hands a claim back as it was
-- (attempt not consumed, due now); it never overwrites a cancellation, a
-- skip or another worker's claim.
-- ---------------------------------------------------------------------------
create or replace function public.release_email_outbox(p_id uuid, p_claim_token uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  perform public.assert_service_role();
  select status into v_status from public.email_outbox where id = p_id and claim_token = p_claim_token for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then return v_status; end if;
  update public.email_outbox set status = 'queued', claim_token = null, claimed_until = null, attempts = greatest(attempts - 1, 0),
      next_attempt_at = now(), last_error = 'released: out of time'
    where id = p_id;
  return 'queued';
end $$;
revoke execute on function public.release_email_outbox(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Model-budget exhaustion is its own outcome.
-- Finding: a reached usage limit took the provider-failure path (attempts,
-- backoff, eventually human review with "Our review service is not
-- responding"). defer_pending_until keeps the message pending, gives back the
-- attempt the claim took, explains the limit to the sender, and makes the row
-- claimable again only at the given time (the daily reset).
-- ---------------------------------------------------------------------------
create or replace function public.defer_pending_until(p_pending uuid, p_until timestamptz, p_error text, p_claim_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_token uuid; v_status public.pending_status;
begin
  perform public.assert_service_role();
  select claim_token, status into v_token, v_status from public.pending_messages where id = p_pending for update;
  if v_status <> 'pending' then return; end if;
  if v_token is distinct from p_claim_token then return; end if;   -- only the worker holding the claim
  update public.pending_messages set attempts = greatest(attempts - 1, 0), claim_token = null, last_error = left(p_error, 500),
      next_attempt_at = greatest(p_until, now() + interval '1 minute'),
      user_explanation = 'The daily limit for automated checks has been reached. This message is waiting and will be checked automatically when the limit resets; you can also cancel it.',
      updated_at = now()
    where id = p_pending;
end $$;
revoke execute on function public.defer_pending_until(uuid, timestamptz, text, uuid) from public, anon, authenticated;

-- when the current daily usage window resets (model_usage is keyed by current_date)
create or replace function public.model_budget_reset_at()
returns timestamptz language sql stable as $$ select (current_date + 1)::timestamptz $$;

-- ---------------------------------------------------------------------------
-- 4. Held messages and appeal outcomes, reachable after the conversation ends.
-- Finding: once a live conversation ended the chat screen redirected to the
-- reflection page, which had no held-message controls; an overturned but
-- undeliverable message became 'cancelled' and dropped out of the actionable
-- query, hiding its explanation. my_held_messages returns the caller's own
-- decided messages (revise/blocked), plus cancelled ones that were appealed,
-- each with its latest appeal, bounded, newest first. Participant-only through
-- my_participant_id; never another person's rows.
-- resolve_appeal: when delivery is refused because the OTHER person cleared the
-- history, the recorded reason is 'cleared', not 'ended'.
-- ---------------------------------------------------------------------------
create or replace function public.my_held_messages(p_conversation uuid, p_limit int default 50)
returns table (id uuid, kind public.message_kind, body text, status public.pending_status, user_explanation text, suggested_revision text,
               undeliverable_reason text, created_at timestamptz,
               appeal_id uuid, appeal_status text, appeal_note text, appeal_resolution_note text, appeal_created_at timestamptz, appeal_resolved_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.kind, m.body, m.status, m.user_explanation, m.suggested_revision, m.undeliverable_reason, m.created_at,
         a.id, a.status, a.note, a.resolution_note, a.created_at, a.resolved_at
  from public.pending_messages m
  left join lateral (select * from public.appeals x where x.pending_message_id = m.id order by x.created_at desc limit 1) a on true
  where m.conversation_id = p_conversation
    and m.sender_participant_id = public.my_participant_id(p_conversation)
    and (m.status in ('revise', 'blocked') or (m.status = 'cancelled' and a.id is not null))
  order by m.created_at desc
  limit greatest(1, least(p_limit, 200))
$$;
grant execute on function public.my_held_messages(uuid, int) to authenticated;

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
        -- delivery refused at the last moment: the other person cleared the history, or the pair is blocked / the chat ended meanwhile
        v_reason := case when v_out ->> 'reason' = 'history cleared' then 'cleared' else coalesce(v_c.end_reason, 'ended') end;
        update public.pending_messages set undeliverable_reason = coalesce(undeliverable_reason, v_reason),
            user_explanation = 'A reviewer accepted your appeal, but the message could not be delivered because ' || public.undeliverable_text(v_reason) || '.'
          where id = v_pending;
        v_out := v_out || jsonb_build_object('delivered', false, 'reason', v_reason);
      else
        v_out := v_out || jsonb_build_object('delivered', true);
      end if;
    end if;
  end if;
  return v_out || jsonb_build_object('pending_id', v_pending);
end $$;

-- ---------------------------------------------------------------------------
-- 5. One appeal per message. A double tap (or a retried request) cannot file a
-- second appeal; the UI disables the button while a request is in flight and
-- the server refuses a duplicate so the record stays single.
-- ---------------------------------------------------------------------------
create or replace function public.file_appeal(p_pending uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype := public.owned_pending(p_pending);
  v_id uuid;
begin
  if v_m.status not in ('blocked', 'revise') then raise exception 'nothing to appeal' using errcode = 'P0001'; end if;
  if exists (select 1 from public.appeals where pending_message_id = p_pending) then raise exception 'this message was already appealed' using errcode = 'P0001'; end if;
  if not public.take_rate_limit('appeal', 5, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.appeals (pending_message_id, account_id, note) values (p_pending, auth.uid(), left(p_note, 1000)) returning id into v_id;
  return v_id;
end $$;
