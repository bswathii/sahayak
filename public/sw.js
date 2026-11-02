// sw.js — caches the application shell and lesson packs.
// Cached lesson availability is NOT full offline functionality: messaging and
// handoff generation still require the server.

// Bump whenever a cached asset changes: this is the only way an installed
// service worker stops serving the previous shell from its cache.
const CACHE_VERSION = 'sahayak-shell-v14';
const SHELL = [
  '/',
  '/index.html',
  '/student',
  '/teacher',
  '/student.html',
  '/teacher.html',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/classroom.js',
  '/js/stream.js',
  '/js/student.js',
  '/js/teacher.js',
  // Cached so the activity guide and interface labels survive a lost connection.
  '/api/ui',
  '/api/lessons/stickem-tallest-tower',
];

self.addEventListener('install', (event) => {
  // Cached one by one: cache.addAll is all-or-nothing, so a single failed
  // request would leave the app shell and the activity uncached.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.allSettled(
          SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(request, cacheKey) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(cacheKey || request, copy));
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(cacheKey || request);
      if (cached) return cached;
      return new Response(
        JSON.stringify({ error: { code: 'offline', message: 'This content is not cached on this device.' } }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      );
    });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live session data is never served from cache.
  if (url.pathname.startsWith('/api/sessions') || url.pathname === '/health') return;

  // Lesson packs and lesson listings: network first, then cache.
  if (url.pathname.startsWith('/api/lessons')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigations: network first so a new build is picked up, cache as fallback.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, url.pathname === '/' ? '/index.html' : request));
    return;
  }

  // Static assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
