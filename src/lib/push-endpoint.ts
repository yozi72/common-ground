// Web Push endpoints we are willing to contact. The worker POSTs to whatever
// endpoint is stored, so only known push services are accepted; anything else
// (including loopback, private ranges, or an arbitrary host) is rejected both
// when saving and again right before sending.
const ALLOWED_HOST_SUFFIXES = [
  "fcm.googleapis.com",            // Chrome / Chromium (FCM)
  "android.googleapis.com",        // legacy Chrome
  "updates.push.services.mozilla.com", // Firefox
  "push.services.mozilla.com",
  "notify.windows.com",            // Edge (WNS), e.g. *.notify.windows.com
  "push.apple.com",                // Safari / iOS (web.push.apple.com and regional *.push.apple.com)
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false; // no IP literals
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

export const ALLOWED_PUSH_HOSTS = ALLOWED_HOST_SUFFIXES;
