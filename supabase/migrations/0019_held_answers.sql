-- 0019: my_held_messages carries question_id so a held custom answer is tied
-- to the question it answered; the question card never shows an old held
-- answer's controls for the current question. Same rows, same access
-- (caller's own rows only); the return type changes, hence drop + create.
drop function if exists public.my_held_messages(uuid, int);
create function public.my_held_messages(p_conversation uuid, p_limit int default 50)
returns table (id uuid, kind public.message_kind, question_id uuid, body text, status public.pending_status, user_explanation text, suggested_revision text,
               undeliverable_reason text, created_at timestamptz,
               appeal_id uuid, appeal_status text, appeal_note text, appeal_resolution_note text, appeal_created_at timestamptz, appeal_resolved_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.kind, m.question_id, m.body, m.status, m.user_explanation, m.suggested_revision, m.undeliverable_reason, m.created_at,
         a.id, a.status, a.note, a.resolution_note, a.created_at, a.resolved_at
  from public.pending_messages m
  left join lateral (select * from public.appeals x where x.pending_message_id = m.id order by x.created_at desc limit 1) a on true
  where m.conversation_id = p_conversation
    and m.sender_participant_id = public.my_participant_id(p_conversation)
    and (m.status in ('revise', 'blocked') or (m.status in ('cancelled', 'approved') and a.id is not null))
  order by m.created_at desc
  limit greatest(1, least(p_limit, 200))
$$;
grant execute on function public.my_held_messages(uuid, int) to authenticated;
