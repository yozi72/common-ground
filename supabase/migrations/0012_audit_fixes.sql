-- Combined audit (Claude audit + ChatGPT verification of e1e4b49).
--  1. availability_requests.avoid_account_ids held peer account ids readable by
--     the row's owner → column-level grant hides it from clients.
--  2. Direct client writes could mark onboarding complete, store unvalidated
--     political answers and insert arbitrary consent rows → accounts are
--     read-only for clients, profiles accept only the timezone override
--     directly, consent goes through record_consent().
--  3. leave_conversation accepted friend threads → live only; affected threads
--     repaired (only 'left' friend threads whose friendship is still active).
--  4. Simultaneous "yes" decisions could both miss each other → per-account
--     advisory locks (same order as acceptance/removal/block) around the
--     decision and the connection upsert.
--  5. Moderation claims carry a token; results and deferrals apply only with
--     the live token (or explicitly as a human decision), so stale/overlapping
--     workers cannot change a newer outcome. Leases are 75 s (model timeout
--     25 s × up to 2 tries + margin). Unprocessed claims can be released.
--  7. run_matching locks and revalidates both queue rows before creating an
--     invitation; the invitation email is queued again (dropped in 0006).
--  9. email_outbox gets atomic claims with leases, bounded retries, cancellation
--     and a relevance check before sending.
-- 10. metrics_summary and internal helpers are no longer executable by
--     ordinary users.
-- 13. Missing indexes; retention for queue entries, metrics, outbox, reminders.

-- ---------------------------------------------------------------------------
-- 1. availability_requests: hide avoid_account_ids from clients
-- ---------------------------------------------------------------------------
revoke select on public.availability_requests from authenticated, anon;
grant select (id, account_id, status, session_start, expires_at, notify_email, created_at, ended_at,
              matched_invitation_id, invited_at, paused_at, paused_reason, broaden, last_seen_at)
  on public.availability_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 2. accounts / profiles / consent_events: validated paths only
-- ---------------------------------------------------------------------------
drop policy if exists accounts_self_update on public.accounts;
revoke insert, update, delete on public.accounts from authenticated, anon;

