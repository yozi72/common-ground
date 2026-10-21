-- Lock ordering for concurrent acceptances: per-account advisory locks are
-- taken BEFORE the invitation row lock, so two invitations involving the same
-- person serialize on that person instead of deadlocking (the winner must also
-- update the loser's invitation row).
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
  v_a uuid;
begin
  -- membership check first (no locks), then ordered per-account locks, then the row lock
  select * into v_mine from public.invitation_participants where invitation_id = p_invitation and account_id = v_uid;
  if v_mine.invitation_id is null then raise exception 'not your invitation' using errcode = '42501'; end if;
  for v_a in select account_id from public.invitation_participants where invitation_id = p_invitation order by account_id loop
    perform pg_advisory_xact_lock(hashtext('cg_account_' || v_a::text));
  end loop;
  select * into v_inv from public.match_invitations where id = p_invitation for update;
  if v_inv.id is null then raise exception 'invitation not found' using errcode = 'P0001'; end if;

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
