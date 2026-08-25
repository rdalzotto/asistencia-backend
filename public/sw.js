// ── Service Worker — AsistenciaAR ────────────────────────────────────────────
// Estrategia: Network First para HTML/navegación (siempre trae la versión más
// nueva cuando hay conexión), Cache First para assets estáticos reales
// (íconos, manifest), y bypass total para /api/*.
// Antes esto era Cache First para el HTML, lo que hacía que una vez cacheado
// index.html, el navegador NUNCA volviera a pedirlo a la red — cualquier
// actualización subida al servidor quedaba invisible para el usuario hasta
// que se le ocurriera borrar el caché a mano. Con Network First evitamos eso.

const CACHE_NAME = 'asistencia-v4';
const EXTINTORES_CACHE = 'extintores-v2';

// Assets que se cachean al instalar el SW (para poder abrir la app offline)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/extintores.html',
  '/manifest.json',
];

// Extensiones que se consideran "assets estáticos reales" (no HTML) — para
// estos sí conviene Cache First, porque su contenido no cambia salvo que
// cambie el nombre del archivo.
const ASSET_EXT_RE = /\.(png|jpg|jpeg|svg|ico|webp|woff2?|ttf)$/i;

// ── Instalación: cachear el app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('[SW] No se pudieron cachear todos los assets:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activación: limpiar caches viejos ────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== EXTINTORES_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Las llamadas a /api/* nunca se interceptan — van siempre a la red.
  if (url.pathname.startsWith('/api/')) return;

  const esNavegacionOHtml = event.request.mode === 'navigate' || event.request.destination === 'document';
  const esAssetEstatico = ASSET_EXT_RE.test(url.pathname);

  if (esAssetEstatico && !esNavegacionOHtml) {
    // Assets reales (imágenes, íconos, fuentes): Cache First.
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML / navegación: Network First — siempre intenta traer lo último del
  // servidor, y solo si falla (sin conexión) usa lo que haya en caché.
  // cache:'no-store' es clave acá: sin esto, este fetch() todavía puede
  // resolverse contra la caché HTTP del navegador (no la de este Service
  // Worker) si el servidor mandó cabeceras que lo permiten — "Network First"
  // dejaba de ser realmente "siempre a la red" en esos casos. Forzando
  // no-store, esta llamada ignora esa caché HTTP y pega contra el servidor
  // de verdad en cada navegación.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then(response => {
      if (response && response.status === 200 && response.type !== 'opaque') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (esNavegacionOHtml) return caches.match('/index.html');
      });
    })
  );
});
