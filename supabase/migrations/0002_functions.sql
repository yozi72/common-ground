-- Common Ground — transactional functions
--
-- Two kinds of functions live here:
--   * user RPCs: SECURITY DEFINER, start by checking auth.uid(), and only ever
--     return data the caller is allowed to see (never a peer's account id).
--   * worker RPCs: callable by the service role only; EXECUTE is revoked from
--     authenticated. The app's cron/worker routes call these.

create or replace function public.assert_service_role() returns void
language plpgsql as $$
begin
  -- auth.role() is the JWT role claim: 'anon'/'authenticated' for end users,
  -- 'service_role' for workers, null for direct database sessions.
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'service role required' using errcode = '42501';
  end if;
end $$;

create or replace function public.assert_user() returns uuid
language plpgsql as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------

create or replace function public.complete_onboarding(
  p_age_band text, p_region text, p_community text, p_life_context text[],
  p_share_context boolean, p_political_answers jsonb, p_terms_version text
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  update public.accounts set adult_attested_at = coalesce(adult_attested_at, now()), onboarding_complete = true
    where id = v_uid;
  update public.profiles set
    age_band = p_age_band, region = p_region, community = p_community,
    life_context = coalesce(p_life_context, '{}'), share_context_with_prompts = p_share_context,
    political_answers = coalesce(p_political_answers, '{}'::jsonb), updated_at = now()
    where account_id = v_uid;
  insert into public.consent_events (account_id, kind, version, granted) values
    (v_uid, 'terms', p_terms_version, true),
    (v_uid, 'profile_context', p_terms_version, p_share_context);
end $$;

-- ---------------------------------------------------------------------------
-- Matching distance
-- ---------------------------------------------------------------------------

-- Mean absolute difference over dimensions both people answered; null when
-- fewer than min_answered_dimensions overlap. "unsure" is stored as 0 (center)
-- by the client; a skipped dimension is absent from the json.
create or replace function public.difference_score(a jsonb, b jsonb) returns numeric
language sql immutable as $$
  with d as (
    select abs((a->>k)::numeric - (b->>k)::numeric) as diff
    from jsonb_object_keys(a) k
    where b ? k and jsonb_typeof(a->k) = 'number' and jsonb_typeof(b->k) = 'number'
  )
  select case when count(*) >= 2 then round(avg(diff), 3) else null end from d
$$;

create or replace function public.answered_dimensions(a jsonb) returns int
language sql immutable as $$
  select count(*)::int from jsonb_object_keys(a) k where jsonb_typeof(a->k) = 'number'
$$;

-- ---------------------------------------------------------------------------
-- Availability queue
-- ---------------------------------------------------------------------------

create or replace function public.join_queue(p_notify_email boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_id uuid;
  v_ttl int := (public.cfg('availability_ttl_seconds', '1800'))::int;
  v_min_dims int := (public.cfg('min_answered_dimensions', '3'))::int;
  v_existing uuid;
begin
  if not exists (select 1 from public.accounts where id = v_uid and onboarding_complete) then
    raise exception 'onboarding incomplete' using errcode = 'P0001';
  end if;
  if (select public.answered_dimensions(political_answers) from public.profiles where account_id = v_uid) < v_min_dims then
    raise exception 'answer at least % matching questions' , v_min_dims using errcode = 'P0001';
  end if;
  if exists (select 1 from public.participants p join public.conversations c on c.id = p.conversation_id
             where p.account_id = v_uid and c.status <> 'ended' and p.left_at is null) then
    raise exception 'already in a conversation' using errcode = 'P0001';
  end if;
  if not public.take_rate_limit('join_queue', 10, 3600) then
    raise exception 'rate limited' using errcode = 'P0002';
  end if;

  select id into v_existing from public.availability_requests
    where account_id = v_uid and status in ('waiting','invited');
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.availability_requests (account_id, notify_email, expires_at)
    values (v_uid, p_notify_email, now() + make_interval(secs => v_ttl))
    returning id into v_id;
  if p_notify_email then
    insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'waiting_email', 'v1', true);
  end if;
  return v_id;
end $$;

create or replace function public.leave_queue() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  update public.availability_requests set status = 'cancelled', ended_at = now()
    where account_id = v_uid and status = 'waiting';
end $$;

-- Worker: pair waiting requests. Serialized with an advisory lock so two ticks
-- cannot pair the same person twice. Oldest waiter first; partner is the
-- most-different eligible candidate, ties broken by wait time.
create or replace function public.run_matching() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_ttl int := (public.cfg('invitation_ttl_seconds', '180'))::int;
  v_min_diff numeric := (public.cfg('min_difference_score', '1.0'))::numeric;
  v_waiter record;
  v_partner record;
  v_inv uuid;
  v_pairs int := 0;
begin
  perform public.assert_service_role();
  perform pg_advisory_xact_lock(hashtext('common_ground_matching'));

  for v_waiter in
    select r.id, r.account_id, r.created_at, p.political_answers
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.expires_at > now()
    order by r.created_at
  loop
    -- the waiter may have been paired as someone else's partner earlier in this loop
    if not exists (select 1 from public.availability_requests where id = v_waiter.id and status = 'waiting') then
      continue;
    end if;

    select r.id, r.account_id, public.difference_score(v_waiter.political_answers, p.political_answers) as score
    into v_partner
    from public.availability_requests r
    join public.profiles p on p.account_id = r.account_id
    where r.status = 'waiting' and r.expires_at > now()
      and r.account_id <> v_waiter.account_id
      and not public.is_blocked_either_way(v_waiter.account_id, r.account_id)
      and public.difference_score(v_waiter.political_answers, p.political_answers) >= v_min_diff
    order by public.difference_score(v_waiter.political_answers, p.political_answers) desc, r.created_at
    limit 1;

    if v_partner.id is null then
      continue;
    end if;

    insert into public.match_invitations (kind, difference_score, expires_at)
      values ('match', v_partner.score, now() + make_interval(secs => v_ttl))
      returning id into v_inv;
    insert into public.invitation_participants (invitation_id, account_id, availability_request_id) values
      (v_inv, v_waiter.account_id, v_waiter.id),
      (v_inv, v_partner.account_id, v_partner.id);
    update public.availability_requests set status = 'invited', matched_invitation_id = v_inv
      where id in (v_waiter.id, v_partner.id);
    insert into public.notifications (account_id, kind, payload) values
      (v_waiter.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)),
      (v_partner.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv));
    insert into public.email_outbox (account_id, template, payload)
      select r.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)
      from public.availability_requests r where r.id in (v_waiter.id, v_partner.id) and r.notify_email;
    v_pairs := v_pairs + 1;
  end loop;
  return v_pairs;
