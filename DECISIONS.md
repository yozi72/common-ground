# Decisions

Record of product and technical decisions for the Common Ground pilot, so the next conversation can continue from here rather than re-deciding. Dates are absolute.

## Decided (2026-10-20)

**Stack.** Next.js 16 + Supabase (Postgres with RLS, magic-link auth, realtime on approved tables only). Server-side model gateway wired for Claude; labeled mock until a key exists. Local-first with Supabase CLI; hosted project later via env vars.

**Audience.** US adults, English only, 18+ self-attested at onboarding.

**Sign-in.** Email magic link. Email is the private identity; never shown to other participants.

**Political matching.** Five-dimension questionnaire (government role, tradition/change, immigration, economy, institutions), each -2..2 with "unsure" = 0, any dimension skippable; at least 3 answered to join the queue. Difference = mean absolute difference over dimensions both answered (needs ≥2 overlapping). Threshold `min_difference_score` = 1.0. Oldest waiter first; partner = most different eligible candidate. Participants only ever see "you answered some questions differently"; exact answers are never shown to anyone.

**Conversation format.** Opening round of 10 shared questions, each with 3 generated choices plus a custom answer. Answers hidden until both have answered or skipped. Custom answers go through moderation like messages. Then open chat. Mid-chat questions fire after ~90 s of *active* chat (quiet gaps count at most 60 s), and the gap doubles each time up to 10 min. One open question at a time; unfinished mid-chat questions close unrevealed after 10 min. All values are `policy_config` knobs.

**Choices source.** AI-generated with server validation (3 distinct, no loaded/partisan vocabulary), falling back to a curated bank. In mock mode the bank is used directly.

**Partner exit.** Heartbeat every 30 s; the other person is told within 2 min (`partner_away_after_seconds` = 120); conversation ends as abandoned after 10 min of silence.

**Moderation outage.** Hold with backoff and visible explanation; sender may cancel after 45 s; after six failed attempts the message goes to human review. Nothing is ever passed on error.

**Friendship/reconnection.** Enabled, no time gate, mutual private opt-in after any ended conversation (not after a block). Both find out only when both said yes. Reconnection reuses the original aliases. Policy version `v1-mutual-no-gate`; switchable off via `friendship_enabled`.

**Contact sharing.** Disabled. No feature, no toggle in the UI. `contact_sharing_enabled=false` is recorded for a future explicit policy.

**Stance reveal.** Only the "you differ" note at match time. No coarse summary at reflection.

**Queue notifications.** In-app always; optional email (Resend) on opt-in; availability request lasts 30 min, invitations 3 min. Browser push deferred.

**Retention.** Approved messages purged 30 days after a conversation ends; pending/blocked after 7 days (held while an appeal is open); reports kept 365 days; reflections kept; account deletion propagates immediately through FK cascades.

**Reviewers.** One admin account (`ADMIN_EMAIL`), promoted on first sign-in. Admin decisions use the same enforcement function as the worker and are logged as `provider = 'human'`.

**Identity disclosure.** Never automatic. No AI trustworthiness score exists; the connection-readiness check is a deterministic policy gate that a model can only add review flags to.

## Still open

1. **Launch windows.** Scheduled windows were a suggestion, not a requirement. The queue works any time; a window would just be a published time when more people are waiting.
2. **Contact sharing policy.** Stays disabled until an explicit, separately consented, granular policy is written.
3. **Success criteria.** Metrics captured: queue abandonment (availability_requests by status), match acceptance (invitation_participants), completion (conversations.end_reason), felt understood / recognized shared experience (session_reflections), repeat participation, moderation outcomes (moderation_decisions by decision/provider), appeals overturned. Thresholds that would justify expanding are not set.
4. **Reviewer capacity and SLA.** One admin for the pilot; what happens if held messages wait hours is unspecified beyond the sender's ability to cancel.
5. **Model cost budget.** Not set. ~1 call per message, ~1 per question; `moderation_decisions.latency_ms` and row counts give the numbers.
6. **Email provider.** Resend assumed; domain not verified yet.
7. **Questionnaire wording.** First draft in `src/lib/political.ts`; should be reviewed before real participants see it.
8. **Hosted environment.** Supabase project, domain, and scheduler are not created yet.
