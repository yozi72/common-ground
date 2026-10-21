-- Fourth external review (commit 25affa1 / 0687936):
--  1. HIGH: a blocked (or departed) person could still finish an open question
--     and trigger the reveal of the other person's answer. Ending a conversation
--     for any reason now closes its open questions, and answer/skip/reveal
--     enforce the conversation's state and blocks.
--  2. A removed friendship could be re-activated by one person because the
--     other person's old "yes" was still counted. Decisions are revoked when a
--     friendship ends; restoring needs a fresh yes from both, and then the
--     thread comes back with the connection.
--  3. Queued friend pushes ignored later mute / removal / block / read. The
--     claim re-checks all of that; those actions cancel queued rows.
--  4. Friend-push delivery failures now retry (3 attempts, backoff) instead of
--     being lost. Rows stuck in 'claimed' are reclaimed after 10 minutes.
--  5. mark_thread_read can be bounded to the newest message the client has
--     actually loaded (never moves backwards).

-- ---------------------------------------------------------------------------
-- 1. Questions follow the conversation state
-- ---------------------------------------------------------------------------
create or replace function public.end_conversation(p_conversation uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set status = 'ended', ended_at = now(), end_reason = p_reason
    where id = p_conversation and status <> 'ended';
  update public.pending_messages set status = 'cancelled', updated_at = now()
    where conversation_id = p_conversation and status in ('pending', 'review');
  -- nothing unfinished can be completed (and so revealed) after the end
  update public.conversation_questions set status = 'closed'
    where conversation_id = p_conversation and status = 'open';
  update public.push_queue set status = 'cancelled', last_error = 'conversation ended'
    where conversation_id = p_conversation and status in ('queued', 'claimed');
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'conversation_ended', jsonb_build_object('conversation_id', p_conversation, 'reason', p_reason)
    from public.participants p where p.conversation_id = p_conversation;
end $$;

-- Shared guard for answering: open question, active conversation, caller still
-- in it, no block between the two people.
create or replace function public.assert_can_answer(p_question uuid) returns public.conversation_questions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_q public.conversation_questions%rowtype;
  v_status public.conversation_status;
  v_peer uuid;
begin
  select * into v_q from public.conversation_questions where id = p_question;
  if v_q.id is null or not public.is_participant(v_q.conversation_id) then
    raise exception 'not a participant' using errcode = '42501';
  end if;
  select status into v_status from public.conversations where id = v_q.conversation_id;
  if v_status = 'ended' then raise exception 'conversation ended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.participants where conversation_id = v_q.conversation_id and account_id = v_uid and left_at is not null) then
    raise exception 'you left this conversation' using errcode = 'P0001';
  end if;
  select account_id into v_peer from public.participants where conversation_id = v_q.conversation_id and account_id <> v_uid limit 1;
  if v_peer is not null and public.is_blocked_either_way(v_uid, v_peer) then
    raise exception 'conversation ended' using errcode = 'P0001';
  end if;
  if v_q.status <> 'open' then raise exception 'question closed' using errcode = 'P0001'; end if;
  return v_q;
end $$;
revoke execute on function public.assert_can_answer(uuid) from public, anon, authenticated;

create or replace function public.answer_with_choice(p_question uuid, p_choice int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_q public.conversation_questions%rowtype := public.assert_can_answer(p_question);
  v_pid uuid;
begin
  if p_choice not between 0 and 2 then raise exception 'bad choice' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(v_q.conversation_id);
  insert into public.question_answers (question_id, participant_id, conversation_id, choice_index, status)
    values (p_question, v_pid, v_q.conversation_id, p_choice, 'approved')
    on conflict (question_id, participant_id) do update
      set choice_index = excluded.choice_index, custom_text = null, status = 'approved', updated_at = now()
      where public.question_answers.status <> 'approved';
  return jsonb_build_object('revealed', public.maybe_reveal_question(p_question));
end $$;

create or replace function public.skip_question(p_question uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_q public.conversation_questions%rowtype := public.assert_can_answer(p_question);
  v_pid uuid;
begin
  v_pid := public.my_participant_id(v_q.conversation_id);
  insert into public.question_answers (question_id, participant_id, conversation_id, status)
    values (p_question, v_pid, v_q.conversation_id, 'skipped')
    on conflict (question_id, participant_id) do update
      set choice_index = null, custom_text = null, status = 'skipped', updated_at = now()
      where public.question_answers.status <> 'approved';
  return jsonb_build_object('revealed', public.maybe_reveal_question(p_question));
end $$;

-- Reveal only inside a live, unblocked conversation; otherwise the question closes.
create or replace function public.maybe_reveal_question(p_question uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_q public.conversation_questions%rowtype;
  v_needed int;
  v_have int;
  v_conv public.conversations%rowtype;
  v_acc uuid[];
begin
  select * into v_q from public.conversation_questions where id = p_question for update;
  if v_q.revealed_at is not null or v_q.status = 'closed' then return false; end if;
  select * into v_conv from public.conversations where id = v_q.conversation_id for update;
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
  if v_conv.status = 'opening' and v_q.phase = 'opening' and v_q.seq >= v_conv.opening_question_count then
    update public.conversations set status = 'chatting', chat_started_at = now(), last_activity_at = now()
      where id = v_q.conversation_id;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Friendship consent is revoked when the friendship ends
-- ---------------------------------------------------------------------------
alter table public.connection_requests add column if not exists revoked_at timestamptz;

-- Revoke both people's decisions on every conversation between the two.
create or replace function public.revoke_connection_consent(p_a uuid, p_b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.connection_requests r set revoked_at = now()
    where r.revoked_at is null
      and exists (select 1 from public.participants p where p.conversation_id = r.conversation_id and p.account_id = p_a)
      and exists (select 1 from public.participants p where p.conversation_id = r.conversation_id and p.account_id = p_b);
end $$;
revoke execute on function public.revoke_connection_consent(uuid, uuid) from public, anon, authenticated;

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
  v_pid := public.my_participant_id(p_conversation);
  -- a fresh decision always replaces a revoked one
  insert into public.connection_requests (conversation_id, participant_id, decision, policy_version)
    values (p_conversation, v_pid, p_decision, v_version)
    on conflict (conversation_id, participant_id) do update set decision = excluded.decision, created_at = now(), revoked_at = null;
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'reconnect_policy', v_version, p_decision);

  if not p_decision then return jsonb_build_object('status', 'recorded'); end if;

  select p.account_id, a.alias into v_peer
    from public.participants p join public.participant_aliases a on a.participant_id = p.id
    where p.conversation_id = p_conversation and p.account_id <> v_uid;
  if v_peer.account_id is null then return jsonb_build_object('status', 'recorded'); end if;
  if public.is_blocked_either_way(v_uid, v_peer.account_id) then return jsonb_build_object('status', 'recorded'); end if;

  -- only current (unrevoked) decisions count: after a removal both must say yes again
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
  -- a restored friendship gets its thread back (history intact); a thread ended by a block stays ended
  update public.conversations set status = 'chatting', ended_at = null, end_reason = null
    where connection_id = v_conn and kind = 'friend' and status = 'ended' and end_reason = 'unfriended';
  insert into public.notifications (account_id, kind, payload) values
    (v_a, 'connected', jsonb_build_object('connection_id', v_conn)),
    (v_b, 'connected', jsonb_build_object('connection_id', v_conn));
  return jsonb_build_object('status', 'connected', 'connection_id', v_conn);
end $$;

-- Only unrevoked decisions are shown back to the person (a revoked one reads as "not decided").
drop policy if exists connection_requests_self on public.connection_requests;
create policy connection_requests_self on public.connection_requests for select to authenticated
  using (participant_id = public.my_participant_id(conversation_id) and revoked_at is null);

-- ---------------------------------------------------------------------------
-- 3 + 4. Push queue: cancel on mute/read/removal/block, re-check at claim, retry
-- ---------------------------------------------------------------------------
alter table public.push_queue drop constraint if exists push_queue_status_check;
alter table public.push_queue add constraint push_queue_status_check
  check (status in ('queued', 'claimed', 'sent', 'failed', 'skipped', 'cancelled'));
alter table public.push_queue add column if not exists attempts int not null default 0;
alter table public.push_queue add column if not exists next_attempt_at timestamptz not null default now();

create or replace function public.cancel_thread_pushes(p_conversation uuid, p_account uuid, p_why text) returns void
language sql security definer set search_path = public as $$
  update public.push_queue set status = 'cancelled', last_error = p_why
    where conversation_id = p_conversation and account_id = p_account and status in ('queued', 'claimed');
$$;
revoke execute on function public.cancel_thread_pushes(uuid, uuid, text) from public, anon, authenticated;

drop function if exists public.mark_thread_read(uuid);   -- the old overload would otherwise still be picked for one-argument calls
create or replace function public.mark_thread_read(p_conversation uuid, p_up_to timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_mark timestamptz := least(coalesce(p_up_to, now()), now());
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  insert into public.thread_reads (conversation_id, account_id, last_read_at) values (p_conversation, v_uid, v_mark)
    on conflict (conversation_id, account_id) do update set last_read_at = greatest(public.thread_reads.last_read_at, excluded.last_read_at);
  -- nothing left unread → a queued "new message" alert is obsolete
  if not exists (
    select 1 from public.approved_messages m join public.participants p on p.id = m.sender_participant_id
    where m.conversation_id = p_conversation and m.kind = 'chat' and p.account_id <> v_uid
      and m.created_at > (select last_read_at from public.thread_reads where conversation_id = p_conversation and account_id = v_uid)
  ) then
    perform public.cancel_thread_pushes(p_conversation, v_uid, 'read');
  end if;
end $$;

create or replace function public.set_thread_muted(p_conversation uuid, p_muted boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  insert into public.thread_reads (conversation_id, account_id, muted) values (p_conversation, v_uid, p_muted)
    on conflict (conversation_id, account_id) do update set muted = excluded.muted;
  if p_muted then perform public.cancel_thread_pushes(p_conversation, v_uid, 'muted'); end if;
end $$;

create or replace function public.remove_friend(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); v_c public.connections%rowtype; v_conv uuid;
begin
  select * into v_c from public.connections where id = p_connection and (account_a = v_uid or account_b = v_uid) for update;
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
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
  insert into public.blocks (blocker_account_id, blocked_account_id, conversation_id) values (v_uid, v_peer, p_conversation) on conflict do nothing;
  update public.connections set status = 'ended', ended_at = now()
    where status = 'active' and ((account_a = v_uid and account_b = v_peer) or (account_a = v_peer and account_b = v_uid));
  perform public.revoke_connection_consent(v_uid, v_peer);
  for v_t in select c.id from public.conversations c where c.status <> 'ended' and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_uid)
    and exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id = v_peer) loop
    update public.pending_messages set status = 'cancelled', updated_at = now() where conversation_id = v_t and status in ('pending', 'review', 'revise');
    update public.participants set left_at = now() where conversation_id = v_t and account_id = v_uid and left_at is null;
    perform public.end_conversation(v_t, 'blocked');   -- also closes open questions and cancels queued pushes
  end loop;
end $$;

-- Claim only alerts that are still warranted right now; everything else is
-- marked skipped with the reason. Stale claims (worker died) are reclaimed.
create or replace function public.claim_push_queue(p_limit int default 20)
returns setof public.push_queue language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  perform public.assert_service_role();
  select array_agg(id) into v_ids from (
    select id from public.push_queue
      where (status = 'queued' and next_attempt_at <= now()) or (status = 'claimed' and claimed_at < now() - interval '10 minutes')
      order by created_at for update skip locked limit p_limit
  ) s;
  if v_ids is null then return; end if;

  update public.push_queue q set status = 'skipped', last_error = reason
    from (
      select q2.id,
        case
          when c.status = 'ended' then 'conversation ended'
          when not exists (select 1 from public.connections cn where cn.id = c.connection_id and cn.status = 'active') then 'friendship ended'
          when exists (select 1 from public.participants p where p.conversation_id = c.id and p.account_id <> q2.account_id
                       and public.is_blocked_either_way(q2.account_id, p.account_id)) then 'blocked'
          when not exists (select 1 from public.reminder_prefs rp where rp.account_id = q2.account_id and rp.friend_push_enabled) then 'opted out'
          when coalesce((select tr.muted from public.thread_reads tr where tr.conversation_id = c.id and tr.account_id = q2.account_id), false) then 'muted'
          when not exists (
            select 1 from public.approved_messages m join public.participants p on p.id = m.sender_participant_id
            where m.conversation_id = c.id and m.kind = 'chat' and p.account_id <> q2.account_id
              and m.created_at > coalesce((select tr.last_read_at from public.thread_reads tr where tr.conversation_id = c.id and tr.account_id = q2.account_id), 'epoch'::timestamptz)
          ) then 'already read'
          else null
        end as reason
      from public.push_queue q2 join public.conversations c on c.id = q2.conversation_id
      where q2.id = any (v_ids)
    ) chk
    where q.id = chk.id and chk.reason is not null;

  return query
    update public.push_queue q set status = 'claimed', claimed_at = now()
      where q.id = any (v_ids) and q.status in ('queued', 'claimed')
      returning q.*;
end $$;

-- Worker reports a delivery failure: retry with backoff (1, 2, 4 minutes), then give up.
create or replace function public.fail_push_queue(p_id uuid, p_error text, p_max_attempts int default 3) returns text
language plpgsql security definer set search_path = public as $$
declare v_attempts int; v_status text;
begin
  perform public.assert_service_role();
  update public.push_queue set attempts = attempts + 1, last_error = p_error,
      status = case when attempts + 1 >= p_max_attempts then 'failed' else 'queued' end,
      next_attempt_at = now() + (interval '1 minute' * power(2, attempts))
    where id = p_id returning attempts, status into v_attempts, v_status;
  return v_status;
end $$;
revoke execute on function public.fail_push_queue(uuid, text, int) from public, anon, authenticated;

-- Push rows for ended friendships/conversations that were queued before this migration
update public.push_queue q set status = 'cancelled', last_error = 'cleanup: conversation ended'
  from public.conversations c where c.id = q.conversation_id and c.status = 'ended' and q.status in ('queued', 'claimed');
-- Questions left open in ended conversations
update public.conversation_questions q set status = 'closed'
  from public.conversations c where c.id = q.conversation_id and c.status = 'ended' and q.status = 'open';
-- Decisions of friendships that already ended are revoked (fresh consent needed to restore)
update public.connection_requests r set revoked_at = now()
  from public.connections cn
  where r.revoked_at is null and cn.status = 'ended'
    and exists (select 1 from public.participants p where p.conversation_id = r.conversation_id and p.account_id = cn.account_a)
    and exists (select 1 from public.participants p where p.conversation_id = r.conversation_id and p.account_id = cn.account_b);
