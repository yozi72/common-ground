# Common Ground — handoff notes

Short status for anyone reviewing this codebase (including an AI reviewer). Updated with every push; newest entry first under "Change log".

- **Preview (production pilot):** https://common-ground-dusky-nine.vercel.app
- **Repository:** https://github.com/yozi72/common-ground (public). No secrets are committed; see "Secrets".
- **These notes:** `HANDOFF.md` at the repository root — https://github.com/yozi72/common-ground/blob/main/HANDOFF.md
- **What it is:** an anonymous, moderated text-conversation app pairing adults across political differences. Full product brief and decisions: `DECISIONS.md`. Setup, architecture and verification: `README.md`.

## What works (verified)

- **Daily shared session** (default 6–7 pm America/Los_Angeles, every day; `policy_config`: `session_days`, `session_start_time`, `session_duration_minutes`, `session_timezone`). One implementation (`src/lib/schedule.ts`, SQL `session_window()`) drives server eligibility, lobby countdowns, calendar export and reminders. Backend enforcement: `join_queue` and `run_matching` refuse outside the window; queue entries close at session end; invitations created before closing keep their 60-second deadline; existing conversations continue. Friend chats (below) are not session-gated.
- **Readiness-based matching:** lobby heartbeats (5 s) with server-side expiry (45 s grace → auto-resume), nonresponders paused until "I'm ready", responsive person requeued with original priority and an avoid list, oldest-first partner choice, blocks and eligibility revalidated at acceptance, matching atomic under an advisory lock.
- **Consented broadening:** after 60 s "allow a smaller difference" (threshold 0.20 instead of 0.40), after 120 s "anyone available" (0). Stored server-side per queue entry, reversible, stricter of the two preferences wins.
- **Automatic local time:** device IANA timezone (no location access) with a manual override in Profile; server-synchronised countdowns refreshed on focus; "Pacific time" fallback label when detection fails.
- **Reminders:** Web Push (VAPID, service worker, PWA manifest, iOS Add-to-Home-Screen guidance), optional email, Apple/Google calendar export (TZID recurrence, 10-minute alarm, stable UID). Sends are idempotent per (account, session, channel, device), retried up to 3 times inside the 5-minute window, never after the session starts; 404/410 subscriptions are disabled; endpoints move with the account on shared devices; deletion cascades.
- **Scheduler:** Supabase `pg_cron` + `pg_net` call `/api/cron/tick` every minute (URL/secret in `worker_config`); each run logs a `worker_tick` metric event. No paid plan needed.
- **Metrics (Review → Metrics):** queue joins, time to invitation (p50/p90), time until both accept, % starting within 2 minutes, unmatched leaves and rate, missed/declined invitations, broadening, reminder opt-ins and delivery outcomes. No conversation text or answers.

- Email magic-link sign-in (Supabase Auth, custom SMTP via Gmail for the pilot).
- Onboarding: adult attestation, consent, coarse profile, 8-item policy questionnaire v2 (one question per screen, explicit labelled options, nothing preselected, separate “Not sure” / “Prefer not to answer” / skip), optional top-two issue priorities.
- Waiting list → block-aware matching on questionnaire difference → two-party invitation with a 60-second acceptance window → conversation.
- Opening round of 10 shared questions with 3 generated choices + custom answer; answers hidden until both respond; skip.
- Open chat with mid-conversation questions on an activity-based backoff.
- Pre-delivery moderation: every message is `pending` until approved; states `approved / revise / blocked / review`; suggested rewordings only sent if the sender accepts; appeals; sender can cancel while waiting; outages fail closed (retry → human review).
- Real model (Claude, `claude-opus-5-5`) for moderation and question generation when `AI_PROVIDER=anthropic`; deterministic contact/identity detectors always run. Probe results: `npm run probe` (19/20 agreement on a borderline set; 1.5–6 s per call).
- Leave / block / report; partner-away notice (≤2 min); abandonment; reflection; mutual-consent "Friends" with one persistent chat per friendship under the same aliases (see "Friend chats" below); account + data deletion; retention purge.
- Profile stats (people talked with, conversations, mutual friends) and 13 participation badges; the other participant sees only coarse tiers (`peer_badges`), never exact counts.
- Admin review console at `/admin` for the `ADMIN_EMAIL` account (held messages, reports, appeals, policy knobs).
- 90 tests across 9 files (integration against a local Supabase + unit) (`npm test`), lint, typecheck, production build.

