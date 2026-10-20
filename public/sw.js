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
    const sub = await self.registration.pushManager.subscribe(event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true });
    const j = sub.toJSON();
    await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "subscribe", endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) });
  })());
});
