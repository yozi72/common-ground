-- Participation stats and badge tiers.
--
-- A conversation "counts" once at least one shared question was revealed in
-- it (both people answered), so abandoned matches don't inflate anything.
-- Exact counts are private to the account; a peer only ever sees coarse tiers.

create or replace function public.account_stats(p_account uuid)
returns table (people int, conversations int, friends int, full_rounds int, reconnections int)
language sql stable security definer set search_path = public as $$
  with mine as (
    select c.id, c.questions_asked, c.opening_question_count, c.connection_id
    from public.participants p
    join public.conversations c on c.id = p.conversation_id
    where p.account_id = p_account
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
    (select count(*)::int from mine where questions_asked >= opening_question_count),
    (select count(*)::int from mine where connection_id is not null)
$$;

-- Own stats (exact).
create or replace function public.my_stats()
returns table (people int, conversations int, friends int, full_rounds int, reconnections int)
language sql stable security definer set search_path = public as $$
  select * from public.account_stats(auth.uid())
$$;

-- Coarse tier thresholds shared by the app (src/lib/badges.ts) and the peer view.
create or replace function public.tier_of(p_value int, p_thresholds int[]) returns int
language sql immutable as $$
  select coalesce((select max(t) from unnest(p_thresholds) t where t <= p_value), 0)
$$;

-- What a participant may know about the other person: tier floors only.
create or replace function public.peer_badges(p_conversation uuid)
returns table (people_tier int, friends_tier int, full_round boolean, came_back boolean)
language sql stable security definer set search_path = public as $$
  select
    public.tier_of(s.people, array[1,5,10,25,50,100]),
    public.tier_of(s.friends, array[1,2,5,10,25]),
    s.full_rounds > 0,
    s.reconnections > 0
  from public.participants p
  cross join lateral public.account_stats(p.account_id) s
  where p.conversation_id = p_conversation
    and p.account_id <> auth.uid()
    and public.is_participant(p_conversation)
$$;

revoke execute on function public.account_stats(uuid) from public, anon, authenticated;
