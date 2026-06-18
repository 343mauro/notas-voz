// Service worker: cachea la app para uso offline Y sube la cola en segundo plano
// (Background Sync) apenas vuelve internet, aunque la app esté cerrada.
const CACHE = 'notas-voz-v8';
const PRECARGA = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
const URL_SCRIPT = 'https://script.google.com/macros/s/AKfycbw-y3ygx8GP0Dcsy3CTg9fcNiVK68bIaonrb7GZSdFLz2jD6uqN9sI56jF48I9KvKnyxA/exec';
const ESPACIADO_MS = 6000;
const MAX_INTENTOS = 5;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECARGA)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // las llamadas al Apps Script van directo a la red
  e.respondWith(
    caches.match(e.request).then((cacheada) => {
      const deRed = fetch(e.request)
        .then((r) => {
          if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
          return r;
        })
        .catch(() => cacheada);
      return cacheada || deRed;
    })
  );
});

// ===== BACKGROUND SYNC: subir la cola con la app cerrada =====
self.addEventListener('sync', (e) => {
  if (e.tag === 'subir-cola') e.waitUntil(drenarEnSW());
});

function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('notas-voz', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('cola')) db.createObjectStore('cola', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function pedir(store, modo, fn) {
  return abrirDB().then(d => new Promise((res, rej) => {
    const st = d.transaction(store, modo).objectStore(store);
    const q = fn(st);
    if (q) { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }
  }));
}
const getCola   = () => pedir('cola', 'readonly', st => st.getAll());
const delCola   = (id) => pedir('cola', 'readwrite', st => st.delete(id));
const putCola   = (it) => pedir('cola', 'readwrite', st => st.put(it));
const addCola   = (it) => pedir('cola', 'readwrite', st => st.add(it));
const getToken  = () => pedir('config', 'readonly', st => st.get('token')).then(r => r && r.v);
const esperar   = (ms) => new Promise(r => setTimeout(r, ms));

async function hayVentana() {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return cs.length > 0;
}
async function moverAlFinal(it) {
  const copia = Object.assign({}, it); delete copia.id;
  await addCola(copia); await delCola(it.id);
}
function cuerpoDe(it, token) {
  if (it.tipo === 'audio')     return { token: token, accion: 'audio', sesion: it.sesion, parte: it.parte, mime: it.mime, audio: it.datos };
  if (it.tipo === 'fin')       return { token: token, accion: 'fin', sesion: it.sesion };
  if (it.tipo === 'descartar') return { token: token, accion: 'descartar', sesion: it.sesion };
  return { token: token, texto: it.texto };
}

async function drenarEnSW() {
  // Si hay una ventana abierta, que la app se encargue (evita subir dos veces una nota de texto).
  if (await hayVentana()) return;
  const token = await getToken();
  if (!token) return;
  let items = await getCola();
  let vueltas = 0;
  while (items.length && vueltas++ < 300) {
    let it = items[0];
    if (it.tipo === 'fin' && items.length > 1) { await moverAlFinal(it); items = await getCola(); continue; }
    let resp;
    try {
      const r = await fetch(URL_SCRIPT, { method: 'POST', body: JSON.stringify(cuerpoDe(it, token)) });
      resp = await r.text();
    } catch (errRed) {
      throw new Error('sin-red'); // rechaza: el navegador reintenta el sync al haber conexión
    }
    if (resp === 'ok' || resp === 'vacío') {
      await delCola(it.id);
      items = await getCola();
      if (items.length) await esperar(ESPACIADO_MS);
    } else if (resp === 'rate-limit') {
      await esperar(15000);
    } else {
      it.intentos = (it.intentos || 0) + 1;
      if (it.intentos >= MAX_INTENTOS) { await moverAlFinal(it); }
      else { await putCola(it); await esperar(8000); }
      items = await getCola();
    }
  }
  if (items.length) throw new Error('quedan-pendientes'); // reintentar el sync más tarde
}
