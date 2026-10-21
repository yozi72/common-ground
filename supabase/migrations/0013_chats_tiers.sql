-- Chats with two tiers.
--   'chat'   both people chose to keep talking after a live conversation: the
--            persistent, screened, alias-only chat that used to be called a friendship.
--   'friend' both people explicitly chose "Become friends": contact details may be
--            shared in that chat (identity screening off, abuse screening on).
-- The "keep talking" decision stays private (set_connection_decision). "Become
-- friends" is a visible request: one person asks, the other accepts or declines;
-- a pair can be asked at most once per 7 days. Restoring a removed connection
-- resets it to 'chat' (fresh consent for contact sharing too).
-- Continuing and friend chats keep their history until someone clears it or the
-- chat ends (then the 30-day rule applies). Ended live conversations are listed
-- for 30 days so the reflection and the keep-talking decision can be reached.

alter table public.connections add column if not exists tier text not null default 'chat' check (tier in ('chat', 'friend'));
alter table public.connections add column if not exists friend_requested_by uuid references public.accounts(id) on delete set null;
alter table public.connections add column if not exists friend_requested_at timestamptz;
alter table public.connections add column if not exists friends_since timestamptz;

update public.policy_config set value = 'true'::jsonb where key = 'contact_sharing_enabled';
insert into public.policy_config (key, value) values ('friend_request_cooldown_days', '7') on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Become friends: request / respond
-- ---------------------------------------------------------------------------
create or replace function public.request_friend(p_connection uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_peer uuid;
  v_cool int := (public.cfg('friend_request_cooldown_days', '7'))::int;
begin
  if not (public.cfg('contact_sharing_enabled', 'false'))::boolean then raise exception 'contact sharing is not enabled' using errcode = 'P0001'; end if;
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  perform public.lock_accounts(v_c.account_a, v_c.account_b);
  select * into v_c from public.connections where id = p_connection for update;
  if v_c.status <> 'active' then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  if public.is_blocked_either_way(v_uid, v_peer) then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
  if v_c.tier = 'friend' then return 'friends'; end if;
  if v_c.friend_requested_by = v_uid then return 'pending'; end if;
  if v_c.friend_requested_by is not null then raise exception 'they already asked you; answer their request instead' using errcode = 'P0001'; end if;
  -- one request per pair per cooldown period (a declined request can't be repeated at once)
  if v_c.friend_requested_at is not null and v_c.friend_requested_at > now() - make_interval(days => v_cool) then
    raise exception 'a request was made recently; try again later' using errcode = 'P0002';
  end if;
  update public.connections set friend_requested_by = v_uid, friend_requested_at = now() where id = p_connection;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing', 'v1', true);
  insert into public.notifications (account_id, kind, payload) values (v_peer, 'friend_request', jsonb_build_object('connection_id', p_connection));
  return 'pending';
end $$;

create or replace function public.respond_friend_request(p_connection uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_peer uuid;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  perform public.lock_accounts(v_c.account_a, v_c.account_b);
  select * into v_c from public.connections where id = p_connection for update;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  if v_c.friend_requested_by is null or v_c.friend_requested_by <> v_peer then raise exception 'no request to answer' using errcode = 'P0001'; end if;
  if v_c.status <> 'active' or public.is_blocked_either_way(v_uid, v_peer) then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing', 'v1', p_accept);
  if p_accept then
    update public.connections set tier = 'friend', friends_since = now(), friend_requested_by = null where id = p_connection;
    insert into public.notifications (account_id, kind, payload) values
      (v_peer, 'friends', jsonb_build_object('connection_id', p_connection)),
      (v_uid, 'friends', jsonb_build_object('connection_id', p_connection));
    return 'friends';
  end if;
  -- "Not now": the asker is not told; the cooldown (friend_requested_at) stays
  update public.connections set friend_requested_by = null where id = p_connection;
  return 'declined';
end $$;

-- ---------------------------------------------------------------------------
-- Restoring a connection resets it to the chat tier
-- ---------------------------------------------------------------------------
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
    on conflict (account_a, account_b) do update
      set status = 'active', ended_at = null,
          -- a restored connection starts over at the chat tier: contact sharing needs fresh consent
          tier = 'chat', friend_requested_by = null, friend_requested_at = null, friends_since = null
    returning id into v_conn;
  update public.conversations set status = 'chatting', ended_at = null, end_reason = null
    where connection_id = v_conn and kind = 'friend' and status = 'ended' and end_reason = 'unfriended';
  insert into public.notifications (account_id, kind, payload) values
    (v_a, 'connected', jsonb_build_object('connection_id', v_conn)),
    (v_b, 'connected', jsonb_build_object('connection_id', v_conn));
  return jsonb_build_object('status', 'connected', 'connection_id', v_conn);
end $$;

-- ---------------------------------------------------------------------------
-- Overview with tier and request state (no account ids)
-- ---------------------------------------------------------------------------
drop function if exists public.friend_unread_total();
drop function if exists public.friend_threads_overview();
create or replace function public.friend_threads_overview()
returns table (connection_id uuid, conversation_id uuid, peer_alias text, my_alias text, since timestamptz, status text, unread int, last_message_at timestamptz, muted boolean,
               tier text, request_from_me boolean, request_for_me boolean, request_available boolean, friends_since timestamptz)
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
         coalesce((select tr.muted from public.thread_reads tr where tr.conversation_id = cv.id and tr.account_id = auth.uid()), false),
         c.tier,
         coalesce(c.friend_requested_by = auth.uid(), false),
         coalesce(c.friend_requested_by is not null and c.friend_requested_by <> auth.uid(), false),
         c.status = 'active' and c.tier = 'chat' and c.friend_requested_by is null
           and (c.friend_requested_at is null or c.friend_requested_at <= now() - make_interval(days => (public.cfg('friend_request_cooldown_days', '7'))::int))
           and (public.cfg('contact_sharing_enabled', 'false'))::boolean,
         c.friends_since
  from public.connections c
  left join public.conversations cv on cv.connection_id = c.id and cv.kind = 'friend'
  where c.account_a = auth.uid() or c.account_b = auth.uid()
  order by coalesce(cv.last_message_at, c.created_at) desc
$$;
create or replace function public.friend_unread_total() returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(unread), 0)::int from public.friend_threads_overview()
$$;

-- One thread's state for the chat screen.
create or replace function public.thread_state(p_conversation uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('tier', o.tier, 'request_from_me', o.request_from_me, 'request_for_me', o.request_for_me,
                                             'request_available', o.request_available, 'status', o.status, 'connection_id', o.connection_id)
                   from public.friend_threads_overview() o where o.conversation_id = p_conversation), '{}'::jsonb)
$$;

-- Whether contact details may be shared in a thread (worker-side check as well).
create or replace function public.thread_contact_allowed(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations cv join public.connections c on c.id = cv.connection_id
    where cv.id = p_conversation and cv.kind = 'friend' and cv.status <> 'ended' and c.status = 'active' and c.tier = 'friend'
      and not public.is_blocked_either_way(c.account_a, c.account_b)
  )
$$;
revoke execute on function public.thread_contact_allowed(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recent live conversations: reach the reflection and the keep-talking decision later
-- ---------------------------------------------------------------------------
create or replace function public.my_recent_conversations()
returns table (conversation_id uuid, peer_alias text, ended_at timestamptz, end_reason text, questions_asked int,
               my_decision boolean, both_yes boolean, reflection_done boolean, connection_id uuid, thread_id uuid)
language sql stable security definer set search_path = public as $$
  select cv.id,
         (select a.alias from public.participants p2 join public.participant_aliases a on a.participant_id = p2.id where p2.conversation_id = cv.id and p2.account_id <> auth.uid() limit 1),
         cv.ended_at, cv.end_reason, cv.questions_asked,
         (select r.decision from public.connection_requests r where r.conversation_id = cv.id and r.participant_id = me.id and r.revoked_at is null),
         cn.id is not null,
         exists (select 1 from public.session_reflections s where s.conversation_id = cv.id and s.participant_id = me.id),
         cn.id,
         (select t.id from public.conversations t where t.connection_id = cn.id and t.kind = 'friend')
  from public.conversations cv
  join public.participants me on me.conversation_id = cv.id and me.account_id = auth.uid()
  join public.participants other on other.conversation_id = cv.id and other.account_id <> auth.uid()
  left join public.connections cn on cn.status = 'active'
    and ((cn.account_a = auth.uid() and cn.account_b = other.account_id) or (cn.account_b = auth.uid() and cn.account_a = other.account_id))
  where cv.kind = 'live' and cv.status = 'ended' and cv.end_reason is distinct from 'blocked'
    and cv.ended_at > now() - interval '30 days'
    and not public.is_blocked_either_way(auth.uid(), other.account_id)
  order by cv.ended_at desc
$$;

-- ---------------------------------------------------------------------------
-- History: kept until cleared or the chat ends
-- ---------------------------------------------------------------------------
create or replace function public.clear_thread_history(p_conversation uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_kind text; n int;
begin
  select kind into v_kind from public.conversations where id = p_conversation;
  if v_kind is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_kind <> 'friend' then raise exception 'only chats can be cleared' using errcode = 'P0001'; end if;
  delete from public.approved_messages where conversation_id = p_conversation;
  get diagnostics n = row_count;
  update public.question_answers set custom_text = null where conversation_id = p_conversation and custom_text is not null;
  update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = p_conversation and status in ('pending', 'review', 'revise');
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'history_cleared', jsonb_build_object('conversation_id', p_conversation) from public.participants p where p.conversation_id = p_conversation;
  return n;
end $$;

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
  -- live conversations: 30 days after the conversation ended
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'live' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
  -- chats: kept while the chat is open; 30 days after it ended (removed, blocked)
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'friend' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n6 = row_count;
  update public.question_answers a set custom_text = null from public.conversations c
    where a.conversation_id = c.id and a.custom_text is not null
      and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
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
  delete from public.availability_requests where status not in ('waiting', 'invited') and coalesce(ended_at, created_at) < now() - make_interval(days => d_queue);
  get diagnostics n7 = row_count;
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
