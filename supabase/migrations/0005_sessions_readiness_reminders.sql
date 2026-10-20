-- Daily shared session, readiness-based matching, consented broadening,
-- reminders (push/email), operational metrics, and a database-driven scheduler.

-- ---------------------------------------------------------------------------
-- Session schedule (anchored to a wall-clock time in a timezone)
-- ---------------------------------------------------------------------------

insert into public.policy_config (key, value) values
  ('session_days',             '[0,1,2,3,4,5,6]'),
  ('session_start_time',       '"18:00"'),
  ('session_duration_minutes', '60'),
  ('session_timezone',         '"America/Los_Angeles"'),
  ('presence_grace_seconds',   '45'),
  ('broaden_relaxed_after_seconds', '60'),
  ('broaden_any_after_seconds',     '120'),
  ('relaxed_difference_score', '0.5')
on conflict (key) do nothing;

update public.policy_config set value = '60' where key = 'invitation_ttl_seconds';

-- Start/end of the session whose window contains p_at, else null.
-- Uses the tz database so DST is handled; checks today and yesterday in tz.
create or replace function public.session_window(p_at timestamptz)
returns table (session_start timestamptz, session_end timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := trim(both '"' from (public.cfg('session_timezone', '"America/Los_Angeles"'))::text);
  v_time time := (trim(both '"' from (public.cfg('session_start_time', '"18:00"'))::text))::time;
  v_dur int := (public.cfg('session_duration_minutes', '60'))::int;
  v_days jsonb := public.cfg('session_days', '[0,1,2,3,4,5,6]');
  v_local_date date;
  v_d date;
  v_start timestamptz;
  v_end timestamptz;
begin
  v_local_date := (p_at at time zone v_tz)::date;
  for i in 0..1 loop
    v_d := v_local_date - i;
    if v_days @> to_jsonb(extract(dow from v_d)::int) then
      v_start := (v_d + v_time) at time zone v_tz;
      v_end := v_start + make_interval(mins => v_dur);
      if p_at >= v_start and p_at < v_end then
        session_start := v_start; session_end := v_end;
        return next;
        return;
      end if;
    end if;
  end loop;
  return;
end $$;

create or replace function public.session_open_now() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.session_window(now()))
$$;

-- ---------------------------------------------------------------------------
-- Queue: presence, pauses, broadening, session membership
-- ---------------------------------------------------------------------------

alter table public.availability_requests
  add column if not exists session_start timestamptz,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists paused_at timestamptz,
  add column if not exists paused_reason text check (paused_reason in ('stale', 'no_response')),
  add column if not exists broaden text not null default 'strict' check (broaden in ('strict', 'relaxed', 'any')),
  add column if not exists avoid_account_ids uuid[] not null default '{}',
  add column if not exists invited_at timestamptz;

create index if not exists availability_live_idx on public.availability_requests (status, paused_at, last_seen_at) where status in ('waiting', 'invited');

