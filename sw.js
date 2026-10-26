const CACHE_NAME = "muse-pwa-shell-v2";
const ARTWORK_CACHE = "muse-artwork-cache-v1";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./logo.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== ARTWORK_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept ranged audio streams or /play redirects so native OS media pipeline streams directly
  if (
    req.headers.has("Range") ||
    url.pathname.endsWith("/play") ||
    (url.pathname.endsWith("/stream") && !/\.(jpg|jpeg|png|webp|avif)/i.test(url.search))
  ) {
    return;
  }

  // Cache album/song artwork images for instant offline/scroll rendering
  if (
    url.pathname.endsWith("/stream") &&
    /\.(jpg|jpeg|png|webp|avif)/i.test(decodeURIComponent(url.search))
  ) {
    event.respondWith(
      caches.open(ARTWORK_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const netRes = await fetch(req);
          if (netRes && netRes.status === 200) {
            cache.put(req, netRes.clone());
          }
          return netRes;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Network-first with offline cache fallback for HTML/Manifest/App Shell
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
  }
});
