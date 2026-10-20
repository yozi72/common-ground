-- Questionnaire v2: eight specific policy questions, normalized 0..1 answers,
-- explicit non-answers, issue priorities, pair scoring with a minimum overlap,
-- and a fresh start for questionnaire data (no real users yet).

alter table public.profiles
  add column if not exists political_nonanswers jsonb not null default '{}'::jsonb,
  add column if not exists issue_priorities text[] not null default '{}',
  add column if not exists questionnaire_version int not null default 2;

-- Thresholds for the new 0..1 score (provisional; see HANDOFF.md).
update public.policy_config set value = '0.4' where key = 'min_difference_score';
update public.policy_config set value = '0.2' where key = 'relaxed_difference_score';
delete from public.policy_config where key = 'min_answered_dimensions';
insert into public.policy_config (key, value) values ('min_shared_answers', '5') on conflict (key) do nothing;

-- Mean absolute distance over shared substantive answers (both numeric, 0..1).
-- Null when fewer than min_shared_answers overlap: insufficient information,
-- not agreement. Equal weight per question.
create or replace function public.difference_score(a jsonb, b jsonb) returns numeric
language sql stable security definer set search_path = public as $$
  with d as (
    select abs((a->>k)::numeric - (b->>k)::numeric) as diff
    from jsonb_object_keys(a) k
    where b ? k and jsonb_typeof(a->k) = 'number' and jsonb_typeof(b->k) = 'number'
  )
  select case when count(*) >= (public.cfg('min_shared_answers', '5'))::int then round(avg(diff), 3) else null end from d
$$;

create or replace function public.shared_answers(a jsonb, b jsonb) returns int
language sql immutable as $$
  select count(*)::int from jsonb_object_keys(a) k
  where b ? k and jsonb_typeof(a->k) = 'number' and jsonb_typeof(b->k) = 'number'
$$;

