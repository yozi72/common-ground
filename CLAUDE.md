## Working rules (always follow)
- After EVERY change you make (file edit, new file, decision, fix, bug found), update NOTES.md before replying to me. No exceptions, even for small changes.
- Each update: add what changed, which files/functions, and why.
- End every reply with one line: "NOTES.md updated: <what you added>". If you didn't update it, say why.
- Commit to git after each meaningful working change with a clear message. Ask first if it's risky.
- When context gets heavy, tell me and write a full handoff to NOTES.md.

# Common Ground — project facts

## What it is
An anonymous, moderated text-conversation pilot that pairs adults who answered a short policy questionnaire differently, gives both the same human (non-political) questions, then opens chat. One shared daily "conversation hour" (default 6–7 pm America/Los_Angeles) for meeting new people; afterwards both can privately choose to keep talking (a persistent screened chat) and later explicitly become friends (contact sharing allowed). Product brief and decisions: `DECISIONS.md`. Status, known issues, test script for reviewers: `HANDOFF.md` (keep it updated on every push; ChatGPT reviews from it). Running notes: `NOTES.md`.

## Stack
- Next.js 16 (App Router, `src/`), React 19, Tailwind v4, TypeScript. `proxy.ts` (not middleware) refreshes the Supabase session and gates pages.
- Supabase: Postgres with RLS, magic-link auth, Realtime on approved tables only. Migrations in `supabase/migrations/` (append new files; never edit applied ones). Local stack via `npx supabase start` (Docker provided by Colima on this Mac). Hosted project ref `nrhduxkatknackelzbmv`.
- AI: server-side gateway `src/lib/ai/gateway.ts` (Claude `claude-opus-5-5`, effort low; labeled mock when `AI_PROVIDER=mock`). Moderation decisions are enforced only by `apply_moderation_decision` (service role).
- Workers: `src/lib/workers/*`; `/api/cron/tick` is called every minute by `pg_cron` in the hosted database (`worker_config` holds URL + secret).
- Deploy: Vercel project `common-ground` (free plan) via `npx vercel deploy --prod --yes`; env vars on Vercel; GitHub `yozi72/common-ground` (public).
- Tests: `npm test` (vitest; needs local Supabase and `.env.local` exported). Probe of the real model: `npm run probe` (costs API calls).
- Delivery isolation (incident 2026-10-21): `env.liveDeliveryAllowed()` is false under vitest and, outside production, unless `ALLOW_LIVE_DELIVERY=true`; every real email/push sender calls `env.assertLiveDelivery()` first; `tests/setup.ts` strips provider credentials, fakes nodemailer/web-push, blocks non-local fetch and refuses a non-local database. New senders must go through `env` and call the hard stop; never read `SMTP_*`/`RESEND_API_KEY`/VAPID vars directly.

## Two kinds of conversation (lasting distinction)
- **Live session with a new person** (`conversations.kind = 'live'`): only during the daily session window, via queue → invitation (60 s) → two-party acceptance; opening round of shared questions; presence/partner-away/abandonment rules; at most one active live conversation per person (`has_active_conversation`, live only); feeds matching metrics.
- **Chat** (`conversations.kind = 'friend'`, the kind name is historical): exactly one per connection (`open_friend_thread`, unique partial index), aliases retained, usable any time and offline, no session gating, no presence or inactivity rules, no opening round; "Give us a question" is on demand and friend-only; `insert_question` enforces phases (opening only during a live opening round, mid only in open chat). Never blocks the queue, lobby, matching or metrics. Controls: mute, remove friend, block, report. Ending a conversation for any reason closes its open questions; removal/block revoke both people's friendship consent (fresh mutual yes needed to restore). Read marks are set only by the client, only for messages it loaded in a visible tab. Push is a separate consent, always the neutral "You have a new message.", one per thread per 10 minutes. History is kept while the chat is open (either person can clear it) and deleted 30 days after it ends. Two tiers on `connections.tier`: `chat` (both said keep talking; screened, no contact details) and `friend` (visible `request_friend` → `respond_friend_request`, 7-day cooldown; contact details allowed; the identity detectors still run as hints to the model but no longer impose the identity-screening floor; abuse, threat, scam and third-party-doxxing screening stay on; `thread_contact_allowed`). Restoring a connection resets it to `chat`. Ended live conversations are listed for 30 days (`my_recent_conversations`).
- Both kinds share moderation (`submit_message` → worker → `apply_moderation_decision`), RLS and Realtime. New code that touches presence, queueing, matching or metrics must scope to `kind = 'live'`.

