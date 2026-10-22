-- Review of 99c121a / a6ca19d / migration 0013 (ChatGPT + Claude).
--  2. "Not now" is private: a declined request looks exactly like an unanswered
--     one to the requester (same flags, same responses, same cooldown).
--     Unanswered requests expire after the cooldown so nothing gets stuck.
--  3. set_connection_decision only resets a connection that was ended; an
--     active one keeps tier, request, cooldown and history; repeats have no
--     side effects. Withdrawing while connected is refused (end the chat instead).
--  5. Clearing history: delivered messages, shared questions and answers go;
--     cleared questions are closed and can never reveal; messages created
--     before the clear are not delivered afterwards (their review record stays);
--     only the caller's own unreviewed submissions are cancelled; delivered
--     bodies in moderation records are redacted; report evidence is snapshotted
--     at report time (restricted table, purged with the report); ended-chat
--     retention also removes questions and answers.
--  6. Delivery re-validates contact permission (thread_contact_allowed) under
--     the conversation lock; a result produced under a permission that no
--     longer holds is re-moderated instead of delivered.
-- 12. complete_onboarding validates every input against the schema.
-- 13. resolve_appeal is one transaction (appeal + delivery).
-- 14. One lock order (conversation → question) with NO KEY UPDATE locks so FK
--     key-share locks from answer inserts can't deadlock; duplicate
--     client_send_id is safe under concurrency.
-- 15. Stats distinguish chats from friends; model-usage budget.

-- ---------------------------------------------------------------------------
-- 2. Friend requests: private decline, expiry
-- ---------------------------------------------------------------------------
alter table public.connections add column if not exists friend_request_declined_at timestamptz;
alter table public.conversations add column if not exists history_cleared_at timestamptz;

