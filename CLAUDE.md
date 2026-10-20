## Working rules (always follow)
- After EVERY change you make (file edit, new file, decision, fix, bug found), update NOTES.md before replying to me. No exceptions, even for small changes.
- Each update: add what changed, which files/functions, and why.
- End every reply with one line: "NOTES.md updated: <what you added>". If you didn't update it, say why.
- Commit to git after each meaningful working change with a clear message. Ask first if it's risky.
- When context gets heavy, tell me and write a full handoff to NOTES.md.

# Common Ground — project facts

## What it is
An anonymous, moderated text-conversation pilot that pairs adults who answered a short policy questionnaire differently, gives both the same human (non-political) questions, then opens chat. One shared daily "conversation hour" (default 6–7 pm America/Los_Angeles). Product brief and decisions: `DECISIONS.md`. Status, known issues, test script for reviewers: `HANDOFF.md` (keep it updated on every push; ChatGPT reviews from it). Running notes: `NOTES.md`.

## Stack
- Next.js 16 (App Router, `src/`), React 19, Tailwind v4, TypeScript. `proxy.ts` (not middleware) refreshes the Supabase session and gates pages.
- Supabase: Postgres with RLS, magic-link auth, Realtime on approved tables only. Migrations in `supabase/migrations/` (append new files; never edit applied ones). Local stack via `npx supabase start` (Docker provided by Colima on this Mac). Hosted project ref `nrhduxkatknackelzbmv`.
- AI: server-side gateway `src/lib/ai/gateway.ts` (Claude `claude-opus-5-5`, effort low; labeled mock when `AI_PROVIDER=mock`). Moderation decisions are enforced only by `apply_moderation_decision` (service role).
- Workers: `src/lib/workers/*`; `/api/cron/tick` is called every minute by `pg_cron` in the hosted database (`worker_config` holds URL + secret).
- Deploy: Vercel project `common-ground` (free plan) via `npx vercel deploy --prod --yes`; env vars on Vercel; GitHub `yozi72/common-ground` (public).
- Tests: `npm test` (vitest; needs local Supabase and `.env.local` exported). Probe of the real model: `npm run probe` (costs API calls).

## Conventions
- All client writes go through SECURITY DEFINER RPCs that start with `assert_user()`; worker RPCs have EXECUTE revoked from `authenticated` and call `assert_service_role()`.
- Never expose another user's `account_id` to a client: peers are referenced by `participant_id` and shown by alias.
- Nothing reaches `approved_messages` except through `apply_moderation_decision`. Pending messages are sender-only and excluded from Realtime.
- Political answers and issue priorities are used for matching only; `buildQuestionInput()` is the only path to the question model and must never include them.
- UI: light warm theme, rounded components, one top bar + bottom tab bar (Talk / Friends / Profile [/ Review]), one primary action per screen, no browser `confirm()`/`prompt()`.
- Lint rules forbid `Date.now()` in render and `setState` directly in effects; use `serverNow()` / deferred effects.
- Commit messages end with the Co-Authored-By line the harness provides; no secrets in the repo (`.env.local`, `.vercel/` are ignored).

## Never do
- Run `supabase db reset` or any destructive helper against the hosted project.
- Put a secret in a committed file, a chat reply, or a screenshot.
- Promise anonymity, alarm-grade reminders, or validated political measurement in copy.
- Change product positioning, landing-page headline, marketing copy, the guided-question content, or the number of required conversation questions without being asked.
- Accept an invitation or act inside the app on the user's real accounts.
