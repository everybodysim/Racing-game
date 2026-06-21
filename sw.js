const CLEANUP_WORKER_VERSION = '20260621-boot-cleanup-v2';

self.addEventListener('install', (event) => {
  console.info(`Installing racing game cleanup service worker ${CLEANUP_WORKER_VERSION}`);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('racing-game-')).map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.navigate(client.url);
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      return await fetch(event.request, { cache: 'reload' });
    } catch (error) {
      // Do not serve an app-shell fallback here; let the browser perform a normal
      // navigation request so stale index.html cannot be resurrected from CacheStorage.
      return fetch(event.request);
    }
  })());
});
