const CACHE_NAME = 'signapp-cache-v3';
const ASSETS = [
  './ky-ten-anh.html',
  './css/style.css',
  './js/app.js',
  './js/state.js',
  './js/render.js',
  './js/ui.js',
  './vendor/qrcode.min.js',
  './libs/jszip/jszip.min.js',
  './libs/filesaver/FileSaver.min.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const { request } = event;
  const acceptHeader = request.headers.get('accept') || '';
  const isHtmlRequest = request.mode === 'navigate' || acceptHeader.includes('text/html');

  if (isHtmlRequest) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          const fallback = await caches.match('./ky-ten-anh.html');
          if (fallback) {
            return fallback;
          }
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        return cached;
      }
      return fetch(request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