drop policy if exists profiles_self on public.profiles;
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select to authenticated using (account_id = auth.uid());
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated using (account_id = auth.uid()) with check (account_id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated, anon;
grant update (timezone_override, updated_at) on public.profiles to authenticated;  -- everything else via complete_onboarding()

drop policy if exists consent_self_insert on public.consent_events;
revoke insert, update, delete on public.consent_events from authenticated, anon;

-- Preference consents (reminders, friend pushes, email opt-out) are recorded
-- here; onboarding consents are written by complete_onboarding().
create or replace function public.record_consent(p_kind text, p_version text, p_granted boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  if p_kind not in ('reminders', 'friend_push', 'reminders_email') then raise exception 'unknown consent kind' using errcode = 'P0001'; end if;
  if p_version is null or length(p_version) not between 1 and 32 then raise exception 'bad version' using errcode = 'P0001'; end if;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, p_kind, p_version, p_granted);
end $$;

-- ---------------------------------------------------------------------------
-- 3. leave_conversation: live sessions only
-- ---------------------------------------------------------------------------
create or replace function public.leave_conversation(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_kind text;
begin
  select kind into v_kind from public.conversations where id = p_conversation;
  if v_kind is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_kind <> 'live' then raise exception 'friend chats are ended by removing the friend' using errcode = 'P0001'; end if;
  update public.participants set left_at = now() where conversation_id = p_conversation and account_id = v_uid and left_at is null;
  perform public.end_conversation(p_conversation, 'left');
end $$;

-- Repair: friend threads ended by the live "leave" action while the friendship
-- itself is still active and nobody is blocked. Blocked or removed ones stay ended.
update public.conversations c set status = 'chatting', ended_at = null, end_reason = null
  from public.connections cn
  where c.kind = 'friend' and c.status = 'ended' and c.end_reason = 'left'
    and cn.id = c.connection_id and cn.status = 'active'
    and not public.is_blocked_either_way(cn.account_a, cn.account_b);
update public.participants p set left_at = null
  from public.conversations c
  where p.conversation_id = c.id and c.kind = 'friend' and c.status = 'chatting' and p.left_at is not null;

-- ---------------------------------------------------------------------------
-- 4. Friendship decisions under per-account locks (sorted, same as elsewhere)
-- ---------------------------------------------------------------------------
create or replace function public.lock_accounts(variadic p_ids uuid[]) returns void
language plpgsql as $$
declare v uuid;
begin
  for v in select distinct x from unnest(p_ids) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtext('cg_account_' || v::text));
  end loop;
end $$;
revoke execute on function public.lock_accounts(uuid[]) from public, anon, authenticated;

create or replace function public.set_connection_decision(p_conversation uuid, p_decision boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_pid uuid;
  v_peer record;
  v_version text := trim(both '"' from (public.cfg('friendship_policy_version', '"v1"'))::text);
  v_both boolean;
  v_n int;
  v_conn uuid;
  v_a uuid; v_b uuid; v_alias_a text; v_alias_b text;
begin
  if not (public.cfg('friendship_enabled', 'true'))::boolean then
    raise exception 'reconnection is not enabled' using errcode = 'P0001';
  end if;
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if exists (select 1 from public.conversations where id = p_conversation and (end_reason = 'blocked' or kind <> 'live')) then
    raise exception 'not available for this conversation' using errcode = 'P0001';
  end if;
  select p.account_id, a.alias into v_peer
    from public.participants p join public.participant_aliases a on a.participant_id = p.id
    where p.conversation_id = p_conversation and p.account_id <> v_uid;
  -- serialize with the other person's decision, removal and blocking
  perform public.lock_accounts(v_uid, v_peer.account_id);

  v_pid := public.my_participant_id(p_conversation);
  insert into public.connection_requests (conversation_id, participant_id, decision, policy_version)
    values (p_conversation, v_pid, p_decision, v_version)
    on conflict (conversation_id, participant_id) do update set decision = excluded.decision, created_at = now(), revoked_at = null;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'reconnect_policy', v_version, p_decision);

  if not p_decision then return jsonb_build_object('status', 'recorded'); end if;
  if v_peer.account_id is null then return jsonb_build_object('status', 'recorded'); end if;
  if public.is_blocked_either_way(v_uid, v_peer.account_id) then return jsonb_build_object('status', 'recorded'); end if;

  select bool_and(decision), count(*) into v_both, v_n from public.connection_requests
    where conversation_id = p_conversation and revoked_at is null;
  if not coalesce(v_both, false) or v_n < 2 then return jsonb_build_object('status', 'recorded'); end if;

  if v_uid < v_peer.account_id then
    v_a := v_uid; v_b := v_peer.account_id;
    select alias into v_alias_a from public.participant_aliases where participant_id = v_pid;
    v_alias_b := v_peer.alias;
  else
    v_a := v_peer.account_id; v_b := v_uid;
    v_alias_a := v_peer.alias;
    select alias into v_alias_b from public.participant_aliases where participant_id = v_pid;
  end if;
  insert into public.connections (account_a, account_b, alias_a, alias_b, source_conversation_id)
    values (v_a, v_b, v_alias_a, v_alias_b, p_conversation)
    on conflict (account_a, account_b) do update set status = 'active', ended_at = null
    returning id into v_conn;
  update public.conversations set status = 'chatting', ended_at = null, end_reason = null
    where connection_id = v_conn and kind = 'friend' and status = 'ended' and end_reason = 'unfriended';
  insert into public.notifications (account_id, kind, payload) values
    (v_a, 'connected', jsonb_build_object('connection_id', v_conn)),
    (v_b, 'connected', jsonb_build_object('connection_id', v_conn));
  return jsonb_build_object('status', 'connected', 'connection_id', v_conn);
end $$;

create or replace function public.remove_friend(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_conv uuid;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  perform public.lock_accounts(v_c.account_a, v_c.account_b);
  select * into v_c from public.connections where id = p_connection for update;
  update public.connections set status = 'ended', ended_at = now() where id = p_connection and status = 'active';
  perform public.revoke_connection_consent(v_c.account_a, v_c.account_b);
  select id into v_conv from public.conversations where connection_id = p_connection and kind = 'friend';
  if v_conv is not null then
    update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = v_conv and status in ('pending', 'review', 'revise');
    update public.conversation_questions set status = 'closed' where conversation_id = v_conv and status = 'open';
    update public.push_queue set status = 'cancelled', last_error = 'friendship ended' where conversation_id = v_conv and status in ('queued', 'claimed');
    update public.conversations set status = 'ended', ended_at = now(), end_reason = 'unfriended' where id = v_conv and status <> 'ended';
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'friendship_ended', jsonb_build_object('conversation_id', v_conv) from public.participants p where p.conversation_id = v_conv and p.account_id <> v_uid;
  end if;
end $$;

create or replace function public.block_peer(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_peer uuid; v_t uuid;
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  if v_peer is null then return; end if;
  perform public.lock_accounts(v_uid, v_peer);
  insert into public.blocks (blocker_account_id, blocked_account_id, conversation_id) values (v_uid, v_peer, p_conversation) on conflict do nothing;
  update public.connections set status = 'ended', ended_at = now()
    where status = 'active' and ((account_a = v_uid and account_b = v_peer) or (account_a = v_peer and account_b = v_uid));
  perform public.revoke_connection_consent(v_uid, v_peer);
  for v_t in select c.id from public.conversations c where c.status <> 'ended' and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_uid)
    and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_peer) loop
    update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = v_t and status in ('pending', 'review', 'revise');
    update public.participants set left_at = now() where conversation_id = v_t and account_id = v_uid and left_at is null;
    perform public.end_conversation(v_t, 'blocked');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Moderation claims with tokens
-- ---------------------------------------------------------------------------
alter table public.pending_messages add column if not exists claim_token uuid;

-- Lease = model timeout (25 s) × 2 tries + margin. next_attempt_at doubles as the lease end.
drop function if exists public.claim_pending(int);   -- the old overload would make calls ambiguous
create or replace function public.claim_pending(p_limit int default 10, p_lease_seconds int default 75)
returns setof public.pending_messages language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  return query
    update public.pending_messages m
      set attempts = attempts + 1, claim_token = gen_random_uuid(),
          next_attempt_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
      where m.id in (
        select id from public.pending_messages
        where status = 'pending' and next_attempt_at <= now()
        order by created_at
        for update skip locked
        limit p_limit
      )
      returning m.*;
end $$;

-- Immediate processing right after a send: same claim semantics as the batch.
create or replace function public.claim_pending_by_id(p_id uuid, p_lease_seconds int default 75)
returns setof public.pending_messages language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  return query
    update public.pending_messages m
      set attempts = attempts + 1, claim_token = gen_random_uuid(),
          next_attempt_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
      where m.id = p_id and m.status = 'pending' and m.next_attempt_at <= now()
      returning m.*;
end $$;
revoke execute on function public.claim_pending_by_id(uuid, int) from public, anon, authenticated;
revoke execute on function public.claim_pending(int, int) from public, anon, authenticated;

-- A worker that ran out of time hands a claim back without consuming the attempt.
create or replace function public.release_pending_claim(p_id uuid, p_claim_token uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.assert_service_role();
  update public.pending_messages set attempts = greatest(attempts - 1, 0), claim_token = null, next_attempt_at = now(), updated_at = now()
    where id = p_id and status = 'pending' and claim_token = p_claim_token;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function public.release_pending_claim(uuid, uuid) from public, anon, authenticated;

drop function if exists public.defer_pending(uuid, text, int);
create or replace function public.defer_pending(p_pending uuid, p_error text, p_max_attempts int default 6, p_claim_token uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_attempts int; v_token uuid; v_status public.pending_status;
begin
  perform public.assert_service_role();
  select attempts, claim_token, status into v_attempts, v_token, v_status from public.pending_messages where id = p_pending for update;
  if v_status <> 'pending' then return; end if;
  -- a deferral must come from the worker that holds the claim (a stale worker changes nothing)
  if p_claim_token is not null and v_token is distinct from p_claim_token then return; end if;
  if v_attempts >= p_max_attempts then
    update public.pending_messages set status = 'review', last_error = left(p_error, 500), claim_token = null,
      user_explanation = 'Our review service is not responding. This message is held for a human review.', updated_at = now()
      where id = p_pending and status = 'pending';
  else
    update public.pending_messages set last_error = left(p_error, 500), claim_token = null,
      next_attempt_at = now() + make_interval(secs => least(5 * power(2, v_attempts), 120)::int), updated_at = now()
      where id = p_pending and status = 'pending';
  end if;
end $$;
revoke execute on function public.defer_pending(uuid, text, int, uuid) from public, anon, authenticated;

drop function if exists public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int);
create or replace function public.apply_moderation_decision(
  p_pending uuid, p_decision text, p_categories text[], p_user_explanation text,
  p_suggested_revision text, p_confidence numeric, p_detector_hits text[],
  p_provider text, p_model text, p_raw_valid boolean, p_latency_ms int,
  p_claim_token uuid default null
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
  -- Ownership of the outcome:
  --   automated result (token given): only while the row is still 'pending' AND
  --   the token is the live claim — an expired/overlapped/cancelled claim is stale;
  --   human decision (no token, provider 'human'): on rows that are pending or held.
  if p_claim_token is not null then
    if v_m.status <> 'pending' or v_m.claim_token is distinct from p_claim_token then
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true, 'reason', 'stale claim');
    end if;
  else
    if p_provider is distinct from 'human' then raise exception 'automated decisions need a claim token' using errcode = 'P0001'; end if;
    if v_m.status not in ('pending', 'review') then return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true); end if;
  end if;

  insert into public.moderation_decisions (pending_message_id, decision, categories, user_explanation, suggested_revision, confidence, detector_hits, provider, model, raw_valid, latency_ms)
    values (p_pending, p_decision, coalesce(p_categories, '{}'), p_user_explanation, p_suggested_revision, p_confidence, coalesce(p_detector_hits, '{}'), p_provider, p_model, p_raw_valid, p_latency_ms);

  if p_decision = 'allow' then
    select * into v_conv from public.conversations where id = v_m.conversation_id for update;
    select p.account_id into v_sender from public.participants p where p.id = v_m.sender_participant_id;
    select p.account_id into v_recipient from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_sender limit 1;
    if v_conv.status = 'ended'
       or (v_conv.kind = 'friend' and (not exists (select 1 from public.connections where id = v_conv.connection_id and status = 'active') or public.is_blocked_either_way(v_sender, v_recipient))) then
      update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = now() where id = p_pending;
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true);
    end if;

    -- approved_messages.pending_message_id is unique: a message can never be delivered twice
    insert into public.approved_messages (conversation_id, sender_participant_id, pending_message_id, kind, question_id, body)
      values (v_m.conversation_id, v_m.sender_participant_id, p_pending, v_m.kind, v_m.question_id, v_m.body);
    update public.pending_messages set status = 'approved', claim_token = null, updated_at = now() where id = p_pending;
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
    update public.pending_messages set status = 'revise', user_explanation = p_user_explanation, suggested_revision = p_suggested_revision, claim_token = null, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then update public.question_answers set status = 'revise', updated_at = now() where pending_message_id = p_pending; end if;
  elsif p_decision = 'block' then
    update public.pending_messages set status = 'blocked', user_explanation = p_user_explanation, claim_token = null, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then update public.question_answers set status = 'blocked', updated_at = now() where pending_message_id = p_pending; end if;
  elsif p_decision = 'review' then
    update public.pending_messages set status = 'review', user_explanation = coalesce(p_user_explanation, 'Held for a human review.'), claim_token = null, updated_at = now() where id = p_pending;
  else
    raise exception 'unknown decision %', p_decision;
  end if;
  return jsonb_build_object('question_due', v_due, 'revealed', v_revealed);