## Conventions
- All client writes go through SECURITY DEFINER RPCs that start with `assert_user()`; worker RPCs have EXECUTE revoked from `authenticated` and call `assert_service_role()`.
- Never expose another user's `account_id` to a client: peers are referenced by `participant_id` and shown by alias.
- Nothing reaches `approved_messages` except through `apply_moderation_decision`. Pending messages are sender-only and excluded from Realtime.
- Contact details are allowed only when `thread_contact_allowed` is true for the thread (friends tier, active, unblocked); the worker passes `contactAllowed` to the gateway. Never relax identity screening anywhere else.
- Political answers and issue priorities are used for matching only; `buildQuestionInput()` is the only path to the question model and must never include them.
- Chat clients keep every loaded message and merge by id (`src/lib/chat-history.ts`); never replace the loaded set with the newest page. Read queries for the chat live in `src/lib/chat-queries.ts` and are shared with tests.
- Moderation results carry the claim token (`apply_moderation_decision(..., p_claim_token)`); human decisions pass `p_provider = 'human'` and no token. Never apply an automated outcome without the token.
- Clients never write `accounts`, `profiles` (except `timezone_override`) or `consent_events` directly: `complete_onboarding` and `record_consent` are the paths.
- Internal helper functions are revoked from `authenticated`; anything a client must call needs an explicit grant and its own authorization check.
- Lock order (migration 0016 §4 header): per-account advisory locks → `connections` row → `conversations` row (`for no key update`), which serializes everything that touches a conversation's questions or pending rows (those two may be taken in either order under it). A function that touches a conversation's questions or pending rows takes the conversation lock first, including `resolve_appeal`; the only exceptions are the sender's single-row actions (`cancel_pending`, `accept_revision`, `file_appeal`). `end_conversation`/`close_pending_delivery` are the way to close a conversation's pending rows: decided rows (revise/blocked) keep their status and get `undeliverable_reason`, so they stay appealable; nothing is ever delivered into an ended, blocked or cleared conversation.
- Model routes: every route that can call the model exports `maxDuration = 60` and creates one `Deadline` at entry that all its work shares (including `after()` work); never pass a fresh constant budget mid-handler. Per-account usage attribution (`CallOpts.accounts`) is server metadata: sender for moderation, both participants for a question; never in a prompt or a response.
- Consent events for contact sharing use the vocabulary in migration 0016 §5 (`contact_sharing_request`, `contact_sharing_response`, `contact_sharing`, `contact_sharing_ended`); a decline is recorded for the responder only.
- Tests that need DDL or coordinated transactions use `tests/pg.ts` (its destination guard refuses any non-local host before a client exists); tests that need the real gateway path use `setModelClientForTests` with an intercepted provider, never the SDK.
- Held messages: the sender's decided messages and appeal outcomes come from `my_held_messages` (participant-only) and are shown wherever the conversation can no longer be used (reflection page, ended or cleared chat); a route must never take a conversation id from the request body for privileged follow-up work, it derives it from the authorized row under RLS.
- Worker outcomes are distinct: never started (release, no attempt), genuine provider failure (attempt + backoff), uncertain after a started send (attempt, retried), budget exhaustion (`defer_pending_until` at the reset, no attempt). Transport timeouts are bounded by the remaining budget; a Promise timeout does not cancel the external send.
- Every model call takes the remaining budget (`CallOpts.deadlineMs`); workers pass their `Deadline` through every stage and external send (`within()`), release claims they cannot start, and the tick reserves one generation's budget for questions. Never add an unbounded external call to a worker stage or an API route that calls the model.
- Chat message caches go through `src/lib/chat-sync.ts` (functional merges, persisted gaps, sequence guard); never replace the cache with a snapshot.
- Clearing a chat must never cancel the other person's submissions or remove review records; evidence for reports lives in `report_evidence`, captured at report time.
- Push worker updates are conditional on the claim (`finish_push_queue` / `recheck_push_queue`); never write a terminal push status unconditionally.
- UI: light warm theme, rounded components, one top bar + bottom tab bar (Talk / Chats / Profile [/ Review]), one primary action per screen, no browser `confirm()`/`prompt()`.
- Lint rules forbid `Date.now()` in render and `setState` directly in effects; use `serverNow()` / deferred effects.
- Commit messages end with the Co-Authored-By line the harness provides; no secrets in the repo (`.env.local`, `.vercel/` are ignored).

## Never do
- Run `supabase db reset` or any destructive helper against the hosted project.
- Put a secret in a committed file, a chat reply, or a screenshot.
- Promise anonymity, alarm-grade reminders, or validated political measurement in copy.
- Change product positioning, landing-page headline, marketing copy, the guided-question content, or the number of required conversation questions without being asked.
- Accept an invitation or act inside the app on the user's real accounts.
