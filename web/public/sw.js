// Service worker of the mobile build (installable app): once a page has been opened it opens again without a connection.
// Same-origin GETs are answered from the cache and refreshed in the background. Not touched: video (Range requests),
// anything under /api/ and other sites (YouTube). The data of the matches is not here: it lives in IndexedDB.
const CACHE = "sportsan-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(fresh);
        return hit;
      }
      return (await fresh) ?? (req.mode === "navigate" ? await cache.match("/", { ignoreSearch: true }) : null) ?? Response.error();
    })(),
  );
});
