// Bump this version whenever app.js/style.css/index.html change — it
// invalidates the old cache on activate (replaces relying on ?v= alone).
const CACHE = 'factfeed-v7';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'src/main.js',
  'src/storage.js',
  'src/recommender.js',
  'src/reactions.js',
  'facts.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // facts.json: network first, so new facts arrive as soon as they're
  // deployed; fall back to the cached copy offline.
  if (url.pathname.endsWith('/facts.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }

  // App shell: cache first (ignoreSearch so style.css?v=5 hits the cached
  // style.css), network fallback with cache backfill.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
