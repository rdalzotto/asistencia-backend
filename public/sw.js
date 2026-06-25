// ── Service Worker — AsistenciaAR ────────────────────────────────────────────
// Estrategia: Cache First para assets estáticos, Network First para API.
// Al actualizar la app, el nuevo SW espera a que no haya tabs abiertos.

const CACHE_NAME = 'asistencia-v2';
const EXTINTORES_CACHE = 'extintores-v2';

// Assets que se cachean al instalar el SW (app shell)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/extintores.html',
  '/manifest.json',
];

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

// ── Fetch: Cache First para HTML/assets, bypass para API ─────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Las llamadas a /api/* nunca se interceptan — van siempre a la red.
  // Si fallan, el cliente maneja el error (lógica offline en el JS de la app).
  if (url.pathname.startsWith('/api/')) return;

  // Para requests de navegación y assets estáticos: Cache First.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      // No está en caché: buscar en red y guardar para la próxima vez.
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Sin red y sin caché: para HTML devolver index.html como fallback
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
