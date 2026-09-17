// ============================================================================
// Service worker for the NDA Register PWA.
//
// Two jobs:
//  1. Its mere presence + registration is one of the browser's requirements
//     for showing a real "Install app" prompt instead of a plain shortcut.
//  2. Caches the app shell (HTML/CSS/JS, since index.html is all-in-one)
//     so the app still opens if the phone has no signal. Firebase calls
//     (auth, Firestore) always go to the network — this worker never caches
//     or intercepts those, so sign-in and data sync behave exactly as
//     online-only, unaffected by this cache.
//
// Bump CACHE_NAME any time you deploy a new version of the cached files —
// this is what makes the service worker fetch fresh copies instead of
// serving a stale cached app shell forever.
// ============================================================================

const CACHE_NAME = 'nda-register-v1';
const APP_SHELL = [
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache/intercept Firebase or Google auth traffic — those must
  // always hit the network so sign-in and sync work correctly.
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('google.com')
  ) {
    return;
  }

  // Only handle same-origin GET requests for the cached app shell; let
  // everything else (including admin.html, js/*.js) go straight to network
  // so the admin panel and access-control logic are always fresh.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache if we have it

      return cached || networkFetch;
    })
  );
});
