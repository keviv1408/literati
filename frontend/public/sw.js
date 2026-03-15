/**
 * Literati Service Worker
 *
 * Strategy:
 * - Cache-first for static assets (JS, CSS, images, fonts)
 * - Network-first for API/WebSocket routes (pass-through)
 * - Offline fallback page for navigation requests
 */

const CACHE_NAME = 'literati-v1';

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Activate immediately without waiting for old clients to close
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, WebSocket upgrades, and cross-origin API calls
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    !url.origin.startsWith(self.location.origin)
  ) {
    return; // Let the browser handle it normally
  }

  // Cache-first for Next.js static assets (_next/static)
  if (url.pathname.startsWith('/_next/static')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            return res;
          })
      )
    );
    return;
  }

  // Network-first for navigation (HTML pages) with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(request)
          .then((cached) => cached || caches.match('/offline.html'))
      )
    );
    return;
  }

  // Stale-while-revalidate for everything else
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const fetchPromise = fetch(request).then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        });
        return cached || fetchPromise;
      })
    )
  );
});