-- Operational events (no conversation text, no political answers).
create table if not exists public.metric_events (
  id bigserial primary key,
  kind text not null,
  account_id uuid references public.accounts(id) on delete set null,
  session_start timestamptz,
  value numeric,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists metric_events_kind_idx on public.metric_events (kind, created_at);
alter table public.metric_events enable row level security;
create policy metrics_admin on public.metric_events for select to authenticated using (public.is_admin());

create or replace function public.log_metric(p_kind text, p_account uuid, p_session timestamptz, p_value numeric, p_meta jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.metric_events (kind, account_id, session_start, value, meta) values (p_kind, p_account, p_session, p_value, coalesce(p_meta, '{}'::jsonb))
$$;
revoke execute on function public.log_metric(text, uuid, timestamptz, numeric, jsonb) from public, anon, authenticated;

-- join_queue: only while a session is open; the entry lives until the session
-- ends. Re-joining an existing entry (e.g. after a pause) keeps its priority.
create or replace function public.join_queue(p_notify_email boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_id uuid;
  v_min_dims int := (public.cfg('min_answered_dimensions', '3'))::int;
  v_existing public.availability_requests%rowtype;
  v_win record;
begin
  select * into v_win from public.session_window(now());
  if v_win.session_start is null then
    raise exception 'The session is not open right now' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.accounts where id = v_uid and onboarding_complete) then
    raise exception 'onboarding incomplete' using errcode = 'P0001';
  end if;
  if (select public.answered_dimensions(political_answers) from public.profiles where account_id = v_uid) < v_min_dims then
    raise exception 'answer at least % matching questions', v_min_dims using errcode = 'P0001';
  end if;
  if exists (select 1 from public.participants p join public.conversations c on c.id = p.conversation_id
             where p.account_id = v_uid and c.status <> 'ended' and p.left_at is null) then
    raise exception 'already in a conversation' using errcode = 'P0001';
  end if;

  select * into v_existing from public.availability_requests
    where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_existing.id is not null then
    -- same session: resume (explicit join counts as readiness); different session: close it
    if v_existing.session_start = v_win.session_start then
      update public.availability_requests set last_seen_at = now(), paused_at = null, paused_reason = null where id = v_existing.id;
      return v_existing.id;
    end if;
    update public.availability_requests set status = 'expired', ended_at = now() where id = v_existing.id;
  end if;

  if not public.take_rate_limit('join_queue', 20, 3600) then
    raise exception 'rate limited' using errcode = 'P0002';
  end if;

  insert into public.availability_requests (account_id, notify_email, expires_at, session_start, last_seen_at)
    values (v_uid, p_notify_email, v_win.session_end, v_win.session_start, now())
    returning id into v_id;
  perform public.log_metric('queue_join', v_uid, v_win.session_start, null);
  if p_notify_email then
    insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'waiting_email', 'v1', true);
  end if;
  return v_id;
end $$;

create or replace function public.leave_queue() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_r public.availability_requests%rowtype;
begin
  select * into v_r from public.availability_requests where account_id = v_uid and status = 'waiting' for update;
  if v_r.id is null then return; end if;
  update public.availability_requests set status = 'cancelled', ended_at = now() where id = v_r.id;
  perform public.log_metric('unmatched_leave', v_uid, v_r.session_start, extract(epoch from (now() - v_r.created_at)));
end $$;

-- Presence: called by the lobby every few seconds. Resumes a 'stale' pause
-- (a brief disconnect) but not a 'no_response' pause, which needs confirm_ready().
create or replace function public.lobby_heartbeat() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_r public.availability_requests%rowtype;
begin
  update public.availability_requests
    set last_seen_at = now(),
        paused_at = case when paused_reason = 'stale' then null else paused_at end,
        paused_reason = case when paused_reason = 'stale' then null else paused_reason end
    where account_id = v_uid and status in ('waiting', 'invited')
    returning * into v_r;
  return jsonb_build_object('now', now(), 'request', case when v_r.id is null then null else jsonb_build_object(
    'id', v_r.id, 'status', v_r.status, 'paused_reason', v_r.paused_reason, 'broaden', v_r.broaden,
    'created_at', v_r.created_at, 'session_start', v_r.session_start, 'expires_at', v_r.expires_at) end);
end $$;

-- After a missed invitation the person must say they are ready again.
create or replace function public.confirm_ready() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  update public.availability_requests set paused_at = null, paused_reason = null, last_seen_at = now()
    where account_id = v_uid and status = 'waiting';
end $$;

-- Consented broadening, allowed only after the configured waiting times.
-- Reversible (any level can be set back to 'strict').
create or replace function public.set_broaden(p_level text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_r public.availability_requests%rowtype;
  v_relaxed_after int := (public.cfg('broaden_relaxed_after_seconds', '60'))::int;
  v_any_after int := (public.cfg('broaden_any_after_seconds', '120'))::int;
  v_waited numeric;
begin
  if p_level not in ('strict', 'relaxed', 'any') then raise exception 'bad level' using errcode = 'P0001'; end if;
  select * into v_r from public.availability_requests where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_r.id is null then raise exception 'not waiting' using errcode = 'P0001'; end if;
  v_waited := extract(epoch from (now() - v_r.created_at));
  if p_level = 'relaxed' and v_waited < v_relaxed_after then raise exception 'not yet available' using errcode = 'P0001'; end if;
  if p_level = 'any' and v_waited < v_any_after then raise exception 'not yet available' using errcode = 'P0001'; end if;
  update public.availability_requests set broaden = p_level where id = v_r.id;
  perform public.log_metric('broaden_selected', v_uid, v_r.session_start, v_waited, jsonb_build_object('level', p_level));
end $$;

-- Threshold a pair must clear given both preferences (the stricter wins).
create or replace function public.pair_threshold(a text, b text) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when a = 'strict' or b = 'strict' then (public.cfg('min_difference_score', '1.0'))::numeric
    when a = 'relaxed' or b = 'relaxed' then (public.cfg('relaxed_difference_score', '0.5'))::numeric
    else 0 end
$$;

-- Matching: session must be open; both people present (recent heartbeat, not
-- paused); oldest waiter first; partner = oldest eligible candidate (waiting
-- time over ideological distance); both preferences respected; blocks and
-- avoid lists honoured. Serialized with an advisory lock.
create or replace function public.run_matching() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ttl int := (public.cfg('invitation_ttl_seconds', '60'))::int;
  v_grace int := (public.cfg('presence_grace_seconds', '45'))::int;
  v_win record;
  v_waiter record;
  v_partner record;
  v_inv uuid;
  v_pairs int := 0;
  v_score numeric;
begin
  perform public.assert_service_role();
  perform pg_advisory_xact_lock(hashtext('common_ground_matching'));
  select * into v_win from public.session_window(now());
  if v_win.session_start is null then return 0; end if;

  for v_waiter in
    select r.id, r.account_id, r.created_at, r.broaden, r.avoid_account_ids, p.political_answers
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.paused_at is null and r.expires_at > now()
      and r.session_start = v_win.session_start
      and r.last_seen_at > now() - make_interval(secs => v_grace)
    order by r.created_at
  loop
    if not exists (select 1 from public.availability_requests where id = v_waiter.id and status = 'waiting') then continue; end if;

    select r.id, r.account_id, r.broaden, public.difference_score(v_waiter.political_answers, p.political_answers) as score
    into v_partner
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.paused_at is null and r.expires_at > now()
      and r.session_start = v_win.session_start
      and r.last_seen_at > now() - make_interval(secs => v_grace)
      and r.account_id <> v_waiter.account_id
      and not (r.account_id = any (v_waiter.avoid_account_ids))
      and not (v_waiter.account_id = any (r.avoid_account_ids))
      and not public.is_blocked_either_way(v_waiter.account_id, r.account_id)
      and (
        public.pair_threshold(v_waiter.broaden, r.broaden) = 0
        or coalesce(public.difference_score(v_waiter.political_answers, p.political_answers), -1) >= public.pair_threshold(v_waiter.broaden, r.broaden)
      )
    order by r.created_at
    limit 1;

    if v_partner.id is null then continue; end if;
    v_score := v_partner.score;

    insert into public.match_invitations (kind, difference_score, expires_at)
      values ('match', v_score, now() + make_interval(secs => v_ttl))
      returning id into v_inv;
    insert into public.invitation_participants (invitation_id, account_id, availability_request_id) values
      (v_inv, v_waiter.account_id, v_waiter.id),
      (v_inv, v_partner.account_id, v_partner.id);
    update public.availability_requests set status = 'invited', matched_invitation_id = v_inv, invited_at = now()
      where id in (v_waiter.id, v_partner.id);
    insert into public.notifications (account_id, kind, payload) values
      (v_waiter.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)),
      (v_partner.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv));
    perform public.log_metric('invitation_created', v_waiter.account_id, v_win.session_start, extract(epoch from (now() - v_waiter.created_at)), jsonb_build_object('score', v_score));
    perform public.log_metric('invitation_created', v_partner.account_id, v_win.session_start, extract(epoch from (now() - (select created_at from public.availability_requests where id = v_partner.id))), jsonb_build_object('score', v_score));
    v_pairs := v_pairs + 1;
  end loop;
  return v_pairs;
