// DextUI PWA service worker: network-first with offline cache fallback.
// The cache name is build-specific: the app registers `/sw.js?v=<build-id>`
// and this worker derives `dextui-<id>` from its own URL, deleting every
// other `dextui-*` cache on activate so an update never serves an old shell.
const CACHE = `dextui-${new URL(self.location.href).searchParams.get("v") ?? "dev"}`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("dextui-") && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// Live host surfaces are never cached: authenticated JSON that must not be
// replayed offline as if it were fresh. Only the app shell and assets go
// through the cache.
const HOST_API = (p) => p === "/ws" || p === "/health" || p === "/__agent" || p === "/sessions" || p.startsWith("/sessions/");

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.cache === "no-store" || HOST_API(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        throw new Error("offline and not cached");
      }
    })(),
  );
});