create or replace function public.request_friend(p_connection uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_peer uuid;
  v_cool int := (public.cfg('friend_request_cooldown_days', '7'))::int; v_live boolean;
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
  -- a request is "live" for the cooldown period, answered or not; the requester
  -- can't tell the difference and nobody can ask again meanwhile
  v_live := v_c.friend_requested_at is not null and v_c.friend_requested_at > now() - make_interval(days => v_cool);
  if v_live then
    if v_c.friend_requested_by = v_uid then return 'pending'; end if;                          -- mine: same answer, declined or not
    if v_c.friend_requested_by = v_peer and v_c.friend_request_declined_at is null then
      raise exception 'they already asked you; answer their request instead' using errcode = 'P0001';
    end if;
    raise exception 'a request was made recently; try again later' using errcode = 'P0002';   -- cooldown (per pair)
  end if;
  update public.connections set friend_requested_by = v_uid, friend_requested_at = now(), friend_request_declined_at = null where id = p_connection;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing', 'v1', true);
  insert into public.notifications (account_id, kind, payload) values (v_peer, 'friend_request', jsonb_build_object('connection_id', p_connection));
  return 'pending';
end $$;

create or replace function public.respond_friend_request(p_connection uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_peer uuid;
  v_cool int := (public.cfg('friend_request_cooldown_days', '7'))::int;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  perform public.lock_accounts(v_c.account_a, v_c.account_b);
  select * into v_c from public.connections where id = p_connection for update;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  if v_c.friend_requested_by is distinct from v_peer or v_c.friend_request_declined_at is not null
     or v_c.friend_requested_at is null or v_c.friend_requested_at <= now() - make_interval(days => v_cool) then
    raise exception 'no request to answer' using errcode = 'P0001';
  end if;
  if v_c.status <> 'active' or public.is_blocked_either_way(v_uid, v_peer) then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing', 'v1', p_accept);
  if p_accept then
    update public.connections set tier = 'friend', friends_since = now(), friend_requested_by = null, friend_request_declined_at = null where id = p_connection;
    insert into public.notifications (account_id, kind, payload) values
      (v_peer, 'friends', jsonb_build_object('connection_id', p_connection)),
      (v_uid, 'friends', jsonb_build_object('connection_id', p_connection));
    return 'friends';
  end if;
  -- "Not now": recorded privately; to the requester nothing changes
  update public.connections set friend_request_declined_at = now() where id = p_connection;
  return 'declined';
end $$;

drop function if exists public.friend_unread_total();
drop function if exists public.thread_state(uuid);
drop function if exists public.friend_threads_overview();
create or replace function public.friend_threads_overview()
returns table (connection_id uuid, conversation_id uuid, peer_alias text, my_alias text, since timestamptz, status text, unread int, last_message_at timestamptz, muted boolean,
               tier text, request_from_me boolean, request_for_me boolean, request_available boolean, friends_since timestamptz, history_cleared_at timestamptz)
language sql stable security definer set search_path = public as $$
  with cool as (select make_interval(days => (public.cfg('friend_request_cooldown_days', '7'))::int) as d)
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
         -- live request from me: identical whether the other person declined or has not answered
         coalesce(c.friend_requested_by = auth.uid() and c.friend_requested_at > now() - cool.d, false),
         coalesce(c.friend_requested_by is not null and c.friend_requested_by <> auth.uid() and c.friend_request_declined_at is null and c.friend_requested_at > now() - cool.d, false),
         c.status = 'active' and c.tier = 'chat'
           and (c.friend_requested_at is null or c.friend_requested_at <= now() - cool.d)
           and (public.cfg('contact_sharing_enabled', 'false'))::boolean,
         c.friends_since,
         cv.history_cleared_at
  from public.connections c
  cross join cool
  left join public.conversations cv on cv.connection_id = c.id and cv.kind = 'friend'
  where c.account_a = auth.uid() or c.account_b = auth.uid()
  order by coalesce(cv.last_message_at, c.created_at) desc
$$;
create or replace function public.friend_unread_total() returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(unread), 0)::int from public.friend_threads_overview()
$$;
create or replace function public.thread_state(p_conversation uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('tier', o.tier, 'request_from_me', o.request_from_me, 'request_for_me', o.request_for_me,
                                             'request_available', o.request_available, 'status', o.status, 'connection_id', o.connection_id,
                                             'history_cleared_at', o.history_cleared_at)
                   from public.friend_threads_overview() o where o.conversation_id = p_conversation), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- 3 + 4. Keep-talking decision: active connections are left alone
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
  v_existing public.connections%rowtype;
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
  if v_uid < v_peer.account_id then v_a := v_uid; v_b := v_peer.account_id; else v_a := v_peer.account_id; v_b := v_uid; end if;
  select * into v_existing from public.connections where account_a = v_a and account_b = v_b for update;

  -- withdrawing after the chat exists would leave it active: the honest path is "End this chat"
  if not p_decision and v_existing.id is not null and v_existing.status = 'active' then
    raise exception 'you already have a chat with this person; end the chat instead' using errcode = 'P0001';
  end if;

  v_pid := public.my_participant_id(p_conversation);
  insert into public.connection_requests (conversation_id, participant_id, decision, policy_version)
    values (p_conversation, v_pid, p_decision, v_version)
    on conflict (conversation_id, participant_id) do update set decision = excluded.decision, created_at = now(), revoked_at = null;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'reconnect_policy', v_version, p_decision);

  if not p_decision then return jsonb_build_object('status', 'recorded'); end if;
  if v_peer.account_id is null then return jsonb_build_object('status', 'recorded'); end if;
  if public.is_blocked_either_way(v_uid, v_peer.account_id) then return jsonb_build_object('status', 'recorded'); end if;

  -- already connected (this conversation or an earlier one): nothing to change, nothing to announce
  if v_existing.id is not null and v_existing.status = 'active' then
    return jsonb_build_object('status', 'connected', 'connection_id', v_existing.id);
  end if;

  select bool_and(decision), count(*) into v_both, v_n from public.connection_requests
    where conversation_id = p_conversation and revoked_at is null;
  if not coalesce(v_both, false) or v_n < 2 then return jsonb_build_object('status', 'recorded'); end if;

  if v_uid = v_a then
    select alias into v_alias_a from public.participant_aliases where participant_id = v_pid; v_alias_b := v_peer.alias;
  else
    v_alias_a := v_peer.alias; select alias into v_alias_b from public.participant_aliases where participant_id = v_pid;
  end if;
  if v_existing.id is null then
    insert into public.connections (account_a, account_b, alias_a, alias_b, source_conversation_id)
      values (v_a, v_b, v_alias_a, v_alias_b, p_conversation) returning id into v_conn;
  else
    -- restoring an ended connection: back to the chat tier with fresh consent needed for
    -- contact sharing; the request cooldown is kept so a decline can't be bypassed this way
    v_conn := v_existing.id;
    update public.connections set status = 'active', ended_at = null, alias_a = v_alias_a, alias_b = v_alias_b, source_conversation_id = p_conversation,
        tier = 'chat', friend_requested_by = null, friend_request_declined_at = null, friends_since = null
      where id = v_conn;
    update public.conversations set status = 'chatting', ended_at = null, end_reason = null
      where connection_id = v_conn and kind = 'friend' and status = 'ended' and end_reason = 'unfriended';
  end if;
  insert into public.notifications (account_id, kind, payload) values
    (v_a, 'connected', jsonb_build_object('connection_id', v_conn)),
    (v_b, 'connected', jsonb_build_object('connection_id', v_conn));
  return jsonb_build_object('status', 'connected', 'connection_id', v_conn);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Clearing history, report evidence, retention of questions and answers
