# Common Ground

Anonymous, moderated text conversations between adults who hold different political views. Two people are paired because they answered a short questionnaire differently, get the same human questions to answer, then chat — with every message reviewed server-side before the other person can see it.

This is an authenticated pilot build: Next.js 16 (App Router) + Supabase (Postgres, RLS, Auth, Realtime) + a server-side model gateway.

## What is implemented vs. what is mocked

| Area | Status |
| --- | --- |
| Sign-in (email magic link), private account separated from per-conversation aliases | **Implemented** (Supabase Auth) |
| Onboarding: adult attestation, consent events, coarse profile, 8-question policy questionnaire (v2) with explicit non-answers and optional issue priorities | **Implemented** |
| Availability queue with expiry, email opt-in | **Implemented**; email delivery needs `RESEND_API_KEY`, otherwise rows are marked `skipped` and nothing is sent |
| Matching: block-aware, difference-score threshold, mixed/unsure policy, fair ordering, atomic reservation, expiring invitations, two-party acceptance | **Implemented** (`run_matching`, `respond_invitation`; advisory + row locks) |
| Opening round of 10 shared questions, 3 choices + custom answer, answers hidden until both respond, skip | **Implemented** |
| Open chat with mid-chat questions on an activity-based backoff schedule | **Implemented** |
| Pre-delivery moderation: pending → approved/revise/blocked/review, idempotent sends, sender-only pending table, retries with backoff, fail-closed into human review, cancel while waiting | **Implemented** |
| Moderation model | **Real with Claude when `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`**. Otherwise a **labeled mock**: deterministic contact/identity detectors + a tiny abuse list. The mock is shown in a banner and refuses to approve chat in production unless `AI_MOCK_ALLOW_IN_PRODUCTION=true`. |
| Question generation | **Real with Claude** (validated JSON, loaded-choice filter, bank fallback). Mock = curated bank. |
| Connection-readiness check | Deterministic policy is authoritative; the model (when configured) may only add review flags. Never a trust score. |
| Partner-away notice (≤2 min), abandonment, leave, block, report | **Implemented** (heartbeat + `expire_stale`) |
| Reflection, private mutual keep-talking decision → one persistent moderated chat (reused aliases, any time, offline delivery, unread counts, mute / end / block, on-demand question, history until cleared); visible rate-limited Become friends request → friends tier where contact details may be shared (abuse screening kept) | **Implemented** |
| Admin review console (held messages, reports, appeals, policy knobs) | **Implemented** for a single admin (`ADMIN_EMAIL`) |
| Account + data deletion (immediate, cascading) and retention purge | **Implemented** |
| Realtime | Supabase Realtime on approved tables only; polling fallback everywhere |
| Browser push notifications | **Implemented** (Web Push): session reminders, and a separate opt-in for neutral "You have a new message." pushes from friend chats. Not yet verified on a physical phone. |
| Personal-contact sharing | **Friends tier only**: both people must explicitly agree (request + accept, 7-day cooldown after a decline); `contact_sharing_enabled` gates it |

## Security model in one paragraph

Every client read goes through row-level security; every client write that matters goes through a `SECURITY DEFINER` RPC that starts by checking `auth.uid()`. Tables that contain another person's account id (`participants`, `blocks`, `connections`, `invitation_participants`) are readable only for the caller's own rows; peers are referenced by per-conversation `participant_id` and shown by alias. `pending_messages` is readable only by its sender, is not in the realtime publication, and is written only by `submit_message`. `approved_messages` has no client insert policy at all; the only writer is `apply_moderation_decision`, executed by the service role from the worker (or the admin console, which logs the same audit row). Worker functions have `EXECUTE` revoked from `anon`/`authenticated` and also assert the JWT role. Rate limits are per account in the database. Model credentials are read only in `src/lib/ai/gateway.ts` (server-only).

## Local setup

Prerequisites: Node 22, a Docker runtime for local Supabase (Docker Desktop or Colima).

```bash
npm install
npx supabase start          # prints API URL, anon key, service_role key
cp .env.example .env.local  # then paste the keys; set ADMIN_EMAIL to your address
npm run dev                 # http://localhost:3000
npm run tick                # in a second terminal: runs the worker every 15s
```