end $$;
revoke execute on function public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Matching: lock + revalidate both rows before creating an invitation
-- ---------------------------------------------------------------------------
create or replace function public.run_matching() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ttl int := (public.cfg('invitation_ttl_seconds', '60'))::int;
  v_grace int := (public.cfg('presence_grace_seconds', '45'))::int;
  v_win record;
  v_waiter record;
  v_partner record;
  v_w public.availability_requests%rowtype;
  v_p public.availability_requests%rowtype;
  v_inv uuid;
  v_pairs int := 0;
begin
  perform public.assert_service_role();
  perform pg_advisory_xact_lock(hashtext('common_ground_matching'));
  select * into v_win from public.session_window(now());
  if v_win.session_start is null then return 0; end if;

  for v_waiter in
    select r.id, r.account_id, r.created_at, r.broaden, r.avoid_account_ids, p.political_answers, p.questionnaire_version
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.paused_at is null and r.expires_at > now()
      and r.session_start = v_win.session_start
      and r.last_seen_at > now() - make_interval(secs => v_grace)
    order by r.created_at
  loop
    if not exists (select 1 from public.availability_requests where id = v_waiter.id and status = 'waiting') then continue; end if;

    select r.id, r.account_id, r.broaden, r.created_at,
           public.difference_score(v_waiter.political_answers, p.political_answers) as score,
           public.shared_answers(v_waiter.political_answers, p.political_answers) as shared
    into v_partner
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.paused_at is null and r.expires_at > now()
      and r.session_start = v_win.session_start
      and r.last_seen_at > now() - make_interval(secs => v_grace)
      and r.account_id <> v_waiter.account_id
      and p.questionnaire_version = v_waiter.questionnaire_version
      and not (r.account_id = any (v_waiter.avoid_account_ids))
      and not (v_waiter.account_id = any (r.avoid_account_ids))
      and not public.is_blocked_either_way(v_waiter.account_id, r.account_id)
      and (
        (v_waiter.broaden = 'any' and r.broaden = 'any')
        or public.difference_score(v_waiter.political_answers, p.political_answers) >= public.pair_threshold(v_waiter.broaden, r.broaden)
      )
    order by r.created_at
    limit 1;

    if v_partner.id is null then continue; end if;

    -- Lock both rows (ordered) and re-check everything that a concurrent
    -- cancellation, pause, expiry, block or preference change could have altered.
    if v_waiter.id < v_partner.id then
      select * into v_w from public.availability_requests where id = v_waiter.id for update;
      select * into v_p from public.availability_requests where id = v_partner.id for update;
    else
      select * into v_p from public.availability_requests where id = v_partner.id for update;
      select * into v_w from public.availability_requests where id = v_waiter.id for update;
    end if;
    if v_w.status <> 'waiting' or v_p.status <> 'waiting'
       or v_w.paused_at is not null or v_p.paused_at is not null
       or v_w.expires_at <= now() or v_p.expires_at <= now()
       or v_w.session_start is distinct from v_win.session_start or v_p.session_start is distinct from v_win.session_start
       or v_w.last_seen_at <= now() - make_interval(secs => v_grace) or v_p.last_seen_at <= now() - make_interval(secs => v_grace)
       or v_p.account_id = any (v_w.avoid_account_ids) or v_w.account_id = any (v_p.avoid_account_ids)
       or public.is_blocked_either_way(v_w.account_id, v_p.account_id)
       or public.has_active_conversation(v_w.account_id) or public.has_active_conversation(v_p.account_id)
       or not ((v_w.broaden = 'any' and v_p.broaden = 'any') or v_partner.score >= public.pair_threshold(v_w.broaden, v_p.broaden)) then
      continue;
    end if;

    insert into public.match_invitations (kind, difference_score, expires_at)
      values ('match', v_partner.score, now() + make_interval(secs => v_ttl)) returning id into v_inv;
    insert into public.invitation_participants (invitation_id, account_id, availability_request_id) values
      (v_inv, v_w.account_id, v_w.id), (v_inv, v_p.account_id, v_p.id);
    update public.availability_requests set status = 'invited', matched_invitation_id = v_inv, invited_at = now()
      where id in (v_w.id, v_p.id) and status = 'waiting';
    insert into public.notifications (account_id, kind, payload) values
      (v_w.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)),
      (v_p.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv));
    insert into public.email_outbox (account_id, template, payload)
      select r.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)
      from public.availability_requests r where r.id in (v_w.id, v_p.id) and r.notify_email;
    perform public.log_metric('invitation_created', v_w.account_id, v_win.session_start, extract(epoch from (now() - v_w.created_at)), jsonb_build_object('score', v_partner.score, 'shared', v_partner.shared));
    perform public.log_metric('invitation_created', v_p.account_id, v_win.session_start, extract(epoch from (now() - v_p.created_at)), jsonb_build_object('score', v_partner.score, 'shared', v_partner.shared));
    v_pairs := v_pairs + 1;
  end loop;
  return v_pairs;