-- ---------------------------------------------------------------------------
alter table public.conversation_questions add column if not exists cleared_at timestamptz;

-- participants never see cleared questions again (admins still can, for reports)
drop policy if exists questions_in_conversation on public.conversation_questions;
create policy questions_in_conversation on public.conversation_questions for select to authenticated
  using ((public.is_participant(conversation_id) and cleared_at is null) or public.is_admin());

-- Report evidence: an immutable snapshot of what the reporter could see at the
-- time, kept apart from the live chat (which may be cleared later). Service role only.
create table if not exists public.report_evidence (
  report_id uuid primary key references public.reports(id) on delete cascade,
  conversation_kind text,
  cited jsonb not null default '[]'::jsonb,
  context jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.report_evidence enable row level security;
revoke all on public.report_evidence from anon, authenticated;

-- Messages the reporter is allowed to see: chat messages, their own answers,
-- and answers to revealed questions (the same rule as the RLS policy).
create or replace function public.visible_messages_for(p_conversation uuid, p_account uuid, p_limit int)
returns table (id uuid, sender_participant_id uuid, sender_alias text, kind text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.sender_participant_id, a.alias, m.kind::text, m.body, m.created_at
  from public.approved_messages m
  join public.participant_aliases a on a.participant_id = m.sender_participant_id
  join public.participants me on me.conversation_id = m.conversation_id and me.account_id = p_account
  where m.conversation_id = p_conversation
    and (m.kind = 'chat' or m.sender_participant_id = me.id
         or exists (select 1 from public.conversation_questions q where q.id = m.question_id and q.revealed_at is not null))
  order by m.created_at desc
  limit p_limit
$$;
revoke execute on function public.visible_messages_for(uuid, uuid, int) from public, anon, authenticated;

create or replace function public.report_peer(p_conversation uuid, p_reason text, p_details text, p_message_ids uuid[], p_also_block boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_peer_pid uuid;
  v_id uuid;
  v_kind text;
  v_cited jsonb;
  v_context jsonb;
  v_valid uuid[];
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if not public.take_rate_limit('report', 10, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  -- serialize with clear_thread_history so the evidence reflects what was there
  select kind into v_kind from public.conversations where id = p_conversation for update;
  select id into v_peer_pid from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  -- only messages of this conversation that the reporter could see are citable
  select coalesce(array_agg(v.id), '{}'), coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'alias', v.sender_alias, 'kind', v.kind, 'body', v.body, 'at', v.created_at) order by v.created_at), '[]'::jsonb)
    into v_valid, v_cited
    from public.visible_messages_for(p_conversation, v_uid, 10000) v
    where v.id = any (coalesce(p_message_ids, '{}'));
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'alias', v.sender_alias, 'kind', v.kind, 'body', v.body, 'at', v.created_at) order by v.created_at), '[]'::jsonb)
    into v_context from public.visible_messages_for(p_conversation, v_uid, 20) v;
  insert into public.reports (reporter_account_id, reported_participant_id, conversation_id, reason, details, message_ids)
    values (v_uid, v_peer_pid, p_conversation, p_reason, left(p_details, 2000), v_valid)
    returning id into v_id;
  insert into public.report_evidence (report_id, conversation_kind, cited, context) values (v_id, v_kind, v_cited, v_context);
  if p_also_block then perform public.block_peer(p_conversation); end if;
  return v_id;
