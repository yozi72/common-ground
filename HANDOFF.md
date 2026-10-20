# Common Ground — handoff notes

Short status for anyone reviewing this codebase (including an AI reviewer). Updated with every push; newest entry first under "Change log".

- **Preview (production pilot):** https://common-ground-dusky-nine.vercel.app
- **Repository:** https://github.com/yozi72/common-ground (public). No secrets are committed; see "Secrets".
- **These notes:** `HANDOFF.md` at the repository root — https://github.com/yozi72/common-ground/blob/main/HANDOFF.md
- **What it is:** an anonymous, moderated text-conversation app pairing adults across political differences. Full product brief and decisions: `DECISIONS.md`. Setup, architecture and verification: `README.md`.

## What works (verified)

- **Daily shared session** (default 6–7 pm America/Los_Angeles, every day; `policy_config`: `session_days`, `session_start_time`, `session_duration_minutes`, `session_timezone`). One implementation (`src/lib/schedule.ts`, SQL `session_window()`) drives server eligibility, lobby countdowns, calendar export and reminders. Backend enforcement: `join_queue`, `run_matching`, `request_reconnection` refuse outside the window; queue entries close at session end; invitations created before closing keep their 60-second deadline; existing conversations continue.
- **Readiness-based matching:** lobby heartbeats (5 s) with server-side expiry (45 s grace → auto-resume), nonresponders paused until "I'm ready", responsive person requeued with original priority and an avoid list, oldest-first partner choice, blocks and eligibility revalidated at acceptance, matching atomic under an advisory lock.
- **Consented broadening:** after 60 s "allow a smaller difference" (threshold 0.5 instead of 1.0), after 120 s "anyone available" (0). Stored server-side per queue entry, reversible, stricter of the two preferences wins.
- **Automatic local time:** device IANA timezone (no location access) with a manual override in Profile; server-synchronised countdowns refreshed on focus; "Pacific time" fallback label when detection fails.
- **Reminders:** Web Push (VAPID, service worker, PWA manifest, iOS Add-to-Home-Screen guidance), optional email, Apple/Google calendar export (TZID recurrence, 10-minute alarm, stable UID). Sends are idempotent per (account, session, channel, device), retried up to 3 times inside the 5-minute window, never after the session starts; 404/410 subscriptions are disabled; endpoints move with the account on shared devices; deletion cascades.
- **Scheduler:** Supabase `pg_cron` + `pg_net` call `/api/cron/tick` every minute (URL/secret in `worker_config`); each run logs a `worker_tick` metric event. No paid plan needed.
- **Metrics (Review → Metrics):** queue joins, time to invitation (p50/p90), time until both accept, % starting within 2 minutes, unmatched leaves and rate, missed/declined invitations, broadening, reminder opt-ins and delivery outcomes. No conversation text or answers.

- Email magic-link sign-in (Supabase Auth, custom SMTP via Gmail for the pilot).
- Onboarding: adult attestation, consent, coarse profile, 5-item questionnaire (one question per screen, slider).
- Waiting list → block-aware matching on questionnaire difference → two-party invitation with 3-minute expiry → conversation.
- Opening round of 10 shared questions with 3 generated choices + custom answer; answers hidden until both respond; skip.
- Open chat with mid-conversation questions on an activity-based backoff.
- Pre-delivery moderation: every message is `pending` until approved; states `approved / revise / blocked / review`; suggested rewordings only sent if the sender accepts; appeals; sender can cancel while waiting; outages fail closed (retry → human review).
- Real model (Claude, `claude-opus-5-5`) for moderation and question generation when `AI_PROVIDER=anthropic`; deterministic contact/identity detectors always run. Probe results: `npm run probe` (19/20 agreement on a borderline set; 1.5–6 s per call).
- Leave / block / report; partner-away notice (≤2 min); abandonment; reflection; mutual-consent "Friends" with reconnection under the same aliases; account + data deletion; retention purge.
- Profile stats (people talked with, conversations, mutual friends) and 13 participation badges; the other participant sees only coarse tiers (`peer_badges`), never exact counts.
- Admin review console at `/admin` for the `ADMIN_EMAIL` account (held messages, reports, appeals, policy knobs).
- 39 tests (35 integration against a local Supabase + 4 unit)  (`npm test`), lint, typecheck, production build.

## Unfinished, mocked, or known issues

