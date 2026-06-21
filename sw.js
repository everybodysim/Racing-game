const CLEANUP_VERSION = '20260621-ctrl-r-boot';
const RACING_CACHE_PREFIX = 'racing-game-';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(RACING_CACHE_PREFIX))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      const url = new URL(client.url);
      url.searchParams.set('sw-reset', CLEANUP_VERSION);
      client.navigate(url.href);
    }
  })());
});

self.addEventListener('fetch', () => {
  // Intentionally no fetch handler: allow normal browser reload semantics.
});
