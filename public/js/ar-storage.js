/**
 * ar-storage.js — Almacenamiento local compartido para AsistenciaAR
 * ─────────────────────────────────────────────────────────────────
 * Usar SIEMPRE este módulo (en vez de localStorage) para cualquier dato
 * de un módulo offline que pueda crecer: borradores de formularios largos,
 * fotos en base64, colas de sincronización, etc.
 *
 * Por qué: localStorage tiene un límite de ~5-10MB por origen. En una
 * jornada de campo larga sin conexión (constancias, extintores, informes
 * de visita futuros), con varias fotos y firmas guardadas, ese límite se
 * llena en silencio — no tira un error visible, simplemente deja de guardar
 * y se pierden datos. IndexedDB soporta cientos de MB (según espacio libre
 * del dispositivo) y escribe de forma transaccional, evitando datos
 * corruptos a mitad de escritura.
 *
 * Se comparte una sola base (asistenciaAR) entre todas las páginas del
 * sistema (index.html, extintores.html, y cualquier módulo futuro), para
 * no duplicar código ni bases de datos.
 *
 * ── USO PARA NUEVOS MÓDULOS (checklists, informes, etc.) ──────────────
 *
 *   await ARStorage.set('miclave', valor)        // guarda (objeto, no hace falta JSON.stringify)
 *   const v = await ARStorage.get('miclave')      // null si no existe
 *   await ARStorage.del('miclave')                // borra
 *   const claves = await ARStorage.keys('prefijo_') // todas las claves que empiezan con el prefijo
 *
 * Convención de nombres de clave sugerida para módulos nuevos:
 *   '<modulo>_draft'                  → borrador en edición (uno solo)
 *   '<modulo>_draft_<id>'             → si puede haber varios borradores en simultáneo
 *   '<modulo>_offline_queue'          → cola de envíos pendientes de sincronizar
 *
 * ── MIGRACIÓN DE DATOS VIEJOS EN LOCALSTORAGE ──────────────────────────
 * Si un módulo nuevo reemplaza uno que ya guardaba algo en localStorage,
 * llamar una vez al iniciar (dentro de init()):
 *
 *   await ARStorage.migrarDesdeLocalStorage(
 *     ['clave_exacta_1', 'clave_exacta_2'],   // claves puntuales
 *     ['prefijo_dinamico_']                    // prefijos de claves con ID variable
 *   );
 *
 * Esto es IMPORTANTE la primera vez que se despliega esta migración: si
 * hay técnicos con datos pendientes de sincronizar guardados en el sistema
 * viejo, hay que copiarlos a IndexedDB antes de borrarlos, o se pierden.
 */
(function (global) {
  const DB_NAME = 'asistenciaAR';
  const STORE_NAME = 'kv';
  let _dbPromise = null;

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error('IndexedDB no soportado en este navegador')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  async function set(key, value) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      // Fallback de emergencia si IndexedDB no está disponible (navegadores
      // muy viejos, modo incógnito restrictivo). No debería pasar en la
      // práctica, pero evita que el módulo quede totalmente sin guardar.
      console.error('[ARStorage.set] fallback a localStorage:', e);
      try { localStorage.setItem('idbfallback_' + key, JSON.stringify(value)); } catch (e2) {}
      return false;
    }
  }

  async function get(key) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[ARStorage.get] fallback a localStorage:', e);
      try {
        const v = localStorage.getItem('idbfallback_' + key);
        return v ? JSON.parse(v) : null;
      } catch (e2) { return null; }
    }
  }

  async function del(key) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      try { localStorage.removeItem('idbfallback_' + key); } catch (e2) {}
      return false;
    }
  }

  async function keys(prefix) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = () => {
          const all = req.result || [];
          resolve(prefix ? all.filter(k => String(k).startsWith(prefix)) : all);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.error('[ARStorage.keys] fallback a localStorage:', e);
      const all = Object.keys(localStorage)
        .filter(k => k.startsWith('idbfallback_'))
        .map(k => k.replace('idbfallback_', ''));
      return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
  }

  // Migra claves puntuales y/o por prefijo desde localStorage a IndexedDB,
  // borrando el original una vez copiado. Segura de llamar en cada carga:
  // si ya no queda nada en localStorage, no hace nada.
  async function migrarDesdeLocalStorage(clavesExactas = [], prefijos = []) {
    for (const key of clavesExactas) {
      try {
        const legacy = localStorage.getItem(key);
        if (legacy == null) continue;
        const existing = await get(key);
        if (existing == null) await set(key, JSON.parse(legacy));
        localStorage.removeItem(key);
      } catch (e) { console.error('[ARStorage.migrar]', key, e); }
    }
    for (const prefix of prefijos) {
      try {
        const legacyKeys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
        for (const key of legacyKeys) {
          const legacy = localStorage.getItem(key);
          if (legacy == null) continue;
          const existing = await get(key);
          if (existing == null) await set(key, JSON.parse(legacy));
          localStorage.removeItem(key);
        }
      } catch (e) { console.error('[ARStorage.migrar prefijo]', prefix, e); }
    }
  }

  global.ARStorage = { set, get, del, keys, migrarDesdeLocalStorage };
})(window);
