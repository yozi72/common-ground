-- Common Ground — initial schema
--
-- Identity model
--   auth.users            private identity (email). Never exposed to another user.
--   accounts              app-side row per auth user (role, adult attestation).
--   participants          one row per (conversation, account): the private link.
--   participant_aliases   the public face: random alias per conversation.
--
-- Everything another user may see references participant ids, never account ids.
-- Clients only read through RLS or SECURITY DEFINER functions that project
-- away account ids. Workers (matching, moderation, retention) use the service
-- role and bypass RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.current_account_id() returns uuid
language sql stable as $$ select auth.uid() $$;

create table public.policy_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.cfg(p_key text, p_default jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.policy_config where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------------
-- Accounts, profiles, consent
-- ---------------------------------------------------------------------------

create type public.account_role as enum ('user', 'admin');

create table public.accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.account_role not null default 'user',
  adult_attested_at timestamptz,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.accounts where id = auth.uid() and role = 'admin')
$$;

-- Coarse, consented context. political_answers is the matching questionnaire:
-- five dimensions, each -2..2 or null (skipped). Never readable by another user.
create table public.profiles (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  age_band text check (age_band in ('18-24','25-34','35-44','45-54','55-64','65+')),
  region text check (region in ('northeast','midwest','south','west','other')),
  community text check (community in ('urban','suburban','rural','mixed')),
  life_context text[] not null default '{}',
  share_context_with_prompts boolean not null default false,
  political_answers jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.consent_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null,          -- 'terms', 'profile_context', 'waiting_email', 'reconnect_policy'
  version text not null,
  granted boolean not null,
  created_at timestamptz not null default now()
);
create index on public.consent_events (account_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Blocks (account level; never selectable by clients — see RPCs)
-- ---------------------------------------------------------------------------

create table public.blocks (
  blocker_account_id uuid not null references public.accounts(id) on delete cascade,
  blocked_account_id uuid not null references public.accounts(id) on delete cascade,
  conversation_id uuid,
  created_at timestamptz not null default now(),
  primary key (blocker_account_id, blocked_account_id)
);
create index on public.blocks (blocked_account_id);

create or replace function public.is_blocked_either_way(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks
    where (blocker_account_id = a and blocked_account_id = b)
       or (blocker_account_id = b and blocked_account_id = a)
  )
$$;

-- ---------------------------------------------------------------------------
-- Availability queue and matching
-- ---------------------------------------------------------------------------

create type public.availability_status as enum ('waiting', 'invited', 'matched', 'expired', 'cancelled');

create table public.availability_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  status public.availability_status not null default 'waiting',
  notify_email boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  matched_invitation_id uuid,
  ended_at timestamptz
);
-- one live request per account
create unique index availability_one_live on public.availability_requests (account_id)
  where status in ('waiting', 'invited');
create index on public.availability_requests (status, created_at);

create type public.invitation_status as enum ('pending', 'accepted', 'declined', 'expired');
create type public.invitation_kind as enum ('match', 'reconnect');

create table public.match_invitations (
  id uuid primary key default gen_random_uuid(),
  kind public.invitation_kind not null default 'match',
  status public.invitation_status not null default 'pending',
  difference_score numeric,
  connection_id uuid,                       -- for kind = 'reconnect'
  conversation_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);
create index on public.match_invitations (status, expires_at);

-- one row per invited account; a client may only ever read its own row
create table public.invitation_participants (
  invitation_id uuid not null references public.match_invitations(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  availability_request_id uuid references public.availability_requests(id) on delete set null,
  decision text check (decision in ('accepted', 'declined')),
  decided_at timestamptz,
  primary key (invitation_id, account_id)
);
create index on public.invitation_participants (account_id);

alter table public.availability_requests
  add constraint availability_requests_invitation_fk
  foreign key (matched_invitation_id) references public.match_invitations(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create type public.conversation_status as enum ('opening', 'chatting', 'ended');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  status public.conversation_status not null default 'opening',
  invitation_id uuid references public.match_invitations(id) on delete set null,
  connection_id uuid,                        -- set when this is a reconnection
  opening_question_count int not null default 10,
  questions_asked int not null default 0,
  question_gap_seconds int not null default 90,
  active_seconds_since_question int not null default 0,
  last_activity_at timestamptz,
  chat_started_at timestamptz,
  opened_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,                           -- 'left', 'abandoned', 'blocked', 'completed'
  partner_away_notified_at timestamptz
);
create index on public.conversations (status);

alter table public.match_invitations
  add constraint match_invitations_conversation_fk
  foreign key (conversation_id) references public.conversations(id) on delete set null;

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  unique (conversation_id, account_id)
);
create index on public.participants (account_id);

