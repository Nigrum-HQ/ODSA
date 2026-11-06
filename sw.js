// Service worker de ODSA: permite instalar el sistema como app y abrirlo aunque no haya señal.
// Solo guarda la página del sistema y los íconos. Nunca guarda datos ni respuestas de /api:
// los datos siempre se piden al servidor (y sin señal se muestran los últimos que tenía el dispositivo).
const CACHE = 'odsa-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // el aviso de versión usa HEAD: no se toca
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;           // datos: siempre directo al servidor

  if (req.mode === 'navigate') {
    // Primero la red (así siempre se abre la última versión); si no hay señal, la última guardada
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put('/', copia)); }
          return r;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('Sin conexión. Volvé a intentar cuando tengas señal.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
    );
    return;
  }

  if (/\.(png|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))
      )
    );
  }
});
