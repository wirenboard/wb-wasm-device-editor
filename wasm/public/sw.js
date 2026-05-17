// Both placeholders are substituted at build time by swCachePlugin in
// vite.config.ts: APP_VERSION ← package.json semver, CACHE_VERSION ← git
// short hash (or a Date.now() base36 fallback if git isn't on PATH).
//
// Backward compatibility: PWA users on older builds detect updates by
// byte-comparing /sw.js content on reg.update(). The lines below only ADD
// content vs. the previous shape (still has the same CACHE_VERSION /
// CACHE_NAME pattern), so the byte diff still triggers their normal
// install + skipWaiting + controllerchange flow.
const APP_VERSION = '__APP_VERSION__';
const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = `wb-device-editor-${CACHE_VERSION}`;
// The standalone (file://) build can't fetch this file directly: the
// deveditor.wirenboard.com bucket doesn't send Access-Control-Allow-Origin,
// so a CORS preflight blocks fetch from an opaque (file://) origin. A
// <script src=...> request has no preflight, so the standalone loads sw.js
// that way instead. We mirror the build markers onto `self` (which is the
// document's window when this file is executed as a regular script) so the
// standalone's onload handler can read them and detect a redeploy.
self.__WB_APP_VERSION__ = APP_VERSION;
self.__WB_BUILD_ID__ = CACHE_VERSION;

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
  '/vendor/web-serial-polyfill.js',
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
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
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

  // Hashed assets (/assets/*): cache-first (immutable).
  // Defend against CDN SPA-fallback returning text/html for missing assets:
  // ignore HTML responses (both from cache and network) so the browser sees a
  // real failure instead of a poisoned MIME type.
  if (url.pathname.startsWith('/assets/')) {
    const isHtml = (response) =>
      response && (response.headers.get('content-type') || '').includes('text/html');
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached && !isHtml(cached)) return cached;
        return fetch(request).then((response) => {
          if (response.ok && !isHtml(response)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      }),
    );
    return;
  }

  // All other same-origin requests: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});