- **Email sender:** Gmail SMTP (app password) for sign-in links and now also for match-ready / reconnect notices (nodemailer; a test notice was delivered 2026-10-20). Capped ~500/day, "from" is a personal address. The lobby only offers the email option when a sender is configured. A sending domain + Resend is the planned replacement.
- **Worker scheduling:** `pg_cron` in the hosted database calls the worker every minute (verified: `worker_tick` events with `source: pg_cron`). Vercel's daily cron still runs the retention purge. If the database scheduler ever stops, housekeeping still runs opportunistically from user activity.
- **Push on real devices:** implemented and exercised in automated tests with fake endpoints; **not yet verified on a physical iPhone/Android** (needs a real device: Profile → Reminders → Enable phone notifications; on iPhone, Add to Home Screen first). Lock-screen text is neutral and fixed.
- **Contact sharing:** disabled by policy; no code path.
- **Realtime in production:** lobby and conversation screens poll (10 s / 5 s) and also subscribe to Supabase Realtime; the subscription has not been separately verified on the hosted project (polling covers it). Background/hidden tabs are throttled by browsers, so a tab left in the background may update slowly until it is focused.
- **Question-after-reveal latency:** 3–10 s in dev (server `after()` hook + 5 s polling fallback); realtime should be faster in production but hasn't been measured there.
- **Design:** the warm/rounded light theme now covers every screen (landing, sign-in, onboarding, Talk, conversation, reflection, Friends, Profile, Review). Screenshots in `docs/screenshots/`. Dark theme exists but is untested after the redesign.
- **Questionnaire wording and the 15-question fallback bank** are first drafts (`src/lib/political.ts`, `src/lib/ai/questionBank.ts`).
- **Single reviewer**, no SLA for held messages beyond the sender's ability to cancel.
- Aliases are random adjective+noun; the same noun can appear for both people in a conversation (cosmetic).

## Secrets

Never in the repo. `.env.local` (git-ignored) holds local keys; production values live in Vercel env vars; the hosted Supabase auth/SMTP config is pushed with `scripts/push-auth-config.sh`. `.env.example` lists every variable with no values.

## Testing with two users

Prerequisite: two email addresses you can read. Use two browsers or one normal + one private window (sessions are cookie-based).

1. Both: open the preview URL → Sign in → click the emailed link → complete onboarding. **Make the two questionnaires differ**: one person slides mostly toward the left statements, the other mostly toward the right (at least 3 answered each). Similar answers never match.
2. Both: Talk → "Join the waiting list". Within ~10 s both see "We found someone" → both Accept.
3. Question 1 appears for both. Answer on one side only: the other side still sees the question, not the answer. Answer on the second side: both answers appear together, then question 2 arrives (a few seconds).
4. Try a custom answer containing a phone number: the sender sees "Not delivered… phone number" with a rewording; the recipient sees nothing. "Send this version" delivers the redacted text.
5. Finish all 10 questions → chat opens. Send a message: "Checking before delivery…" then it appears on both sides. Send "you people are vermin and I will find you": blocked with an explanation; recipient sees nothing.
6. Options → Leave conversation → both land on the reflection page. Both answer "Yes, I'd talk again" → both see "You both said yes" and the other person under Friends → "Invite to talk again" → the other accepts from Talk → new conversation with the same aliases.
7. As the admin: `/admin` shows held messages, reports and appeals.

Local alternative without a second person: `node scripts/qa-partner.mjs` (with `.env.local` exported) plays the other side against a local Supabase. It is a test harness only, never a product feature.

## External review (ChatGPT, commit ae6735b) — status

All nine findings were confirmed and fixed in `2c165c7` (migration `0004_review_fixes.sql`, applied locally and on the hosted project). Each database finding has a regression test in `tests/pilot.test.ts` ("review regressions").

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Clients could UPDATE their own `participants` row (incl. `conversation_id`) | UPDATE policy dropped; UPDATE/INSERT/DELETE revoked from `authenticated`; heartbeat stays an RPC | rv1 |
| 2 | `bool_and` ignored NULL decisions → one acceptance opened the conversation | `respond_invitation` requires `count(accepted) = count(participants) >= 2` | rv2 (+ live test) |
| 3 | Approved custom answers readable by the peer before reveal | `approved_messages` SELECT policy: answers visible to sender, or once the question is revealed; Realtime follows RLS | rv3 |
| 4 | Retention left `question_answers.custom_text` | `purge_retention` nulls custom text with the message purge | rv4 |
| 5 | Ownership checks against NULL `my_participant_id` never raised | `owned_pending()` resolves the caller's participant and raises 42501 for outsiders; used by cancel / accept_revision / appeal | rv5 |
| 6 | Two open questions possible under overlapping workers | `insert_question` locks the conversation and rechecks; partial unique index on `(conversation_id) where status='open'`; existing duplicates closed | rv6 |
| 7 | Unvalidated `next` redirect in the auth callback | `src/lib/safe-next.ts`: resolves against the site origin and rejects anything whose resolved origin differs, including normalization tricks like `/a/..//example.org` | `tests/safe-next.test.ts` |
| 8 | "Email me" promised but no sender | notices send via SMTP (or Resend); option hidden when no sender; delivery tested | — (manual) |
| 9 | Friends list copied props into state | rendered from server props only; after inviting, `router.refresh()` in a transition; `my_connections` reports a pending invitation only while valid, so expired/declined ones clear | pilot test "reconnect invitation state follows the server" |

