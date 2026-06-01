const CACHE = 'onix-v13';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
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
  const isNavigation = req.mode === 'navigate';
  const isHTML = url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const isData = url.pathname.includes('/data/');

  if (isNavigation || isHTML || isData) {
    e.respondWith(
      fetch(req).then(res => {
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
