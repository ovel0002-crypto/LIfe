/* Life service worker: offline app shell, cached API reads, push notifications with actions. */
const VERSION = "life-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-180.png"];
const API_CACHE = ["/api/today", "/api/plan", "/api/projects", "/api/tasks", "/api/events"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API: network first, fall back to the last good response (works on the train).
  if (url.pathname.startsWith("/api/")) {
    if (!API_CACHE.includes(url.pathname)) return;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || new Response("{}", { headers: { "content-type": "application/json" } }))),
    );
    return;
  }

  // Navigations: network first so updates land immediately; offline → cached shell.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
    return;
  }

  // Hashed static assets: cache first.
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok && (url.pathname.startsWith("/_expo/") || url.pathname.startsWith("/assets/"))) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "Life", body: "" };
  try {
    data = e.data.json();
  } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/", tag: data.tag },
      actions: (data.actions || []).slice(0, 2).map((a) => ({ action: a.id, title: a.label })),
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url, tag } = e.notification.data || {};
  // Actions open the app with the answer; the app posts it with your token.
  const target = e.action && tag ? `/?checkin=${encodeURIComponent(tag)}&action=${encodeURIComponent(e.action)}` : url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