end $$;

-- ---------------------------------------------------------------------------
-- Invitations → conversations
-- ---------------------------------------------------------------------------

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
begin
  select * into v_inv from public.match_invitations where id = p_invitation for update;
  if v_inv.conversation_id is not null then return v_inv.conversation_id; end if;

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
    insert into public.notifications (account_id, kind, payload) values
      (v_p.account_id, 'conversation_opened', jsonb_build_object('conversation_id', v_conv));
  end loop;

  update public.match_invitations set status = 'accepted', conversation_id = v_conv, resolved_at = now() where id = p_invitation;
  update public.availability_requests set status = 'matched', ended_at = now() where matched_invitation_id = p_invitation;
  return v_conv;
end $$;

-- Returns: {status: 'waiting_for_other' | 'opened' | 'declined' | 'expired', conversation_id?}
create or replace function public.respond_invitation(p_invitation uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_inv public.match_invitations%rowtype;
  v_mine public.invitation_participants%rowtype;
  v_all_accepted boolean;
  v_conv uuid;
begin
  -- Row lock serializes concurrent acceptances from both parties.
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
    -- decliner's request is cancelled; the other person goes back to waiting
    perform public.requeue_after_invitation(p_invitation, v_uid);
    return jsonb_build_object('status', 'declined');
  end if;

  select bool_and(decision = 'accepted') into v_all_accepted
    from public.invitation_participants where invitation_id = p_invitation;
  if v_all_accepted then
    v_conv := public.open_conversation_for_invitation(p_invitation);
    return jsonb_build_object('status', 'opened', 'conversation_id', v_conv);
  end if;
  return jsonb_build_object('status', 'waiting_for_other');
end $$;

-- After a decline/expiry: the decliner (if any) is cancelled; everyone else
-- whose request is still within its TTL returns to 'waiting'.
create or replace function public.requeue_after_invitation(p_invitation uuid, p_decliner uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.availability_requests r set status = 'cancelled', ended_at = now(), matched_invitation_id = null
    where r.matched_invitation_id = p_invitation and r.account_id = p_decliner;
  update public.availability_requests r
    set status = case when r.expires_at > now() then 'waiting'::public.availability_status else 'expired'::public.availability_status end,
        matched_invitation_id = null,
        ended_at = case when r.expires_at > now() then null else now() end
    where r.matched_invitation_id = p_invitation and r.status = 'invited';
end $$;

-- ---------------------------------------------------------------------------
-- Conversation presence and lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.heartbeat(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  update public.participants set last_seen_at = now()
    where conversation_id = p_conversation and account_id = v_uid and left_at is null;
end $$;

create or replace function public.end_conversation(p_conversation uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set status = 'ended', ended_at = now(), end_reason = p_reason
    where id = p_conversation and status <> 'ended';
  update public.pending_messages set status = 'cancelled', updated_at = now()
    where conversation_id = p_conversation and status in ('pending', 'review');
  insert into public.notifications (account_id, kind, payload)
    select p.account_id, 'conversation_ended', jsonb_build_object('conversation_id', p_conversation, 'reason', p_reason)
    from public.participants p where p.conversation_id = p_conversation;
end $$;

create or replace function public.leave_conversation(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user();
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  update public.participants set left_at = now() where conversation_id = p_conversation and account_id = v_uid and left_at is null;
  perform public.end_conversation(p_conversation, 'left');
end $$;

-- ---------------------------------------------------------------------------
-- Questions
-- ---------------------------------------------------------------------------

-- Worker: insert the next question. Resets mid-chat pacing.
create or replace function public.insert_question(
  p_conversation uuid, p_phase public.question_phase, p_text text, p_choices text[],
  p_followup_a text, p_followup_b text, p_source text, p_sensitive boolean, p_rationale text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_seq int;
  v_mult numeric := (public.cfg('question_gap_multiplier', '2'))::numeric;
  v_max int := (public.cfg('question_gap_max_seconds', '600'))::int;
begin
  perform public.assert_service_role();
  select coalesce(max(seq), 0) + 1 into v_seq from public.conversation_questions where conversation_id = p_conversation;
  insert into public.conversation_questions
    (conversation_id, seq, phase, question_text, choices, followup_a, followup_b, source, sensitive_topic_flag, rationale_internal)
    values (p_conversation, v_seq, p_phase, p_text, p_choices, p_followup_a, p_followup_b, p_source, p_sensitive, p_rationale)
    returning id into v_id;
  update public.conversations set
    questions_asked = questions_asked + 1,
    active_seconds_since_question = 0,
    question_gap_seconds = case when p_phase = 'mid' then least((question_gap_seconds * v_mult)::int, v_max) else question_gap_seconds end
    where id = p_conversation;
  return v_id;
end $$;

-- Reveal when both participants have a terminal answer. Returns true if newly revealed.
create or replace function public.maybe_reveal_question(p_question uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_q public.conversation_questions%rowtype;
  v_needed int;
  v_have int;
  v_conv public.conversations%rowtype;
begin
  select * into v_q from public.conversation_questions where id = p_question for update;
  if v_q.revealed_at is not null or v_q.status = 'closed' then return false; end if;
  select count(*) into v_needed from public.participants where conversation_id = v_q.conversation_id and left_at is null;
  select count(*) into v_have from public.question_answers
    where question_id = p_question and status in ('approved', 'skipped');
  if v_have < greatest(v_needed, 2) then return false; end if;

  update public.conversation_questions set revealed_at = now(), status = 'revealed' where id = p_question;

  select * into v_conv from public.conversations where id = v_q.conversation_id for update;
  if v_conv.status = 'opening' and v_q.phase = 'opening' and v_q.seq >= v_conv.opening_question_count then
    update public.conversations set status = 'chatting', chat_started_at = now(), last_activity_at = now()
      where id = v_q.conversation_id;
  end if;
  return true;
end $$;

-- Picks one of the three choices. Returns {revealed: bool}.
create or replace function public.answer_with_choice(p_question uuid, p_choice int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_q public.conversation_questions%rowtype;
  v_pid uuid;
begin
  select * into v_q from public.conversation_questions where id = p_question;
  if v_q.id is null or not public.is_participant(v_q.conversation_id) then
    raise exception 'not a participant' using errcode = '42501';
  end if;
  if v_q.status <> 'open' then raise exception 'question closed' using errcode = 'P0001'; end if;
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
  v_uid uuid := public.assert_user();
  v_q public.conversation_questions%rowtype;
  v_pid uuid;
begin
  select * into v_q from public.conversation_questions where id = p_question;
  if v_q.id is null or not public.is_participant(v_q.conversation_id) then
    raise exception 'not a participant' using errcode = '42501';
  end if;
  if v_q.status <> 'open' then raise exception 'question closed' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(v_q.conversation_id);
  insert into public.question_answers (question_id, participant_id, conversation_id, status)
    values (p_question, v_pid, v_q.conversation_id, 'skipped')
    on conflict (question_id, participant_id) do update
      set choice_index = null, custom_text = null, status = 'skipped', updated_at = now()
      where public.question_answers.status <> 'approved';
  return jsonb_build_object('revealed', public.maybe_reveal_question(p_question));
end $$;

-- ---------------------------------------------------------------------------
-- Sending: everything lands in pending_messages first
-- ---------------------------------------------------------------------------

-- Idempotent on (conversation, client_send_id). Returns the pending row id.
create or replace function public.submit_message(
  p_conversation uuid, p_client_send_id text, p_body text,
  p_kind public.message_kind default 'chat', p_question uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_pid uuid;
  v_id uuid;
  v_status public.conversation_status;
begin
  select status into v_status from public.conversations where id = p_conversation;
  if v_status is null or not public.is_participant(p_conversation) then
    raise exception 'not a participant' using errcode = '42501';
  end if;
  if v_status = 'ended' then raise exception 'conversation ended' using errcode = 'P0001'; end if;
  v_pid := public.my_participant_id(p_conversation);
  if exists (select 1 from public.participants where id = v_pid and left_at is not null) then
    raise exception 'you left this conversation' using errcode = 'P0001';
  end if;
  if p_kind = 'chat' and v_status <> 'chatting' then
    raise exception 'chat opens after the opening questions' using errcode = 'P0001';
  end if;
  if p_kind = 'answer' then
    if p_question is null or not exists (
      select 1 from public.conversation_questions where id = p_question and conversation_id = p_conversation and status = 'open'
    ) then raise exception 'question not open' using errcode = 'P0001'; end if;
  end if;

  select id into v_id from public.pending_messages where conversation_id = p_conversation and client_send_id = p_client_send_id;
  if v_id is not null then return v_id; end if;

  if not public.take_rate_limit('send', 30, 60) then
    raise exception 'rate limited' using errcode = 'P0002';
  end if;

  insert into public.pending_messages (conversation_id, sender_participant_id, client_send_id, kind, question_id, body)
    values (p_conversation, v_pid, p_client_send_id, p_kind, p_question, p_body)
    returning id into v_id;

  if p_kind = 'answer' then
    insert into public.question_answers (question_id, participant_id, conversation_id, status, pending_message_id)
      values (p_question, v_pid, p_conversation, 'pending', v_id)
      on conflict (question_id, participant_id) do update
        set choice_index = null, custom_text = null, status = 'pending', pending_message_id = v_id, updated_at = now()
        where public.question_answers.status <> 'approved';
  end if;
  return v_id;
end $$;

create or replace function public.cancel_pending(p_pending uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_m public.pending_messages%rowtype;
begin
  select * into v_m from public.pending_messages where id = p_pending for update;
  if v_m.id is null or v_m.sender_participant_id <> public.my_participant_id(v_m.conversation_id) then
    raise exception 'not your message' using errcode = '42501';
  end if;
  if v_m.status in ('pending', 'review', 'revise', 'failed', 'blocked') then
    update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then
      delete from public.question_answers where pending_message_id = p_pending and status <> 'approved';
    end if;
  end if;
end $$;

-- Sender accepts the suggested revision: a new pending message is created and
-- goes through moderation again. Nothing is ever delivered unseen by the sender.
create or replace function public.accept_revision(p_pending uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_m public.pending_messages%rowtype;
begin
  select * into v_m from public.pending_messages where id = p_pending;
  if v_m.id is null or v_m.sender_participant_id <> public.my_participant_id(v_m.conversation_id) then
    raise exception 'not your message' using errcode = '42501';
  end if;
  if v_m.status <> 'revise' or v_m.suggested_revision is null then
    raise exception 'no revision to accept' using errcode = 'P0001';
  end if;
  update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
  return public.submit_message(v_m.conversation_id, v_m.client_send_id || ':rev:' || v_m.attempts, v_m.suggested_revision, v_m.kind, v_m.question_id);
end $$;

create or replace function public.file_appeal(p_pending uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_m public.pending_messages%rowtype;
  v_id uuid;
begin
  select * into v_m from public.pending_messages where id = p_pending;
  if v_m.id is null or v_m.sender_participant_id <> public.my_participant_id(v_m.conversation_id) then
    raise exception 'not your message' using errcode = '42501';
  end if;
  if v_m.status not in ('blocked', 'revise') then raise exception 'nothing to appeal' using errcode = 'P0001'; end if;
  if not public.take_rate_limit('appeal', 5, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.appeals (pending_message_id, account_id, note) values (p_pending, v_uid, left(p_note, 1000)) returning id into v_id;
  return v_id;
end $$;

-- Worker: claim a batch of pending messages for moderation.
create or replace function public.claim_pending(p_limit int default 10)
returns setof public.pending_messages language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_service_role();
  return query
    update public.pending_messages m
      set attempts = attempts + 1, next_attempt_at = now() + interval '20 seconds', updated_at = now()
      where m.id in (
        select id from public.pending_messages
        where status = 'pending' and next_attempt_at <= now()
        order by created_at
        for update skip locked
        limit p_limit
      )
      returning m.*;
end $$;

-- Worker: enforce a moderation decision. The only path that writes approved_messages.
-- Returns {question_due: bool, revealed: bool}.
create or replace function public.apply_moderation_decision(
  p_pending uuid, p_decision text, p_categories text[], p_user_explanation text,
  p_suggested_revision text, p_confidence numeric, p_detector_hits text[],
  p_provider text, p_model text, p_raw_valid boolean, p_latency_ms int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_m public.pending_messages%rowtype;
  v_conv public.conversations%rowtype;
  v_quiet_cap int := (public.cfg('quiet_cap_seconds', '60'))::int;
  v_delta int;
  v_due boolean := false;
  v_revealed boolean := false;
  v_approved uuid;
begin
  perform public.assert_service_role();
  select * into v_m from public.pending_messages where id = p_pending for update;
  if v_m.id is null then raise exception 'pending not found'; end if;
  if v_m.status not in ('pending', 'review') then
    -- already resolved (duplicate worker run, or cancelled by sender)
    return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true);
  end if;

  insert into public.moderation_decisions
    (pending_message_id, decision, categories, user_explanation, suggested_revision, confidence, detector_hits, provider, model, raw_valid, latency_ms)
    values (p_pending, p_decision, coalesce(p_categories, '{}'), p_user_explanation, p_suggested_revision, p_confidence,
            coalesce(p_detector_hits, '{}'), p_provider, p_model, p_raw_valid, p_latency_ms);

  if p_decision = 'allow' then
    select * into v_conv from public.conversations where id = v_m.conversation_id for update;
    if v_conv.status = 'ended' then
      update public.pending_messages set status = 'cancelled', updated_at = now() where id = p_pending;
      return jsonb_build_object('question_due', false, 'revealed', false, 'skipped', true);
    end if;

    insert into public.approved_messages (conversation_id, sender_participant_id, pending_message_id, kind, question_id, body)
      values (v_m.conversation_id, v_m.sender_participant_id, p_pending, v_m.kind, v_m.question_id, v_m.body)
      returning id into v_approved;
    update public.pending_messages set status = 'approved', updated_at = now() where id = p_pending;

    if v_m.kind = 'answer' then
      update public.question_answers set status = 'approved', custom_text = v_m.body, updated_at = now()
        where pending_message_id = p_pending;
      v_revealed := public.maybe_reveal_question(v_m.question_id);
    elsif v_conv.status = 'chatting' then
      v_delta := least(coalesce(extract(epoch from (now() - v_conv.last_activity_at))::int, 0), v_quiet_cap);
      update public.conversations set
        active_seconds_since_question = active_seconds_since_question + v_delta,
        last_activity_at = now()
        where id = v_conv.id
        returning active_seconds_since_question >= question_gap_seconds into v_due;
      -- only one open mid question at a time
      if v_due and exists (select 1 from public.conversation_questions where conversation_id = v_conv.id and status = 'open') then
        v_due := false;
      end if;
    end if;
  elsif p_decision = 'revise' then
    update public.pending_messages set status = 'revise', user_explanation = p_user_explanation,
      suggested_revision = p_suggested_revision, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then
      update public.question_answers set status = 'revise', updated_at = now() where pending_message_id = p_pending;
    end if;
  elsif p_decision = 'block' then
    update public.pending_messages set status = 'blocked', user_explanation = p_user_explanation, updated_at = now() where id = p_pending;
    if v_m.kind = 'answer' then
      update public.question_answers set status = 'blocked', updated_at = now() where pending_message_id = p_pending;
    end if;
  elsif p_decision = 'review' then
    update public.pending_messages set status = 'review', user_explanation = coalesce(p_user_explanation, 'Held for a human review.'), updated_at = now() where id = p_pending;
  else
    raise exception 'unknown decision %', p_decision;
  end if;

  return jsonb_build_object('question_due', v_due, 'revealed', v_revealed);
end $$;

-- Worker: moderation call failed; keep pending with backoff, or fail into review after many attempts.
create or replace function public.defer_pending(p_pending uuid, p_error text, p_max_attempts int default 6) returns void
language plpgsql security definer set search_path = public as $$
declare v_attempts int;
begin
  perform public.assert_service_role();
  select attempts into v_attempts from public.pending_messages where id = p_pending;
  if v_attempts >= p_max_attempts then
    update public.pending_messages set status = 'review', last_error = left(p_error, 500),
      user_explanation = 'Our review service is not responding. This message is held for a human review.', updated_at = now()
      where id = p_pending and status = 'pending';
  else
    update public.pending_messages set last_error = left(p_error, 500),
      next_attempt_at = now() + make_interval(secs => least(5 * power(2, v_attempts), 120)::int), updated_at = now()
      where id = p_pending and status = 'pending';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Blocks, reports
-- ---------------------------------------------------------------------------

create or replace function public.block_peer(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_peer uuid;
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  select account_id into v_peer from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  if v_peer is null then return; end if;
  insert into public.blocks (blocker_account_id, blocked_account_id, conversation_id) values (v_uid, v_peer, p_conversation)
    on conflict do nothing;
  update public.connections set status = 'ended', ended_at = now()
    where status = 'active' and ((account_a = v_uid and account_b = v_peer) or (account_a = v_peer and account_b = v_uid));
  update public.participants set left_at = now() where conversation_id = p_conversation and account_id = v_uid and left_at is null;
  perform public.end_conversation(p_conversation, 'blocked');
end $$;

create or replace function public.report_peer(p_conversation uuid, p_reason text, p_details text, p_message_ids uuid[], p_also_block boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_peer_pid uuid;
  v_id uuid;
begin
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if not public.take_rate_limit('report', 10, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  select id into v_peer_pid from public.participants where conversation_id = p_conversation and account_id <> v_uid;
  insert into public.reports (reporter_account_id, reported_participant_id, conversation_id, reason, details, message_ids)
    values (v_uid, v_peer_pid, p_conversation, p_reason, left(p_details, 2000), coalesce(p_message_ids, '{}'))
    returning id into v_id;
  if p_also_block then perform public.block_peer(p_conversation); end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Reconnection (friendship)
-- ---------------------------------------------------------------------------

-- Records this person's private decision. Only when both say yes does a
-- connection exist; the response then says 'connected'. A 'no' is never
-- revealed to the other person; they just never see 'connected'.
create or replace function public.set_connection_decision(p_conversation uuid, p_decision boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_pid uuid;
  v_peer record;
  v_version text := trim(both '"' from (public.cfg('friendship_policy_version', '"v1"'))::text);
  v_both boolean;
  v_conn uuid;
  v_a uuid; v_b uuid; v_alias_a text; v_alias_b text;
begin
  if not (public.cfg('friendship_enabled', 'true'))::boolean then
    raise exception 'reconnection is not enabled' using errcode = 'P0001';
  end if;
  if not public.is_participant(p_conversation) then raise exception 'not a participant' using errcode = '42501'; end if;
  if exists (select 1 from public.conversations where id = p_conversation and end_reason = 'blocked') then
    raise exception 'not available for this conversation' using errcode = 'P0001';
  end if;
  v_pid := public.my_participant_id(p_conversation);
  insert into public.connection_requests (conversation_id, participant_id, decision, policy_version)
    values (p_conversation, v_pid, p_decision, v_version)
    on conflict (conversation_id, participant_id) do update set decision = excluded.decision, created_at = now();
  insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'reconnect_policy', v_version, p_decision);

  if not p_decision then return jsonb_build_object('status', 'recorded'); end if;

  select p.account_id, a.alias into v_peer
    from public.participants p join public.participant_aliases a on a.participant_id = p.id
    where p.conversation_id = p_conversation and p.account_id <> v_uid;
  if v_peer.account_id is null then return jsonb_build_object('status', 'recorded'); end if;
  if public.is_blocked_either_way(v_uid, v_peer.account_id) then return jsonb_build_object('status', 'recorded'); end if;

  select bool_and(decision) into v_both from public.connection_requests where conversation_id = p_conversation;
  if not v_both or (select count(*) from public.connection_requests where conversation_id = p_conversation) < 2 then
    return jsonb_build_object('status', 'recorded');
  end if;

  -- stable ordering so (a,b) is unique regardless of who clicked last
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
  insert into public.notifications (account_id, kind, payload) values
    (v_a, 'connected', jsonb_build_object('connection_id', v_conn)),
    (v_b, 'connected', jsonb_build_object('connection_id', v_conn));
  return jsonb_build_object('status', 'connected', 'connection_id', v_conn);
end $$;

create or replace function public.my_connections()
returns table (connection_id uuid, peer_alias text, my_alias text, since timestamptz, status text, pending_invitation_id uuid)
language sql security definer set search_path = public as $$
  select c.id,
         case when c.account_a = auth.uid() then c.alias_b else c.alias_a end,
         case when c.account_a = auth.uid() then c.alias_a else c.alias_b end,
         c.created_at, c.status,
         (select i.id from public.match_invitations i where i.connection_id = c.id and i.status = 'pending' and i.expires_at > now() limit 1)
  from public.connections c
  where (c.account_a = auth.uid() or c.account_b = auth.uid())
  order by c.created_at desc
$$;

-- Creates a reconnect invitation for both parties; the requester is auto-accepted.
create or replace function public.request_reconnection(p_connection uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_c public.connections%rowtype;
  v_inv uuid;
  v_ttl int := 86400; -- a day: reconnections are not live-queue invitations
  v_peer uuid;
begin
  if not (public.cfg('friendship_enabled', 'true'))::boolean then raise exception 'reconnection is not enabled' using errcode = 'P0001'; end if;
  select * into v_c from public.connections where id = p_connection and status = 'active' and (account_a = v_uid or account_b = v_uid);
  if v_c.id is null then raise exception 'connection not found' using errcode = '42501'; end if;
  if not public.take_rate_limit('reconnect', 5, 86400) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  select id into v_inv from public.match_invitations where connection_id = p_connection and status = 'pending' and expires_at > now();
  if v_inv is not null then return v_inv; end if;
  if exists (select 1 from public.conversations where connection_id = p_connection and status <> 'ended') then
    raise exception 'a conversation is already open' using errcode = 'P0001';
  end if;
  v_peer := case when v_c.account_a = v_uid then v_c.account_b else v_c.account_a end;
  insert into public.match_invitations (kind, connection_id, expires_at) values ('reconnect', p_connection, now() + make_interval(secs => v_ttl))
    returning id into v_inv;
  insert into public.invitation_participants (invitation_id, account_id, decision, decided_at) values
    (v_inv, v_uid, 'accepted', now()), (v_inv, v_peer, null, null);
  insert into public.notifications (account_id, kind, payload) values (v_peer, 'reconnect_invitation', jsonb_build_object('invitation_id', v_inv));
  insert into public.email_outbox (account_id, template, payload) values (v_peer, 'reconnect_invitation', jsonb_build_object('invitation_id', v_inv));
  return v_inv;
end $$;

-- ---------------------------------------------------------------------------
-- Housekeeping (worker)
-- ---------------------------------------------------------------------------

create or replace function public.expire_stale() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv record;
  v_away int := (public.cfg('partner_away_after_seconds', '120'))::int;
  v_abandon int := (public.cfg('abandon_after_seconds', '600'))::int;
  v_cancel_after int := (public.cfg('pending_cancel_after_seconds', '45'))::int;
  v_conv record;
  n_inv int := 0; n_avail int := 0; n_away int := 0; n_abandoned int := 0; n_q int := 0;
begin
  perform public.assert_service_role();

  for v_inv in select id from public.match_invitations where status = 'pending' and expires_at < now() for update skip locked loop
    update public.match_invitations set status = 'expired', resolved_at = now() where id = v_inv.id;
    perform public.requeue_after_invitation(v_inv.id, null);
    n_inv := n_inv + 1;
  end loop;

  update public.availability_requests set status = 'expired', ended_at = now()
    where status = 'waiting' and expires_at < now();
  get diagnostics n_avail = row_count;

  -- partner away: notify the other side once
  for v_conv in
    select c.id, p.account_id as away_account
    from public.conversations c
    join public.participants p on p.conversation_id = c.id
    where c.status <> 'ended' and c.partner_away_notified_at is null and p.left_at is null
      and p.last_seen_at < now() - make_interval(secs => v_away)
  loop
    update public.conversations set partner_away_notified_at = now() where id = v_conv.id;
    insert into public.notifications (account_id, kind, payload)
      select p.account_id, 'partner_away', jsonb_build_object('conversation_id', v_conv.id)
      from public.participants p where p.conversation_id = v_conv.id and p.account_id <> v_conv.away_account;
    n_away := n_away + 1;
  end loop;

  -- abandoned: a participant silent for abandon_after_seconds
  for v_conv in
    select distinct c.id from public.conversations c
    join public.participants p on p.conversation_id = c.id
    where c.status <> 'ended' and p.left_at is null and p.last_seen_at < now() - make_interval(secs => v_abandon)
  loop
    perform public.end_conversation(v_conv.id, 'abandoned');
    n_abandoned := n_abandoned + 1;
  end loop;

  -- mid-chat questions nobody finished within 10 minutes close unrevealed
  update public.conversation_questions set status = 'closed'
    where status = 'open' and phase = 'mid' and created_at < now() - interval '10 minutes';
  get diagnostics n_q = row_count;

  return jsonb_build_object('invitations_expired', n_inv, 'availability_expired', n_avail,
    'partner_away', n_away, 'abandoned', n_abandoned, 'questions_closed', n_q,
    'pending_cancel_after_seconds', v_cancel_after);
end $$;

create or replace function public.purge_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d_msg int := (public.cfg('retention_messages_days', '30'))::int;
  d_pending int := (public.cfg('retention_pending_days', '7'))::int;
  d_reports int := (public.cfg('retention_reports_days', '365'))::int;
  n1 int; n2 int; n3 int; n4 int;
begin
  perform public.assert_service_role();
  delete from public.approved_messages m using public.conversations c
    where m.conversation_id = c.id and c.status = 'ended' and c.ended_at < now() - make_interval(days => d_msg);
  get diagnostics n1 = row_count;
  delete from public.pending_messages where status <> 'pending' and updated_at < now() - make_interval(days => d_pending)
    and not exists (select 1 from public.appeals a where a.pending_message_id = pending_messages.id and a.status = 'open');
  get diagnostics n2 = row_count;
  delete from public.reports where status in ('resolved', 'dismissed') and resolved_at < now() - make_interval(days => d_reports);
  get diagnostics n3 = row_count;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics n4 = row_count;
  delete from public.notifications where created_at < now() - interval '30 days';
  return jsonb_build_object('messages', n1, 'pending', n2, 'reports', n3, 'rate_limits', n4);
end $$;

-- Deletion propagation: everything is FK-cascaded from accounts → auth.users.
-- The app deletes the auth user with the service role; this function covers
-- the pieces that should not cascade silently (ending live state, notifying peers).
create or replace function public.prepare_account_deletion(p_account uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_conv record;
begin
  perform public.assert_service_role();
  for v_conv in select c.id from public.conversations c join public.participants p on p.conversation_id = c.id
                where p.account_id = p_account and c.status <> 'ended' loop
    perform public.end_conversation(v_conv.id, 'left');
  end loop;
  update public.availability_requests set status = 'cancelled', ended_at = now() where account_id = p_account and status in ('waiting','invited');
  update public.connections set status = 'ended', ended_at = now() where account_a = p_account or account_b = p_account;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: worker functions are service-role only
-- ---------------------------------------------------------------------------

revoke execute on function public.run_matching() from public, anon, authenticated;
revoke execute on function public.insert_question(uuid, public.question_phase, text, text[], text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.claim_pending(int) from public, anon, authenticated;
revoke execute on function public.apply_moderation_decision(uuid, text, text[], text, text, numeric, text[], text, text, boolean, int) from public, anon, authenticated;
revoke execute on function public.defer_pending(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.expire_stale() from public, anon, authenticated;
revoke execute on function public.purge_retention() from public, anon, authenticated;
revoke execute on function public.prepare_account_deletion(uuid) from public, anon, authenticated;
revoke execute on function public.open_conversation_for_invitation(uuid) from public, anon, authenticated;
revoke execute on function public.requeue_after_invitation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.end_conversation(uuid, text) from public, anon, authenticated;
revoke execute on function public.maybe_reveal_question(uuid) from public, anon, authenticated;
revoke execute on function public.assert_service_role() from public, anon, authenticated;
