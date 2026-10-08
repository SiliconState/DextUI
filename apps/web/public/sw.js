// Network-first PWA shell assets only; renderer/source/session data is not an
// offline conversation store. Each build claims its own asset cache.
const CACHE = `dextui-${new URL(self.location.href).searchParams.get("v") ?? "dev"}`;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n.startsWith("dextui-") && n !== CACHE).map(n => caches.delete(n)));
    } catch { /* Storage is optional, including during worker activation. */ }
    await self.clients.claim();
  })());
});

const CACHEABLE = p => p === "/" || p === "/index.html" || p === "/manifest.webmanifest" || /^\/(icon[\w-]*|apple-touch-icon)\.(svg|png)$/.test(p) || p.startsWith("/assets/");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.cache === "no-store" || !CACHEABLE(url.pathname)) return;
  // URLs or headers carrying credentials must not turn an asset-shaped route
  // into cached private content. Normal JS/CSS requests have neither.
  if (url.searchParams.has("t") || url.searchParams.has("token") || request.headers.has("Authorization")) return;

  // Call waitUntil synchronously, before any awaits. Storage is optional:
  // denied/quota-exhausted CacheStorage must never block a healthy network.
  const cache = caches.open(CACHE).catch(() => null);
  let fromNetwork = false;
  const response = (async () => {
    try { const fresh = await fetch(request); fromNetwork = true; return fresh; }
    catch (error) {
      const store = await cache;
      if (store) {
        try { const hit = await store.match(request); if (hit) return hit; }
        catch { /* Cache unavailable; retain the actual network failure. */ }
      }
      throw error;
    }
  })();
  event.waitUntil(response.then(async fresh => {
    if (!fromNetwork) return; // An offline hit already has its own cache entry.
    const finalUrl = new URL(fresh.url || request.url);
    const revoked = /(?:no-store|private)/i.test(fresh.headers.get("cache-control") ?? "")
      || [401, 403, 404, 410].includes(fresh.status)
      || finalUrl.origin !== self.location.origin || !CACHEABLE(finalUrl.pathname)
      || finalUrl.searchParams.has("t") || finalUrl.searchParams.has("token");
    if (revoked) {
      // A route can stop being public/cacheable. Do not replay its older public
      // entry offline after the server explicitly revoked it. Transient 5xx
      // failures leave the existing offline shell intact.
      const store = await cache;
      if (store) await store.delete(request);
      return;
    }
    if (!fresh.ok) return;
    // Clone before awaiting storage: the caller may consume `response` while
    // CacheStorage is opening, making a later clone fail with body-used.
    const copy = fresh.clone();
    const store = await cache;
    if (store) await store.put(request, copy);
  }).catch(() => {}));
  event.respondWith(response);
});
