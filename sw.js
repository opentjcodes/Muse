

// ============================================================================
// MUSE PWA OFFLINE-FIRST SERVICE WORKER & STORAGE CONTROLLER (v6.0)
// Caches index.html, cast.js, tv.html, Tailwind UI, FontAwesome, Google Fonts,
// PeerJS, Artwork & Worker JSON Feeds for instant startup and 100% offline play.
// ============================================================================

const SW_VERSION = "v6.0.0";
const SHELL_CACHE = `muse-ui-shell-${SW_VERSION}`;
const CDN_UI_CACHE = `muse-cdn-assets-${SW_VERSION}`;
const API_DATA_CACHE = `muse-api-json-${SW_VERSION}`;
const ARTWORK_CACHE = `muse-artwork-${SW_VERSION}`;

const ACTIVE_CACHES = [
  SHELL_CACHE,
  CDN_UI_CACHE,
  API_DATA_CACHE,
  ARTWORK_CACHE
];

const MAX_ARTWORK_ITEMS = 400;
const MAX_API_JSON_ITEMS = 180;

// Core Same-Origin App Shell (Includes Cast Engine & TV Receiver View)
const CORE_SHELL_URLS = [
  "./",
  "./index.html",
  "./cast.js",
  "./tv.html",
  "./manifest.json",
  "./logo.png"
];

// External UI/UX & Cast Assets
const CRITICAL_CDN_UI_URLS = [
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js",
  "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2"
];

const OFFLINE_SVG_COVER = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#141826"/><stop offset="100%" stop-color="#05060a"/></linearGradient></defs><rect width="500" height="500" fill="url(%23g)"/><circle cx="250" cy="250" r="105" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="18"/><circle cx="250" cy="250" r="32" fill="rgba(255,255,255,0.22)"/></svg>`;

async function fetchWithTimeout(request, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function trimCacheQuota(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const deleteCount = keys.length - maxItems;
      for (let i = 0; i < deleteCount; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) {}
}

// 1. INSTALL
self.addEventListener("install", (event) => {
  self.skipWaiting();

  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        CORE_SHELL_URLS.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (res && res.ok) await shellCache.put(url, res);
          } catch (e) {}
        })
      );

      const cdnCache = await caches.open(CDN_UI_CACHE);
      await Promise.allSettled(
        CRITICAL_CDN_UI_URLS.map(async (url) => {
          try {
            let res = await fetch(url, { mode: "cors" }).catch(() => null);
            if (!res || (!res.ok && res.type !== "opaque")) {
              res = await fetch(url, { mode: "no-cors" });
            }
            if (res && (res.ok || res.type === "opaque")) {
              await cdnCache.put(url, res);
            }
          } catch (e) {}
        })
      );
    })()
  );
});