end $$;
revoke execute on function public.run_matching() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Email outbox: atomic claims, leases, retries, cancellation, relevance
-- ---------------------------------------------------------------------------
alter table public.email_outbox drop constraint if exists email_outbox_status_check;
alter table public.email_outbox add constraint email_outbox_status_check
  check (status in ('queued', 'claimed', 'sent', 'failed', 'skipped', 'cancelled'));
alter table public.email_outbox add column if not exists claim_token uuid;
alter table public.email_outbox add column if not exists claimed_until timestamptz;
alter table public.email_outbox add column if not exists next_attempt_at timestamptz not null default now();
create index if not exists email_outbox_due_idx on public.email_outbox (next_attempt_at) where status in ('queued', 'claimed');

-- Why a queued email should no longer go out (null = still relevant).
create or replace function public.email_outbox_obsolete_reason(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when o.template = 'invitation' then
      case
        when not exists (select 1 from public.match_invitations i where i.id = (o.payload->>'invitation_id')::uuid and i.status = 'pending' and i.expires_at > now()) then 'invitation no longer pending'
        when not exists (select 1 from public.availability_requests r where r.matched_invitation_id = (o.payload->>'invitation_id')::uuid and r.account_id = o.account_id and r.notify_email and r.status = 'invited') then 'email notice no longer requested'
        else null end
    when o.template = 'reconnect_invitation' then 'legacy template'
    else null end
  from public.email_outbox o where o.id = p_id
$$;
revoke execute on function public.email_outbox_obsolete_reason(uuid) from public, anon, authenticated;

create or replace function public.claim_email_outbox(p_limit int default 20, p_lease_seconds int default 120)
returns setof public.email_outbox language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  perform public.assert_service_role();
  select array_agg(id) into v_ids from (
    select id from public.email_outbox
      where (status = 'queued' and next_attempt_at <= now()) or (status = 'claimed' and claimed_until < now())
      order by created_at for update skip locked limit p_limit
  ) s;
  if v_ids is null then return; end if;
  update public.email_outbox o set status = 'skipped', last_error = r.reason
    from (select id, public.email_outbox_obsolete_reason(id) as reason from public.email_outbox where id = any (v_ids)) r
    where o.id = r.id and r.reason is not null;
  return query
    update public.email_outbox o set status = 'claimed', claim_token = gen_random_uuid(), claimed_until = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1
      where o.id = any (v_ids) and o.status in ('queued', 'claimed')
      returning o.*;
end $$;
revoke execute on function public.claim_email_outbox(int, int) from public, anon, authenticated;

-- Right before sending: still my claim, still relevant?
create or replace function public.recheck_email_outbox(p_id uuid, p_claim_token uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_reason text;
begin
  perform public.assert_service_role();
  select status into v_status from public.email_outbox where id = p_id and claim_token = p_claim_token for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then return v_status; end if;
  v_reason := public.email_outbox_obsolete_reason(p_id);
  if v_reason is not null then
    update public.email_outbox set status = 'skipped', last_error = v_reason where id = p_id;
    return 'skipped';
  end if;
  return 'claimed';
end $$;
revoke execute on function public.recheck_email_outbox(uuid, uuid) from public, anon, authenticated;

-- 'sent' | 'retry' (backoff 1, 2, 4, 8 min; 'failed' after p_max_attempts) | 'failed' | 'skipped'; only on my claim.
create or replace function public.finish_email_outbox(p_id uuid, p_claim_token uuid, p_outcome text, p_error text default null, p_max_attempts int default 5) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_attempts int;
begin
  perform public.assert_service_role();
  select status, attempts into v_status, v_attempts from public.email_outbox where id = p_id and claim_token = p_claim_token for update;
  if v_status is null then return 'reclaimed'; end if;
  if v_status <> 'claimed' then return v_status; end if;
  if p_outcome = 'sent' then
    update public.email_outbox set status = 'sent', sent_at = now(), last_error = p_error, claim_token = null where id = p_id; return 'sent';
  elsif p_outcome = 'retry' then
    update public.email_outbox set status = case when v_attempts >= p_max_attempts then 'failed' else 'queued' end,
        last_error = left(p_error, 500), claim_token = null,
        next_attempt_at = now() + (interval '1 minute' * power(2, least(v_attempts, 6) - 1))
      where id = p_id returning status into v_status;
    return v_status;
  elsif p_outcome = 'failed' then
    update public.email_outbox set status = 'failed', last_error = left(p_error, 500), claim_token = null where id = p_id; return 'failed';
  else
    update public.email_outbox set status = 'skipped', last_error = left(p_error, 500), claim_token = null where id = p_id; return 'skipped';
  end if;
end $$;
revoke execute on function public.finish_email_outbox(uuid, uuid, text, text, int) from public, anon, authenticated;

-- Declining/expiring an invitation cancels its queued notices.
create or replace function public.cancel_invitation_emails(p_invitation uuid) returns void
language sql security definer set search_path = public as $$
  update public.email_outbox set status = 'cancelled', last_error = 'invitation resolved'
    where template = 'invitation' and (payload->>'invitation_id')::uuid = p_invitation and status in ('queued', 'claimed');
$$;
revoke execute on function public.cancel_invitation_emails(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Internal helpers are not for ordinary users
-- ---------------------------------------------------------------------------
revoke execute on function public.metrics_summary(timestamptz) from public, anon, authenticated;
revoke execute on function public.is_blocked_either_way(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.difference_score(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.shared_answers(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.pair_threshold(text, text) from public, anon, authenticated;
revoke execute on function public.answered_dimensions(jsonb) from public, anon, authenticated;
revoke execute on function public.tier_of(int, int[]) from public, anon, authenticated;
revoke execute on function public.random_alias() from public, anon, authenticated;
revoke execute on function public.take_rate_limit(text, int, int) from public, anon, authenticated;
revoke execute on function public.cfg(text, jsonb) from public, anon, authenticated;
revoke execute on function public.session_open_now() from public, anon, authenticated;
revoke execute on function public.record_consent(text, text, boolean) from public, anon;
grant execute on function public.record_consent(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Indexes and retention
-- ---------------------------------------------------------------------------
create index if not exists question_answers_conversation_idx on public.question_answers (conversation_id);
create index if not exists pending_messages_conversation_idx on public.pending_messages (conversation_id, created_at desc);
create index if not exists push_queue_thread_idx on public.push_queue (conversation_id, account_id) where status in ('queued', 'claimed');
create index if not exists push_queue_due_idx on public.push_queue (next_attempt_at) where status = 'queued';
create index if not exists metric_events_created_idx on public.metric_events (created_at);
create index if not exists availability_requests_ended_idx on public.availability_requests (ended_at) where status not in ('waiting', 'invited');
create index if not exists reminder_sends_created_idx on public.reminder_sends (created_at);

-- Retention (policy_config keys, days): retention_queue_days 90, retention_metrics_days 365,
-- retention_outbox_days 30, retention_reminder_sends_days 30. Live-session vs
-- friend-message rules unchanged.
create or replace function public.purge_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d_msg int := (public.cfg('retention_messages_days', '30'))::int;
  d_pending int := (public.cfg('retention_pending_days', '7'))::int;
  d_reports int := (public.cfg('retention_reports_days', '365'))::int;
  d_queue int := (public.cfg('retention_queue_days', '90'))::int;
  d_metrics int := (public.cfg('retention_metrics_days', '365'))::int;
  d_outbox int := (public.cfg('retention_outbox_days', '30'))::int;
  d_sends int := (public.cfg('retention_reminder_sends_days', '30'))::int;
  n1 int; n2 int; n3 int; n4 int; n5 int; n6 int; n7 int; n8 int; n9 int; n10 int;
begin
  perform public.assert_service_role();
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'live' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
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
  delete from public.push_queue where created_at < now() - interval '7 days' and status not in ('queued', 'claimed');
  -- finished queue entries (never a live one); invitations referencing them are long resolved
  delete from public.availability_requests where status not in ('waiting', 'invited') and coalesce(ended_at, created_at) < now() - make_interval(days => d_queue);
  get diagnostics n7 = row_count;
  -- metrics: aggregate counters only, no content; worker heartbeats after 7 days, the rest after a year
  delete from public.metric_events where (kind = 'worker_tick' and created_at < now() - interval '7 days') or created_at < now() - make_interval(days => d_metrics);
  get diagnostics n8 = row_count;
  delete from public.email_outbox where status not in ('queued', 'claimed') and created_at < now() - make_interval(days => d_outbox);
  get diagnostics n9 = row_count;
  delete from public.reminder_sends where created_at < now() - make_interval(days => d_sends);
  get diagnostics n10 = row_count;
  return jsonb_build_object('messages', n1, 'friend_messages', n6, 'custom_answers', n5, 'pending', n2, 'reports', n3, 'rate_limits', n4,
    'queue_entries', n7, 'metric_events', n8, 'outbox', n9, 'reminder_sends', n10);
end $$;
revoke execute on function public.purge_retention() from public, anon, authenticated;

-- An invitation that stops being pending (declined, expired, accepted) cancels its queued email notices.
create or replace function public.trg_cancel_invitation_emails() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'pending' and old.status = 'pending' then perform public.cancel_invitation_emails(new.id); end if;
  return new;
end $$;
drop trigger if exists cancel_invitation_emails on public.match_invitations;
create trigger cancel_invitation_emails after update of status on public.match_invitations
  for each row execute function public.trg_cancel_invitation_emails();
