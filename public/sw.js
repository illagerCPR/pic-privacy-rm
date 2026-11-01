/*
 * PicPrivacy service worker.
 *
 * Keeps the app usable offline without ever serving a stale shell:
 *  - navigation requests are network-first (so a new deployment is picked up),
 *    falling back to the cached copy when the network is gone;
 *  - hashed assets are cache-first (their URL changes when they change).
 *
 * Bump CACHE_VERSION when the strategy itself changes.
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `picprivacy-${CACHE_VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(request);
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return Response.error();
      }
    })(),
  );
});
