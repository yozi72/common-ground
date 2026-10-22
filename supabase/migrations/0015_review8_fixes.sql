-- Review of 912eb92 / 6afa83a (ChatGPT + Claude).
--  1. Retention no longer deletes questions that an open appeal still needs
--     (the cascade questions → pending answers → appeals bypassed the guard).
--  2. Participation stats come from content-free marks on the conversation
--     (counted_at, full_round_at), so retention and clearing don't erase them.
--  3. One lock order everywhere (documented below); apply_moderation_decision
--     now locks the conversation before the pending row, block/remove end the
--     conversation before touching pending rows, report_peer takes the account
--     locks before the conversation row.
--  9. contact_sharing_enabled is a real gate: permission, acceptance and
--     delivery all check it; consent events distinguish a person's request
--     from mutual activation.
-- 10. my_recent_conversations reports this conversation's decisions and the
--     pair's connection separately; model budget per task and per account;
--     reminder claims can be recovered after an interrupted worker.
--
-- Lock order (acquire in this order, never the reverse):
--   1. per-account advisory locks, sorted              lock_accounts()
--   2. connections row                                 for update
--   3. conversations row                               for no key update
--   4. conversation_questions row                      for no key update
--   5. pending_messages rows
--   6. question_answers / approved_messages / thread_reads / push_queue / participants
-- NO KEY UPDATE on parents coexists with the KEY SHARE locks child inserts take.

-- ---------------------------------------------------------------------------
-- 2. Durable participation marks
-- ---------------------------------------------------------------------------
alter table public.conversations add column if not exists counted_at timestamptz;
alter table public.conversations add column if not exists full_round_at timestamptz;
update public.conversations c set counted_at = s.first_reveal
  from (select conversation_id, min(revealed_at) as first_reveal from public.conversation_questions where revealed_at is not null group by conversation_id) s
  where s.conversation_id = c.id and c.counted_at is null;
update public.conversations set full_round_at = coalesce(chat_started_at, counted_at)
  where full_round_at is null and kind = 'live' and questions_asked >= opening_question_count and chat_started_at is not null;

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
  select * into v_conv from public.conversations where id = v_q.conversation_id for no key update;   -- 3 → 4
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
  -- the conversation "counts" from its first reveal, whatever happens to the content later
  update public.conversations set counted_at = coalesce(counted_at, now()) where id = v_q.conversation_id;
  if v_conv.kind = 'live' and v_conv.status = 'opening' then
    select count(*) into v_revealed from public.conversation_questions where conversation_id = v_q.conversation_id and status = 'revealed';
    if v_revealed >= v_conv.opening_question_count then
      update public.conversations set status = 'chatting', chat_started_at = now(), last_activity_at = now(), full_round_at = coalesce(full_round_at, now())
        where id = v_q.conversation_id;
    end if;
  end if;
  return true;
end $$;