// 2. ACTIVATE
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => !ACTIVE_CACHES.includes(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// 3. FETCH ROUTER
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();

  // A. BYPASS LIVE AUDIO STREAMS
  const isArtworkStream =
    url.pathname.endsWith("/stream") &&
    /\.(jpg|jpeg|png|webp|avif|svg)/i.test(decodeURIComponent(url.search));

  if (
    req.headers.has("Range") ||
    url.pathname.endsWith("/play") ||
    (url.pathname.endsWith("/stream") && !isArtworkStream)
  ) {
    return;
  }

  // B. SAME-ORIGIN APP SHELL (./, ./index.html, ./cast.js, ./tv.html, ./manifest.json, ./logo.png)
  if (
    req.mode === "navigate" ||
    (url.origin === self.location.origin &&
      (url.pathname.endsWith("/") ||
        url.pathname.endsWith("/index.html") ||
        url.pathname.endsWith("/cast.js") ||
        url.pathname.endsWith("/tv.html") ||
        url.pathname.endsWith("/manifest.json") ||
        url.pathname.endsWith("/logo.png")))
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached =
          (await cache.match(req, { ignoreSearch: true })) ||
          (req.mode === "navigate" && url.pathname.endsWith("/tv.html")
            ? await cache.match("./tv.html")
            : null) ||
          (req.mode === "navigate" ? await cache.match("./index.html") : null);

        const networkFetch = fetchWithTimeout(req, 4000)
          .then((netRes) => {
            if (netRes && netRes.status === 200) {
              cache.put(req, netRes.clone());
            }
            return netRes;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }

        const fresh = await networkFetch;
        if (fresh) return fresh;

        return (
          (await cache.match("./index.html")) ||
          new Response("Muse Offline — Please connect once to initialize UI.", {
            status: 503,
            headers: { "Content-Type": "text/plain" }
          })
        );
      })()
    );
    return;
  }

  // C. EXTERNAL UI & CAST CDNs
  if (
    host.includes("cdn.tailwindcss.com") ||
    host.includes("unpkg.com") ||
    host.includes("fonts.googleapis.com") ||
    host.includes("fonts.gstatic.com") ||
    host.includes("cdnjs.cloudflare.com")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CDN_UI_CACHE);
        const cached =
          (await cache.match(req)) || (await cache.match(req.url));

        const updateTask = fetch(req)
          .then((netRes) => {
            if (netRes && (netRes.status === 200 || netRes.type === "opaque")) {
              cache.put(req, netRes.clone());
            }
            return netRes;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(updateTask);
          return cached;
        }

        const netRes = await updateTask;
        if (netRes) return netRes;

        return new Response("", { status: 200 });
      })()
    );
    return;
  }

  // D. ALBUM & TRACK ARTWORK IMAGES
  if (
    isArtworkStream ||
    req.destination === "image" ||
    /\.(jpg|jpeg|png|webp|avif|svg)(\?.*)?$/i.test(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ARTWORK_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;

        try {
          const netRes = await fetchWithTimeout(req, 5000);
          if (netRes && (netRes.status === 200 || netRes.type === "opaque")) {
            cache.put(req, netRes.clone());
            event.waitUntil(trimCacheQuota(ARTWORK_CACHE, MAX_ARTWORK_ITEMS));
            return netRes;
          }
        } catch (e) {}

        return new Response(OFFLINE_SVG_COVER, {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-store"
          }
        });
      })()
    );
    return;
  }

  // E. CLOUDFLARE WORKER API JSON (/home, /search, /lyrics, /album, /song, /reco)
  // Stale-While-Revalidate + Fast Network Fallback for Reduced Server Load
  if (
    host.includes("workers.dev") &&
    ["/home", "/search", "/lyrics", "/album", "/song", "/reco"].some((p) =>
      url.pathname.endsWith(p)
    )
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_DATA_CACHE);
        const cachedExact = await cache.match(req);

        const networkTask = fetchWithTimeout(req, 4200)
          .then((netRes) => {
            if (netRes && netRes.status === 200) {
              cache.put(req, netRes.clone());
              trimCacheQuota(API_DATA_CACHE, MAX_API_JSON_ITEMS);
            }
            return netRes;
          })
          .catch(() => null);

        if (cachedExact) {
          event.waitUntil(networkTask);
          return cachedExact;
        }

        const fresh = await networkTask;
        if (fresh) return fresh;

        const fallbackPayload = url.pathname.endsWith("/lyrics")
          ? {
              source: "OfflineCache",
              syncType: "PLAIN",
              lines: [
                {
                  index: 0,
                  time: 0,
                  endTime: 999,
                  text: "Offline Mode — Playing from App Vault",
                  plainOnly: true,
                  words: []
                }
              ]
            }
          : {
              source: "OfflineMode",
              offline: true,
              songs: [],
              albums: [],
              results: [],
              list: []
            };

        return new Response(JSON.stringify(fallbackPayload), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Cache-Status": "OFFLINE-FALLBACK"
          }
        });
      })()
    );
    return;
  }
});

// 4. MESSAGE CONTROLLER
self.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (data.type === "CLEAR_RUNTIME_CACHES") {
    event.waitUntil(
      (async () => {
        await caches.delete(API_DATA_CACHE);
        await caches.delete(ARTWORK_CACHE);
        if (event.source) {
          event.source.postMessage({
            type: "CACHES_CLEARED",
            status: "ok"
          });
        }
      })()
    );
  }
});
