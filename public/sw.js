// Common Ground service worker: push reminders only. No offline caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Common Ground", body: "The conversation hour is starting soon.", url: "/lobby", tag: "session" };
  try { data = { ...data, ...event.data.json() }; } catch {}
  // Lock-screen copy stays neutral: no partner, no answers, no political content.
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    renotify: false,
    data: { url: data.url },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/lobby";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

// If the browser rotates the subscription, re-register it with the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      // the old subscription (and its options) may be gone; the server knows the key
      let options = event.oldSubscription && event.oldSubscription.options;
      if (!options || !options.applicationServerKey) {
        const r = await fetch("/api/reminders?vapid=1", { credentials: "same-origin" });
        if (!r.ok) throw new Error("vapid key " + r.status);
        const { key } = await r.json();
        if (!key) throw new Error("no vapid key");
        options = { userVisibleOnly: true, applicationServerKey: key };
      }
      const sub = await self.registration.pushManager.subscribe(options);
      const j = sub.toJSON();
      // the session cookie goes along, so the server attaches the device to the same account
      const res = await fetch("/api/reminders", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "subscribe", endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) });
      if (!res.ok) throw new Error("register " + res.status);
      if (event.oldSubscription && event.oldSubscription.endpoint !== j.endpoint) {
        await fetch("/api/reminders", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unsubscribe", endpoint: event.oldSubscription.endpoint }) }).catch(() => {});
      }
    } catch (e) {
      // nothing more can be done from a worker; the next app visit re-registers (push-client.ts)
      console.warn("[sw] push subscription rotation failed:", e && e.message);
    }
  })());
});
