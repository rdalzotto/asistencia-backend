// ── PLANILLAS DE CHEQUEO POR MÓDULOS (Etapa 1) ──────────────────────────────
// Pantalla de relevamiento para la tablet. Funciona sin señal:
//   chk_catalogo            catálogo (módulos, ítems, plantillas)
//   chk_ctx_<destino>       contexto del establecimiento (actividades, instalaciones
//                           conocidas, acciones abiertas)
//   chk_idx_<visita>_<dest> id del relevamiento de esa visita y establecimiento
//   chk_rel_<uuid>          relevamiento completo; _dirty = falta enviarlo
//   chk_foto_<uuid>         foto comprimida; subida = ya está en el servidor
// Se envía solo al servidor cuando hay señal (/api/planillas/relevamientos/sync).
// Depende de globals de index.html: api, toast, STATE, ARStorage.
(function (global) {
  'use strict';

  const PESO = { 1: 3, 2: 2, 3: 1 };
  const PLAZO_DIAS = { 1: 0, 2: 30, 3: 90 };
  const NIVELES = { B: 'Básico', A: 'Ampliado', C: 'Certificación' };
  const NIVEL_ORDEN = { B: 1, A: 2, C: 3 };
  const TIPO = { L: 'Legal', BP: 'Buena práctica', C: 'Certificación' };
  const CRIT = { 1: 'Crítico', 2: 'Importante', 3: 'Menor' };
  const RES = { C: 'Cumple', NC: 'No cumple', NA: 'No aplica', NV: 'No verif.' };
  const CALIF = { satisfactorio: 'Satisfactorio', aceptable: 'Aceptable con mejoras', deficiente: 'Deficiente', sin_datos: 'Sin datos' };

  let P = null;           // estado de la pantalla del técnico
  let A = null;           // estado de la pantalla de Dirección
  let tGuardar = null, tEnviar = null, enviando = false;

  // ── utilidades ──────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
  const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  function sumarDias(iso, d) { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }
  const plazoSugerido = (crit, fecha) => sumarDias(fecha || hoy(), PLAZO_DIAS[crit] ?? 30);
  const fmtFecha = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
  const online = () => navigator.onLine;

  function resumir(rs) {
    const r = { total: 0, C: 0, NC: 0, NA: 0, NV: 0, nc1: 0, puntos: 0, max: 0 };
    for (const x of rs) {
      if (!RES[x.resultado]) continue;
      r.total++; r[x.resultado]++;
      if (x.resultado === 'C' || x.resultado === 'NC') {
        const c = [1, 2, 3].includes(Number(x.criticidad)) ? Number(x.criticidad) : 2;
        r.max += PESO[c];
        if (x.resultado === 'C') r.puntos += PESO[c]; else if (c === 1) r.nc1++;
      }
    }
    r.indice = r.max ? Math.round(r.puntos / r.max * 1000) / 10 : null;
    r.calificacion = r.indice === null ? 'sin_datos' : r.nc1 ? 'deficiente' : r.indice >= 90 ? 'satisfactorio' : r.indice >= 75 ? 'aceptable' : 'deficiente';
    return r;
  }
  const colorCalif = c => c === 'satisfactorio' ? 'var(--green)' : c === 'aceptable' ? 'var(--yellow)' : c === 'deficiente' ? 'var(--red)' : 'var(--text2)';
  const colorCrit = c => c === 1 ? 'var(--red)' : c === 2 ? 'var(--orange)' : 'var(--text2)';

  // ── estilos (una sola vez) ──────────────────────────────────────────────
  function inyectarEstilos() {
    if (document.getElementById('pl-estilos')) return;
    const st = document.createElement('style');
    st.id = 'pl-estilos';
    st.textContent = `
#modal-planillas{position:fixed;inset:0;z-index:450;background:var(--bg);display:none;flex-direction:column}
#modal-planillas.abierto{display:flex}
.pl-top{background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 14px;display:flex;gap:10px;align-items:center}
.pl-top .t{flex:1;min-width:0}.pl-top .t b{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-top .t span{font-size:12px;color:var(--text2)}
.pl-back{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:8px 12px;font-size:14px;cursor:pointer;flex-shrink:0}
.pl-sync{font-size:11px;padding:3px 8px;border-radius:10px;white-space:nowrap}
.pl-body{flex:1;overflow-y:auto;padding:14px;padding-bottom:90px;max-width:820px;width:100%;margin:0 auto}
.pl-sec{font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin:18px 0 8px}
.pl-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:8px}
.pl-row{display:flex;align-items:center;gap:10px;cursor:pointer}
.pl-row .n{flex:1;min-width:0}.pl-row .n b{font-size:15px}.pl-row .n small{display:block;color:var(--text2);font-size:12px;margin-top:2px}
.pl-bar{width:70px;height:6px;border-radius:3px;background:var(--bg3);overflow:hidden;flex-shrink:0}.pl-bar i{display:block;height:100%;background:var(--accent)}
.pl-chip{display:inline-block;border:1px dashed var(--accent);color:var(--accent);border-radius:14px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;background:none;margin:0 6px 6px 0}
.pl-chip.on{border-style:solid;background:rgba(0,212,255,.15)}
.pl-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:4px;background:var(--bg3);color:var(--text2);margin-right:4px}
.pl-item{background:var(--bg2);border:1px solid var(--border);border-left:4px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px}
.pl-item.r-C{border-left-color:var(--green)}.pl-item.r-NC{border-left-color:var(--red)}.pl-item.r-NA,.pl-item.r-NV{border-left-color:var(--text3)}
.pl-item .tx{font-size:15px;line-height:1.35;margin-bottom:6px}
.pl-item .ref{font-size:11.5px;color:var(--text2);margin-bottom:8px;font-family:var(--mono)}
.pl-btns{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.pl-btns button{padding:12px 2px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-weight:700;font-size:13px;cursor:pointer}
.pl-btns button.on-C{background:var(--green);color:#0f1923;border-color:var(--green)}
.pl-btns button.on-NC{background:var(--red);color:#fff;border-color:var(--red)}
.pl-btns button.on-NA,.pl-btns button.on-NV{background:var(--text3);color:#fff;border-color:var(--text3)}
.pl-nc{margin-top:10px;display:grid;gap:8px}
.pl-nc label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.pl-in{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px;font-size:14px;font-family:var(--font)}
textarea.pl-in{min-height:64px;resize:vertical}
.pl-crit{display:flex;gap:6px;flex-wrap:wrap}.pl-crit button{flex:1;min-width:90px;padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px;font-weight:600;cursor:pointer}
.pl-fotos{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pl-fotos img{width:64px;height:64px;object-fit:cover;border-radius:6px}
.pl-add-foto{border:1px dashed var(--border);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text2);cursor:pointer}
.pl-warn{font-size:12px;color:var(--orange);font-weight:600}
.pl-foot{position:fixed;left:0;right:0;bottom:0;background:var(--bg2);border-top:1px solid var(--border);padding:10px 14px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;z-index:451}
.pl-foot button{flex:1}
.pl-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(max-width:520px){.pl-grid2{grid-template-columns:1fr}}
.pl-tabla{width:100%;border-collapse:collapse;font-size:13px}.pl-tabla td,.pl-tabla th{padding:7px 6px;border-bottom:1px solid var(--border);text-align:left}
.pl-tabla th{color:var(--text2);font-size:11px;text-transform:uppercase}
.pl-sub{font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
.pl-confirm{background:rgba(255,145,0,.1);border:1px solid var(--orange);border-radius:10px;padding:12px;margin-top:10px}`;
    document.head.appendChild(st);
  }

  function contenedor() {
    let m = document.getElementById('modal-planillas');
    if (!m) {
      m = document.createElement('div');
      m.id = 'modal-planillas';
      // Un solo contenedor para la pantalla del técnico y la de Dirección.
      m.addEventListener('click', e => (A ? onClickAdmin(e) : onClick(e)));
      m.addEventListener('input', e => { if (!A) onInput(e); });
      m.addEventListener('change', e => (A ? onChangeAdmin(e) : onChange(e)));
      document.body.appendChild(m);
    }
    return m;
  }

  // ── datos locales ───────────────────────────────────────────────────────
  async function catalogo() {
    let cat = await ARStorage.get('chk_catalogo');
    if (online()) {
      try { cat = await api('/planillas/catalogo'); await ARStorage.set('chk_catalogo', cat); } catch (e) { /* sin señal: queda la copia */ }
    }
    return cat;
  }
  // excluirRel: el relevamiento en curso, para no contrastarlo consigo mismo
  // (también se filtra acá por si la copia guardada en la tablet lo incluye).
  async function contexto(destinoId, excluirRel) {
    const vacio = { actividades: [], instancias_conocidas: [], acciones_abiertas: [], respuestas_anteriores: [] };
    if (!destinoId) return vacio;
    let ctx = await ARStorage.get('chk_ctx_' + destinoId);
    if (online()) {
      try { ctx = await api('/planillas/destinos/' + destinoId + '/contexto?excluir=' + encodeURIComponent(excluirRel || '')); await ARStorage.set('chk_ctx_' + destinoId, ctx); } catch (e) { /* copia local */ }
    }
    ctx = { ...vacio, ...(ctx || {}) };
    ctx.acciones_abiertas = ctx.acciones_abiertas.filter(a => a.relevamiento_id !== excluirRel);
    ctx.respuestas_anteriores = ctx.respuestas_anteriores.filter(r => r.relevamiento_id !== excluirRel);
    return ctx;
  }

  // ── contraste con la visita anterior ────────────────────────────────────
  const claveItem = (modulo, etiqueta, itemId) => modulo + '|' + String(etiqueta || '').trim().toLowerCase() + '|' + itemId;
  function evolucion(antes, ahora) {
    const ok = x => x === 'C' || x === 'NC';
    if (!ok(antes) || !ok(ahora)) return null;
    if (antes === 'NC' && ahora === 'C') return 'mejoro';
    if (antes === 'C' && ahora === 'NC') return 'empeoro';
    return ahora === 'NC' ? 'sigue_nc' : 'sigue_c';
  }
  const EVOL = {
    mejoro: ['✓ Mejoró', 'var(--green)'], empeoro: ['✗ Empeoró', 'var(--red)'],
    sigue_nc: ['= Sigue sin cumplir', 'var(--orange)'], sigue_c: ['= Sigue cumpliendo', 'var(--text2)'],
  };
  const anteriorDe = (inst, itemId) => P.prev?.get(claveItem(inst.modulo_codigo, inst.etiqueta, itemId)) || null;

  // Pares (antes, ahora) de los ítems chequeados hoy que también se chequearon antes.
  function paresDe(instancias) {
    const pares = [];
    for (const i of instancias) for (const r of respuestasDe(i.id)) {
      if (!r.item_id) continue;
      const a = anteriorDe(i, r.item_id);
      if (a) pares.push({ antes: a, ahora: r, inst: i });
    }
    return pares;
  }
  function comparar(pares) {
    const c = { comparables: 0, mejoro: 0, empeoro: 0, sigue_nc: 0, sigue_c: 0, lista: { mejoro: [], empeoro: [], sigue_nc: [] } };
    const antes = [], ahora = [];
    for (const p of pares) {
      const e = evolucion(p.antes.resultado, p.ahora.resultado);
      if (!e) continue;
      c.comparables++; c[e]++;
      if (c.lista[e]) c.lista[e].push(p);
      const crit = p.ahora.criticidad ?? p.antes.criticidad;
      antes.push({ resultado: p.antes.resultado, criticidad: crit });
      ahora.push({ resultado: p.ahora.resultado, criticidad: crit });
    }
    c.indice_antes = resumir(antes).indice;
    c.indice_ahora = resumir(ahora).indice;
    return c;
  }

  // Si el ítem que hoy se chequea tenía una acción abierta, su verificación se
  // registra sola (corregido / sin cambios). Si el técnico la marcó a mano arriba, se respeta.
  function seguimientoAutomatico(inst, itemId, resultado) {
    const acc = (P.ctx.acciones_abiertas || []).find(a => a.item_id === itemId && a.modulo_codigo === inst.modulo_codigo
      && String(a.instancia_etiqueta || '').trim().toLowerCase() === String(inst.etiqueta || '').trim().toLowerCase());
    if (!acc) return;
    P.doc.seguimientos = P.doc.seguimientos || [];
    const s = P.doc.seguimientos.find(x => x.accion_id === acc.id);
    if (s && !s.auto) return;
    const nuevo = resultado === 'C' ? 'corregido' : resultado === 'NC' ? 'sin_cambios' : null;
    if (!nuevo) { if (s) P.doc.seguimientos = P.doc.seguimientos.filter(x => x !== s); return; }
    const comentario = nuevo === 'corregido' ? 'Verificado al chequear el ítem: ahora cumple.' : 'Verificado al chequear el ítem: sigue sin cumplir.';
    if (s) Object.assign(s, { resultado: nuevo, comentario });
    else P.doc.seguimientos.push({ id: uuid(), accion_id: acc.id, resultado: nuevo, comentario, fotos: [], auto: true });
  }
  const claveIdx = (visitaId, constanciaId, destinoId) =>
    'chk_idx_' + (visitaId ? 'v' + visitaId : 'c' + constanciaId) + '_' + (destinoId || 'x');

  // Paquete para salir al campo: se llama al entrar a la app con señal.
  async function precargar() {
    if (!online() || !STATE?.token) return;
    try {
      const p = await api('/planillas/paquete');
      await ARStorage.set('chk_catalogo', p.catalogo);
      for (const c of p.contextos || []) await ARStorage.set('chk_ctx_' + c.destino_id, c);
      await ARStorage.set('chk_paquete_en', p.generado_en);
    } catch (e) { console.warn('[planillas] precarga:', e.message); }
  }

  async function buscarEnServidor(visitaId, destinoId) {
    if (!online() || !visitaId) return null;
    try {
      const lista = await api('/planillas/relevamientos?visita_id=' + visitaId + (destinoId ? '&destino_id=' + destinoId : ''));
      if (!lista.length) return null;
      const d = await api('/planillas/relevamientos/' + lista[0].id);
      return {
        rel: { id: d.id, visita_id: d.visita_id, constancia_id: d.constancia_id, destino_id: d.destino_id, establecimiento_texto: d.establecimiento_texto,
          plantilla_id: d.plantilla_id, nivel: d.nivel, estado: d.estado, actividades_observadas: d.actividades_observadas || [], iniciado_en: d.iniciado_en },
        instancias: d.instancias.map(i => ({ id: i.id, modulo_codigo: i.modulo_codigo, etiqueta: i.etiqueta, datos: i.datos || {}, fotos: i.fotos || [] })),
        respuestas: d.respuestas.map(r => ({ id: r.id, instancia_id: r.instancia_id, item_id: r.item_id, item_codigo: r.item_codigo, item_texto: r.item_texto,
          item_ref: r.item_ref, item_tipo: r.item_tipo, resultado: r.resultado, criticidad: r.criticidad, observacion: r.observacion || '', medida: r.medida || '',
          plazo: r.plazo ? String(r.plazo).slice(0, 10) : '', fotos: r.fotos || [], respondido_en: r.respondido_en })),
        seguimientos: [], _dirty: false, _enviado_en: d.actualizado_en,
      };
    } catch (e) { return null; }
  }

  async function cargarRelevamiento(o) {
    const idx = claveIdx(o.visitaId, o.constanciaId, o.destinoId);
    const id = await ARStorage.get(idx);
    let doc = id ? await ARStorage.get('chk_rel_' + id) : null;
    if (!doc) doc = await buscarEnServidor(o.visitaId, o.destinoId);
    if (!doc) {
      doc = {
        rel: { id: uuid(), visita_id: o.visitaId || null, constancia_id: null, destino_id: o.destinoId || null,
          establecimiento_texto: o.destinoId ? null : (o.establecimiento || 'Sin nombre'), plantilla_id: null, nivel: 'B',
          estado: 'en_curso', actividades_observadas: [], iniciado_en: new Date().toISOString() },
        instancias: [], respuestas: [], seguimientos: [], _dirty: false, _nuevo: true,
      };
    }
    const cid = Number(o.constanciaId);
    if (Number.isInteger(cid) && cid > 0 && doc.rel.constancia_id !== cid) { doc.rel.constancia_id = cid; doc._dirty = true; }
    await ARStorage.set(idx, doc.rel.id);
    return doc;
  }

  function guardar() {
    if (!P) return;
    P.doc._dirty = true;
    clearTimeout(tGuardar);
    tGuardar = setTimeout(async () => {
      await ARStorage.set('chk_rel_' + P.doc.rel.id, P.doc);
      clearTimeout(tEnviar);
      if (online()) tEnviar = setTimeout(() => enviar(P.doc.rel.id), 2500);
      pintarSync();
    }, 300);
  }

  // Envía un relevamiento guardado. Devuelve true si quedó en el servidor.
  async function enviar(relId) {
    const doc = P && P.doc.rel.id === relId ? P.doc : await ARStorage.get('chk_rel_' + relId);
    if (!doc || !doc._dirty || !online()) return false;
    try {
      await subirFotos(relId);
      const r = await api('/planillas/relevamientos/sync', { method: 'POST', body: JSON.stringify({
        relevamiento: doc.rel, instancias: doc.instancias, respuestas: doc.respuestas, seguimientos: doc.seguimientos || [] }) });
      doc._dirty = false; doc._error = null; doc._enviado_en = new Date().toISOString(); doc._resumen = r.resumen;
      await ARStorage.set('chk_rel_' + relId, doc);
      pintarSync();
      return true;
    } catch (e) {
      if (e.status && e.status < 500) { doc._error = e.message; await ARStorage.set('chk_rel_' + relId, doc); }
      pintarSync();
      return false;
    }
  }

  async function subirFotos(relId) {
    for (const k of await ARStorage.keys('chk_foto_')) {
      const f = await ARStorage.get(k);
      if (!f || f.subida || (relId && f.rel_id !== relId)) continue;
      await api('/planillas/fotos', { method: 'POST', body: JSON.stringify({ id: f.id, relevamiento_id: f.rel_id, data_url: f.data_url, original_id: f.original_id || null }) });
      f.subida = true;
      await ARStorage.set(k, f);
    }
  }

  // Llamado desde sincronizarTodoPendiente() de index.html al volver la señal.
  async function sincronizarPendientes() {
    if (!online()) return;
    let ok = 0, fallidos = 0;
    for (const k of await ARStorage.keys('chk_rel_')) {
      const doc = await ARStorage.get(k);
      if (!doc || !doc._dirty) continue;
      if (await enviar(doc.rel.id)) ok++; else fallidos++;
    }
    try { await subirFotos(null); } catch (e) { /* se reintenta en la próxima */ }
    if (ok) toast('Planillas enviadas ✓ (' + ok + ')', 'success');
    if (fallidos) toast('⚠ ' + fallidos + ' planilla(s) no se pudieron enviar: siguen guardadas en la tablet.', 'error', 8000);
  }

  // ── abrir / cerrar ──────────────────────────────────────────────────────
  async function abrir(o) {
    A = null;
    inyectarEstilos();
    const m = contenedor();
    m.innerHTML = '<div class="pl-body" style="text-align:center;color:var(--text2);padding-top:60px">Cargando planillas…</div>';
    m.classList.add('abierto');
    const cat = await catalogo();
    if (!cat || !cat.modulos) {
      m.innerHTML = `<div class="pl-top"><button class="pl-back" data-a="cerrar">← Volver</button><div class="t"><b>Planillas</b></div></div>
        <div class="pl-body"><div class="pl-card">No hay catálogo en la tablet. Conectate a internet una vez para descargarlo (se guarda y después funciona sin señal).</div></div>`;
      P = { o, doc: null };
      return;
    }
    const doc = await cargarRelevamiento(o);
    const ctx = await contexto(o.destinoId, doc.rel.id);
    P = { o, cat, ctx, doc, vista: doc.instancias.length ? 'inicio' : 'agregar', instId: null, verTodos: false, confirmar: null };
    P.mod = Object.fromEntries(cat.modulos.map(x => [x.codigo, x]));
    P.prev = new Map(ctx.respuestas_anteriores.map(r => [claveItem(r.modulo_codigo, r.etiqueta, r.item_id), r]));
    if (doc._nuevo) delete doc._nuevo;
    pintar();
  }

  function cerrar() {
    const m = document.getElementById('modal-planillas');
    if (m) m.classList.remove('abierto');
    if (P?.doc) { clearTimeout(tGuardar); ARStorage.set('chk_rel_' + P.doc.rel.id, P.doc).then(() => { if (online() && P?.doc?._dirty) enviar(P.doc.rel.id); }); }
    const cb = P?.o?.onCerrar;
    setTimeout(() => { if (typeof cb === 'function') cb(); }, 50);
  }

  // ── instancias ──────────────────────────────────────────────────────────
  function agregarInstancia(codigo, etiqueta, datos) {
    const m = P.mod[codigo];
    if (!m) return null;
    if (!m.repetible) {
      const ya = P.doc.instancias.find(i => i.modulo_codigo === codigo);
      if (ya) return ya;
    }
    const inst = { id: uuid(), modulo_codigo: codigo, etiqueta: etiqueta || (m.repetible ? '' : null), datos: datos ? { ...datos } : {} };
    if (etiqueta && m.repetible) inst.datos.nombre = etiqueta;
    P.doc.instancias.push(inst);
    return inst;
  }

  // Agrega los módulos de una plantilla. Los repetibles se precargan con las
  // instalaciones ya relevadas en visitas anteriores (con sus datos).
  function aplicarPlantilla(pl) {
    for (const c of pl.modulos) {
      const m = P.mod[c];
      if (!m) continue;
      if (P.doc.instancias.some(i => i.modulo_codigo === c)) continue;
      if (m.repetible) {
        const conocidas = (P.ctx.instancias_conocidas || []).filter(k => k.modulo_codigo === c);
        if (conocidas.length) conocidas.forEach(k => agregarInstancia(c, k.etiqueta, k.datos));
        else agregarInstancia(c, '', {});
      } else agregarInstancia(c);
    }
    P.doc.rel.plantilla_id = pl.id;
    if (NIVEL_ORDEN[pl.nivel] > NIVEL_ORDEN[P.doc.rel.nivel]) P.doc.rel.nivel = pl.nivel;
  }

  function itemsVisibles(inst) {
    const m = P.mod[inst.modulo_codigo];
    const nv = NIVEL_ORDEN[P.doc.rel.nivel];
    const cat = (m?.items || []).filter(it => P.verTodos || NIVEL_ORDEN[it.nivel] <= nv || respuestaDe(inst.id, it.id));
    const libres = P.doc.respuestas.filter(r => r.instancia_id === inst.id && !r.item_id);
    return { cat, libres };
  }
  const respuestaDe = (instId, itemId) => P.doc.respuestas.find(r => r.instancia_id === instId && r.item_id === itemId);
  const respuestasDe = instId => P.doc.respuestas.filter(r => r.instancia_id === instId);

  function progreso(inst) {
    const { cat, libres } = itemsVisibles(inst);
    const total = cat.length + libres.length;
    const hechas = respuestasDe(inst.id).length;
    return { total, hechas, pct: total ? Math.min(100, Math.round(hechas / total * 100)) : 0, nc: respuestasDe(inst.id).filter(r => r.resultado === 'NC').length };
  }

  function nombreInst(inst) {
    const m = P.mod[inst.modulo_codigo];
    return (m ? m.nombre : inst.modulo_codigo) + (inst.etiqueta ? ' · ' + inst.etiqueta : '');
  }

  // ── pintar ──────────────────────────────────────────────────────────────
  function pintarSync() {
    const el = document.getElementById('pl-sync');
    if (!el || !P?.doc) return;
    const d = P.doc;
    let txt, bg, col;
    if (d._error) { txt = '⚠ ' + d._error; bg = 'rgba(255,82,82,.15)'; col = 'var(--red)'; }
    else if (d._dirty) { txt = online() ? 'Enviando…' : 'Sin señal · guardado en la tablet'; bg = 'rgba(255,145,0,.15)'; col = 'var(--orange)'; }
    else if (!d._enviado_en) { txt = 'Sin datos todavía'; bg = 'var(--bg3)'; col = 'var(--text2)'; }
    else { txt = 'Enviado ✓'; bg = 'rgba(0,230,118,.15)'; col = 'var(--green)'; }
    el.textContent = txt; el.style.background = bg; el.style.color = col;
  }

  function cabecera(titulo, sub, back) {
    return `<div class="pl-top"><button class="pl-back" data-a="${back}">←</button>
      <div class="t"><b>${esc(titulo)}</b><span>${esc(sub)}</span></div><span class="pl-sync" id="pl-sync"></span></div>`;
  }

  function pintar() {
    const m = contenedor();
    const scroll = m.querySelector('.pl-body')?.scrollTop || 0;
    const v = P.vista;
    m.innerHTML = v === 'instancia' ? vInstancia() : v === 'agregar' ? vAgregar() : v === 'resumen' ? vResumen() : vInicio();
    pintarSync();
    if (P.vista === P._vistaAnterior && P.instId === P._instAnterior) { const b = m.querySelector('.pl-body'); if (b) b.scrollTop = scroll; }
    P._vistaAnterior = P.vista; P._instAnterior = P.instId;
    cargarMiniaturas();
  }

  const nombreEst = () => P.o.establecimiento || P.doc.rel.establecimiento_texto || 'Establecimiento';

  function vInicio() {
    const d = P.doc;
    const pl = (P.cat.plantillas || []).find(p => p.id === d.rel.plantilla_id);
    const res = resumir(d.respuestas);
    const acc = P.ctx.acciones_abiertas || [];
    const seg = id => (d.seguimientos || []).find(s => s.accion_id === id);
    const obs = d.rel.actividades_observadas || [];
    const acts = P.ctx.actividades || [];
    let h = cabecera(nombreEst(), (pl ? pl.nombre : d.instancias.length + (d.instancias.length === 1 ? ' chequeo' : ' chequeos')) + ' · Nivel ' + NIVELES[d.rel.nivel], 'cerrar') + '<div class="pl-body">';
    if (d.rel.estado === 'cerrado') h += `<div class="pl-card" style="border-color:var(--green)">Relevamiento cerrado. Para cambiar algo, pedile a Dirección que lo reabra.</div>`;
    if (acc.length) {
      h += `<div class="pl-sec">Pendientes de visitas anteriores (${acc.length})</div>`;
      for (const a of acc) {
        const s = seg(a.id);
        h += `<div class="pl-card"><div style="display:flex;gap:8px;align-items:flex-start"><span class="pl-tag" style="color:${colorCrit(a.criticidad)}">${CRIT[a.criticidad]}</span>
          <div style="flex:1;font-size:14px">${esc(a.hallazgo)}<div style="font-size:12px;color:var(--text2);margin-top:3px">${esc([a.modulo_nombre, a.instancia_etiqueta].filter(Boolean).join(' · '))}${a.fecha_compromiso ? ' · plazo ' + fmtFecha(a.fecha_compromiso) : ''}</div></div></div>
          <div class="pl-crit" style="margin-top:8px">${[['corregido', '✓ Corregido'], ['en_curso', 'En curso'], ['sin_cambios', 'Sin cambios']].map(([k, t]) =>
            `<button data-a="seguimiento" data-id="${a.id}" data-v="${k}" style="${s?.resultado === k ? 'background:var(--accent);color:#0f1923;border-color:var(--accent)' : ''}">${t}</button>`).join('')}</div>
          ${s?.auto ? `<div style="font-size:12px;color:var(--accent);margin-top:6px">Marcado solo al chequear el ítem hoy. Si no es así, tocá otra opción.</div>` : ''}
          ${!s && a.item_id ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">Se marca solo al chequear ese ítem en ${esc(a.modulo_nombre || 'su tema')}${a.instancia_etiqueta ? ' · ' + esc(a.instancia_etiqueta) : ''}.</div>` : ''}
          ${s ? `<input class="pl-in" style="margin-top:8px" placeholder="Comentario (opcional)" data-f="seg-com" data-id="${a.id}" value="${esc(s.comentario || '')}">
            <div style="margin-top:8px">${tiraFotos('seg', a.id, s.fotos, s.resultado === 'corregido' ? '📷 Foto del después' : '📷 Foto')}</div>` : ''}</div>`;
      }
    }
    h += `<div class="pl-sec">Actividades que se están haciendo hoy</div><div>`;
    for (const a of acts) {
      const on = obs.some(o => o.actividad_id === a.id);
      h += `<button class="pl-chip ${on ? 'on' : ''}" data-a="act" data-id="${a.id}">${esc(a.actividad)}${a.frecuencia !== 'permanente' ? ' <small>(' + esc(a.frecuencia) + ')</small>' : ''}</button>`;
    }
    for (const o of obs.filter(o => !o.actividad_id)) h += `<button class="pl-chip on" data-a="act-quitar" data-v="${esc(o.texto)}">${esc(o.texto)} ✕</button>`;
    h += `</div><div style="display:flex;gap:8px"><input class="pl-in" id="pl-act-nueva" placeholder="Otra actividad no registrada (ej.: arreglo de alambrado)"><button class="btn btn-secondary btn-sm" data-a="act-nueva">Agregar</button></div>
      <div style="font-size:12px;color:var(--text2);margin-top:4px">Las que no estaban registradas se suman al establecimiento como eventuales.</div>`;
    h += `<div class="pl-sec">Chequeos de esta visita (${d.instancias.length})${res.indice !== null ? ` · índice <span style="color:${colorCalif(res.calificacion)}">${res.indice}%</span>` : ''}</div>`;
    d.instancias.forEach(i => {
      const p = progreso(i);
      const falta = P.mod[i.modulo_codigo]?.repetible && !i.etiqueta;
      const cmp = comparar(paresDe([i]));
      const txtCmp = cmp.comparables ? ` · antes ${cmp.indice_antes}% → hoy ${cmp.indice_ahora}%${cmp.mejoro ? ` <span style="color:var(--green)">${cmp.mejoro} mejoró</span>` : ''}${cmp.empeoro ? ` <span style="color:var(--red)">${cmp.empeoro} empeoró</span>` : ''}` : '';
      h += `<div class="pl-card pl-row" data-a="inst" data-id="${i.id}"><div class="n"><b>${esc(nombreInst(i))}</b>
        <small>${falta ? '<span class="pl-warn">Falta el nombre · </span>' : ''}${p.hechas} de ${p.total}${p.nc ? ` · <span style="color:var(--red)">${p.nc} no cumple</span>` : ''}${txtCmp}</small></div>
        <div class="pl-bar"><i style="width:${p.pct}%"></i></div></div>`;
    });
    h += `<div style="margin-top:6px"><button class="pl-chip" data-a="vista" data-v="agregar">+ Otro chequeo</button></div>`;
    h += `</div><div class="pl-foot"><button class="btn btn-secondary" data-a="cerrar">Volver a la constancia</button><button class="btn btn-primary" data-a="vista" data-v="resumen">Resumen</button></div>`;
    return h;
  }

  // Pantalla de entrada: se elige el TEMA a chequear (uno solo va directo a él).
  // Si en el lugar aparece otro chequeo, se vuelve acá con "+ Otro chequeo".
  // Las plantillas (varios temas juntos) quedan como atajo opcional al final.
  function vAgregar() {
    const vacio = !P.doc.instancias.length;
    const presentes = new Set(P.doc.instancias.map(i => i.modulo_codigo + '|' + (i.etiqueta || '').toLowerCase()));
    const conocidasDe = c => (P.ctx.instancias_conocidas || []).filter(k => k.modulo_codigo === c && !presentes.has(c + '|' + (k.etiqueta || '').toLowerCase()));
    let h = cabecera(vacio ? '¿Qué vas a chequear?' : 'Agregar otro chequeo', nombreEst(), vacio ? 'cerrar' : 'inicio') + '<div class="pl-body">';

    // Tema repetible con instalaciones ya conocidas: elegir cuál (o una nueva).
    if (P.eligiendo) {
      const m = P.mod[P.eligiendo];
      const con = conocidasDe(P.eligiendo);
      P._conocidas = con;
      h += `<div class="pl-sec">${esc(m.nombre)}: ¿cuál?</div>`;
      con.forEach((k, n) => { h += `<div class="pl-card pl-row" data-a="add-conocida" data-v="${n}"><div class="n"><b>${esc(k.etiqueta)}</b><small>Chequeado el ${fmtFecha(k.visto_en)}</small></div><span style="font-size:20px">›</span></div>`; });
      h += `<div class="pl-card pl-row" data-a="add-nueva" data-v="${m.codigo}"><div class="n"><b>+ Otro u otra nueva</b><small>No está en la lista</small></div><span style="font-size:20px">›</span></div>
        <button class="pl-chip" data-a="elegir-volver">← Elegir otro tema</button>`;
      return h + '</div>';
    }

    h += `<div class="pl-grid2">`;
    for (const m of P.cat.modulos) {
      const n = P.doc.instancias.filter(i => i.modulo_codigo === m.codigo).length;
      if (!m.repetible && n) continue;
      const k = conocidasDe(m.codigo).length;
      h += `<div class="pl-card pl-row" data-a="add-mod" data-v="${m.codigo}" style="margin:0"><div class="n"><b>${esc(m.nombre)}</b>
        <small>${m.items.length} ítems${n ? ` · ya cargados: ${n}` : ''}${k ? ` · ${k} de visitas anteriores` : ''}</small></div></div>`;
    }
    h += `</div>`;
    const pls = P.cat.plantillas || [];
    h += `<details class="pl-card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">Recorrida completa: varios temas juntos</summary>
      <div style="font-size:12px;color:var(--text2);margin:8px 0">Solo si en esta visita toca revisar todo. Agrega varios temas de una vez; los que no uses se quitan.</div>
      ${pls.map(p => `<div class="pl-card pl-row" data-a="plantilla" data-v="${p.id}"><div class="n"><b>${esc(p.nombre)}</b>
        <small>${p.modulos.map(c => esc(P.mod[c]?.nombre || c)).join(' · ')}</small></div><span style="font-size:20px">›</span></div>`).join('')}</details>
      <details class="pl-card"><summary style="cursor:pointer;font-weight:600">Nivel del establecimiento: ${NIVELES[P.doc.rel.nivel]}</summary>
      <div style="margin-top:8px">${Object.entries(NIVELES).map(([k, n]) => `<button class="pl-chip ${P.doc.rel.nivel === k ? 'on' : ''}" data-a="nivel" data-v="${k}">${n}</button>`).join('')}</div>
      <div style="font-size:12px;color:var(--text2)">Ampliado suma documentación y mediciones; Certificación suma requisitos de PEFC, FSC, GlobalG.A.P. o ISO 45001.</div></details>`;
    return h + '</div>';
  }

  function campoInstancia(inst, c) {
    const v = inst.datos?.[c.clave];
    const attrs = `class="pl-in" data-f="dato" data-k="${esc(c.clave)}"`;
    let ctrl;
    if (c.tipo === 'opcion') ctrl = `<select ${attrs}><option value=""></option>${(c.opciones || []).map(o => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (c.tipo === 'si_no') ctrl = `<select ${attrs}><option value=""></option><option value="si" ${v === true || v === 'si' ? 'selected' : ''}>Sí</option><option value="no" ${v === false || v === 'no' ? 'selected' : ''}>No</option></select>`;
    else if (c.tipo === 'gps') ctrl = `<div style="display:flex;gap:8px;align-items:center"><button class="btn btn-secondary btn-sm" data-a="gps" data-k="${esc(c.clave)}">📍 Tomar ubicación</button><span style="font-size:12px;color:var(--text2)">${v?.lat ? `${Number(v.lat).toFixed(5)}, ${Number(v.lng).toFixed(5)} (±${Math.round(v.precision || 0)} m)` : 'Sin ubicación'}</span></div>`;
    else ctrl = `<input ${attrs} type="${c.tipo === 'numero' ? 'number' : c.tipo === 'fecha' ? 'date' : c.tipo === 'hora' ? 'time' : 'text'}" value="${esc(v ?? '')}" ${c.tipo === 'numero' ? 'inputmode="decimal"' : ''}>`;
    return `<div><label style="font-size:11px;color:var(--text2);font-weight:600;text-transform:uppercase">${esc(c.etiqueta)}${c.requerido ? ' *' : ''}</label>${ctrl}</div>`;
  }

  // "Anterior (12/08): No cumple — observación" y, si ya se respondió hoy, cómo evolucionó.
  function lineaAnterior(inst, it, r) {
    if (!it.id) return '';
    const a = anteriorDe(inst, it.id);
    if (!a) return '';
    const e = r ? evolucion(a.resultado, r.resultado) : null;
    const colAntes = a.resultado === 'NC' ? 'var(--red)' : a.resultado === 'C' ? 'var(--green)' : 'var(--text2)';
    return `<div style="font-size:12.5px;margin:-2px 0 8px;padding:6px 8px;background:var(--bg3);border-radius:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span style="color:var(--text2)">Anterior (${fmtFecha(a.fecha)}):</span><b style="color:${colAntes}">${RES[a.resultado] || a.resultado}</b>
      ${a.observacion ? `<span style="color:var(--text2)">— ${esc(a.observacion)}</span>` : ''}
      ${e ? `<span style="margin-left:auto;font-weight:700;color:${EVOL[e][1]}">${EVOL[e][0]}</span>` : ''}</div>`;
  }

  function tarjetaItem(inst, it, r) {
    const res = r?.resultado;
    const crit = r ? Number(r.criticidad || it.criticidad || 2) : it.criticidad;
    const key = it.id ? `data-item="${it.id}"` : `data-resp="${r.id}"`;
    let h = `<div class="pl-item ${res ? 'r-' + res : ''}" ${key}>
      <div class="tx">${it.codigo ? `<span style="color:var(--text3);font-family:var(--mono);font-size:12px">${esc(it.codigo)}</span> ` : ''}${esc(it.texto)}</div>
      <div class="ref"><span class="pl-tag">${TIPO[it.tipo] || 'Agregado en el campo'}</span><span class="pl-tag" style="color:${colorCrit(it.criticidad)}">${CRIT[it.criticidad] || ''}</span>${esc(it.ref_normativa || '')}</div>
      ${lineaAnterior(inst, it, r)}
      <div class="pl-btns">${Object.entries(RES).map(([k, t]) => `<button data-a="res" data-v="${k}" class="${res === k ? 'on-' + k : ''}">${t}</button>`).join('')}</div>`;
    if (res === 'NC') {
      const sinFoto = crit === 1 && !(r.fotos || []).length;
      h += `<div class="pl-nc">
        <div><label>Criticidad</label><div class="pl-crit">${[1, 2, 3].map(c => `<button data-a="crit" data-v="${c}" style="${crit === c ? `background:${colorCrit(c)};color:#fff;border-color:${colorCrit(c)}` : ''}">${CRIT[c]}</button>`).join('')}</div></div>
        ${crit === 1 ? '<div class="pl-warn">Crítico: indicar en el momento detener la tarea o el equipo.</div>' : ''}
        <div><label>Observación 🎤</label><textarea class="pl-in" data-f="observacion" placeholder="Qué se vio. Podés dictar con el micrófono del teclado.">${esc(r.observacion || '')}</textarea></div>
        <div><label>Medida propuesta</label><textarea class="pl-in" data-f="medida">${esc(r.medida || '')}</textarea></div>
        <div class="pl-grid2"><div><label>Plazo sugerido</label><input class="pl-in" type="date" data-f="plazo" value="${esc(r.plazo || '')}"></div></div>
        <div><label>Fotos · tocá una para marcarla con flechas o círculos</label>${tiraFotos('resp', r.id, r.fotos)}
          ${(r.fotos || []).length > 2 ? '<div style="font-size:11.5px;color:var(--text2);margin-top:4px">Las 2 primeras van a la constancia; todas van al informe. Con ★ elegís cuál va primero.</div>' : ''}
          ${sinFoto ? '<div class="pl-warn" style="margin-top:4px">Falta la foto (obligatoria en críticos)</div>' : ''}</div>
      </div>`;
    } else if (res === 'NA' || res === 'NV' || res === 'C') {
      h += `<input class="pl-in" style="margin-top:8px" data-f="observacion" placeholder="Nota (opcional)" value="${esc(r.observacion || '')}">
        <div style="margin-top:6px">${tiraFotos('resp', r.id, r.fotos, 'Foto (opcional)')}</div>`;
    }
    if (!it.id) h += `<button class="pl-chip" style="margin-top:8px;border-color:var(--red);color:var(--red)" data-a="libre-quitar">Quitar este ítem</button>`;
    return h + '</div>';
  }

  function vInstancia() {
    const inst = P.doc.instancias.find(i => i.id === P.instId);
    if (!inst) { P.vista = 'inicio'; return vInicio(); }
    const m = P.mod[inst.modulo_codigo] || { nombre: inst.modulo_codigo, campos_instancia: [], items: [] };
    const { cat, libres } = itemsVisibles(inst);
    const ocultos = (m.items || []).length - cat.length;
    const p = progreso(inst);
    let h = cabecera(nombreInst(inst), `${p.hechas} de ${p.total} respondidos`, 'inicio') + '<div class="pl-body" data-inst="' + inst.id + '">';
    const campos = m.campos_instancia || [];
    if (campos.length) {
      const faltan = campos.some(c => c.requerido && !inst.datos?.[c.clave]);
      h += `<details class="pl-card" ${faltan || !p.hechas ? 'open' : ''}><summary style="cursor:pointer;font-weight:600">Datos ${faltan ? '<span class="pl-warn">· completar</span>' : ''}</summary>
        <div class="pl-grid2" style="margin-top:10px">${campos.map(c => campoInstancia(inst, c)).join('')}</div></details>`;
    }
    h += `<div class="pl-card"><div style="font-weight:600;font-size:14px;margin-bottom:6px">Fotos generales ${(inst.fotos || []).length ? '(' + inst.fotos.length + ')' : ''}</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:6px">Vista de conjunto de la instalación, también lo que está bien.</div>${tiraFotos('inst', inst.id, inst.fotos)}</div>`;
    let grupo = null;
    for (const it of cat) {
      if (it.grupo !== grupo) { grupo = it.grupo; if (grupo) h += `<div class="pl-sub">${esc(grupo)}</div>`; }
      h += tarjetaItem(inst, it, respuestaDe(inst.id, it.id));
    }
    if (libres.length) {
      h += `<div class="pl-sub">Agregados en el campo</div>`;
      for (const r of libres) h += tarjetaItem(inst, { texto: r.item_texto, ref_normativa: r.item_ref, criticidad: r.criticidad, tipo: null }, r);
    }
    h += `<div class="pl-card" style="margin-top:12px"><b style="font-size:14px">+ Ítem no previsto</b>
      <textarea class="pl-in" id="pl-libre-txt" style="margin-top:8px" placeholder="Qué se controla (ej.: bebedero sin cerco junto a la vivienda)"></textarea>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:8px"><input type="checkbox" id="pl-libre-prop" style="width:18px;height:18px"> Proponer a Dirección para sumarlo al catálogo</label>
      <button class="btn btn-secondary btn-sm" style="margin-top:8px" data-a="libre">Agregar ítem</button></div>`;
    if (ocultos > 0 || P.verTodos) h += `<button class="pl-chip" data-a="ver-todos">${P.verTodos ? 'Ocultar ítems de nivel superior' : `Mostrar ${ocultos} ítems de nivel superior`}</button>`;
    h += `<button class="pl-chip" data-a="pendientes-nv">Lo que falta: no se pudo verificar</button>`;
    h += P.confirmar === 'quitar'
      ? `<div class="pl-confirm">¿Quitar ${esc(nombreInst(inst))} y todo lo cargado en este módulo? <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-danger btn-sm" data-a="quitar-si">Sí, quitar</button><button class="btn btn-secondary btn-sm" data-a="quitar-no">No</button></div></div>`
      : `<button class="pl-chip" style="border-color:var(--red);color:var(--red)" data-a="quitar">Quitar este módulo</button>`;
    h += `</div><div class="pl-foot"><button class="btn btn-secondary" data-a="vista" data-v="inicio">Módulos</button>${siguienteInst(inst) ? `<button class="btn btn-primary" data-a="inst" data-id="${siguienteInst(inst).id}">Siguiente módulo ›</button>` : `<button class="btn btn-primary" data-a="vista" data-v="resumen">Resumen</button>`}</div>`;
    return h;
  }
  function siguienteInst(inst) { const l = P.doc.instancias; return l[l.indexOf(inst) + 1] || null; }

  // Contraste con la visita anterior, sobre los mismos ítems y las mismas instalaciones.
  function bloqueComparacion() {
    const d = P.doc;
    const c = comparar(paresDe(d.instancias));
    const segs = (d.seguimientos || []);
    const accs = P.ctx.acciones_abiertas || [];
    const corr = segs.filter(s => s.resultado === 'corregido').length;
    const sinCambio = segs.filter(s => s.resultado === 'sin_cambios').length;
    const enCurso = segs.filter(s => s.resultado === 'en_curso').length;
    if (!c.comparables && !accs.length) return '';
    const flecha = c.indice_ahora > c.indice_antes ? '▲' : c.indice_ahora < c.indice_antes ? '▼' : '=';
    const colF = c.indice_ahora > c.indice_antes ? 'var(--green)' : c.indice_ahora < c.indice_antes ? 'var(--red)' : 'var(--text2)';
    const lista = (arr, titulo, col) => arr.length ? `<div style="margin-top:8px"><b style="font-size:12px;color:${col};text-transform:uppercase">${titulo} (${arr.length})</b>
      ${arr.map(p => `<div style="font-size:13px;margin-top:3px">• ${esc(p.ahora.item_texto)} <span style="color:var(--text2)">· ${esc(nombreInst(p.inst))}</span></div>`).join('')}</div>` : '';
    let h = `<div class="pl-sec">Contra la visita anterior</div><div class="pl-card">`;
    if (c.comparables) {
      h += `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div style="font-size:22px;font-weight:700">${c.indice_antes}% <span style="color:${colF}">${flecha}</span> ${c.indice_ahora}%</div>
        <div style="font-size:13px"><span style="color:var(--green)">${c.mejoro} mejoraron</span> · <span style="color:var(--red)">${c.empeoro} empeoraron</span> · <span style="color:var(--orange)">${c.sigue_nc} siguen sin cumplir</span> · ${c.sigue_c} siguen cumpliendo</div></div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">Sobre ${c.comparables} ítems chequeados en las dos visitas.</div>
        ${lista(c.lista.mejoro, 'Mejoraron', 'var(--green)')}${lista(c.lista.empeoro, 'Empeoraron', 'var(--red)')}${lista(c.lista.sigue_nc, 'Siguen sin cumplir', 'var(--orange)')}`;
    }
    if (accs.length) {
      h += `<div style="margin-top:${c.comparables ? 12 : 0}px;font-size:13px"><b>Pendientes anteriores (${accs.length}):</b> <span style="color:var(--green)">${corr} corregidos</span> · ${enCurso} en curso · <span style="color:var(--orange)">${sinCambio} sin cambios</span> · ${accs.length - corr - enCurso - sinCambio} sin verificar</div>`;
    }
    return h + '</div>';
  }

  function vResumen() {
    const d = P.doc;
    const res = resumir(d.respuestas);
    const porMod = {};
    for (const i of d.instancias) {
      const k = i.modulo_codigo;
      (porMod[k] = porMod[k] || { nombre: P.mod[k]?.nombre || k, inst: 0, rs: [] }).inst++;
      porMod[k].rs.push(...respuestasDe(i.id));
    }
    const nc = d.respuestas.filter(r => r.resultado === 'NC').sort((a, b) => a.criticidad - b.criticidad);
    const instPor = Object.fromEntries(d.instancias.map(i => [i.id, i]));
    const faltanFotos = nc.filter(r => Number(r.criticidad) === 1 && !(r.fotos || []).length).length;
    const sinResp = d.instancias.reduce((n, i) => { const p = progreso(i); return n + Math.max(0, p.total - p.hechas); }, 0);
    let h = cabecera('Resumen', nombreEst(), 'inicio') + `<div class="pl-body">
      <div class="pl-card" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <div style="font-size:40px;font-weight:700;color:${colorCalif(res.calificacion)}">${res.indice === null ? '—' : res.indice + '%'}</div>
        <div><b style="color:${colorCalif(res.calificacion)}">${CALIF[res.calificacion]}</b><div style="font-size:12px;color:var(--text2)">Índice ponderado por criticidad${res.nc1 ? ' · con críticos abiertos la calificación no puede ser mejor que deficiente' : ''}</div>
        <div style="font-size:13px;margin-top:4px">${res.C} cumple · ${res.NC} no cumple · ${res.NA} no aplica · ${res.NV} no verificado</div></div></div>
      ${sinResp ? `<div style="font-size:12px;color:var(--text2)">${sinResp} ítems de estos chequeos quedaron sin responder: no cuentan en el índice.</div>` : ''}
      ${faltanFotos ? `<div class="pl-warn">Hay ${faltanFotos} crítico(s) sin foto.</div>` : ''}
      ${bloqueComparacion()}
      <div class="pl-sec">Por módulo</div><div class="pl-card" style="overflow-x:auto"><table class="pl-tabla"><tr><th>Módulo</th><th>Cant.</th><th>No cumple</th><th>Índice</th></tr>
      ${Object.values(porMod).map(x => { const r = resumir(x.rs); return `<tr><td>${esc(x.nombre)}</td><td>${x.inst}</td><td>${r.NC}</td><td style="color:${colorCalif(r.calificacion)}">${r.indice === null ? '—' : r.indice + '%'}</td></tr>`; }).join('')}</table></div>
      <div class="pl-sec">Hallazgos (${nc.length})</div>
      ${nc.map(r => `<div class="pl-card"><span class="pl-tag" style="color:${colorCrit(Number(r.criticidad))}">${CRIT[r.criticidad]}</span> <b style="font-size:14px">${esc(r.item_texto)}</b>
        <div style="font-size:12px;color:var(--text2);margin-top:3px">${esc(nombreInst(instPor[r.instancia_id] || {}))}${r.plazo ? ' · plazo ' + fmtFecha(r.plazo) : ''}</div>
        ${r.observacion ? `<div style="font-size:13px;margin-top:4px">${esc(r.observacion)}</div>` : ''}${r.medida ? `<div style="font-size:13px;margin-top:4px;color:var(--accent)">→ ${esc(r.medida)}</div>` : ''}</div>`).join('') || '<div class="pl-card">Sin hallazgos.</div>'}
      <div style="font-size:12px;color:var(--text2);margin-top:10px">Los hallazgos pasan a "Desvíos" de la constancia desde el paso Planillas. Los plazos son sugerencias de EXIT y se acuerdan con el cliente.</div>
      ${d.rel.estado !== 'cerrado' ? (P.confirmar === 'cerrar-rel'
        ? `<div class="pl-confirm">Al cerrar, el relevamiento ya no se puede cambiar desde la tablet (Dirección puede reabrirlo). <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-warning btn-sm" data-a="cerrar-rel-si">Cerrar relevamiento</button><button class="btn btn-secondary btn-sm" data-a="quitar-no">Seguir editando</button></div></div>`
        : `<button class="pl-chip" style="margin-top:12px" data-a="cerrar-rel">Terminar y cerrar el relevamiento</button>`) : ''}
    </div><div class="pl-foot"><button class="btn btn-secondary" data-a="vista" data-v="inicio">Módulos</button><button class="btn btn-primary" data-a="cerrar">Volver a la constancia</button></div>`;
    return h;
  }

  // ── fotos ───────────────────────────────────────────────────────────────
  function comprimir(file, max = 1280, calidad = 0.7) {
    return new Promise((ok, mal) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', calidad));
      };
      img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la foto')); };
      img.src = url;
    });
  }
  // Tira de miniaturas + botón de cámara. ft: resp (ítem) | inst (módulo) | seg (seguimiento).
  function tiraFotos(ft, fid, fotos, texto) {
    const lista = fotos || [];
    return `<div class="pl-fotos">${lista.map((f, n) => `<span style="position:relative;display:inline-block">
        <img data-a="foto-ver" data-ft="${ft}" data-fid="${fid}" data-foto="${f}" alt="Foto ${n + 1}">
        ${n === 0 && lista.length > 1 ? '<span style="position:absolute;top:2px;left:4px;font-size:12px">★</span>' : ''}</span>`).join('')}
      <label class="pl-add-foto">${texto || '📷 Foto'}<input type="file" accept="image/*" capture="environment" hidden data-f="foto" data-ft="${ft}" data-fid="${fid}"></label></div>`;
  }

  // Devuelve (y crea si hace falta) el arreglo de fotos del destino.
  function listaFotos(ft, fid) {
    if (ft === 'resp') { const r = P.doc.respuestas.find(x => x.id === fid); if (!r) return null; return (r.fotos = r.fotos || []); }
    if (ft === 'inst') { const i = P.doc.instancias.find(x => x.id === fid); if (!i) return null; return (i.fotos = i.fotos || []); }
    if (ft === 'seg') { const s = (P.doc.seguimientos || []).find(x => x.accion_id === Number(fid)); if (!s) return null; return (s.fotos = s.fotos || []); }
    return null;
  }

  // Foto guardada en la tablet; si no está (se cargó en otra tablet), se baja del servidor.
  async function fotoLocal(id) {
    let f = await ARStorage.get('chk_foto_' + id);
    if (f?.data_url || !online() || !STATE?.token) return f;
    try {
      const r = await fetch('/api/planillas/fotos/' + id, { headers: { Authorization: 'Bearer ' + STATE.token } });
      if (!r.ok) return null;
      const blob = await r.blob();
      const data_url = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
      f = { id, rel_id: P?.doc?.rel.id || null, data_url, subida: true };
      await ARStorage.set('chk_foto_' + id, f);
      return f;
    } catch (e) { return null; }
  }

  async function cargarMiniaturas() {
    for (const img of document.querySelectorAll('#modal-planillas img[data-foto]')) {
      const f = await fotoLocal(img.dataset.foto);
      if (f?.data_url) img.src = f.data_url;
    }
  }

  // ── visor y editor de marcas ────────────────────────────────────────────
  // La foto marcada se guarda como foto nueva (con original_id); la original
  // queda intacta y también se envía al servidor.
  const COLORES = { rojo: '#ff3b30', amarillo: '#ffd60a' };
  let V = null; // { ft, fid, id, foto, img, marcas, herr, color, trazo, esc }

  function capaVisor() {
    let c = document.getElementById('pl-visor');
    if (!c) {
      c = document.createElement('div');
      c.id = 'pl-visor';
      c.style.cssText = 'position:fixed;inset:0;z-index:470;background:rgba(0,0,0,.92);display:none;flex-direction:column';
      c.addEventListener('click', onClickVisor);
      document.body.appendChild(c);
    }
    return c;
  }

  async function abrirVisor(ft, fid, id) {
    const foto = await fotoLocal(id);
    if (!foto?.data_url) return toast('La foto todavía no está en esta tablet', 'error');
    V = { ft, fid, id, foto, editando: false };
    const c = capaVisor();
    const lista = listaFotos(ft, fid) || [];
    const ed = editable();
    c.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:10px;min-height:0">
        <img src="${foto.data_url}" alt="Foto" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;padding:12px calc(12px + env(safe-area-inset-bottom))">
        ${ed ? `<button class="btn btn-primary btn-sm" data-v="marcar">✏ Marcar</button>` : ''}
        ${ed && ft === 'resp' && lista.indexOf(id) > 0 ? `<button class="btn btn-secondary btn-sm" data-v="primera">★ Poner primera</button>` : ''}
        ${ed ? `<button class="btn btn-danger btn-sm" data-v="quitar">Quitar</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-v="cerrar">Cerrar</button></div>`;
    c.style.display = 'flex';
  }

  function cerrarVisor() { const c = capaVisor(); c.style.display = 'none'; c.innerHTML = ''; V = null; }

  async function onClickVisor(e) {
    const b = e.target.closest('[data-v]');
    if (!b || !V) return;
    const v = b.dataset.v;
    const lista = listaFotos(V.ft, V.fid);
    if (v === 'cerrar') return cerrarVisor();
    if (v === 'primera' && lista) { lista.splice(lista.indexOf(V.id), 1); lista.unshift(V.id); guardar(); cerrarVisor(); return pintar(); }
    if (v === 'quitar' && lista) {
      if (V.confirmarQuitar) { lista.splice(lista.indexOf(V.id), 1); guardar(); cerrarVisor(); return pintar(); }
      V.confirmarQuitar = true; b.textContent = '¿Seguro? Tocá de nuevo'; return;
    }
    if (v === 'marcar') return abrirEditor();
    if (v === 'herr') { V.herr = b.dataset.h; return pintarBarraEditor(); }
    if (v === 'color') { V.color = b.dataset.c; return pintarBarraEditor(); }
    if (v === 'deshacer') { V.marcas.pop(); return dibujar(); }
    if (v === 'cancelar') return abrirVisor(V.ft, V.fid, V.id);
    if (v === 'texto-ok') {
      const t = document.getElementById('pl-marca-texto')?.value.trim();
      if (t && V.textoEn) V.marcas.push({ tipo: 'texto', color: V.color, x1: V.textoEn.x, y1: V.textoEn.y, texto: t.slice(0, 40) });
      V.textoEn = null; document.getElementById('pl-marca-caja').style.display = 'none'; return dibujar();
    }
    if (v === 'guardar-marcas') return guardarMarcas();
  }

  async function abrirEditor() {
    // Si la foto ya estaba marcada, se edita sobre la original con las marcas anteriores.
    let base = V.foto;
    if (V.foto.original_id) { const o = await fotoLocal(V.foto.original_id); if (o?.data_url) base = o; }
    const img = new Image();
    await new Promise(ok => { img.onload = ok; img.src = base.data_url; });
    Object.assign(V, { base, img, marcas: [...(V.foto.marcas || [])], herr: 'flecha', color: 'rojo', trazo: null, textoEn: null });
    const c = capaVisor();
    c.innerHTML = `<div id="pl-barra-editor" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;padding:10px"></div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:0 8px">
        <canvas id="pl-lienzo" style="max-width:100%;max-height:100%;touch-action:none;border-radius:6px;background:#000"></canvas></div>
      <div id="pl-marca-caja" style="display:none;gap:8px;padding:10px;justify-content:center">
        <input id="pl-marca-texto" class="pl-in" maxlength="40" placeholder="Texto corto (ej.: sin protección)" style="max-width:360px">
        <button class="btn btn-primary btn-sm" data-v="texto-ok">Poner</button></div>
      <div style="display:flex;gap:8px;justify-content:center;padding:10px calc(10px + env(safe-area-inset-bottom))">
        <button class="btn btn-secondary btn-sm" data-v="deshacer">↶ Deshacer</button>
        <button class="btn btn-secondary btn-sm" data-v="cancelar">Cancelar</button>
        <button class="btn btn-success btn-sm" data-v="guardar-marcas">Guardar foto marcada</button></div>`;
    const cv = document.getElementById('pl-lienzo');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    cv.addEventListener('pointerdown', e => {
      const p = pos(e);
      if (V.herr === 'texto') {
        V.textoEn = p;
        const caja = document.getElementById('pl-marca-caja'); caja.style.display = 'flex';
        const t = document.getElementById('pl-marca-texto'); t.value = ''; t.focus();
        return;
      }
      cv.setPointerCapture(e.pointerId);
      V.trazo = { tipo: V.herr, color: V.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    });
    cv.addEventListener('pointermove', e => { if (!V?.trazo) return; const p = pos(e); V.trazo.x2 = p.x; V.trazo.y2 = p.y; dibujar(); });
    cv.addEventListener('pointerup', () => {
      if (!V?.trazo) return;
      const t = V.trazo; V.trazo = null;
      if (Math.hypot(t.x2 - t.x1, t.y2 - t.y1) > 8) V.marcas.push(t);
      dibujar();
    });
    pintarBarraEditor();
    dibujar();
  }

  function pintarBarraEditor() {
    const b = document.getElementById('pl-barra-editor');
    if (!b) return;
    const btn = (attrs, txt, on) => `<button class="btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}" ${attrs}>${txt}</button>`;
    b.innerHTML = btn('data-v="herr" data-h="flecha"', '➚ Flecha', V.herr === 'flecha') + btn('data-v="herr" data-h="circulo"', '◯ Círculo', V.herr === 'circulo')
      + btn('data-v="herr" data-h="texto"', 'T Texto', V.herr === 'texto')
      + Object.entries(COLORES).map(([k, c]) => `<button data-v="color" data-c="${k}" aria-label="Color ${k}" style="width:36px;height:36px;border-radius:50%;background:${c};border:3px solid ${V.color === k ? '#fff' : 'transparent'};cursor:pointer"></button>`).join('');
  }

  function pintarMarcas(ctx, marcas, w) {
    const grosor = Math.max(3, w / 180);
    for (const m of marcas) {
      const col = COLORES[m.color] || COLORES.rojo;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = grosor; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = grosor;
      if (m.tipo === 'flecha') {
        const ang = Math.atan2(m.y2 - m.y1, m.x2 - m.x1), cab = grosor * 5;
        ctx.beginPath(); ctx.moveTo(m.x1, m.y1); ctx.lineTo(m.x2, m.y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(m.x2, m.y2);
        ctx.lineTo(m.x2 - cab * Math.cos(ang - 0.45), m.y2 - cab * Math.sin(ang - 0.45));
        ctx.lineTo(m.x2 - cab * Math.cos(ang + 0.45), m.y2 - cab * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      } else if (m.tipo === 'circulo') {
        ctx.beginPath();
        ctx.ellipse((m.x1 + m.x2) / 2, (m.y1 + m.y2) / 2, Math.abs(m.x2 - m.x1) / 2, Math.abs(m.y2 - m.y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (m.tipo === 'texto') {
        const tam = Math.max(18, w / 28);
        ctx.font = `bold ${tam}px sans-serif`; ctx.textBaseline = 'middle';
        ctx.shadowBlur = 0; ctx.lineWidth = tam / 6; ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(m.texto, m.x1, m.y1); ctx.fillText(m.texto, m.x1, m.y1);
      }
      ctx.shadowBlur = 0;
    }
  }

  function dibujar() {
    const cv = document.getElementById('pl-lienzo');
    if (!cv || !V?.img) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(V.img, 0, 0);
    pintarMarcas(ctx, V.trazo ? [...V.marcas, V.trazo] : V.marcas, cv.width);
  }

  async function guardarMarcas() {
    const lista = listaFotos(V.ft, V.fid);
    if (!lista) return cerrarVisor();
    if (!V.marcas.length) { toast('No hay marcas para guardar', 'info'); return; }
    const cv = document.getElementById('pl-lienzo');
    const data_url = cv.toDataURL('image/jpeg', 0.8);
    const id = uuid();
    const originalId = V.base.id;
    await ARStorage.set('chk_foto_' + id, { id, rel_id: P.doc.rel.id, data_url, subida: false, original_id: originalId, marcas: V.marcas });
    const pos = lista.indexOf(V.id);
    if (pos >= 0) lista[pos] = id; else lista.push(id);
    guardar(); cerrarVisor(); pintar();
    toast('Foto marcada guardada ✓ (la original se conserva)', 'success');
  }
  // Fotos de un hallazgo como data URL (para los desvíos de la constancia).
  async function fotosDe(r) {
    const out = [];
    for (const id of (r.fotos || []).slice(0, 2)) { const f = await fotoLocal(id); if (f?.data_url) out.push(f.data_url); }
    return out;
  }

  // ── eventos ─────────────────────────────────────────────────────────────
  function tarjetaDe(el) {
    const card = el.closest('.pl-item');
    if (!card) return null;
    const inst = P.doc.instancias.find(i => i.id === P.instId);
    if (card.dataset.resp) return { inst, r: P.doc.respuestas.find(r => r.id === card.dataset.resp) };
    const itemId = Number(card.dataset.item);
    const it = (P.mod[inst.modulo_codigo]?.items || []).find(x => x.id === itemId);
    return { inst, it, r: respuestaDe(inst.id, itemId) };
  }
  const editable = () => P.doc.rel.estado !== 'cerrado';

  async function onClick(e) {
    const el = e.target.closest('[data-a]');
    if (!el || !P) return;
    const a = el.dataset.a, v = el.dataset.v;
    if (a === 'cerrar') return cerrar();
    if (a === 'vista') { P.vista = v; P.confirmar = null; P.eligiendo = null; return pintar(); }
    if (['inicio'].includes(a)) { P.vista = 'inicio'; return pintar(); }
    if (a === 'inst') { P.instId = el.dataset.id; P.vista = 'instancia'; P.confirmar = null; P._vistaAnterior = null; pintar(); document.querySelector('#modal-planillas .pl-body')?.scrollTo(0, 0); return; }
    if (a === 'foto-ver') return abrirVisor(el.dataset.ft, el.dataset.fid, el.dataset.foto);
    if (!editable() && !['ver-todos'].includes(a)) { toast('El relevamiento está cerrado', 'info'); return; }
    if (a === 'nivel') { P.doc.rel.nivel = v; guardar(); return pintar(); }
    if (a === 'plantilla') {
      const pl = P.cat.plantillas.find(p => String(p.id) === v);
      if (pl) { aplicarPlantilla(pl); guardar(); P.vista = 'inicio'; pintar(); }
      return;
    }
    if (a === 'elegir-volver') { P.eligiendo = null; return pintar(); }
    if (a === 'add-mod' || a === 'add-nueva') {
      const presentes = new Set(P.doc.instancias.map(i => i.modulo_codigo + '|' + (i.etiqueta || '').toLowerCase()));
      const hayConocidas = (P.ctx.instancias_conocidas || []).some(k => k.modulo_codigo === v && !presentes.has(v + '|' + (k.etiqueta || '').toLowerCase()));
      if (a === 'add-mod' && P.mod[v]?.repetible && hayConocidas) { P.eligiendo = v; return pintar(); }
      P.eligiendo = null;
      const inst = agregarInstancia(v);
      guardar(); P.instId = inst.id; P.vista = 'instancia'; return pintar();
    }
    if (a === 'add-conocida') {
      const k = P._conocidas?.[Number(v)];
      if (k) { P.eligiendo = null; const inst = agregarInstancia(k.modulo_codigo, k.etiqueta, k.datos); guardar(); P.instId = inst.id; P.vista = 'instancia'; pintar(); }
      return;
    }
    if (a === 'seguimiento') {
      const id = Number(el.dataset.id);
      P.doc.seguimientos = P.doc.seguimientos || [];
      let s = P.doc.seguimientos.find(x => x.accion_id === id);
      // Marcado a mano: deja de ser automático y ya no lo cambia el chequeo del ítem.
      if (s && s.resultado === v) P.doc.seguimientos = P.doc.seguimientos.filter(x => x !== s);
      else if (s) { s.resultado = v; s.auto = false; }
      else P.doc.seguimientos.push({ id: uuid(), accion_id: id, resultado: v, comentario: '' });
      guardar(); return pintar();
    }
    if (a === 'act') {
      const id = Number(el.dataset.id);
      const obs = P.doc.rel.actividades_observadas;
      const i = obs.findIndex(o => o.actividad_id === id);
      if (i >= 0) obs.splice(i, 1); else obs.push({ actividad_id: id, texto: P.ctx.actividades.find(x => x.id === id)?.actividad });
      guardar(); return pintar();
    }
    if (a === 'act-quitar') { P.doc.rel.actividades_observadas = P.doc.rel.actividades_observadas.filter(o => o.actividad_id || o.texto !== v); guardar(); return pintar(); }
    if (a === 'act-nueva') {
      const t = document.getElementById('pl-act-nueva')?.value.trim();
      if (!t) return;
      const reg = (P.ctx.actividades || []).find(x => x.actividad.toLowerCase() === t.toLowerCase());
      const obs = P.doc.rel.actividades_observadas;
      if (reg) { if (!obs.some(o => o.actividad_id === reg.id)) obs.push({ actividad_id: reg.id, texto: reg.actividad }); }
      else if (!obs.some(o => !o.actividad_id && o.texto.toLowerCase() === t.toLowerCase())) obs.push({ texto: t });
      guardar(); return pintar();
    }
    if (a === 'gps') {
      const inst = P.doc.instancias.find(i => i.id === P.instId);
      if (!navigator.geolocation) return toast('Esta tablet no tiene GPS disponible', 'error');
      toast('Buscando ubicación…', 'info', 2000);
      navigator.geolocation.getCurrentPosition(pos => {
        inst.datos[el.dataset.k] = { lat: pos.coords.latitude, lng: pos.coords.longitude, precision: pos.coords.accuracy, hora: new Date().toISOString() };
        guardar(); pintar();
      }, () => toast('No se pudo obtener la ubicación. Revisá que el GPS esté activado.', 'error', 5000), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
      return;
    }
    if (a === 'res' || a === 'crit') {
      const t = tarjetaDe(el);
      if (!t) return;
      let r = t.r;
      if (a === 'res') {
        // Tocar de nuevo la misma opción la desmarca (en ítems del catálogo; los agregados en el campo se quitan con "Quitar").
        if (r && r.resultado === v && t.it) {
          P.doc.respuestas = P.doc.respuestas.filter(x => x !== r);
          seguimientoAutomatico(t.inst, t.it.id, null);
          guardar(); return pintar();
        }
        if (r && r.resultado === v) return;
        if (!r) {
          r = { id: uuid(), instancia_id: t.inst.id, item_id: t.it.id, item_codigo: t.it.codigo, item_texto: t.it.texto, item_ref: t.it.ref_normativa,
            item_tipo: t.it.tipo, criticidad: t.it.criticidad, observacion: '', medida: '', plazo: '', fotos: [] };
          P.doc.respuestas.push(r);
        }
        r.resultado = v;
        r.respondido_en = new Date().toISOString();
        if (v === 'NC') {
          if (!r.medida && t.it?.medida_sugerida) r.medida = t.it.medida_sugerida;
          if (!r.plazo) r.plazo = plazoSugerido(Number(r.criticidad || 2), String(P.doc.rel.iniciado_en || '').slice(0, 10) || hoy());
        }
        if (t.it?.id) seguimientoAutomatico(t.inst, t.it.id, v);
      } else {
        r.criticidad = Number(v);
        r.plazo = plazoSugerido(r.criticidad, String(P.doc.rel.iniciado_en || '').slice(0, 10) || hoy());
      }
      guardar(); return pintar();
    }
    if (a === 'libre') {
      const txt = document.getElementById('pl-libre-txt')?.value.trim();
      if (!txt) return toast('Escribí qué se controla', 'error');
      P.doc.respuestas.push({ id: uuid(), instancia_id: P.instId, item_id: null, item_codigo: null, item_texto: txt, item_ref: '', item_tipo: null,
        resultado: 'NC', criticidad: 2, observacion: '', medida: '', plazo: plazoSugerido(2, String(P.doc.rel.iniciado_en || '').slice(0, 10) || hoy()),
        fotos: [], respondido_en: new Date().toISOString(), proponer_catalogo: !!document.getElementById('pl-libre-prop')?.checked });
      guardar(); return pintar();
    }
    if (a === 'libre-quitar') { const t = tarjetaDe(el); if (t?.r) { P.doc.respuestas = P.doc.respuestas.filter(x => x !== t.r); guardar(); pintar(); } return; }
    if (a === 'ver-todos') { P.verTodos = !P.verTodos; return pintar(); }
    if (a === 'pendientes-nv') {
      const inst = P.doc.instancias.find(i => i.id === P.instId);
      const { cat } = itemsVisibles(inst);
      for (const it of cat) if (!respuestaDe(inst.id, it.id)) P.doc.respuestas.push({ id: uuid(), instancia_id: inst.id, item_id: it.id, item_codigo: it.codigo, item_texto: it.texto,
        item_ref: it.ref_normativa, item_tipo: it.tipo, resultado: 'NV', criticidad: it.criticidad, observacion: '', medida: '', plazo: '', fotos: [], respondido_en: new Date().toISOString() });
      guardar(); return pintar();
    }
    if (a === 'quitar') { P.confirmar = 'quitar'; return pintar(); }
    if (a === 'quitar-no') { P.confirmar = null; return pintar(); }
    if (a === 'quitar-si') {
      P.doc.respuestas = P.doc.respuestas.filter(r => r.instancia_id !== P.instId);
      P.doc.instancias = P.doc.instancias.filter(i => i.id !== P.instId);
      P.confirmar = null; P.vista = 'inicio'; guardar(); return pintar();
    }
    if (a === 'cerrar-rel') { P.confirmar = 'cerrar-rel'; return pintar(); }
    if (a === 'cerrar-rel-si') { P.doc.rel.estado = 'cerrado'; P.confirmar = null; guardar(); toast('Relevamiento cerrado', 'success'); return pintar(); }
  }

  function onInput(e) {
    const el = e.target;
    const f = el.dataset?.f;
    if (!f || !P || !editable()) return;
    if (f === 'dato') {
      const inst = P.doc.instancias.find(i => i.id === P.instId);
      let val = el.value;
      if (el.tagName === 'SELECT' && (val === 'si' || val === 'no')) val = val === 'si';
      if (el.type === 'number') val = val === '' ? '' : Number(val);
      inst.datos[el.dataset.k] = val;
      if (el.dataset.k === 'nombre') inst.etiqueta = String(el.value).trim() || '';
      return guardar();
    }
    if (f === 'seg-com') {
      const s = (P.doc.seguimientos || []).find(x => x.accion_id === Number(el.dataset.id));
      if (s) { s.comentario = el.value; guardar(); }
      return;
    }
    if (['observacion', 'medida', 'plazo'].includes(f)) {
      const t = tarjetaDe(el);
      if (t?.r) { t.r[f] = el.value; guardar(); }
    }
  }

  async function onChange(e) {
    const el = e.target;
    if (el.dataset?.f === 'dato' && el.tagName === 'SELECT') return onInput(e);
    if (el.dataset?.f !== 'foto' || !P || !editable()) return;
    const lista = listaFotos(el.dataset.ft, el.dataset.fid);
    const file = el.files?.[0];
    if (!lista || !file) return;
    if (lista.length >= 20) return toast('Máximo 20 fotos por ítem', 'error');
    try {
      const data_url = await comprimir(file);
      const id = uuid();
      await ARStorage.set('chk_foto_' + id, { id, rel_id: P.doc.rel.id, data_url, subida: false });
      lista.push(id);
      guardar(); pintar();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ── integración con la constancia ───────────────────────────────────────
  async function docDe(o) {
    const id = await ARStorage.get(claveIdx(o.visitaId, o.constanciaId, o.destinoId));
    return id ? ARStorage.get('chk_rel_' + id) : null;
  }

  // Para el paso "Planillas" de la constancia.
  async function resumenParaConstancia(o) {
    let doc = await docDe(o);
    if (!doc && online() && o.visitaId) doc = await buscarEnServidor(o.visitaId, o.destinoId);
    if (!doc) return null;
    const cat = await ARStorage.get('chk_catalogo');
    const nombres = Object.fromEntries((cat?.modulos || []).map(m => [m.codigo, m.nombre]));
    const r = resumir(doc.respuestas);
    return { ...r, modulos: doc.instancias.map(i => (nombres[i.modulo_codigo] || i.modulo_codigo) + (i.etiqueta ? ' · ' + i.etiqueta : '')),
      pendiente: !!doc._dirty, error: doc._error || null, estado: doc.rel.estado };
  }

  // Hallazgos convertidos al formato de desvío de la constancia.
  async function desviosParaConstancia(o) {
    const doc = await docDe(o);
    if (!doc) return [];
    const cat = await ARStorage.get('chk_catalogo');
    const nombres = Object.fromEntries((cat?.modulos || []).map(m => [m.codigo, m.nombre]));
    const instPor = Object.fromEntries(doc.instancias.map(i => [i.id, i]));
    const out = [];
    for (const r of doc.respuestas.filter(x => x.resultado === 'NC').sort((a, b) => a.criticidad - b.criticidad)) {
      const inst = instPor[r.instancia_id] || {};
      const fotos = await fotosDe(r);
      const c = Number(r.criticidad);
      out.push({
        chk_respuesta_id: r.id,
        titulo: r.item_texto.length > 120 ? r.item_texto.slice(0, 117) + '…' : r.item_texto,
        severidad: c === 1 ? 'ALTA' : c === 2 ? 'MEDIA' : 'BAJA',
        estado: 'pendiente',
        normativa_incumplida: r.item_ref || '',
        descripcion: [(nombres[inst.modulo_codigo] || inst.modulo_codigo) + (inst.etiqueta ? ' · ' + inst.etiqueta : ''), r.observacion,
          (r.fotos || []).length > 2 ? `(${r.fotos.length - 2} foto(s) más en el informe)` : ''].filter(Boolean).join(' — '),
        accion_correctiva: r.medida || '',
        plazo: c === 1 ? 'Inmediato' : r.plazo ? fmtFecha(r.plazo) : '',
        foto_1: fotos[0] || null, foto_2: fotos[1] || null,
      });
    }
    return out;
  }

  // ── Dirección: propuestas al catálogo y carga masiva de actividades ──────
  const COLS_ACT = ['Establecimiento', 'Actividad', 'Rubro', 'Frecuencia', 'Meses', 'Trabajadores', 'Contratista', 'Módulo sugerido', 'Observaciones'];
  async function abrirAdmin() {
    inyectarEstilos();
    const m = contenedor();
    m.classList.add('abierto');
    A = { propuestas: [], filas: null, resultado: null, cargando: true };
    P = null;
    pintarAdmin();
    try { A.propuestas = await api('/planillas/catalogo/propuestas'); } catch (e) { toast(e.message, 'error'); }
    A.cargando = false;
    pintarAdmin();
  }

  function pintarAdmin() {
    const m = contenedor();
    let h = `<div class="pl-top"><button class="pl-back" data-adm="salir">←</button><div class="t"><b>Planillas · Dirección</b><span>Catálogo y actividades de los establecimientos</span></div></div><div class="pl-body">`;
    h += `<div class="pl-sec">Ítems propuestos por los técnicos (${A.propuestas.length})</div>`;
    if (A.cargando) h += '<div class="pl-card">Cargando…</div>';
    else if (!A.propuestas.length) h += '<div class="pl-card" style="color:var(--text2)">No hay propuestas pendientes.</div>';
    for (const p of A.propuestas) {
      h += `<div class="pl-card" data-prop="${p.id}"><div style="font-size:12px;color:var(--text2)">${esc(p.modulo_nombre)} · propuesto por ${esc(p.propuesto_por_nombre || '—')} el ${fmtFecha(p.creado_en)}</div>
        <textarea class="pl-in" data-pf="texto" style="margin-top:6px">${esc(p.texto)}</textarea>
        <input class="pl-in" data-pf="ref_normativa" style="margin-top:6px" placeholder="Referencia normativa (verificada)" value="${esc(p.ref_normativa === 'A definir' ? '' : p.ref_normativa)}">
        <div class="pl-grid2" style="margin-top:6px">
          <select class="pl-in" data-pf="tipo">${Object.entries(TIPO).map(([k, t]) => `<option value="${k}" ${p.tipo === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select class="pl-in" data-pf="criticidad">${[1, 2, 3].map(c => `<option value="${c}" ${p.criticidad === c ? 'selected' : ''}>${CRIT[c]}</option>`).join('')}</select>
          <select class="pl-in" data-pf="nivel">${Object.entries(NIVELES).map(([k, t]) => `<option value="${k}" ${p.nivel === k ? 'selected' : ''}>Nivel ${t}</option>`).join('')}</select>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-success btn-sm" data-adm="aprobar">Aprobar y sumar al catálogo</button><button class="btn btn-secondary btn-sm" data-adm="rechazar">Descartar</button></div></div>`;
    }
    h += `<div class="pl-sec">Actividades de los establecimientos: carga masiva</div>
      <div class="pl-card"><div style="font-size:14px;margin-bottom:8px">Cargá en una planilla Excel todas las actividades de cada establecimiento, incluidas las estacionales y eventuales (vacunación, cosecha, fumigación, contratistas). Así en cada visita el técnico ve qué hay que controlar y nada queda afuera.</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">El establecimiento se identifica por su número (hoja "Establecimientos" de la plantilla), el id del CRM o el nombre exacto. Si la actividad ya existe, se actualiza.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" data-adm="plantilla">📄 Bajar plantilla</button>
      <label class="btn btn-primary btn-sm" style="cursor:pointer">📂 Elegir Excel<input type="file" accept=".xlsx,.xls" hidden data-adm-file="1"></label></div>`;
    if (A.filas) {
      h += `<div style="margin-top:12px;font-size:14px">${A.filas.length} fila(s) leídas.</div>
        <div style="overflow-x:auto;margin-top:6px"><table class="pl-tabla"><tr>${COLS_ACT.slice(0, 5).map(c => `<th>${c}</th>`).join('')}</tr>
        ${A.filas.slice(0, 8).map(f => `<tr>${['establecimiento', 'actividad', 'rubro', 'frecuencia', 'meses'].map(k => `<td>${esc(f[k] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
        ${A.filas.length > 8 ? `<div style="font-size:12px;color:var(--text2)">… y ${A.filas.length - 8} más</div>` : ''}
        <button class="btn btn-primary btn-sm" style="margin-top:10px" data-adm="importar">Importar ${A.filas.length} fila(s)</button>`;
    }
    if (A.resultado) {
      const r = A.resultado;
      h += `<div style="margin-top:12px;font-size:14px"><b style="color:var(--green)">${r.nuevas} nuevas</b> · ${r.actualizadas} actualizadas · <b style="color:${r.errores ? 'var(--red)' : 'var(--text2)'}">${r.errores} con error</b></div>
        ${r.resultado.filter(x => !x.ok).map(x => `<div style="font-size:13px;color:var(--red)">Fila ${x.fila}: ${esc(x.error)}</div>`).join('')}`;
    }
    h += `</div><div class="pl-sec">Catálogo base</div><div class="pl-card"><div style="font-size:13px;margin-bottom:8px">Trae las correcciones del catálogo de EXIT que vengan con una actualización de la app. No pisa los ítems que Dirección editó ni los propios.</div>
      <button class="btn btn-secondary btn-sm" data-adm="base">Actualizar catálogo base</button></div></div>`;
    m.innerHTML = h;
  }

  async function descargarPlantillaActividades() {
    let destinos = [];
    try { destinos = await api('/config/destinos'); } catch (e) { /* la plantilla sale sin la hoja de referencia */ }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([COLS_ACT,
      ['12', 'Vacunación de hacienda', 'Ganadería', 'estacional', 'abr-may', 4, '', 'M4', 'Aftosa y brucelosis'],
      ['Estancia La Aurora', 'Fumigación de lotes', 'Agricultura', 'eventual', '', 2, 'Aplicaciones del Sur', 'M7', ''],
      ['12', 'Mantenimiento de molinos', 'General', 'permanente', '', 1, '', 'M19', '']]);
    ws['!cols'] = [{ wch: 26 }, { wch: 32 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Actividades');
    const ref = XLSX.utils.aoa_to_sheet([['N°', 'Establecimiento', 'Id CRM'], ...destinos.map(d => [d.id, d.nombre, d.crm_establecimiento_id || ''])]);
    ref['!cols'] = [{ wch: 6 }, { wch: 40 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, ref, 'Establecimientos');
    const mods = XLSX.utils.aoa_to_sheet([['Código', 'Módulo'], ...((await ARStorage.get('chk_catalogo'))?.modulos || []).map(m => [m.codigo, m.nombre]),
      [], ['Frecuencia: permanente, estacional o eventual']]);
    mods['!cols'] = [{ wch: 8 }, { wch: 44 }];
    XLSX.utils.book_append_sheet(wb, mods, 'Módulos');
    XLSX.writeFile(wb, 'Plantilla_Actividades_Establecimientos.xlsx');
  }

  async function leerExcelActividades(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets['Actividades'] || wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const cab = (filas[0] || []).map(norm);
    const col = n => cab.indexOf(norm(n));
    const claves = { establecimiento: 'Establecimiento', actividad: 'Actividad', rubro: 'Rubro', frecuencia: 'Frecuencia', meses: 'Meses',
      trabajadores: 'Trabajadores', contratista: 'Contratista', modulo_codigo: 'Módulo sugerido', observaciones: 'Observaciones' };
    if (col('Establecimiento') < 0 || col('Actividad') < 0) throw new Error('La planilla necesita las columnas "Establecimiento" y "Actividad". Usá la plantilla.');
    return filas.slice(1).map(r => Object.fromEntries(Object.entries(claves).map(([k, n]) => [k, col(n) >= 0 ? String(r[col(n)] ?? '').trim() : ''])))
      .filter(f => f.establecimiento || f.actividad);
  }

  async function onClickAdmin(e) {
    const el = e.target.closest('[data-adm]');
    if (!el || !A) return;
    const a = el.dataset.adm;
    if (a === 'salir') { contenedor().classList.remove('abierto'); A = null; return; }
    if (a === 'plantilla') return descargarPlantillaActividades();
    if (a === 'aprobar' || a === 'rechazar') {
      const card = el.closest('[data-prop]');
      const id = card.dataset.prop;
      const v = k => card.querySelector(`[data-pf="${k}"]`).value;
      try {
        if (a === 'aprobar') {
          if (!v('ref_normativa').trim()) return toast('Poné la referencia normativa (o "Buena práctica")', 'error');
          await api('/planillas/catalogo/propuestas/' + id + '/aprobar', { method: 'POST', body: JSON.stringify({ texto: v('texto'), ref_normativa: v('ref_normativa'), tipo: v('tipo'), criticidad: Number(v('criticidad')), nivel: v('nivel') }) });
          toast('Sumado al catálogo ✓', 'success');
        } else {
          await api('/planillas/catalogo/propuestas/' + id, { method: 'DELETE' });
          toast('Propuesta descartada', 'info');
        }
        A.propuestas = A.propuestas.filter(p => String(p.id) !== id);
        pintarAdmin();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (a === 'importar') {
      el.disabled = true;
      try {
        A.resultado = await api('/planillas/actividades/importar', { method: 'POST', body: JSON.stringify({ filas: A.filas }) });
        A.filas = null;
        toast('Actividades importadas', 'success');
      } catch (err) { toast(err.message, 'error'); el.disabled = false; }
      return pintarAdmin();
    }
    if (a === 'base') {
      try { await api('/planillas/catalogo/actualizar-base', { method: 'POST' }); await catalogo(); toast('Catálogo base actualizado ✓', 'success'); }
      catch (err) { toast(err.message, 'error'); }
    }
  }

  async function onChangeAdmin(e) {
    if (!A || !e.target.dataset?.admFile) return;
    const file = e.target.files?.[0];
    if (!file) return;
    try { A.filas = await leerExcelActividades(file); A.resultado = null; if (!A.filas.length) toast('La planilla no tiene filas', 'error'); }
    catch (err) { toast(err.message, 'error', 6000); }
    pintarAdmin();
  }

  global.Planillas = { abrir, cerrar, precargar, sincronizarPendientes, resumenParaConstancia, desviosParaConstancia, abrirAdmin, _resumir: resumir };
})(window);
