-- Fixes from the 2026-10-20 third review.

-- 1. Push endpoints: only known push services over https. The same rule is
--    enforced in the API and right before sending; this is the database floor.
create or replace function public.is_allowed_push_endpoint(p_endpoint text) returns boolean
language sql immutable as $$
  select p_endpoint ~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)(:443)?/[^ ]*$'
     and p_endpoint !~ '@'
$$;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_endpoint_allowed;
-- existing rows that fail the rule are disabled rather than deleted (none expected in production)
update public.push_subscriptions set disabled_at = now() where not public.is_allowed_push_endpoint(endpoint);

create or replace function public.upsert_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_id uuid;
begin
  if not public.is_allowed_push_endpoint(p_endpoint) then
    raise exception 'unsupported push service' using errcode = 'P0001';
  end if;
  insert into public.push_subscriptions (account_id, endpoint, p256dh, auth, user_agent)
    values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
    on conflict (endpoint) do update set account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, last_seen_at = now(), disabled_at = null, failures = 0
    returning id into v_id;
  perform public.log_metric('reminder_optin', v_uid, null, null, jsonb_build_object('channel', 'push'));
  return v_id;
end $$;

-- 2. One active conversation per person, across matching and Friends, under
--    concurrent acceptances. Both accounts are locked (advisory, ordered) and
--    rechecked right before the conversation row is created.
create or replace function public.has_active_conversation(p_account uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.participants p join public.conversations c on c.id = p.conversation_id
    where p.account_id = p_account and p.left_at is null and c.status <> 'ended'
  )
$$;

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
begin
  select * into v_inv from public.match_invitations where id = p_invitation for update;
  if v_inv.conversation_id is not null then return v_inv.conversation_id; end if;

  -- serialize per account so two invitations accepted at once cannot both open
  select array_agg(account_id order by account_id) into v_accounts from public.invitation_participants where invitation_id = p_invitation;
  foreach v_a in array v_accounts loop
    perform pg_advisory_xact_lock(hashtext('cg_account_' || v_a::text));
  end loop;
  foreach v_a in array v_accounts loop
    if public.has_active_conversation(v_a) then
      update public.match_invitations set status = 'declined', resolved_at = now() where id = p_invitation;
      perform public.requeue_after_invitation(p_invitation, null);
      raise exception 'already in a conversation' using errcode = 'P0001';
    end if;
  end loop;

  insert into public.conversations (invitation_id, connection_id, opening_question_count, question_gap_seconds)
    values (p_invitation, v_inv.connection_id, v_count, v_gap) returning id into v_conv;
  if v_inv.connection_id is not null then
    select * into v_conn from public.connections where id = v_inv.connection_id;
  end if;
  for v_p in select account_id from public.invitation_participants where invitation_id = p_invitation loop
    insert into public.participants (conversation_id, account_id) values (v_conv, v_p.account_id) returning id into v_pid;
    if v_conn.id is not null then
      v_alias := case when v_p.account_id = v_conn.account_a then v_conn.alias_a else v_conn.alias_b end;
    else
      v_alias := public.random_alias();
    end if;
    insert into public.participant_aliases (participant_id, conversation_id, alias) values (v_pid, v_conv, v_alias);
    insert into public.notifications (account_id, kind, payload) values (v_p.account_id, 'conversation_opened', jsonb_build_object('conversation_id', v_conv));
  end loop;
  update public.match_invitations set status = 'accepted', conversation_id = v_conv, resolved_at = now() where id = p_invitation;
  update public.availability_requests set status = 'matched', ended_at = now() where matched_invitation_id = p_invitation;
  -- any other pending invitation involving these two people is now moot
  update public.match_invitations i set status = 'declined', resolved_at = now()
    where i.status = 'pending' and i.id <> p_invitation
      and exists (select 1 from public.invitation_participants ip where ip.invitation_id = i.id and ip.account_id = any (v_accounts));
  return v_conv;
end $$;

-- request_reconnection: the sender must be free too.
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
  if public.has_active_conversation(v_uid) then raise exception 'You are already in a conversation' using errcode = 'P0001'; end if;
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

-- respond_invitation: refuse to open if either side is already talking; the
-- 'conversation_opened' metric is logged for BOTH participants.
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
  v_session timestamptz;
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
    select account_id into v_other from public.invitation_participants where invitation_id = p_invitation and account_id <> v_uid limit 1;
    if public.is_blocked_either_way(v_uid, v_other)
       or not exists (select 1 from public.accounts where id = v_other and onboarding_complete)
       or not exists (select 1 from public.accounts where id = v_uid and onboarding_complete)
       or public.has_active_conversation(v_uid) or public.has_active_conversation(v_other) then
      update public.match_invitations set status = 'declined', resolved_at = now() where id = p_invitation;
      perform public.requeue_after_invitation(p_invitation, null);
      return jsonb_build_object('status', 'declined');
    end if;
    begin
      v_conv := public.open_conversation_for_invitation(p_invitation);
    exception when sqlstate 'P0001' then
      return jsonb_build_object('status', 'declined');
    end;
    select session_start into v_session from public.availability_requests where matched_invitation_id = p_invitation limit 1;
    perform public.log_metric('conversation_opened', v_uid, v_session, extract(epoch from (now() - v_inv.created_at)));
    perform public.log_metric('conversation_opened', v_other, v_session, extract(epoch from (now() - v_inv.created_at)));
    return jsonb_build_object('status', 'opened', 'conversation_id', v_conv);
  end if;
  return jsonb_build_object('status', 'waiting_for_other');
end $$;

revoke execute on function public.open_conversation_for_invitation(uuid) from public, anon, authenticated;
revoke execute on function public.has_active_conversation(uuid) from public, anon, authenticated;