end $$;

-- Clear: delivered history, shared questions and answers for both people.
--  * cleared questions are closed and marked, so they can never reveal and are
--    no longer visible to participants
--  * the caller's OWN unreviewed submissions (pending / needs a change) are
--    cancelled; the other person's are left alone (their review continues, but
--    a message from before the clear is not delivered afterwards)
--  * delivered bodies in the caller's and the peer's moderation records are
--    redacted; review records themselves are kept
create or replace function public.clear_thread_history(p_conversation uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.conversations%rowtype; v_pid uuid; n int; v_now timestamptz := now();
begin
  select * into v_c from public.conversations where id = p_conversation for update;
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_c.kind <> 'friend' then raise exception 'only chats can be cleared' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  delete from public.approved_messages where conversation_id = p_conversation;
  get diagnostics n = row_count;
  delete from public.question_answers where conversation_id = p_conversation;
  update public.conversation_questions set status = 'closed', cleared_at = v_now where conversation_id = p_conversation and cleared_at is null;
  update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = v_now
    where conversation_id = p_conversation and sender_participant_id = v_pid and status in ('pending', 'revise');
  update public.pending_messages set body = '[cleared]', suggested_revision = null, updated_at = v_now
    where conversation_id = p_conversation and status in ('approved', 'cancelled') and created_at < v_now and body <> '[cleared]';
  update public.conversations set history_cleared_at = v_now where id = p_conversation;
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'history_cleared', jsonb_build_object('conversation_id', p_conversation) from public.participants p where p.conversation_id = p_conversation;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 14. One lock order: conversation first, then the question
-- ---------------------------------------------------------------------------
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
  select * into v_q from public.conversation_questions where id = p_question;
  if v_q.id is null then return false; end if;
  -- NO KEY UPDATE: coexists with the KEY SHARE locks that answer inserts take through
  -- their foreign keys (FOR UPDATE would deadlock against a concurrent answer)
  select * into v_conv from public.conversations where id = v_q.conversation_id for no key update;   -- conversation → question
  select * into v_q from public.conversation_questions where id = p_question for no key update;
  if v_q.revealed_at is not null or v_q.status = 'closed' or v_q.cleared_at is not null then return false; end if;
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

-- ---------------------------------------------------------------------------
-- 6. Delivery re-validates contact permission; 5. cleared chats don't deliver old messages
-- ---------------------------------------------------------------------------
drop function if exists public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int, uuid);
create or replace function public.apply_moderation_decision(
  p_pending uuid, p_decision text, p_categories text[], p_user_explanation text,
  p_suggested_revision text, p_confidence numeric, p_detector_hits text[],
  p_provider text, p_model text, p_raw_valid boolean, p_latency_ms int,
  p_claim_token uuid default null, p_contact_allowed boolean default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype;
  v_conv public.conversations%rowtype;
  v_quiet_cap int := (public.cfg('quiet_cap_seconds', '60'))::int;
  v_delta int;
  v_due boolean := false;
  v_revealed boolean := false;
  v_sender uuid; v_recipient uuid; v_pushed timestamptz;
  v_allowed_now boolean;
  v_q_cleared boolean;
begin
  perform public.assert_service_role();
  select * into v_m from public.pending_messages where id = p_pending for update;
  if v_m.id is null then raise exception 'pending not found'; end if;
  if p_claim_token is not null then
    if v_m.status <> 'pending' or v_m.claim_token is distinct from p_claim_token then
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true, 'reason', 'stale claim');
    end if;
  else
    if p_provider is distinct from 'human' then raise exception 'automated decisions need a claim token' using errcode = 'P0001'; end if;
    if v_m.status not in ('pending', 'review') then return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true); end if;
  end if;

  -- the review record is kept whatever happens to delivery
  insert into public.moderation_decisions (pending_message_id, decision, categories, user_explanation, suggested_revision, confidence, detector_hits, provider, model, raw_valid, latency_ms)
    values (p_pending, p_decision, coalesce(p_categories, '{}'), p_user_explanation, p_suggested_revision, p_confidence, coalesce(p_detector_hits, '{}'), p_provider, p_model, p_raw_valid, p_latency_ms);

  if p_decision = 'allow' then
    select * into v_conv from public.conversations where id = v_m.conversation_id for no key update;
    select p.account_id into v_sender from public.participants p where p.id = v_m.sender_participant_id;
    select p.account_id into v_recipient from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_sender limit 1;

    -- the permission the moderation ran under must still hold at delivery time
    if p_contact_allowed is true and v_conv.kind = 'friend' then
      v_allowed_now := public.thread_contact_allowed(v_conv.id);
      if not v_allowed_now then
        update public.pending_messages set claim_token = null, next_attempt_at = now(), updated_at = now() where id = p_pending;
        return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true, 'reason', 'permission changed');
      end if;
    end if;

    if v_conv.status = 'ended'
       or (v_conv.kind = 'friend' and (not exists (select 1 from public.connections where id = v_conv.connection_id and status = 'active') or public.is_blocked_either_way(v_sender, v_recipient))) then
      update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = now() where id = p_pending;
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true);
    end if;
    -- a message from before the chat's history was cleared is not delivered afterwards
    select coalesce(q.cleared_at is not null or q.status = 'closed', false) into v_q_cleared from public.conversation_questions q where q.id = v_m.question_id;
    if (v_conv.history_cleared_at is not null and v_m.created_at < v_conv.history_cleared_at) or (v_m.kind = 'answer' and coalesce(v_q_cleared, false)) then
      update public.pending_messages set status = 'cancelled', claim_token = null,
          user_explanation = 'This chat''s history was cleared before this was delivered, so it was not sent.', updated_at = now()
        where id = p_pending;
      if v_m.kind = 'answer' then delete from public.question_answers where pending_message_id = p_pending; end if;
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true, 'reason', 'history cleared');
    end if;

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
revoke execute on function public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 13. Appeal resolution in one transaction
-- ---------------------------------------------------------------------------
create or replace function public.resolve_appeal(p_appeal uuid, p_status text, p_note text, p_resolver uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_pending uuid; v_out jsonb := '{}'::jsonb;
begin
  perform public.assert_service_role();
  if p_status not in ('upheld', 'overturned') then raise exception 'bad status' using errcode = 'P0001'; end if;
  update public.appeals set status = p_status, resolution_note = p_note, resolved_by = p_resolver, resolved_at = now()
    where id = p_appeal and status = 'open' returning pending_message_id into v_pending;
  if v_pending is null then raise exception 'appeal not open' using errcode = 'P0001'; end if;
  if p_status = 'overturned' then
    update public.pending_messages set status = 'pending', attempts = 0, claim_token = null, updated_at = now() where id = v_pending and status in ('blocked', 'revise');
    v_out := public.apply_moderation_decision(v_pending, 'allow', array['appeal_overturned'], null, null, 1, '{}', 'human', null, true, null, null, null);
  end if;
  return v_out || jsonb_build_object('pending_id', v_pending);
end $$;
revoke execute on function public.resolve_appeal(uuid, text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 14. Duplicate client_send_id under concurrency
-- ---------------------------------------------------------------------------
create or replace function public.submit_message(
  p_conversation uuid, p_client_send_id text, p_body text,
  p_kind public.message_kind default 'chat', p_question uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_pid uuid;
  v_id uuid;
  v_c public.conversations%rowtype;
  v_peer uuid;
  v_existing public.pending_messages%rowtype;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_c.status = 'ended' then raise exception 'conversation ended' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  if exists (select 1 from public.participants where id = v_pid and left_at is not null) then raise exception 'you left this conversation' using errcode = 'P0001'; end if;
  -- idempotent resend: the same sender's earlier row, never someone else's
  select * into v_existing from public.pending_messages where conversation_id = p_conversation and client_send_id = p_client_send_id;
  if v_existing.id is not null then
    if v_existing.sender_participant_id <> v_pid then raise exception 'client id in use' using errcode = 'P0001'; end if;
    return v_existing.id;
  end if;
  if v_c.kind = 'friend' then
    if not exists (select 1 from public.connections where id = v_c.connection_id and status = 'active') then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
    select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
    if public.is_blocked_either_way(v_uid, v_peer) then raise exception 'this chat has ended' using errcode = 'P0001'; end if;
  elsif p_kind = 'chat' and v_c.status <> 'chatting' then
    raise exception 'chat opens after the opening questions' using errcode = 'P0001';
  end if;
  if p_kind = 'answer' then
    if p_question is null or not exists (select 1 from public.conversation_questions where id = p_question and conversation_id = p_conversation and status = 'open' and cleared_at is null) then
      raise exception 'question not open' using errcode = 'P0001';
    end if;
  end if;
  if not public.take_rate_limit('send', 30, 60) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.pending_messages (conversation_id, sender_participant_id, client_send_id, kind, question_id, body)
    values (p_conversation, v_pid, p_client_send_id, p_kind, p_question, p_body)
    on conflict (conversation_id, client_send_id) do nothing
    returning id into v_id;
  if v_id is null then
    -- lost a race with the same client id: hand back the row that won (same sender only)
    select * into v_existing from public.pending_messages where conversation_id = p_conversation and client_send_id = p_client_send_id;
    if v_existing.sender_participant_id <> v_pid then raise exception 'client id in use' using errcode = 'P0001'; end if;
    return v_existing.id;
  end if;
  if p_kind = 'answer' then
    insert into public.question_answers (question_id, participant_id, conversation_id, status, pending_message_id)
      values (p_question, v_pid, p_conversation, 'pending', v_id)
      on conflict (question_id, participant_id) do update
        set choice_index = null, custom_text = null, status = 'pending', pending_message_id = v_id, updated_at = now()
        where public.question_answers.status <> 'approved';
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 12. Onboarding inputs validated at the entry point
-- ---------------------------------------------------------------------------
create or replace function public.complete_onboarding(
  p_age_band text, p_region text, p_community text, p_life_context text[],
  p_share_context boolean, p_political_answers jsonb, p_political_nonanswers jsonb,
  p_issue_priorities text[], p_questionnaire_version int, p_terms_version text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user(); k text; t text;
  c_keys text[] := array['public_services','high_income_taxes','healthcare','legal_immigration','deportations','abortion','gun_purchases','climate'];
  c_age text[] := array['18-24','25-34','35-44','45-54','55-64','65+'];
  c_region text[] := array['northeast','midwest','south','west','other'];
  c_community text[] := array['urban','suburban','rural','mixed'];
  c_context text[] := array['parent','caregiver','veteran','small business','shift work','student','retired','faith community','rural roots','city life','moved a lot','first-generation','unemployed recently','health challenges'];
begin
  if p_questionnaire_version is distinct from 2 then raise exception 'unsupported questionnaire version' using errcode = 'P0001'; end if;
  if p_terms_version is null or length(p_terms_version) not between 1 and 32 then raise exception 'bad terms version' using errcode = 'P0001'; end if;
  if p_age_band is not null and not (p_age_band = any (c_age)) then raise exception 'bad age band' using errcode = 'P0001'; end if;
  if p_region is not null and not (p_region = any (c_region)) then raise exception 'bad region' using errcode = 'P0001'; end if;
  if p_community is not null and not (p_community = any (c_community)) then raise exception 'bad community' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_life_context, 1), 0) > 6 then raise exception 'too many life-context tags' using errcode = 'P0001'; end if;
  foreach t in array coalesce(p_life_context, '{}') loop
    if not (t = any (c_context)) then raise exception 'unknown life-context tag' using errcode = 'P0001'; end if;
  end loop;
  if (select count(distinct x) from unnest(coalesce(p_life_context, '{}')) x) <> coalesce(array_length(p_life_context, 1), 0) then raise exception 'duplicate life-context tag' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_political_answers, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_political_nonanswers, '{}'::jsonb)) <> 'object' then raise exception 'bad answers' using errcode = 'P0001'; end if;
  for k in select jsonb_object_keys(coalesce(p_political_answers, '{}'::jsonb)) loop
    if not (k = any (c_keys)) then raise exception 'unknown question' using errcode = 'P0001'; end if;
    if jsonb_typeof(p_political_answers->k) <> 'number' or (p_political_answers->>k)::numeric < 0 or (p_political_answers->>k)::numeric > 1 then
      raise exception 'answer out of range' using errcode = 'P0001';
    end if;
    if coalesce(p_political_nonanswers, '{}'::jsonb) ? k then raise exception 'answer and non-answer for the same question' using errcode = 'P0001'; end if;
  end loop;
  for k in select jsonb_object_keys(coalesce(p_political_nonanswers, '{}'::jsonb)) loop
    if not (k = any (c_keys)) then raise exception 'unknown question' using errcode = 'P0001'; end if;
    if (p_political_nonanswers->>k) not in ('unsure', 'declined') then raise exception 'bad non-answer' using errcode = 'P0001'; end if;
  end loop;
  if coalesce(array_length(p_issue_priorities, 1), 0) > 2 then raise exception 'at most two priorities' using errcode = 'P0001'; end if;
  foreach t in array coalesce(p_issue_priorities, '{}') loop
    if not (t = any (c_keys)) then raise exception 'unknown priority' using errcode = 'P0001'; end if;
  end loop;
  if (select count(distinct x) from unnest(coalesce(p_issue_priorities, '{}')) x) <> coalesce(array_length(p_issue_priorities, 1), 0) then raise exception 'duplicate priority' using errcode = 'P0001'; end if;

  update public.accounts set adult_attested_at = coalesce(adult_attested_at, now()), onboarding_complete = true where id = v_uid;
  update public.profiles set
    age_band = p_age_band, region = p_region, community = p_community,
    life_context = coalesce(p_life_context, '{}'), share_context_with_prompts = coalesce(p_share_context, false),
    political_answers = coalesce(p_political_answers, '{}'::jsonb),
    political_nonanswers = coalesce(p_political_nonanswers, '{}'::jsonb),
    issue_priorities = coalesce(p_issue_priorities, '{}'),
    questionnaire_version = p_questionnaire_version,
    updated_at = now()
    where account_id = v_uid;
  insert into public.consent_events (account_id, kind, version, granted) values
    (v_uid, 'terms', p_terms_version, true),
    (v_uid, 'profile_context', p_terms_version, coalesce(p_share_context, false));