-- Onboarding with the new answer schema. Values are validated server-side.
drop function if exists public.complete_onboarding(text, text, text, text[], boolean, jsonb, text);
create or replace function public.complete_onboarding(
  p_age_band text, p_region text, p_community text, p_life_context text[],
  p_share_context boolean, p_political_answers jsonb, p_political_nonanswers jsonb,
  p_issue_priorities text[], p_questionnaire_version int, p_terms_version text
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.assert_user(); k text;
begin
  if p_questionnaire_version is distinct from 2 then raise exception 'unsupported questionnaire version' using errcode = 'P0001'; end if;
  for k in select jsonb_object_keys(coalesce(p_political_answers, '{}'::jsonb)) loop
    if jsonb_typeof(p_political_answers->k) <> 'number' or (p_political_answers->>k)::numeric < 0 or (p_political_answers->>k)::numeric > 1 then
      raise exception 'answer out of range' using errcode = 'P0001';
    end if;
    if coalesce(p_political_nonanswers, '{}'::jsonb) ? k then raise exception 'answer and non-answer for the same question' using errcode = 'P0001'; end if;
  end loop;
  for k in select jsonb_object_keys(coalesce(p_political_nonanswers, '{}'::jsonb)) loop
    if (p_political_nonanswers->>k) not in ('unsure', 'declined') then raise exception 'bad non-answer' using errcode = 'P0001'; end if;
  end loop;
  if coalesce(array_length(p_issue_priorities, 1), 0) > 2 then raise exception 'at most two priorities' using errcode = 'P0001'; end if;

  update public.accounts set adult_attested_at = coalesce(adult_attested_at, now()), onboarding_complete = true where id = v_uid;
  update public.profiles set
    age_band = p_age_band, region = p_region, community = p_community,
    life_context = coalesce(p_life_context, '{}'), share_context_with_prompts = p_share_context,
    political_answers = coalesce(p_political_answers, '{}'::jsonb),
    political_nonanswers = coalesce(p_political_nonanswers, '{}'::jsonb),
    issue_priorities = coalesce(p_issue_priorities, '{}'),
    questionnaire_version = p_questionnaire_version,
    updated_at = now()
    where account_id = v_uid;
  insert into public.consent_events (account_id, kind, version, granted) values
    (v_uid, 'terms', p_terms_version, true),
    (v_uid, 'profile_context', p_terms_version, p_share_context);
end $$;

-- join_queue: no minimum number of answers (people with few answers can still
-- be matched via "anyone available"); everything else unchanged.
create or replace function public.join_queue(p_notify_email boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_id uuid;
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
  if exists (select 1 from public.participants p join public.conversations c on c.id = p.conversation_id
             where p.account_id = v_uid and c.status <> 'ended' and p.left_at is null) then
    raise exception 'already in a conversation' using errcode = 'P0001';
  end if;
  select * into v_existing from public.availability_requests where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_existing.id is not null then
    if v_existing.session_start = v_win.session_start then
      update public.availability_requests set last_seen_at = now(), paused_at = null, paused_reason = null where id = v_existing.id;
      return v_existing.id;
    end if;
    update public.availability_requests set status = 'expired', ended_at = now() where id = v_existing.id;
  end if;
  if not public.take_rate_limit('join_queue', 20, 3600) then raise exception 'rate limited' using errcode = 'P0002'; end if;
  insert into public.availability_requests (account_id, notify_email, expires_at, session_start, last_seen_at)
    values (v_uid, p_notify_email, v_win.session_end, v_win.session_start, now()) returning id into v_id;
  perform public.log_metric('queue_join', v_uid, v_win.session_start, null);
  if p_notify_email then
    insert into public.consent_events (account_id, kind, version, granted) values (v_uid, 'waiting_email', 'v1', true);
  end if;
  return v_id;
end $$;

-- set_broaden: someone with fewer than min_shared_answers substantive answers
-- can choose "anyone available" right away (it is the only way they can match).
create or replace function public.set_broaden(p_level text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.assert_user();
  v_r public.availability_requests%rowtype;
  v_relaxed_after int := (public.cfg('broaden_relaxed_after_seconds', '60'))::int;
  v_any_after int := (public.cfg('broaden_any_after_seconds', '120'))::int;
  v_min_shared int := (public.cfg('min_shared_answers', '5'))::int;
  v_waited numeric;
  v_answered int;
begin
  if p_level not in ('strict', 'relaxed', 'any') then raise exception 'bad level' using errcode = 'P0001'; end if;
  select * into v_r from public.availability_requests where account_id = v_uid and status in ('waiting', 'invited') for update;
  if v_r.id is null then raise exception 'not waiting' using errcode = 'P0001'; end if;
  select public.answered_dimensions(political_answers) into v_answered from public.profiles where account_id = v_uid;
  v_waited := extract(epoch from (now() - v_r.created_at));
  if p_level = 'relaxed' and v_waited < v_relaxed_after then raise exception 'not yet available' using errcode = 'P0001'; end if;
  if p_level = 'any' and v_waited < v_any_after and v_answered >= v_min_shared then raise exception 'not yet available' using errcode = 'P0001'; end if;
  update public.availability_requests set broaden = p_level where id = v_r.id;
  perform public.log_metric('broaden_selected', v_uid, v_r.session_start, v_waited, jsonb_build_object('level', p_level));
end $$;

-- run_matching: same readiness/priority/block rules; the pair rule now uses the
-- normalized score, requires the same questionnaire version, and treats a null
-- score (insufficient overlap) as matchable only when both chose "anyone".
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

    insert into public.match_invitations (kind, difference_score, expires_at)
      values ('match', v_partner.score, now() + make_interval(secs => v_ttl)) returning id into v_inv;
    insert into public.invitation_participants (invitation_id, account_id, availability_request_id) values
      (v_inv, v_waiter.account_id, v_waiter.id), (v_inv, v_partner.account_id, v_partner.id);
    update public.availability_requests set status = 'invited', matched_invitation_id = v_inv, invited_at = now()
      where id in (v_waiter.id, v_partner.id);
    insert into public.notifications (account_id, kind, payload) values
      (v_waiter.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv)),
      (v_partner.account_id, 'invitation', jsonb_build_object('invitation_id', v_inv));
    perform public.log_metric('invitation_created', v_waiter.account_id, v_win.session_start, extract(epoch from (now() - v_waiter.created_at)), jsonb_build_object('score', v_partner.score, 'shared', v_partner.shared));
    perform public.log_metric('invitation_created', v_partner.account_id, v_win.session_start, extract(epoch from (now() - v_partner.created_at)), jsonb_build_object('score', v_partner.score, 'shared', v_partner.shared));
    v_pairs := v_pairs + 1;
  end loop;
  return v_pairs;
end $$;

-- Fresh start: no real users yet. Clear questionnaire data, queue entries and
-- pending invitations; accounts, roles, consent history and conversations stay.
update public.profiles set political_answers = '{}'::jsonb, political_nonanswers = '{}'::jsonb, issue_priorities = '{}', questionnaire_version = 2;
update public.accounts set onboarding_complete = false;
update public.availability_requests set status = 'cancelled', ended_at = now() where status in ('waiting', 'invited');
update public.match_invitations set status = 'expired', resolved_at = now() where status = 'pending';

revoke execute on function public.run_matching() from public, anon, authenticated;
