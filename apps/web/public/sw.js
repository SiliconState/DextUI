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

// Cache allowlist: only the versioned app shell. Everything else — live
// host surfaces, session files (including ?t=<token> subresource loads),
// pack panel payloads, or whatever a future host release adds — goes
// straight to the network and is never cached: an offline replay of
// authenticated or transient content must be impossible by construction,
// not by enumeration.
const CACHEABLE = (p) => p === "/" || p === "/index.html" || p === "/manifest.webmanifest" || p === "/icon.svg" || p.startsWith("/assets/");

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.cache === "no-store" || !CACHEABLE(url.pathname)) return;
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