end $$;

-- ---------------------------------------------------------------------------
-- 15. Stats: chats vs friends; model-usage budget; indexes; retention
-- ---------------------------------------------------------------------------
drop function if exists public.peer_badges(uuid);
drop function if exists public.my_stats();
drop function if exists public.account_stats(uuid);
create or replace function public.account_stats(p_account uuid)
returns table (people int, conversations int, chats int, friends int, full_rounds int, reconnections int)
language sql stable security definer set search_path = public as $$
  with mine as (
    select c.id, c.questions_asked, c.opening_question_count, c.connection_id
    from public.participants p
    join public.conversations c on c.id = p.conversation_id
    where p.account_id = p_account and c.kind = 'live'
      and exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.revealed_at is not null)
  ),
  peers as (
    select distinct p2.account_id
    from mine m
    join public.participants p2 on p2.conversation_id = m.id and p2.account_id <> p_account
  )
  select
    (select count(*)::int from peers),
    (select count(*)::int from mine),
    (select count(*)::int from public.connections where status = 'active' and (account_a = p_account or account_b = p_account)),
    (select count(*)::int from public.connections where status = 'active' and tier = 'friend' and (account_a = p_account or account_b = p_account)),
    (select count(*)::int from mine where questions_asked >= opening_question_count),
    (select count(*)::int from mine where connection_id is not null)