end $$;

-- Requeue after a decline/expiry. The decliner is cancelled. A nonresponder
-- (no decision) is paused until they confirm readiness; the responsive person
-- returns to waiting with their original priority and avoids the nonresponder.
-- Nothing is requeued once the session has closed.
create or replace function public.requeue_after_invitation(p_invitation uuid, p_decliner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_open boolean := public.session_open_now();
  v_p record;
  v_nonresponders uuid[] := '{}';
begin
  select coalesce(array_agg(account_id), '{}') into v_nonresponders
    from public.invitation_participants where invitation_id = p_invitation and decision is null and (p_decliner is null or account_id <> p_decliner);

  for v_p in select ip.account_id, ip.decision, r.id as request_id, r.session_start
             from public.invitation_participants ip
             left join public.availability_requests r on r.matched_invitation_id = p_invitation and r.account_id = ip.account_id
             where ip.invitation_id = p_invitation
  loop
    if v_p.request_id is null then continue; end if;
    if v_p.account_id = p_decliner then
      update public.availability_requests set status = 'cancelled', ended_at = now(), matched_invitation_id = null where id = v_p.request_id;
      perform public.log_metric('invitation_declined', v_p.account_id, v_p.session_start, null);
    elsif not v_open or exists (select 1 from public.availability_requests where id = v_p.request_id and expires_at <= now()) then
      update public.availability_requests set status = 'expired', ended_at = now(), matched_invitation_id = null where id = v_p.request_id;
    elsif v_p.decision is null and p_decliner is null then
      -- missed the invitation: pause until they confirm they are ready
      update public.availability_requests set status = 'waiting', matched_invitation_id = null, invited_at = null,
        paused_at = now(), paused_reason = 'no_response' where id = v_p.request_id;
      perform public.log_metric('invitation_missed', v_p.account_id, v_p.session_start, null);
    else
      -- responsive (or the one declined on): back to waiting, same created_at, avoid the nonresponders
      update public.availability_requests set status = 'waiting', matched_invitation_id = null, invited_at = null,
        avoid_account_ids = (select array(select distinct x from unnest(avoid_account_ids || v_nonresponders) x where x <> v_p.account_id))
        where id = v_p.request_id;
    end if;
  end loop;
end $$;

-- respond_invitation: 60-second two-party acceptance; eligibility and blocks
-- are revalidated before a conversation is opened.
create or replace function public.respond_invitation(p_invitation uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_inv public.match_invitations%rowtype;
  v_mine public.invitation_participants%rowtype;
  v_total int;
  v_accepted int;
  v_conv uuid;
  v_other uuid;
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

  select count(*), count(*) filter (where decision = 'accepted') into v_total, v_accepted
    from public.invitation_participants where invitation_id = p_invitation;
  if v_total >= 2 and v_accepted = v_total then
    -- revalidate: blocks and account eligibility may have changed since the pairing
    select account_id into v_other from public.invitation_participants where invitation_id = p_invitation and account_id <> v_uid limit 1;
    if public.is_blocked_either_way(v_uid, v_other)
       or not exists (select 1 from public.accounts where id = v_other and onboarding_complete)
       or not exists (select 1 from public.accounts where id = v_uid and onboarding_complete) then
      update public.match_invitations set status = 'declined', resolved_at = now() where id = p_invitation;
      perform public.requeue_after_invitation(p_invitation, null);
      return jsonb_build_object('status', 'declined');
    end if;
    v_conv := public.open_conversation_for_invitation(p_invitation);
    perform public.log_metric('conversation_opened', v_uid, (select session_start from public.availability_requests where matched_invitation_id = p_invitation limit 1),
      extract(epoch from (now() - v_inv.created_at)));
    return jsonb_build_object('status', 'opened', 'conversation_id', v_conv);
  end if;
  return jsonb_build_object('status', 'waiting_for_other');
end $$;

-- Friends reconnection: only during an open session, 60-second acceptance,
-- the sender's request is their explicit readiness.
create or replace function public.request_reconnection(p_connection uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_c public.connections%rowtype;
  v_inv uuid;
  v_ttl int := (public.cfg('invitation_ttl_seconds', '60'))::int;
  v_peer uuid;
begin
  if not (public.cfg('friendship_enabled', 'true'))::boolean then raise exception 'reconnection is not enabled' using errcode = 'P0001'; end if;
  if not public.session_open_now() then raise exception 'The session is not open right now' using errcode = 'P0001'; end if;
  select * into v_c from public.connections where id = p_connection and status = 'active' and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  if not public.take_rate_limit('reconnect', 10, 86400) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  select id into v_inv from public.match_invitations where connection_id = p_connection and status = 'pending' and expires_at > now();
  if v_inv is not null then return v_inv; end if;
  if exists (select 1 from public.conversations where connection_id = p_connection and status <> 'ended') then
    raise exception 'a conversation is already open' using errcode = 'P0001';
  end if;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  if public.is_blocked_either_way(v_uid, v_peer) then raise exception 'connection not found' using errcode = '42501'; end if;
  insert into public.match_invitations (kind, connection_id, expires_at) values ('reconnect', p_connection, now() + make_interval(secs => v_ttl))
    returning id into v_inv;
  insert into public.invitation_participants (invitation_id, account_id, decision, decided_at) values
    (v_inv, v_uid, 'accepted', now()), (v_inv, v_peer, null, null);
  insert into public.notifications (account_id, kind, payload) values (v_peer, 'reconnect_invitation', jsonb_build_object('invitation_id', v_inv));
  return v_inv;
end $$;

-- Housekeeping: invitation expiry (with nonresponder handling), presence
-- pauses, session close, partner-away, abandonment.
create or replace function public.expire_stale() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv record;
  v_grace int := (public.cfg('presence_grace_seconds', '45'))::int;
  v_away int := (public.cfg('partner_away_after_seconds', '120'))::int;
  v_abandon int := (public.cfg('abandon_after_seconds', '600'))::int;
  v_conv record;
  v_win record;
  n_inv int := 0; n_closed int := 0; n_stale int := 0; n_away int := 0; n_abandoned int := 0; n_q int := 0;
begin
  perform public.assert_service_role();
  select * into v_win from public.session_window(now());

  for v_inv in select id from public.match_invitations where status = 'pending' and expires_at < now() for update skip locked loop
    update public.match_invitations set status = 'expired', resolved_at = now() where id = v_inv.id;
    perform public.requeue_after_invitation(v_inv.id, null);
    n_inv := n_inv + 1;
  end loop;

  -- queue entries whose session has ended (or the legacy 30-minute entries) close
  update public.availability_requests set status = 'expired', ended_at = now()
    where status = 'waiting' and (expires_at < now() or session_start is null or session_start is distinct from v_win.session_start);
  get diagnostics n_closed = row_count;

  -- brief disconnects: pause, resume automatically on the next heartbeat
  update public.availability_requests set paused_at = now(), paused_reason = 'stale'
    where status = 'waiting' and paused_at is null and last_seen_at < now() - make_interval(secs => v_grace);
  get diagnostics n_stale = row_count;

  for v_conv in
    select c.id, p.account_id as away_account
    from public.conversations c join public.participants p on p.conversation_id = c.id
    where c.status <> 'ended' and c.partner_away_notified_at is null and p.left_at is null
      and p.last_seen_at < now() - make_interval(secs => v_away)
  loop
    update public.conversations set partner_away_notified_at = now() where id = v_conv.id;
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'partner_away', jsonb_build_object('conversation_id', v_conv.id)
      from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_conv.away_account;
    n_away := n_away + 1;
  end loop;

  for v_conv in
    select distinct c.id from public.conversations c join public.participants p on p.conversation_id = c.id
    where c.status <> 'ended' and p.left_at is null and p.last_seen_at < now() - make_interval(secs => v_abandon)
  loop
    perform public.end_conversation(v_conv.id, 'abandoned');
    n_abandoned := n_abandoned + 1;
  end loop;

  update public.conversation_questions set status = 'closed'
    where status = 'open' and phase = 'mid' and created_at < now() - interval '10 minutes';
  get diagnostics n_q = row_count;

  return jsonb_build_object('invitations_expired', n_inv, 'queue_closed', n_closed, 'paused_stale', n_stale,
    'partner_away', n_away, 'abandoned', n_abandoned, 'questions_closed', n_q,
    'session_open', v_win.session_start is not null);
end $$;

-- ---------------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  failures int not null default 0
);
create index if not exists push_subscriptions_account_idx on public.push_subscriptions (account_id);
alter table public.push_subscriptions enable row level security;
-- clients read only their own subscriptions (to show "this device"); writes go through RPCs
create policy push_self on public.push_subscriptions for select to authenticated using (account_id = auth.uid());

create table if not exists public.reminder_prefs (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  push_enabled boolean not null default false,
  email_enabled boolean not null default false,
  mode text not null default 'daily' check (mode in ('next', 'weekdays', 'daily')),
  days int[] not null default '{0,1,2,3,4,5,6}',
  next_session_start timestamptz,
  minutes_before int not null default 10 check (minutes_before between 1 and 120),
  timezone text,
  updated_at timestamptz not null default now()
);
alter table public.reminder_prefs enable row level security;
create policy reminder_prefs_self on public.reminder_prefs for all to authenticated using (account_id = auth.uid()) with check (account_id = auth.uid());

-- One row per (account, session, channel, target) makes sends idempotent across overlapping workers.
create table if not exists public.reminder_sends (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  session_start timestamptz not null,
  channel text not null check (channel in ('push', 'email')),
  target text not null,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (account_id, session_start, channel, target)
);
alter table public.reminder_sends enable row level security;

-- Upsert a device subscription. An endpoint belongs to exactly one account:
-- re-subscribing from another account on a shared device re-points it.
create or replace function public.upsert_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_id uuid;
begin
  insert into public.push_subscriptions (account_id, endpoint, p256dh, auth, user_agent)
    values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
    on conflict (endpoint) do update set account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, last_seen_at = now(), disabled_at = null, failures = 0
    returning id into v_id;
  perform public.log_metric('reminder_optin', v_uid, null, null, jsonb_build_object('channel', 'push'));
  return v_id;
end $$;

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and account_id = auth.uid()
$$;

-- Profile timezone override (null = use the device timezone).
alter table public.profiles add column if not exists timezone_override text;

-- ---------------------------------------------------------------------------
-- Metrics summary for the review console
-- ---------------------------------------------------------------------------

create or replace function public.metrics_summary(p_since timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with e as (select * from public.metric_events where created_at >= p_since),
  joins as (select count(*) n, count(distinct session_start) sessions from e where kind = 'queue_join'),
  inv as (select count(*) n, percentile_cont(0.5) within group (order by value) p50, percentile_cont(0.9) within group (order by value) p90 from e where kind = 'invitation_created'),
  opened as (select count(*) n, percentile_cont(0.5) within group (order by value) p50 from e where kind = 'conversation_opened'),
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
    'conversations_opened', (select n from opened), 'time_to_both_accept_p50_s', (select p50 from opened),
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
revoke execute on function public.metrics_summary(timestamptz) from public, anon;
-- admins only (is_admin is checked in the app route as well)
create or replace function public.admin_metrics(p_since timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return public.metrics_summary(p_since);
end $$;

-- ---------------------------------------------------------------------------
-- Database-driven scheduler (pg_cron + pg_net): calls the worker every minute
-- so reminders and housekeeping run with nobody online. The URL and secret
-- live in worker_config (service role only) and are set per environment.
-- ---------------------------------------------------------------------------

create table if not exists public.worker_config (key text primary key, value text not null);
alter table public.worker_config enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_worker_tick() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select value into v_url from public.worker_config where key = 'tick_url';
  select value into v_secret from public.worker_config where key = 'cron_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'), body := '{}'::jsonb, timeout_milliseconds := 50000);
end $$;
revoke execute on function public.call_worker_tick() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('common-ground-tick');
exception when others then null;
end $$;
select cron.schedule('common-ground-tick', '* * * * *', 'select public.call_worker_tick()');

-- grants for worker RPCs
revoke execute on function public.session_window(timestamptz) from public, anon;
grant execute on function public.session_window(timestamptz) to authenticated;
revoke execute on function public.run_matching() from public, anon, authenticated;
revoke execute on function public.expire_stale() from public, anon, authenticated;
revoke execute on function public.requeue_after_invitation(uuid, uuid) from public, anon, authenticated;
