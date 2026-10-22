#!/usr/bin/env node
// QA harness only. Creates (or reuses) a throwaway test account on the
// Supabase project in the environment and prints a one-time sign-in URL for
// the app, so a browser can be signed in without reading a mailbox.
//   SITE_URL=https://... node scripts/test-login-link.mjs qa-tester-1@test.local
import { createClient } from "@supabase/supabase-js";

// Isolation guard: this helper creates accounts on whatever project the
// environment points at. It refuses anything but the local stack unless the
// hosted QA environment is designated explicitly (QA_ALLOW_HOSTED=1), and it
// never runs under automated tests.
const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname);
if (process.env.VITEST || process.env.NODE_ENV === "test") { console.error("refusing to run under automated tests"); process.exit(2); }
if (!local && process.env.QA_ALLOW_HOSTED !== "1") { console.error(`refusing to touch ${target.hostname}: set QA_ALLOW_HOSTED=1 to use the designated hosted QA project on purpose`); process.exit(2); }

const email = process.argv[2];
if (!email) { console.error("usage: test-login-link.mjs <email>"); process.exit(1); }
const site = process.env.SITE_URL ?? "http://localhost:3000";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
if (!list.users.some((u) => u.email === email)) {
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
}
const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (error) throw error;
console.log(`${site}/auth/callback?token_hash=${data.properties.hashed_token}&type=magiclink&next=%2Flobby`);