$$;
revoke execute on function public.account_stats(uuid) from public, anon, authenticated;
create or replace function public.my_stats()
returns table (people int, conversations int, chats int, friends int, full_rounds int, reconnections int)
language sql stable security definer set search_path = public as $$
  select * from public.account_stats(auth.uid())
$$;
create or replace function public.peer_badges(p_conversation uuid)
returns table (people_tier int, friends_tier int, full_round boolean, came_back boolean)
language sql stable security definer set search_path = public as $$
  select
    public.tier_of(s.people, array[1,5,10,25,50,100]),
    public.tier_of(s.chats, array[1,2,5,10,25]),
    s.full_rounds > 0,
    s.reconnections > 0
  from public.participants p
  cross join lateral public.account_stats(p.account_id) s
  where p.conversation_id = p_conversation
    and p.account_id <> auth.uid()
    and public.is_participant(p_conversation)
$$;

-- Model-usage budget per UTC day and task. 0 = unlimited (the default).
-- Exhaustion never bypasses moderation: messages stay held; questions use the bank.
create table if not exists public.model_usage (
  day date not null,
  task text not null,
  calls int not null default 0,
  primary key (day, task)
);
alter table public.model_usage enable row level security;
insert into public.policy_config (key, value) values ('model_calls_per_day_moderation', '0'), ('model_calls_per_day_questions', '0') on conflict (key) do nothing;
create or replace function public.take_model_budget(p_task text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_limit int; v_calls int;
begin
  perform public.assert_service_role();
  v_limit := (public.cfg('model_calls_per_day_' || p_task, '0'))::int;
  insert into public.model_usage (day, task, calls) values (current_date, p_task, 1)
    on conflict (day, task) do update set calls = public.model_usage.calls + 1 returning calls into v_calls;
  if v_limit <= 0 then return true; end if;
  return v_calls <= v_limit;
end $$;
revoke execute on function public.take_model_budget(text) from public, anon, authenticated;

create index if not exists question_answers_pending_idx on public.question_answers (pending_message_id);
create index if not exists conversation_questions_cleared_idx on public.conversation_questions (conversation_id, cleared_at);

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
  n1 int; n2 int; n3 int; n4 int; n5 int; n6 int; n7 int; n8 int; n9 int; n10 int; n11 int;
begin
  perform public.assert_service_role();
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'live' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.kind = 'friend' and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n6 = row_count;
  -- questions and answers of ended conversations follow the same rule (the
  -- pending rows that reference them are purged below or cascade)
  delete from public.question_answers a using public.conversations c
    where a.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n5 = row_count;
  delete from public.conversation_questions q using public.conversations c
    where q.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n11 = row_count;
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
  delete from public.model_usage where day < current_date - 90;
  return jsonb_build_object('messages', n1, 'friend_messages', n6, 'answers', n5, 'questions', n11, 'pending', n2, 'reports', n3, 'rate_limits', n4,
    'queue_entries', n7, 'metric_events', n8, 'outbox', n9, 'reminder_sends', n10);
end $$;
revoke execute on function public.purge_retention() from public, anon, authenticated;

-- Live conversations whose next mid-conversation question is due but was never
-- generated (e.g. the worker ran out of time right after delivering a message).
create or replace function public.conversations_due_for_question(p_limit int default 20) returns setof uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.conversations c
  where c.kind = 'live' and c.status = 'chatting'
    and c.active_seconds_since_question >= c.question_gap_seconds
    and not exists (select 1 from public.conversation_questions q where q.conversation_id = c.id and q.status = 'open')
  order by c.last_activity_at
  limit p_limit
$$;
revoke execute on function public.conversations_due_for_question(int) from public, anon, authenticated;
