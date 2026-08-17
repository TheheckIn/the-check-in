// Minimal service worker — required by Chrome/Android for the app to be
// installable via the one-click "Add to Home Screen" prompt.
// This does not add offline caching; it only satisfies installability.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Pass-through: just fetch normally from the network.
  event.respondWith(fetch(event.request));
});
