// Service worker for the Tonic PWA: caches the app shell so it opens
// instantly (and works offline once loaded) while leaving the analysis
// endpoints (/api/analyze, /ws) untouched - those need a live server, and
// a WebSocket upgrade can't be intercepted by a service worker anyway.
const CACHE_NAME = "tonic-shell-v24";
const SHELL_FILES = [
  "/",
  "/style.css",
  "/app.js",
  "/worklet.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-first: the server is always local (embedded in the Android
  // app, or the desktop exe), so the network copy is instant and always
  // current. The old cache-first strategy served the *previous* build's
  // page on the first launch after every update. The cache is now only an
  // offline fallback (e.g. an installed desktop PWA with the server off).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