create table public.participant_aliases (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  alias text not null
);
create index on public.participant_aliases (conversation_id);

create or replace function public.is_participant(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.participants
    where conversation_id = p_conversation and account_id = auth.uid()
  )
$$;

create or replace function public.my_participant_id(p_conversation uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.participants
  where conversation_id = p_conversation and account_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Questions and answers
-- ---------------------------------------------------------------------------

create type public.question_phase as enum ('opening', 'mid');
create type public.question_status as enum ('open', 'revealed', 'closed');

create table public.conversation_questions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  seq int not null,
  phase public.question_phase not null,
  question_text text not null,
  choices text[] not null check (array_length(choices, 1) = 3),
  followup_a text,
  followup_b text,
  source text not null check (source in ('ai', 'bank')),
  sensitive_topic_flag boolean not null default false,
  rationale_internal text,                   -- admin only; never returned to clients
  status public.question_status not null default 'open',
  created_at timestamptz not null default now(),
  revealed_at timestamptz,
  unique (conversation_id, seq)
);

create type public.answer_status as enum ('pending', 'approved', 'skipped', 'blocked', 'revise');

create table public.question_answers (
  question_id uuid not null references public.conversation_questions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  choice_index int check (choice_index between 0 and 2),
  custom_text text,                          -- only populated once approved
  status public.answer_status not null default 'pending',
  pending_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (question_id, participant_id)
);

-- ---------------------------------------------------------------------------
-- Messages: pending (sender-only) and approved (both parties)
-- ---------------------------------------------------------------------------

create type public.pending_status as enum
  ('pending', 'approved', 'revise', 'blocked', 'review', 'cancelled', 'failed');
create type public.message_kind as enum ('chat', 'answer');

create table public.pending_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_participant_id uuid not null references public.participants(id) on delete cascade,
  client_send_id text not null,
  kind public.message_kind not null default 'chat',
  question_id uuid references public.conversation_questions(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  status public.pending_status not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  user_explanation text,
  suggested_revision text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, client_send_id)
);
create index on public.pending_messages (status, next_attempt_at);
create index on public.pending_messages (sender_participant_id, created_at desc);

alter table public.question_answers
  add constraint question_answers_pending_fk
  foreign key (pending_message_id) references public.pending_messages(id) on delete set null;

