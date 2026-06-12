// Guarda la app en el teléfono para que abra sin internet.
// Estrategia: sirve la copia guardada al instante y la actualiza en segundo plano.
const CACHE = 'notas-voz-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // las llamadas al Apps Script van directo a la red
  e.respondWith(
    caches.match(e.request).then((cacheada) => {
      const deRed = fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copia = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copia));
          }
          return r;
        })
        .catch(() => cacheada);
      return cacheada || deRed;
    })
  );
});