Magic-link emails in local dev land in the Supabase mail viewer: http://127.0.0.1:54324.

Migrations are in `supabase/migrations/` and apply automatically on `supabase start` / `supabase db reset`.

To use the real model: set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env.local`, restart `npm run dev`. The banner disappears when both are set.

## Verification

```bash
npm run typecheck
npx eslint src
npm test                    # needs the local Supabase running and keys in the environment
```

`tests/pilot.test.ts` creates real auth users and exercises, through the same RPCs the app uses:

- identity isolation and unauthorized reads (profiles, conversations, aliases, participants, pending rows, internal rationale column, worker RPCs)
- matching: similar users don't pair, different ones do, explicit non-answers excluded, 5-shared-answer minimum, consented broadening, oldest-first fairness, blocks
- concurrent acceptances (including a duplicate click) → exactly one conversation; decline requeues; expiry requeues
- reveal-after-both, skipping, custom answers through moderation, opening→chatting transition
- clean message approved only via the worker; recipient never sees pending; idempotent `client_send_id`; contact details → revise → accept-revision delivers redacted text; threats → block → appeal; model outage → stays pending with backoff → sender can cancel → recovers; repeated failures → human review; rate limiting; mid-chat question pacing and backoff
- leave/block/report side effects; reflection; private decisions; mutual connection; friend threads (one per friendship under concurrency, independent of session hours, never counted as an active conversation, offline delivery, unread/read, separate push consent and flood guard, mute, per-message retention, block/remove ending the thread)
- the on-demand question is friend-only and question phases are enforced server-side; chat history merges by id and pages by (created_at, id); actionable send records stay reachable in long chats; pushes are re-checked before each device send with per-device retry
- questions close with the conversation: a blocked or departed partner can neither answer nor trigger a reveal; a removed friendship needs fresh mutual consent; read marks are bounded and never move backwards; queued pushes are re-checked, cancelled and retried
- queue repair: simultaneous acceptance of two invitations sharing a person opens exactly one conversation without deadlock and requeues the loser's partner; no stranded `invited` rows
- metrics: participant-level success vs. distinct conversations; friend messages don't inflate counts
- reminder targets (`pickNextReminderSession`) and calendar day parsing (`parseDaysParam`)
- partner-away and abandonment housekeeping; account deletion propagation

Run `npm test` with `.env.local` exported, e.g. `set -a; source .env.local; set +a; npm test`.

### Verification evidence (2026-10-20, local Supabase via Colima, `AI_PROVIDER=mock`)

- `npm run typecheck`, `npx eslint src`, `next build`: clean.
- `npm test`: 131 passed, 0 failed across 11 files (latest run, after the two-tier chats change). Two bugs were found and fixed on the way: the lobby's "am I in a live conversation" query hit a PostgREST embed ambiguity (now uses the explicit FK hint and has a regression test), and the moderation worker only drained 10 pending rows per run (now loops).
- Manual two-sided run: user A in the app (magic link via Mailpit → onboarding → queue), user B via `scripts/qa-partner.mjs` (a real second account driving the same RPCs; QA harness only, not product code). Observed: invitation arrived in-app in ~10 s and opened on mutual accept; Q1 answer stayed hidden until both answered, then both appeared together; a custom answer with a phone number was held with "This looks like it contains a phone number", the recipient saw nothing, accepting the rewording delivered `[number removed]`; all 10 opening questions revealed and chat opened; chat delivered both ways after approval; "you people are vermin and I will find you" was blocked with explanation + appeal; leaving ended the conversation for both (partner script saw `ended` within one poll), reflection saved, mutual "yes" produced a connection visible under Connections with aliases preserved; admin console renders for the admin role. Screens checked at 375 px width (onboarding, lobby, conversation, reflection, connections, admin).
- Noted, not yet addressed: the first question after a reveal arrives in 3–10 s in dev (an `after()` hook plus the 5 s poll; realtime delivery should make it faster in production, which hasn't been measured).

Two-browser QA checklist (repeatable): sign in as two emails in two browser profiles → both join the queue → accept on both → answer the first question on one side and confirm the other side sees "waiting", not the answer → finish the round → send a message with a phone number and confirm the recipient sees nothing while the sender sees the revise card → accept the revision → leave on one side and confirm the other is sent to the reflection page → both say yes → the other person appears under Friends. Then open the friend chat from Friends → Message, send a message from one side while the other is signed out, and confirm the unread badge and the message on return. Check at 360px width and with VoiceOver/keyboard: all controls are buttons or inputs with labels, focus is visible, live regions announce status.

## Deployment

### Current hosted pilot (set up 2026-10-20)

- App: https://common-ground-dusky-nine.vercel.app (Vercel project `common-ground`, free plan, deployed from this folder with `npx vercel deploy --prod`)
- Database/auth: Supabase project `common-ground` (ref `nrhduxkatknackelzbmv`, us-east-1). Migrations applied with `npx supabase db push`; auth site URL and redirect URLs pushed with `npx supabase config push`.
- Environment: all variables from `.env.example` are set on Vercel (production). The worker secret is kept locally in `.vercel/cron-secret.local` (git-ignored).
- Worker: `pg_cron` + `pg_net` in the hosted database call `POST /api/cron/tick` every minute (`worker_config` holds the URL and secret; set up by migration 0005). Vercel's daily cron runs the nightly retention purge. Housekeeping also runs opportunistically from user activity.
- Email: Supabase's built-in mailer is used for magic links. It only delivers to members of the Supabase organization until custom SMTP is configured, so real participants need step 3 below (a verified sending domain).

### From scratch

1. Create a Supabase project. Run `npx supabase link --project-ref <ref>` then `npx supabase db push`.
2. In Supabase Auth settings: enable email (magic link), set Site URL to your domain, add `https://<domain>/auth/callback` to redirect URLs, and configure SMTP (the default sender is rate-limited to a handful of emails per hour).
3. Deploy the Next.js app (Vercel or any Node host). Set the env vars from `.env.example`. Use a strong `CRON_SECRET`.
4. Scheduler: `vercel.json` runs `/api/cron/tick` every minute and the retention purge nightly. On other hosts, call the same endpoint with `Authorization: Bearer $CRON_SECRET`. Vercel Cron sends no auth header by default: either add Vercel's `CRON_SECRET` convention (it does send `Authorization: Bearer <CRON_SECRET>` when the env var is named `CRON_SECRET`) or protect the route by network.
5. Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Without them, production holds every chat message for human review.
6. Set `RESEND_API_KEY` and `EMAIL_FROM` with a verified domain, or leave unset to disable email notices.
7. Sign in once with `ADMIN_EMAIL` to get the Review console.

