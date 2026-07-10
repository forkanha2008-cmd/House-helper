// sw.js — House Helper Service Worker
const CACHE_NAME = 'house-helper-v30';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './native.js',
  './analytics.js',
  './icon-192.png',
  './icon-512.png',
];

// Files that change often during development — always check the network
// first so an update is visible on the very next load, not just after a
// manual hard refresh.
const NETWORK_FIRST_PATTERNS = [/\/$/, /index\.html$/, /app\.js$/, /style\.css$/];
function isNetworkFirst(url) {
  return NETWORK_FIRST_PATTERNS.some((p) => p.test(url));
}

// Install — cache assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches, take over immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch:
//  - Core app files (html/js/css): network-first, cache as a fallback only.
//  - Everything else (images, icons, fonts): cache-first, since they rarely change.
self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  if (isNetworkFirst(url)) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (e.request.method === 'GET' && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((response) => {
        if (e.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        if (e.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