## Unfinished, mocked, or known issues

- **Email sender:** Gmail SMTP (app password) for sign-in links and match-ready notices (nodemailer; a test notice was delivered 2026-10-20). Capped ~500/day, "from" is a personal address. The lobby only offers the email option when a sender is configured. A sending domain + Resend is the planned replacement.
- **Worker scheduling:** `pg_cron` in the hosted database calls the worker every minute (verified: `worker_tick` events with `source: pg_cron`). Vercel's daily cron still runs the retention purge. If the database scheduler ever stops, housekeeping still runs opportunistically from user activity.
- **Push on real devices:** implemented and exercised in automated tests with fake endpoints; **not yet verified on a physical iPhone/Android** (needs a real device: Profile → Reminders → Enable phone notifications; on iPhone, Add to Home Screen first). This includes the new friend-message push. Lock-screen text is neutral and fixed.
- **Contact sharing:** disabled by policy; no code path.
- **Realtime in production:** lobby and conversation screens poll (10 s / 5 s) and also subscribe to Supabase Realtime; the subscription has not been separately verified on the hosted project (polling covers it). Background/hidden tabs are throttled by browsers, so a tab left in the background may update slowly until it is focused.
- **Question-after-reveal latency:** 3–10 s in dev (server `after()` hook + 5 s polling fallback); realtime should be faster in production but hasn't been measured there.
- **Design:** the warm/rounded light theme now covers every screen (landing, sign-in, onboarding, Talk, conversation, reflection, Friends, Profile, Review). Screenshots in `docs/screenshots/`. Dark theme exists but is untested after the redesign.
- **Questionnaire v2 is an initial product questionnaire and an ordinal matching heuristic, not a validated political assessment.** Scores are not party labels, vote predictions or certainty estimates; thresholds are provisional (below). The 15-question fallback bank is still a first draft.
- **Single reviewer**, no SLA for held messages beyond the sender's ability to cancel.
- Aliases are random adjective+noun; the same noun can appear for both people in a conversation (cosmetic).

## Secrets

Never in the repo. `.env.local` (git-ignored) holds local keys; production values live in Vercel env vars; the hosted Supabase auth/SMTP config is pushed with `scripts/push-auth-config.sh`. `.env.example` lists every variable with no values.

## Testing with two users

Prerequisite: two email addresses you can read. Use two browsers or one normal + one private window (sessions are cookie-based).

1. Both: open the preview URL → Sign in → click the emailed link → complete onboarding. **Make the two questionnaires differ**: pick opposite options on at least 5 of the 8 questions (fewer than 5 shared answers counts as "not enough information"). Similar answers never match.
2. Both: Talk → "Join the waiting list". Within ~10 s both see "We found someone" → both Accept.
3. Question 1 appears for both. Answer on one side only: the other side still sees the question, not the answer. Answer on the second side: both answers appear together, then question 2 arrives (a few seconds).
4. Try a custom answer containing a phone number: the sender sees "Not delivered… phone number" with a rewording; the recipient sees nothing. "Send this version" delivers the redacted text.
5. Finish all 10 questions → chat opens. Send a message: "Checking before delivery…" then it appears on both sides. Send "you people are vermin and I will find you": blocked with an explanation; recipient sees nothing.
6. Options → Leave conversation → both land on the reflection page. Both answer "Yes, I'd talk again" → both see "You both said yes" and the other person under Friends → "Message" opens the friendship's chat (same aliases) at any time, no acceptance needed; a message sent while the other is offline shows as unread when they come back.
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
| 9 | Friends list copied props into state | rendered from server props only, refreshed in a transition after an action. (Reconnection invitations were later replaced by persistent friend chats; see "Friend chats" below.) | pilot friend-thread tests |

**Live two-user test on the deployed app (2026-10-20, after `2c165c7`):** user A in a browser, user B via `scripts/qa-partner.mjs` against the hosted project. Observed: match formed; B accepted first and the conversation did *not* open until A accepted (fix 2); AI-generated question 1; A's custom answer with a phone number was held by the real model with an explanation and a rewording; accepting it delivered the reworded text and revealed both answers; question 2 generated; leave → reflection; both said yes → "You both said yes" and the partner listed under Friends. Test accounts were deleted afterwards.