create table public.approved_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_participant_id uuid not null references public.participants(id) on delete cascade,
  pending_message_id uuid unique references public.pending_messages(id) on delete set null,
  kind public.message_kind not null default 'chat',
  question_id uuid references public.conversation_questions(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index on public.approved_messages (conversation_id, created_at);

create table public.moderation_decisions (
  id uuid primary key default gen_random_uuid(),
  pending_message_id uuid not null references public.pending_messages(id) on delete cascade,
  decision text not null check (decision in ('allow','revise','block','review')),
  categories text[] not null default '{}',
  user_explanation text,
  suggested_revision text,
  confidence numeric,
  detector_hits text[] not null default '{}',
  provider text not null,                    -- 'anthropic' | 'mock' | 'detectors-only'
  model text,
  raw_valid boolean not null default true,
  latency_ms int,
  created_at timestamptz not null default now()
);
create index on public.moderation_decisions (pending_message_id);

create table public.appeals (
  id uuid primary key default gen_random_uuid(),
  pending_message_id uuid not null references public.pending_messages(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  note text,
  status text not null default 'open' check (status in ('open','upheld','overturned')),
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.accounts(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Reports, reflections, connections
-- ---------------------------------------------------------------------------

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_account_id uuid not null references public.accounts(id) on delete cascade,
  reported_participant_id uuid references public.participants(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  reason text not null check (reason in ('harassment','threat','hate','identity_fishing','spam','other')),
  details text,
  message_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.accounts(id) on delete set null
);
create index on public.reports (status, created_at);

create table public.session_reflections (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  felt_understood int check (felt_understood between 1 and 5),
  recognized_shared int check (recognized_shared between 1 and 5),
  would_repeat boolean,
  free_text text,
  created_at timestamptz not null default now(),
  unique (conversation_id, participant_id)
);

-- Each party's private yes/no to reconnecting. The other party never sees it
-- unless both said yes, at which point a connection is created.
create table public.connection_requests (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  decision boolean not null,
  policy_version text not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, participant_id)
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  account_a uuid not null references public.accounts(id) on delete cascade,
  account_b uuid not null references public.accounts(id) on delete cascade,
  alias_a text not null,
  alias_b text not null,
  source_conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (account_a, account_b)
);
create index on public.connections (account_b);

alter table public.conversations
  add constraint conversations_connection_fk
  foreign key (connection_id) references public.connections(id) on delete set null;
alter table public.match_invitations
  add constraint match_invitations_connection_fk
  foreign key (connection_id) references public.connections(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Notifications, email outbox, rate limits
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index on public.notifications (account_id, created_at desc);

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on public.email_outbox (status, created_at);

create table public.rate_limits (
  account_id uuid not null references public.accounts(id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (account_id, bucket, window_start)
);

-- Returns true and increments when under the limit; false when over.
create or replace function public.take_rate_limit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count int;
begin
  if auth.uid() is null then return false; end if;
  insert into public.rate_limits (account_id, bucket, window_start, count)
  values (auth.uid(), p_bucket, v_window, 1)
  on conflict (account_id, bucket, window_start)
  do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Aliases
-- ---------------------------------------------------------------------------

create or replace function public.random_alias() returns text
language plpgsql as $$
declare
  adjectives text[] := array['Quiet','Amber','Steady','Curious','Gentle','Wandering','Patient','Bright',
    'Humble','Clear','Warm','Thoughtful','Open','Calm','Keen','Mild','Candid','Earnest','Plain','Kind'];
  nouns text[] := array['Heron','Maple','Harbor','Lantern','Meadow','Cedar','River','Compass',
    'Orchard','Summit','Prairie','Willow','Beacon','Canyon','Juniper','Trail','Hollow','Ridge','Fern','Quarry'];
begin
  return adjectives[1 + floor(random() * array_length(adjectives, 1))::int] || ' ' ||
         nouns[1 + floor(random() * array_length(nouns, 1))::int];
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.policy_config enable row level security;
alter table public.accounts enable row level security;
alter table public.profiles enable row level security;
alter table public.consent_events enable row level security;
alter table public.blocks enable row level security;
alter table public.availability_requests enable row level security;
alter table public.match_invitations enable row level security;
alter table public.invitation_participants enable row level security;
alter table public.conversations enable row level security;
alter table public.participants enable row level security;
alter table public.participant_aliases enable row level security;
alter table public.conversation_questions enable row level security;
alter table public.question_answers enable row level security;
alter table public.pending_messages enable row level security;
alter table public.approved_messages enable row level security;
alter table public.moderation_decisions enable row level security;
alter table public.appeals enable row level security;
alter table public.reports enable row level security;
alter table public.session_reflections enable row level security;
alter table public.connection_requests enable row level security;
alter table public.connections enable row level security;
alter table public.notifications enable row level security;
alter table public.email_outbox enable row level security;
alter table public.rate_limits enable row level security;

-- policy_config: readable by everyone signed in (non-secret knobs), writable by admin
create policy cfg_read on public.policy_config for select to authenticated using (true);
create policy cfg_admin on public.policy_config for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy accounts_self on public.accounts for select to authenticated using (id = auth.uid() or public.is_admin());
create policy accounts_self_update on public.accounts for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.accounts a where a.id = auth.uid()));

create policy profiles_self on public.profiles for all to authenticated
  using (account_id = auth.uid()) with check (account_id = auth.uid());

create policy consent_self_read on public.consent_events for select to authenticated using (account_id = auth.uid());
create policy consent_self_insert on public.consent_events for insert to authenticated with check (account_id = auth.uid());

-- blocks: no client select (would expose peer account ids). Managed via RPC.

create policy availability_self on public.availability_requests for select to authenticated using (account_id = auth.uid());

-- invitations: the invitation row is readable only to its own participants;
-- it carries no account ids.
create policy invitations_mine on public.match_invitations for select to authenticated using (
  exists (select 1 from public.invitation_participants ip where ip.invitation_id = id and ip.account_id = auth.uid())
);
create policy invitation_participants_self on public.invitation_participants for select to authenticated using (account_id = auth.uid());

create policy conversations_mine on public.conversations for select to authenticated using (public.is_participant(id) or public.is_admin());

-- participants: own row only (it holds the account id)
create policy participants_self on public.participants for select to authenticated using (account_id = auth.uid());
create policy participants_heartbeat on public.participants for update to authenticated
  using (account_id = auth.uid()) with check (account_id = auth.uid());

-- aliases: both parties in the conversation
create policy aliases_in_conversation on public.participant_aliases for select to authenticated using (public.is_participant(conversation_id));

-- questions: both parties; rationale_internal is stripped by the API layer, and
-- the client select list is restricted by a column grant below.
create policy questions_in_conversation on public.conversation_questions for select to authenticated using (public.is_participant(conversation_id) or public.is_admin());
revoke select on public.conversation_questions from authenticated;
grant select (id, conversation_id, seq, phase, question_text, choices, followup_a, followup_b, source, sensitive_topic_flag, status, created_at, revealed_at)
  on public.conversation_questions to authenticated;

-- answers: own row always; the peer's row only once the question is revealed.
create policy answers_visible on public.question_answers for select to authenticated using (
  participant_id = public.my_participant_id(conversation_id)
  or (
    public.is_participant(conversation_id)
    and exists (select 1 from public.conversation_questions q where q.id = question_id and q.revealed_at is not null)
  )
);

-- pending: sender only. No insert/update policy — writes go through RPC.
create policy pending_sender on public.pending_messages for select to authenticated using (
  sender_participant_id = public.my_participant_id(conversation_id)
);

-- approved: both parties. No client writes at all.
create policy approved_in_conversation on public.approved_messages for select to authenticated using (public.is_participant(conversation_id));

create policy moderation_admin on public.moderation_decisions for select to authenticated using (public.is_admin());

create policy appeals_self on public.appeals for select to authenticated using (account_id = auth.uid() or public.is_admin());
create policy appeals_admin_update on public.appeals for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy reports_self on public.reports for select to authenticated using (reporter_account_id = auth.uid() or public.is_admin());
create policy reports_admin_update on public.reports for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy reflections_self on public.session_reflections for all to authenticated
  using (participant_id = public.my_participant_id(conversation_id))
  with check (participant_id = public.my_participant_id(conversation_id));

create policy connection_requests_self on public.connection_requests for select to authenticated
  using (participant_id = public.my_participant_id(conversation_id));

-- connections: no client select (account ids). Use my_connections().

create policy notifications_self on public.notifications for select to authenticated using (account_id = auth.uid());
create policy notifications_self_update on public.notifications for update to authenticated using (account_id = auth.uid()) with check (account_id = auth.uid());

-- email_outbox, rate_limits: service role only.

-- ---------------------------------------------------------------------------
-- Account bootstrap
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (id) values (new.id) on conflict do nothing;
  insert into public.profiles (account_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime: only tables whose rows are already safe under RLS. pending_messages
-- is deliberately excluded so nothing unapproved reaches a subscription.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.approved_messages;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.conversation_questions;
alter publication supabase_realtime add table public.question_answers;
alter publication supabase_realtime add table public.match_invitations;
alter publication supabase_realtime add table public.notifications;

-- ---------------------------------------------------------------------------
-- Default policy knobs
-- ---------------------------------------------------------------------------

insert into public.policy_config (key, value) values
  ('availability_ttl_seconds',      '1800'),
  ('invitation_ttl_seconds',        '180'),
  ('min_difference_score',          '1.0'),
  ('min_answered_dimensions',       '3'),
  ('opening_question_count',        '10'),
  ('question_gap_initial_seconds',  '90'),
  ('question_gap_multiplier',       '2'),
  ('question_gap_max_seconds',      '600'),
  ('quiet_cap_seconds',             '60'),
  ('partner_away_after_seconds',    '120'),
  ('abandon_after_seconds',         '600'),
  ('friendship_enabled',            'true'),
  ('friendship_policy_version',     '"v1-mutual-no-gate"'),
  ('contact_sharing_enabled',       'false'),
  ('retention_messages_days',       '30'),
  ('retention_pending_days',        '7'),
  ('retention_reports_days',        '365'),
  ('pending_cancel_after_seconds',  '45')
on conflict (key) do nothing;
