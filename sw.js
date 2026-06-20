const CACHE_NAME = 'racing-game-v10';
const CORE_ASSETS = [
  './',
  './index.html',
  './editor.html',
  './mods.html',
  './tas-viewer.html',
  './manifest.webmanifest',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './js/main.js',
  './js/Track.js',
  './js/Physics.js',
  './js/Vehicle.js',
  './js/Camera.js',
  './js/Controls.js',
  './js/Particles.js',
  './js/Audio.js',
  './js/mods-manager.js',
  './js/tas-viewer.js',
  './mods/mods.json',
  './mods/TAS.js',
  './mods/Hacks.js',
  './mods/ArcadeBoost.js',
  './models/vehicle-truck-yellow.glb',
  './models/vehicle-truck-green.glb',
  './models/vehicle-truck-purple.glb',
  './models/vehicle-truck-red.glb',
  './models/track-straight.glb',
  './models/track-corner.glb',
  './models/track-bump.glb',
  './models/track-finish.glb',
  './models/decoration-empty.glb',
  './models/decoration-forest.glb',
  './models/decoration-tents.glb',
  './models/Textures/colormap.png'
];

const CORE_PATHS = new Set(CORE_ASSETS.map((path) => new URL(path, self.location.origin).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(CORE_ASSETS.map((asset) => cache.add(new Request(asset, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = event.request.mode === 'navigate';
  const canCache = !url.search && CORE_PATHS.has(url.pathname);
  const fallback = isNavigation ? './index.html' : null;
  const shouldBypassHttpCache = isNavigation || canCache;
  const networkRequest = shouldBypassHttpCache ? new Request(event.request, { cache: 'reload' }) : event.request;

  event.respondWith(
    fetch(networkRequest)
      .then((response) => {
        if (canCache && response?.status === 200) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (fallback) return caches.match(fallback);
        return Response.error();
      })
  );
});
