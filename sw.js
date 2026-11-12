const CACHE = 'onix-v60';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Network-first para navegaciones, HTML y /data/* (para ver siempre lo último online).
// Cache-first para el resto del shell (manifest, icono).
// Si no hay red, se sirve desde caché (offline).
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // API de Supabase (REST/auth/realtime): SIEMPRE red, nunca caché.
  // Cachearla servía datos viejos al sync. La app ya tiene su propia
  // caché offline (localStorage + outbox).
  if (url.hostname.endsWith('.supabase.co')) return;

  const isNavigation = req.mode === 'navigate';
  const isHTML = url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const isData = url.pathname.includes('/data/');

  if (isNavigation || isHTML || isData) {
    e.respondWith(
      // no-cache: revalida con el servidor y no tira de la caché HTTP del
      // navegador (GitHub Pages da 10 min), que dejaba el index viejo tras publicar
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        // Safari no deja responder una navegación con una respuesta redirigida
        .then(res => (res.redirected ? fetch(req) : res)).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
  }
});
