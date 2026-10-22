// Regression test: automated tests cannot reach a real email or push provider.
// Background: on 2026-10-21 local test runs sourced .env.local (real SMTP
// credentials) and the reminder worker emailed @test.local accounts for real.
import { describe, it, expect, afterEach } from "vitest";
import nodemailer from "nodemailer";
import webpush from "web-push";
import { env, LiveDeliveryBlockedError } from "@/lib/env";
import { sendDueReminders } from "@/lib/workers/reminders";
import { sendQueuedEmails } from "@/lib/workers/email";
import { sendFriendMessagePushes } from "@/lib/workers/friend-push";
import { runTick } from "@/lib/workers/tick";
import { Deadline } from "@/lib/workers/deadline";
import { nextSessions } from "@/lib/schedule";
import { getScheduleConfig } from "@/lib/schedule-config";
import { admin, makeUser, deleteUser, openSessionNow, resetQueue, LEFT, RIGHT, type TestUser } from "./helpers";
import { assertLocalDatabase, PROVIDER_VARS, providerAttempts, stripProviderCredentials, installFetchGuard } from "./setup";

// Fake credentials that must never be usable from a test process.
const FAKE = { RESEND_API_KEY: "re_test_fake", SMTP_HOST: "smtp.example.invalid", SMTP_USER: "fake@example.invalid", SMTP_PASS: "fake", VAPID_PRIVATE_KEY: "fake", NEXT_PUBLIC_VAPID_PUBLIC_KEY: "fake", ALLOW_LIVE_DELIVERY: "true" };
function injectFakeCredentials() { for (const [k, v] of Object.entries(FAKE)) process.env[k] = v; }

const made: TestUser[] = [];
afterEach(async () => {
  stripProviderCredentials();
  providerAttempts().length = 0;
  for (const u of made.splice(0)) await deleteUser(u);
});

