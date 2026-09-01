// ── Service Worker — AsistenciaAR ────────────────────────────────────────────
// Estrategia: Network First para HTML/navegación (siempre trae la versión más
// nueva cuando hay conexión), Cache First para assets estáticos reales
// (íconos, manifest), y bypass total para /api/*.
// Antes esto era Cache First para el HTML, lo que hacía que una vez cacheado
// index.html, el navegador NUNCA volviera a pedirlo a la red — cualquier
// actualización subida al servidor quedaba invisible para el usuario hasta
// que se le ocurriera borrar el caché a mano. Con Network First evitamos eso.

const CACHE_NAME = 'asistencia-v8';
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
  // Cualquier petición que no sea GET (POST/PUT/PATCH/DELETE) va siempre
  // directo a la red, sin pasar por ninguna lógica de cache — la Cache API
  // no admite cachear requests no-GET, y este Service Worker no tiene
  // ningún motivo para interceptarlas de todos modos.
  if (event.request.method !== 'GET') return;

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

// ── Push ──────────────────────────────────────────────────────────────────
// El servidor (pushService.js) manda notificaciones desde hace tiempo, pero
// hasta ahora ningún Service Worker escuchaba el evento 'push' — llegaban al
// navegador y no se mostraba nada nunca, para ningún tipo de aviso (ingreso,
// egreso, solicitudes, etc.). Este listener es lo que faltaba para que se
// vean de verdad, con vibración incluida.
const ICONO_APP = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='24' fill='%237c3aed'/><text y='130' x='96' text-anchor='middle' font-size='110' font-family='sans-serif'>🔥</text></svg>";

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const titulo = data.titulo || 'AsistenciaAR';
  const opciones = {
    body: data.cuerpo || '',
    icon: ICONO_APP,
    badge: ICONO_APP,
    // Patrón de vibración (ms): vibra-pausa-vibra-pausa-vibra, unos 2 segundos
    // en total. Solo tiene efecto en Android — iOS no soporta vibración
    // personalizada en notificaciones, es una limitación de esa plataforma,
    // no de este código.
    vibrate: [300, 100, 300, 100, 300],
    data: data.datos || {},
  };
  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

// Tocar la notificación enfoca una pestaña ya abierta de la app, o abre una
// nueva si no hay ninguna — sin esto, tocarla no hacía nada.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const c of clientList) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