drop function if exists public.peer_badges(uuid);
drop function if exists public.my_stats();
drop function if exists public.account_stats(uuid);
create or replace function public.account_stats(p_account uuid)
returns table (people int, conversations int, chats int, friends int, full_rounds int, reconnections int)
language sql stable security definer set search_path = public as $$
  with mine as (
    select c.id, c.connection_id, c.full_round_at
    from public.participants p
    join public.conversations c on c.id = p.conversation_id
    where p.account_id = p_account and c.kind = 'live' and c.counted_at is not null
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
    (select count(*)::int from mine where full_round_at is not null),
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

-- ---------------------------------------------------------------------------
-- 3. Lock order
-- ---------------------------------------------------------------------------
create or replace function public.end_conversation(p_conversation uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set status = 'ended', ended_at = now(), end_reason = p_reason
    where id = p_conversation and status <> 'ended';                                   -- 3 (row lock)
  update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = now()
    where conversation_id = p_conversation and status in ('pending', 'review', 'revise');  -- 5
  update public.conversation_questions set status = 'closed'
    where conversation_id = p_conversation and status = 'open';
  update public.push_queue set status = 'cancelled', last_error = 'conversation ended'
    where conversation_id = p_conversation and status in ('queued', 'claimed');
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'conversation_ended', jsonb_build_object('conversation_id', p_conversation, 'reason', p_reason)
    from public.participants p where p.conversation_id = p_conversation;
end $$;

create or replace function public.block_peer(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_peer uuid; v_t uuid;
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  if v_peer is null then return; end if;
  perform public.lock_accounts(v_uid, v_peer);                                            -- 1
  insert into public.blocks (blocker_account_id, blocked_account_id, conversation_id) values (v_uid, v_peer, p_conversation) on conflict do nothing;
  update public.connections set status = 'ended', ended_at = now()                        -- 2
    where status = 'active' and ((account_a = v_uid and account_b = v_peer) or (account_a = v_peer and account_b = v_uid));
  perform public.revoke_connection_consent(v_uid, v_peer);
  for v_t in select c.id from public.conversations c where c.status <> 'ended' and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_uid)
    and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_peer) loop
    update public.participants set left_at = now() where conversation_id = v_t and account_id = v_uid and left_at is null;
    perform public.end_conversation(v_t, 'blocked');                                     -- 3 → 5 (pending rows are cancelled inside)
  end loop;
end $$;

create or replace function public.remove_friend(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
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
    update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = now() where conversation_id = v_conv and status in ('pending', 'review', 'revise');  -- 5
    update public.push_queue set status = 'cancelled', last_error = 'friendship ended' where conversation_id = v_conv and status in ('queued', 'claimed');
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'friendship_ended', jsonb_build_object('conversation_id', v_conv) from public.participants p where p.conversation_id = v_conv and p.account_id <> v_uid;
  end if;
end $$;

create or replace function public.report_peer(p_conversation uuid, p_reason text, p_details text, p_message_ids uuid[], p_also_block boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_peer uuid;
  v_peer_pid uuid;
  v_id uuid;
  v_kind text;
  v_cited jsonb;
  v_context jsonb;
  v_valid uuid[];
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if not public.take_rate_limit('report', 10, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  select account_id, id into v_peer, v_peer_pid from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  perform public.lock_accounts(v_uid, v_peer);                                            -- 1 (block_peer re-takes them; advisory xact locks nest)
  select kind into v_kind from public.conversations where id = p_conversation for no key update;   -- 3: serialize with clear_thread_history
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

drop function if exists public.clear_thread_history(uuid);
create or replace function public.clear_thread_history(p_conversation uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.conversations%rowtype; v_pid uuid; n int; v_now timestamptz := clock_timestamp();
begin
  select * into v_c from public.conversations where id = p_conversation for no key update;   -- 3
  if v_c.id is null or not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if v_c.kind <> 'friend' then raise exception 'only chats can be cleared' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  -- the server's clearing mark never moves backwards
  v_now := greatest(v_now, coalesce(v_c.history_cleared_at, v_now));
  update public.conversation_questions set status = 'closed', cleared_at = v_now where conversation_id = p_conversation and cleared_at is null;     -- 4
  update public.pending_messages set status = 'cancelled', claim_token = null, updated_at = v_now                                                     -- 5
    where conversation_id = p_conversation and sender_participant_id = v_pid and status in ('pending', 'revise');
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

-- ---------------------------------------------------------------------------
-- 9. Feature gate, consent meaning
-- ---------------------------------------------------------------------------
create or replace function public.thread_contact_allowed(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (public.cfg('contact_sharing_enabled', 'false'))::boolean and exists (
    select 1 from public.conversations cv join public.connections c on c.id = cv.connection_id
    where cv.id = p_conversation and cv.kind = 'friend' and cv.status <> 'ended' and c.status = 'active' and c.tier = 'friend'
      and not public.is_blocked_either_way(c.account_a, c.account_b)
  )
$$;
revoke execute on function public.thread_contact_allowed(uuid) from public, anon, authenticated;

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
  v_live := v_c.friend_requested_at is not null and v_c.friend_requested_at > now() - make_interval(days => v_cool);
  if v_live then
    if v_c.friend_requested_by = v_uid then return 'pending'; end if;
    if v_c.friend_requested_by = v_peer and v_c.friend_request_declined_at is null then
      raise exception 'they already asked you; answer their request instead' using errcode = 'P0001';
    end if;
    raise exception 'a request was made recently; try again later' using errcode = 'P0002';
  end if;
  update public.connections set friend_requested_by = v_uid, friend_requested_at = now(), friend_request_declined_at = null where id = p_connection;
  -- one person's request is not mutual consent; the activation is recorded at acceptance for both
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing_request', 'v1', true);
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
  if p_accept then
    if not (public.cfg('contact_sharing_enabled', 'false'))::boolean then raise exception 'contact sharing is not enabled' using errcode = 'P0001'; end if;
    update public.connections set tier = 'friend', friends_since = now(), friend_requested_by = null, friend_request_declined_at = null where id = p_connection;
    -- mutual activation: both people's consent takes effect now
    insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing', 'v1', true), (v_peer, 'contact_sharing', 'v1', true);
    insert into public.notifications (account_id, kind, payload) values
      (v_peer, 'friends', jsonb_build_object('connection_id', p_connection)),
      (v_uid, 'friends', jsonb_build_object('connection_id', p_connection));
    return 'friends';
  end if;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'contact_sharing_request', 'v1', false);
  update public.connections set friend_request_declined_at = now() where id = p_connection;
  return 'declined';
end $$;

-- ---------------------------------------------------------------------------
-- 3 (continued). Delivery: conversation lock before the pending row
-- ---------------------------------------------------------------------------
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
  select conversation_id into v_m.conversation_id from public.pending_messages where id = p_pending;
  if v_m.conversation_id is null then raise exception 'pending not found'; end if;
  select * into v_conv from public.conversations where id = v_m.conversation_id for no key update;   -- 3
  select * into v_m from public.pending_messages where id = p_pending for update;                     -- 5
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
    select p.account_id into v_sender from public.participants p where p.id = v_m.sender_participant_id;
    select p.account_id into v_recipient from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_sender limit 1;

    -- the permission the moderation ran under (feature gate included) must still hold now
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
-- 10. Recent conversations: this conversation's decisions vs the pair's connection
-- ---------------------------------------------------------------------------
drop function if exists public.my_recent_conversations();
create or replace function public.my_recent_conversations()
returns table (conversation_id uuid, peer_alias text, ended_at timestamptz, end_reason text, questions_asked int,
               my_decision boolean, both_yes boolean, connected boolean, reflection_done boolean, connection_id uuid, thread_id uuid)
language sql stable security definer set search_path = public as $$
  select cv.id,
         (select a.alias from public.participants p2 join public.participant_aliases a on a.participant_id = p2.id where p2.conversation_id = cv.id and p2.account_id <> auth.uid() limit 1),
         cv.ended_at, cv.end_reason, cv.questions_asked,
         (select r.decision from public.connection_requests r where r.conversation_id = cv.id and r.participant_id = me.id and r.revoked_at is null),
         -- both said yes HERE (unrevoked); independent of connections formed elsewhere
         (select count(*) = 2 and bool_and(r.decision) from public.connection_requests r where r.conversation_id = cv.id and r.revoked_at is null),
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
-- 10. Model budget: global per task AND per account per task
-- ---------------------------------------------------------------------------
-- model_usage keyed by (day, task, account); the all-zero uuid is the global row.
alter table public.model_usage add column if not exists account_id uuid not null default '00000000-0000-0000-0000-000000000000';
alter table public.model_usage drop constraint if exists model_usage_pkey;
alter table public.model_usage add primary key (day, task, account_id);
insert into public.policy_config (key, value) values ('model_calls_per_day_per_account', '0') on conflict (key) do nothing;

drop function if exists public.take_model_budget(text);
create or replace function public.take_model_budget(p_task text, p_accounts uuid[] default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_limit int; v_per int; v_calls int; v_ok boolean := true; v_a uuid;
begin
  perform public.assert_service_role();
  v_limit := (public.cfg('model_calls_per_day_' || p_task, '0'))::int;
  v_per := (public.cfg('model_calls_per_day_per_account', '0'))::int;
  insert into public.model_usage (day, task, account_id, calls) values (current_date, p_task, '00000000-0000-0000-0000-000000000000', 1)
    on conflict (day, task, account_id) do update set calls = public.model_usage.calls + 1 returning calls into v_calls;
  if v_limit > 0 and v_calls > v_limit then v_ok := false; end if;
  -- a shared generation (a question for two people) counts against both accounts
  foreach v_a in array coalesce(p_accounts, '{}') loop
    insert into public.model_usage (day, task, account_id, calls) values (current_date, p_task, v_a, 1)
      on conflict (day, task, account_id) do update set calls = public.model_usage.calls + 1 returning calls into v_calls;
    if v_per > 0 and v_calls > v_per then v_ok := false; end if;
  end loop;
  return v_ok;
end $$;
revoke execute on function public.take_model_budget(text, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reminder claims can be recovered after an interrupted worker
-- ---------------------------------------------------------------------------
alter table public.reminder_sends add column if not exists claimed_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 1. Retention keeps what an open appeal needs
-- ---------------------------------------------------------------------------
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
  delete from public.question_answers a using public.conversations c
    where a.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n5 = row_count;
  -- a question stays while a pending answer to it is under an open appeal: deleting it
  -- would cascade through the answer row and the appeal itself
  delete from public.conversation_questions q using public.conversations c
    where q.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg)
      and not exists (select 1 from public.pending_messages pm join public.appeals ap on ap.pending_message_id = pm.id
                      where pm.question_id = q.id and ap.status = 'open');
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
