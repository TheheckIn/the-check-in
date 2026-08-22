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
  // Only handle requests to our own site. Let all other requests
  // (Facebook Pixel, Stripe, fonts, etc.) pass through untouched —
  // intercepting cross-origin requests can silently break them.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // Pass-through: just fetch normally from the network.
  event.respondWith(fetch(event.request));
});