describe("delivery isolation (automated tests never reach a real provider)", () => {
  it("runs as an automated test with every provider credential stripped", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(env.isAutomatedTest()).toBe(true);
    expect(env.liveDeliveryAllowed()).toBe(false);
    for (const k of PROVIDER_VARS) expect(process.env[k], k).toBeUndefined();
    expect(env.emailConfigured()).toBe(false);
    expect(env.pushConfigured()).toBe(false);
    expect(env.smtp()).toBeNull();
    expect(env.resendApiKey()).toBeNull();
    expect(env.aiProvider()).toBe("mock");
  });

  it("credentials injected into the test process are still treated as absent", () => {
    injectFakeCredentials();
    expect(env.liveDeliveryAllowed()).toBe(false);
    expect(env.emailConfigured()).toBe(false);
    expect(env.pushConfigured()).toBe(false);
    expect(env.smtp()).toBeNull();
    expect(env.resendApiKey()).toBeNull();
    expect(() => env.assertLiveDelivery("email")).toThrow(LiveDeliveryBlockedError);
  });

  it("refuses to run against a non-local database", () => {
    expect(() => assertLocalDatabase("https://example.supabase.co")).toThrow(/not the local Supabase stack/);
    expect(() => assertLocalDatabase(undefined)).toThrow(/not a URL/);
    expect(() => assertLocalDatabase("http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertLocalDatabase("http://localhost:54321")).not.toThrow();
    // .env.local sourcing cannot override the harness: stripping is idempotent and explicit.
    const fake = { SMTP_HOST: "x", RESEND_API_KEY: "y", AI_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv;
    stripProviderCredentials(fake);
    expect(fake).toEqual({ AI_PROVIDER: "mock" });
  });

  it("nodemailer and web-push are fakes that record and throw", async () => {
    await expect(nodemailer.createTransport({}).sendMail({ to: "x@test.local" })).rejects.toThrow(/blocked/);
    await expect(webpush.sendNotification({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "a", auth: "b" } }, "p")).rejects.toThrow(/blocked/);
    expect(providerAttempts().map((a) => a.kind)).toEqual(["smtp", "push"]);
  });

  it("fetch to any non-local host is blocked; local Supabase still works", async () => {
    await expect(fetch("https://api.resend.com/emails", { method: "POST" })).rejects.toThrow(/blocked: automated tests may not reach api.resend.com/);
    await expect(fetch(new URL("https://fcm.googleapis.com/fcm/send/x"))).rejects.toThrow(/blocked/);
    await expect(fetch(new Request("https://example.com/"))).rejects.toThrow(/blocked/);
    expect(providerAttempts().filter((a) => a.kind === "fetch").map((a) => a.detail)).toEqual(["api.resend.com", "fcm.googleapis.com", "example.com"]);
    const { error } = await admin().from("policy_config").select("key").limit(1);
    expect(error).toBeNull();
    // installing the guard twice keeps blocking (no accidental unwrap)
    installFetchGuard();
    await expect(fetch("https://api.resend.com/")).rejects.toThrow(/blocked/);
  });

  it("the real reminder sender cannot email or push even when forced on, with credentials present", async () => {
    injectFakeCredentials();
    await openSessionNow();
    const u = await makeUser("iso-rm", LEFT); made.push(u);
    await u.client.from("reminder_prefs").upsert({ account_id: u.id, push_enabled: true, email_enabled: true, mode: "daily", days: [0, 1, 2, 3, 4, 5, 6], minutes_before: 10 });
    await u.client.rpc("upsert_push_subscription", { p_endpoint: "https://fcm.googleapis.com/fcm/send/iso-" + u.id, p_p256dh: "BPdummykeydummykeydummykey", p_auth: "authdummy", p_user_agent: "test" });
    const cfg = await getScheduleConfig();
    const at = nextSessions(Date.now() + 3 * 3600_000, 1, cfg)[0].start - 9 * 60_000;
    // Default path: credentials are ignored, both channels are skipped.
    const r = await sendDueReminders(at, Deadline.none());
    expect(r.email.sent).toBe(0);
    expect(r.push.sent).toBe(0);
    // Forced path: a caller claiming the channels are configured still hits the hard stop.
    const forced = await sendDueReminders(at, Deadline.none(), { emailConfigured: true, pushConfigured: true });
    expect(forced.email.sent).toBe(0);
    expect(forced.push.sent).toBe(0);
    const { data: sends } = await admin().from("reminder_sends").select("channel, status, last_error").eq("account_id", u.id);
    for (const s of sends ?? []) {
      expect(s.status).not.toBe("sent");
      if (s.last_error) expect(s.last_error).toMatch(/blocked|not configured/);
    }
    expect(providerAttempts()).toEqual([]); // nothing reached nodemailer, web-push or fetch
  });

  it("the outbox sender cannot email even when forced on; a relevant row fails permanently instead of retrying", async () => {
    injectFakeCredentials();
    await openSessionNow();
    await resetQueue();
    const a = await makeUser("iso-ob-a", LEFT); made.push(a);
    const b = await makeUser("iso-ob-b", RIGHT); made.push(b);
    await a.client.rpc("join_queue", { p_notify_email: true });
    await b.client.rpc("join_queue", { p_notify_email: true });
    const { data: pairs } = await admin().rpc("run_matching");
    expect(pairs).toBe(1); // pending invitation → two relevant outbox rows
    const rows = async () => (await admin().from("email_outbox").select("id, status, last_error").in("account_id", [a.id, b.id]).order("created_at")).data!;
    expect((await rows()).map((r) => r.status)).toEqual(["queued", "queued"]);
    const r1 = await sendQueuedEmails(20, Deadline.none());            // default: skipped (not configured)
    expect(r1.sent ?? 0).toBe(0);
    expect((await rows()).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    await admin().from("email_outbox").update({ status: "queued", attempts: 0, next_attempt_at: new Date().toISOString(), claim_token: null, claimed_until: null }).in("account_id", [a.id, b.id]);
    const r2 = await sendQueuedEmails(20, Deadline.none(), { configured: true }); // forced: hard stop inside the real deliverer
    expect(r2.sent ?? 0).toBe(0);
    for (const r of await rows()) {
      expect(r.status).toBe("failed");
      expect(r.last_error).toMatch(/blocked/);
    }
    expect(providerAttempts()).toEqual([]);
  });

  it("the friend push sender cannot push even when forced on", async () => {
    injectFakeCredentials();
    const r = await sendFriendMessagePushes(20, { configured: true }, Deadline.none());
    expect(r.sent).toBe(0);
    expect(providerAttempts()).toEqual([]);
  });

  it("a full worker tick with credentials present reaches no provider", async () => {
    injectFakeCredentials();
    await openSessionNow();
    const u = await makeUser("iso-tick", LEFT); made.push(u);
    await u.client.from("reminder_prefs").upsert({ account_id: u.id, push_enabled: true, email_enabled: true, mode: "daily", days: [0, 1, 2, 3, 4, 5, 6], minutes_before: 10 });
    await admin().from("email_outbox").insert({ account_id: u.id, template: "invitation", payload: {} });
    const tick = await runTick({ budgetMs: 25_000, source: "isolation-test" });
    expect(tick).toBeTruthy();
    expect(providerAttempts()).toEqual([]);
    const { data: sent } = await admin().from("reminder_sends").select("id").eq("account_id", u.id).eq("status", "sent");
    expect(sent ?? []).toEqual([]);
  });
});
