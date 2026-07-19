// Bump this version whenever app.js/style.css/index.html change — it
// invalidates the old cache on activate (replaces relying on ?v= alone).
const CACHE = 'factly-v21';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'src/main.js',
  'src/storage.js',
  'src/recommender.js',
  'src/reactions.js',
  'facts.json',
  'news.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the HTTP cache — otherwise a new worker could
  // populate its fresh cache with STALE files the browser had lying around,
  // silently freezing the old version under a new cache name.
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
  );
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

  // Navigations (the HTML itself): network first, so a deploy is visible on
  // the very next load instead of needing one load to update the worker and
  // a second one to see the new shell. Offline falls back to the cache.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // facts.json/news.json: network first, so new content arrives as soon as
  // it's deployed; fall back to the cached copy offline.
  if (url.pathname.endsWith('/facts.json') || url.pathname.endsWith('/news.json')) {
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