**Live two-user test on the deployed app (2026-10-20, after `2c165c7`):** user A in a browser, user B via `scripts/qa-partner.mjs` against the hosted project. Observed: match formed; B accepted first and the conversation did *not* open until A accepted (fix 2); AI-generated question 1; A's custom answer with a phone number was held by the real model with an explanation and a rewording; accepting it delivered the reworded text and revealed both answers; question 2 generated; leave → reflection; both said yes → "You both said yes" and the partner listed under Friends. Test accounts were deleted afterwards.

## Session schedule & reminders — configuration

- Change the schedule in Review → Policy (`session_days` as `[0..6]`, `session_start_time` `"HH:MM"`, `session_duration_minutes`, `session_timezone` IANA). All surfaces read the same values; downloaded calendar events do **not** update themselves.
- Broadening thresholds: `broaden_relaxed_after_seconds` (60), `broaden_any_after_seconds` (120), `relaxed_difference_score` (0.5), `min_difference_score` (1.0). Presence: `presence_grace_seconds` (45). Invitation acceptance: `invitation_ttl_seconds` (60).
- Push needs `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (set on Vercel). Email reminders use the same SMTP/Resend settings as other mail.
- Scheduler: `worker_config` rows `tick_url` and `cron_secret` on the hosted database (set via service role); the cron job `common-ground-tick` is created by migration 0005.

## Change log

- 2026-10-20 — Daily session, readiness matching, broadening, reminders, metrics, DB scheduler (see sections above). 61 automated tests: schedule (PDT/PST, Arizona, Hawaii, Tokyo date rollover, midnight crossing, weekday-only, spring-forward, reminder window), calendar recurrence/UID/Google link, reminder idempotency/retries/stale/unsubscribe/next-only/shared device, session gating and close, invitation grace at close, nonresponder pause + priority + avoid, stale presence, broadening consent + mutual preference, block at acceptance, plus all earlier security/privacy tests. Not independently tested: push delivery on a physical phone; a real two-user run during a live 6 pm Pacific session (the local two-user flow and the earlier live run cover the mechanics).

- 2026-10-20 — Re-review follow-ups: `safeNext` now validates the resolved origin (fixes `/a/..//example.org` bypass) with unit tests; Friends list has no client-side override and reflects server state after expiry/decline (DB test). 39 tests.

- 2026-10-20 — Review fixes 1–9 (see table above); 34 tests; SMTP notices; `scripts/test-login-link.mjs` harness for signing a test account into any environment.

- 2026-10-20 — Stats and badges: `account_stats`/`my_stats`/`peer_badges` functions (migration 0003, applied locally and on the hosted project), Profile page with counts, next-milestone line and badge grid, peer tier badges under the alias in the conversation header. Per-task model overrides `ANTHROPIC_MODEL_MODERATION` / `ANTHROPIC_MODEL_QUESTIONS`. 28 tests.

- 2026-10-20 — Design pass 2: conversation (avatars, opening-round progress bar, revealed-answer cards with a “Same answer” badge, pill composer, intro card), reflection (illustrations, chip scales), Review console (pill tabs with counts). Phone fixes: question card no longer sticky on small screens; composer sits above the tab bar; Review tab in the bottom bar for admins.

- 2026-10-20 — Design pass 1: light warm theme (cream/terracotta/sage), rounded components, Nunito + Fredoka, inline illustrations, one-question-per-screen slider questionnaire with progress dots and explicit "Unsure", bottom tab bar on phones (Talk / Friends / Profile), Sign out always visible. Admin accounts skip onboarding and land on Review.
- 2026-10-20 — Hosted pilot on Vercel + Supabase; Gmail SMTP for sign-in links; activity-driven worker tick for the free plan.
- 2026-10-20 — Real model path (Claude) with refusal → human review; moderation probe script.
- 2026-10-20 — Initial build: schema/RLS/transactions, workers, all screens, 27 tests, docs.