Latency: the send-to-delivery path is sender → `submit_message` → `after()` worker call → model → `apply_moderation_decision` → realtime. Expect 1–4 s with Claude; the UI shows "Checking before delivery…" and offers cancel after 45 s (`pending_cancel_after_seconds`). Log `moderation_decisions.latency_ms` to measure the distribution. Budget: ~1 moderation call per message + ~1 generation call per question; context is capped at the last 8 messages.

## Operations

- Review console: `/admin` for the `ADMIN_EMAIL` account. Held messages, reports (with the last 20 messages of the conversation), appeals, and policy knobs (`policy_config`).
- Outage behaviour: messages stay `pending` with exponential backoff (5s→120s), six attempts, then `review`. Senders see an explanation and can cancel.
- Retention: `purge_retention` (nightly) deletes approved messages 30 days after a live conversation ends, chat history 30 days after a chat ends (kept while it is open, or until a participant clears it), finished queue entries after 90 days, metric events after a year (worker heartbeats after 7 days), finished email-outbox rows and reminder-send records after 30 days, resolved pending/blocked rows after 7 days (not while an appeal is open), resolved reports after 365 days.
- Deletion: `DELETE /api/account` ends live state, then deletes the auth user; everything cascades.

See `DECISIONS.md` for the choices made so far and what is still open.
