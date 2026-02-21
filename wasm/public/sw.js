const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = `wb-device-editor-${CACHE_VERSION}`;

// Hashed assets (injected at build time by Vite plugin)
const HASHED_ASSETS = [
  // __HASHED_ASSETS__
];

// Small assets precached eagerly
const PRECACHE_ASSETS = [
  '/',
  ...HASHED_ASSETS,
  '/common.css',
  '/manifest.json',
  '/serial.js',
  '/script.js',
  '/module.js',
  '/img/logo.svg',
  '/img/logo-180.png',
  '/img/logo-192.png',
];

// Large assets precached with allSettled (won't block install on slow connections)
const LARGE_ASSETS = [
  '/module.wasm',
  '/module.data',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache small critical assets first (must succeed)
      await cache.addAll(PRECACHE_ASSETS);
      // Cache large WASM files best-effort
      await Promise.allSettled(
        LARGE_ASSETS.map((url) => cache.add(url)),
      );
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('wb-device-editor-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Connectivity check: try to reach the server
  if (url.pathname === '/sw-ping') {
    event.respondWith(
      fetch(new Request(url.origin + '/manifest.json', { method: 'HEAD', cache: 'no-store' }))
        .then(() => new Response('online'))
        .catch(() => new Response('offline')),
    );
    return;
  }

  // Navigation requests: network-first with 3s timeout, fall back to cache
  if (request.mode === 'navigate') {
    const controller = new AbortController();
    event.respondWith(
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          controller.abort();
          caches.match('/').then((cached) => cached && resolve(cached));
        }, 3000);
        fetch(request, { signal: controller.signal })
          .then((response) => {
            clearTimeout(timeout);
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            resolve(response);
          })
          .catch(() => {
            clearTimeout(timeout);
            caches.match('/').then((cached) => resolve(cached));
          });
      }),
    );
    return;
  }

  // Hashed assets (/assets/*): cache-first (immutable)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        }),
      ),
    );
    return;
  }

  // All other same-origin requests: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});
