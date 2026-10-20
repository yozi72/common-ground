# Common Ground — handoff notes

Short status for anyone reviewing this codebase (including an AI reviewer). Updated with every push; newest entry first under "Change log".

- **Preview (production pilot):** https://common-ground-dusky-nine.vercel.app
- **Repository:** https://github.com/yozi72/common-ground (public). No secrets are committed; see "Secrets".
- **These notes:** `HANDOFF.md` at the repository root — https://github.com/yozi72/common-ground/blob/main/HANDOFF.md
- **What it is:** an anonymous, moderated text-conversation app pairing adults across political differences. Full product brief and decisions: `DECISIONS.md`. Setup, architecture and verification: `README.md`.

## What works (verified)

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
- 27 integration tests against a local Supabase (`npm test`), lint, typecheck, production build.

## Unfinished, mocked, or known issues

- **Email sender:** Gmail SMTP (app password) for sign-in links; capped ~500/day, "from" is a personal address. Match-ready / reconnect notices are written to `email_outbox` but only sent if `RESEND_API_KEY` is set (currently not) — otherwise marked `skipped`. A sending domain + Resend is the planned replacement.
- **Worker scheduling:** Vercel free plan runs cron once a day (used for retention). Housekeeping otherwise runs opportunistically from user activity (heartbeat/lobby/queue). Partner-away and abandonment timing is therefore only reliable while someone is active; an external minute-level pinger (`POST /api/cron/tick`, bearer `CRON_SECRET`) is recommended for quiet hours.
- **Browser push notifications:** not built. In-app + optional email only.
- **Contact sharing:** disabled by policy; no code path.
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

## Change log

- 2026-10-20 — Stats and badges: `account_stats`/`my_stats`/`peer_badges` functions (migration 0003, applied locally and on the hosted project), Profile page with counts, next-milestone line and badge grid, peer tier badges under the alias in the conversation header. Per-task model overrides `ANTHROPIC_MODEL_MODERATION` / `ANTHROPIC_MODEL_QUESTIONS`. 28 tests.

- 2026-10-20 — Design pass 2: conversation (avatars, opening-round progress bar, revealed-answer cards with a “Same answer” badge, pill composer, intro card), reflection (illustrations, chip scales), Review console (pill tabs with counts). Phone fixes: question card no longer sticky on small screens; composer sits above the tab bar; Review tab in the bottom bar for admins.

- 2026-10-20 — Design pass 1: light warm theme (cream/terracotta/sage), rounded components, Nunito + Fredoka, inline illustrations, one-question-per-screen slider questionnaire with progress dots and explicit "Unsure", bottom tab bar on phones (Talk / Friends / Profile), Sign out always visible. Admin accounts skip onboarding and land on Review.
- 2026-10-20 — Hosted pilot on Vercel + Supabase; Gmail SMTP for sign-in links; activity-driven worker tick for the free plan.
- 2026-10-20 — Real model path (Claude) with refusal → human review; moderation probe script.
- 2026-10-20 — Initial build: schema/RLS/transactions, workers, all screens, 27 tests, docs.
