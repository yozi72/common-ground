"use client";
// Browser side of push reminders. Permission is only requested from an
// explicit user action (enablePush), never on page load.

export type PushSupport = { supported: boolean; needsInstall: boolean; reason?: string };

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { supported: false, needsInstall: false };
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && (navigator as unknown as { standalone?: boolean }).standalone === true);
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS && !standalone) return { supported: hasApis, needsInstall: true, reason: "On iPhone, notifications only work after the app is added to the Home Screen." };
  if (!hasApis) return { supported: false, needsInstall: false, reason: "This browser doesn't support notifications." };
  return { supported: true, needsInstall: false };
}

function b64ToUint8(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

// Returns 'granted' | 'denied' | 'unsupported'. Registers with the server on success.
export async function enablePush(vapidPublicKey: string): Promise<"granted" | "denied" | "unsupported"> {
  const s = pushSupport();
  if (!s.supported || s.needsInstall) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vapidPublicKey) });
  const j = sub.toJSON();
  const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "subscribe", endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't register this device");
  return "granted";
}

// Removes this device's subscription on the server and in the browser.
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unsubscribe", endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export function deviceTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