## Questionnaire v2 — schema, scoring, thresholds

**Version:** `profiles.questionnaire_version = 2` (migration 0006). Pairs are only compared when versions match.

**Questions (8):** public services, higher-income taxes, healthcare responsibility, legal immigration, deportations, abortion (4 options), gun purchases, climate limits. Definitions in `src/lib/political.ts`.

**Answer schema (per profile):**
- `political_answers` jsonb `{key: value}` — substantive answers only, normalized to 0..1 by option index / (options − 1): a 5-option question gives 0, .25, .5, .75, 1; the 4-option abortion question gives 0, ⅓, ⅔, 1. An explicit middle option (“Stay about the same”, “Neither…”) is a substantive 0.5.
- `political_nonanswers` jsonb `{key: "unsure" | "declined"}` — stored separately; never a midpoint.
- Untouched questions appear in neither (nothing is preselected, so an untouched control can't become an answer).
- `issue_priorities` text[] (≤2 keys) — collected for evaluation; **not used in matching and not sent to the model**.

**Pair score:** mean absolute distance over shared substantive answers, equal weight per question, symmetric; per-issue distances and the shared count are kept internally (`metric_events.meta` on invitations). Fewer than `min_shared_answers` (5) shared answers → **insufficient information** (score null): the pair is neither “different” nor “similar”; they can still match only if **both** chose “anyone available”. People with fewer than five answers may choose “anyone available” immediately.

**Provisional thresholds (policy_config):** `min_difference_score` 0.40 (strict, default), `relaxed_difference_score` 0.20 (after consent at 60 s), “anyone” 0 (after consent at 120 s; immediate when answers are insufficient). The stricter of the two people's preferences applies. Examples: all-first-option vs all-last-option = 1.0 (matches); “somewhat” vs opposite “somewhat” on every question (.25 vs .75) = 0.5 (matches strict); one step apart on every 5-option question (.25) → relaxed only; identical = 0 → “anyone” only; 4 shared answers, all opposite → insufficient. These values are starting points, not validated cut-offs.

**Existing users:** there were no real users; migration 0006 cleared questionnaire data, set `questionnaire_version = 2`, set `onboarding_complete = false`, and cancelled live queue entries/pending invitations. Accounts, roles, consent history, conversations and friendships were kept. Everyone goes through the normal onboarding once (no special re-onboarding flow). Verified by test “existing accounts keep their data when they complete the new questionnaire”.

**What the question-generation model receives (unchanged):** conversation stage and sequence number, previously asked questions, skipped questions, the last ~10 approved messages by alias, and — only when **both** participants consented — each person's coarse life-context tags. Nothing else from profiles: no political answers, priorities, age, region, community, email or ids. Enforced by `buildQuestionInput()` (`src/lib/workers/questions.ts`) and covered by the test “political answers and priorities never reach the question model”.

**Measurement limitations:** ordinal answers treated as equally spaced; equal weights; a single mean hides which issues differ; eight questions are a narrow slice of political views; “not sure” and “declined” are indistinguishable from each other in matching (both excluded). Treat the score as a pairing heuristic only.

## Third review (c64acf8) — status

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 (High) | Push endpoints accepted any URL (SSRF via the worker) | Allowlist of known push services over https (`src/lib/push-endpoint.ts`) enforced in the API, in `upsert_push_subscription` (migration 0007) and again right before sending; non-conforming stored rows disabled | `tests/push-endpoint.test.ts`, pilot “rejects push endpoints…” |
| 2 (High) | A friend's invitation could open a second simultaneous conversation | `has_active_conversation()` (live conversations only) checked for both people at acceptance and inside `open_conversation_for_invitation` under per-account advisory locks; other pending invitations for the two are declined when one opens. Friend invitations no longer exist (friend chats are persistent threads, see below) | pilot “cannot be put into a second one”, “simultaneous acceptances … only one” |
| 3 | Selected-day calendar started on the wrong day; empty selection produced an event | First occurrence is the next selected session day (`firstSession`); no selection → 400 from `/api/calendar`, buttons disabled in the UI | calendar test “start on the next selected day…” |
| 4 | “Next session only” reminders couldn't be renewed | Expired state shown with “Save for the next session” enabled (`src/lib/reminder-state.ts`) | `tests/reminder-state.test.ts` |
| 5 | Edit profile started blank | Onboarding prefills saved profile, answers, non-answers, priorities and attestation | — (manual) |
| 6 | Push stayed attached to the previous account on a shared browser | “This device is set up” only when the browser subscription is registered to the current account; Sign out detaches the device subscription first (`SignOutButton`) | pilot “endpoint belongs to one account” (+ manual) |
| 7 | Success metric counted one participant | `conversation_opened` logged for both participants | pilot “metric is recorded for both participants” |
| — | Sign-in page wording | mentions optional session reminders | — |

## Fourth review (25affa1 / 0687936) — status

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 (High) | After a block, the blocked person could still finish the open question and reveal the other person's private answer | `end_conversation` (used by leave, block, abandonment) and `remove_friend` close open questions; `answer_with_choice` / `skip_question` go through `assert_can_answer` (open question, conversation not ended, caller still present, no block either way); `maybe_reveal_question` refuses and closes the question when the conversation ended, someone left, or a block exists, so an answer approved later never reveals. Migration 0010 closed questions left open in ended conversations. | pilot "blocking closes the open question…", "leaving closes the open question too…" |
| 2 | One person could re-activate a removed friendship because the other person's old "yes" still counted | `connection_requests.revoked_at`: removal and block revoke both people's decisions on every conversation between them (and hide them from the reflect page); only unrevoked decisions count, so both must say yes again. A restored friendship gets its thread back (history intact); a thread ended by a block stays ended. | pilot "a removed friendship needs a fresh yes from both…", "a block revokes consent as well…" |
| 3 | The chat marked messages read during background polling, even in a hidden tab or after a failed fetch; nav badges never updated | The client marks read only after a successful load, only while the tab is visible, and only up to the newest message it displayed (`mark_thread_read(p_conversation, p_up_to)`, never backwards, never into the future). The server page no longer marks read on navigation. Friends badges (desktop link and phone tab) are live: realtime notification inserts, a `cg:unread-changed` event from the chat, focus/visibility, and a 30 s fallback. | pilot "the read marker only advances to what was loaded, and never backwards" |
| 4 | Queued friend alerts ignored later mute / removal / block / read; the worker only checked the general preference | Mute, read-to-end, removal, block and conversation end cancel queued rows; `claim_push_queue` re-checks conversation state, friendship, blocks, consent, mute and unread state at send time and marks obsolete rows skipped with the reason. | pilot "queued friend alerts are dropped by later mute, read, opt-out, removal…" |
| 5 | Long friend chats had no pagination (oldest-first, 1,000-row cap) | The chat loads the newest 200 messages first and offers "Show earlier messages" (200 per page); the read marker is bounded to the newest loaded message. | — (manual) |
| 6 | Friend-push failures had no retry path | `fail_push_queue`: back to the queue with backoff (1, 2, 4 min), `failed` after three attempts; claims older than 10 minutes are reclaimed. | same pilot test as 4 |
| 7 | Privacy page said all delivered messages are deleted 30 days after a conversation ends | Distinguishes session messages (30 days after the conversation ends) from friend messages (30 days after sending). | — |

**Limitation kept on purpose:** the read marker is a single timestamp per person and thread. Seeing the newest page marks everything older as read, including older unread messages the reader has not paged back to. Per-message read receipts would be needed to do better; not planned for the pilot.

## Friend chats, queue repair, reminder edge cases (2026-10-20)

**Friends are persistent chats, not reconnection invitations.** Each friendship (`connections`) has at most one conversation with `kind = 'friend'` (partial unique index `one_friend_thread_per_connection`; `open_friend_thread` is idempotent and safe under concurrent taps). Aliases from the original conversation are kept. Either person can write at any time, including outside session hours and while the other is offline; messages go through the same pre-delivery moderation and appear when the other person next opens the chat. Friends shows an unread count per thread and the Friends tab shows the total. "Give us a question" asks the model for one question on demand (rate-limited 10/hour per person). There are no inactivity rules; a thread ends only when someone removes the friend or blocks the other person.

**Fully separate from new-person matching.** `has_active_conversation()` counts only `kind = 'live'` conversations, so friend chats never block joining the queue, accepting an invitation, or the lobby's "you're in a conversation" redirect. Presence, partner-away, abandonment and the opening-round flow apply to live conversations only. Metrics (`conversation_started`, `conversation_opened`, `successful_participants`) ignore friend threads. The old `request_reconnection` RPC is dropped; legacy `reconnect` invitations were expired by migration 0008.

**Controls and privacy in friend chats:** mute (no pushes, still counted as unread), remove friend (ends the friendship for both; existing messages stay readable until they expire; no new messages), block (ends every thread between the two and cancels undelivered messages), report (unchanged). Push for friend messages is a **separate consent** (Profile → "Notify me about new friend messages"), the lock-screen text is always "You have a new message." with no name or content, and at most one push per thread per 10 minutes. Friend messages are deleted 30 days after they were sent (`purge_retention`), independent of whether the thread is open.

**Stranded queue repair:** `leave_queue` now declines a pending invitation and requeues the other person; `open_conversation_for_invitation` requeues anyone whose competing invitation it declines; `join_queue` and `expire_stale` repair `invited` rows whose invitation is no longer pending; migration 0008 repaired existing rows. `respond_invitation` takes the per-account advisory locks (sorted) before locking the invitation row (migration 0009), which removed a deadlock found by the new concurrency test (two invitations sharing a person, accepted at the same time).

**Reminder/calendar edge cases:** "next session only" computes the target session on the server (`pickNextReminderSession`; 409 if there is no upcoming session) and the confirmation shows that date; "selected days" cannot be saved with no days (400 + disabled button); `/api/calendar?days=` with an empty value yields no days (400), not Sunday. Profile editing shows a load error with "Try again" instead of a blank form.

**Metrics:** `successful_participants` (people whose live conversation opened) is reported next to `conversations_opened` (distinct conversations). Two people, one conversation → 2 joins, 2 successful participants, 1 conversation, 100 %.

**Verified locally (browser, real Claude moderation):** Friends → Message → friend chat opened → message delivered → "Give us a question" generated one. **Not verified:** friend-message push on a physical phone; the two-device friend-chat flow on the hosted project; reminder email delivery for the new "next session" target.

## Reminder setup (2026-10-20 update)

- **Email reminders:** “Email me 10 minutes before the session.” is ON by default in first-time setup and is only activated by **Save reminder preferences** (visiting the page changes nothing). A saved opt-out is never re-enabled. Follows the chosen frequency (next session / selected days / every session). If the server has no email sender, the option shows “Email reminders aren't available on this server yet” instead of an enabled state. Every reminder email carries a signed one-click unsubscribe link (`/api/reminders/unsubscribe?t=…`, HMAC-bound to the account; sets `email_enabled=false` and logs a consent event).
- **Phone notifications:** enabling registers the device immediately (permission prompt only on tap), then Save turns the preference on. “Remove this device” unsubscribes it.
- **Confirmations:** “Email reminders saved for every session, 10 minutes before.” / “Email and phone reminders saved …” / “Email and phone reminders are off.” Nothing ever says “Added to calendar”: opening or downloading the file doesn't confirm an import.
- **Calendar:** two prominent buttons, **Add to Apple Calendar** and **Add to Google Calendar**, plus a small **Other calendars (.ics)** link (same file; works with Outlook and others). Calendar export is separate from app preferences and uses the chosen frequency, the schedule timezone (TZID recurrence) and a 10-minute alarm.
- **iPhone guidance:** on iOS only, the first Apple Calendar export shows a panel (“On the next screen, tap Add To Calendar at the bottom. The blue checkmark closes the preview without adding the event.”) with a visual, **Open calendar preview** and **Cancel**; available again via **Need help adding it?**. Verified against the observed iOS 26 Safari flow from the user's screenshots; the native preview itself is iOS-owned and not styled.
- **Real-device status:** calendar export verified on an iPhone (event preview correct). Push on a physical phone and the new guidance panel are **not yet verified on device**.

## Session schedule & reminders — configuration

- Change the schedule in Review → Policy (`session_days` as `[0..6]`, `session_start_time` `"HH:MM"`, `session_duration_minutes`, `session_timezone` IANA). All surfaces read the same values; downloaded calendar events do **not** update themselves.
- Broadening thresholds: `broaden_relaxed_after_seconds` (60), `broaden_any_after_seconds` (120), `relaxed_difference_score` (0.20), `min_difference_score` (0.40). Presence: `presence_grace_seconds` (45). Invitation acceptance: `invitation_ttl_seconds` (60).
- Push needs `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (set on Vercel). Email reminders use the same SMTP/Resend settings as other mail.
- Scheduler: `worker_config` rows `tick_url` and `cron_secret` on the hosted database (set via service role); the cron job `common-ground-tick` is created by migration 0005.

## Change log

- 2026-10-20 — Fourth review fixes: questions close with the conversation (block/leave can no longer reveal a hidden answer), revocable friendship consent, read marks only for loaded + visible messages with live badges, push-queue re-check/cancel/retry, chat pagination, privacy wording. Migration 0010. 90 tests.

- 2026-10-20 — Friends as persistent chats (one thread per friendship, offline delivery, unread counts, on-demand question, mute/remove/block, separate neutral push consent with flood guard, 30-day per-message retention), live-only scoping of the one-active-conversation rule and metrics, stranded-queue repair and acceptance lock ordering, server-side "next session" reminder target, strict calendar day parsing, profile load error handling. Migrations 0008, 0009. 84 tests.

- 2026-10-20 — Third review fixes (push endpoint allowlist, one conversation per person, calendar first occurrence, reminder renewal, edit prefill, shared-device sign-out, both-side metric, sign-in wording). Migration 0007. 79 tests.

- 2026-10-20 — Reminder setup: email default-on with explicit save and persisted opt-out, one-click unsubscribe in emails, Apple/Google buttons + Other calendars link, iPhone pre-preview guidance, honest confirmations. 70 tests.

- 2026-10-20 — Questionnaire v2 (8 policy questions, explicit non-answers, issue priorities), normalized per-issue scoring with a 5-answer minimum overlap, new thresholds, fresh start of questionnaire data; AI inputs unchanged and now test-pinned. 69 tests.

- 2026-10-20 — Daily session, readiness matching, broadening, reminders, metrics, DB scheduler (see sections above). 61 automated tests: schedule (PDT/PST, Arizona, Hawaii, Tokyo date rollover, midnight crossing, weekday-only, spring-forward, reminder window), calendar recurrence/UID/Google link, reminder idempotency/retries/stale/unsubscribe/next-only/shared device, session gating and close, invitation grace at close, nonresponder pause + priority + avoid, stale presence, broadening consent + mutual preference, block at acceptance, plus all earlier security/privacy tests. Not independently tested: push delivery on a physical phone; a real two-user run during a live 6 pm Pacific session (the local two-user flow and the earlier live run cover the mechanics).

- 2026-10-20 — Re-review follow-ups: `safeNext` now validates the resolved origin (fixes `/a/..//example.org` bypass) with unit tests; Friends list has no client-side override and reflects server state after expiry/decline (DB test). 39 tests.

- 2026-10-20 — Review fixes 1–9 (see table above); 34 tests; SMTP notices; `scripts/test-login-link.mjs` harness for signing a test account into any environment.

- 2026-10-20 — Stats and badges: `account_stats`/`my_stats`/`peer_badges` functions (migration 0003, applied locally and on the hosted project), Profile page with counts, next-milestone line and badge grid, peer tier badges under the alias in the conversation header. Per-task model overrides `ANTHROPIC_MODEL_MODERATION` / `ANTHROPIC_MODEL_QUESTIONS`. 28 tests.

- 2026-10-20 — Design pass 2: conversation (avatars, opening-round progress bar, revealed-answer cards with a “Same answer” badge, pill composer, intro card), reflection (illustrations, chip scales), Review console (pill tabs with counts). Phone fixes: question card no longer sticky on small screens; composer sits above the tab bar; Review tab in the bottom bar for admins.

- 2026-10-20 — Design pass 1: light warm theme (cream/terracotta/sage), rounded components, Nunito + Fredoka, inline illustrations, one-question-per-screen slider questionnaire with progress dots and explicit "Unsure", bottom tab bar on phones (Talk / Friends / Profile), Sign out always visible. Admin accounts skip onboarding and land on Review.
- 2026-10-20 — Hosted pilot on Vercel + Supabase; Gmail SMTP for sign-in links; activity-driven worker tick for the free plan.
- 2026-10-20 — Real model path (Claude) with refusal → human review; moderation probe script.
- 2026-10-20 — Initial build: schema/RLS/transactions, workers, all screens, 27 tests, docs.
