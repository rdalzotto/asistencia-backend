// viajes.js — Viajes: gastos con comprobante, km y adelantos (02/10/2026).
// Pantalla compartida por el empleado (ve y carga lo suyo) y el admin (ve
// todo, registra adelantos, revisa gastos, exporta a Excel). Los gastos se
// pueden cargar sin señal: quedan en ARStorage ('gasto_pendiente_') con un
// uuid y se envían solos al volver la conexión (el servidor no duplica).
// Usa de index.html: api, API, STATE, toast, escHtml, abrirModal, cerrarModal,
// fechaHoyAR, ARStorage, XLSX.
(function () {
  const CATEGORIAS = {
    combustible: '⛽ Combustible', peaje: '🛣️ Peaje', comida: '🍽️ Comida', alojamiento: '🏨 Alojamiento',
    pasajes: '🚌 Pasajes / transporte', inscripcion: '🎟️ Inscripción / entrada', estacionamiento: '🅿️ Estacionamiento', otros: '📦 Otros',
  };
  const SUBTIPOS = { congreso_expo: 'Congreso / expo', capacitacion_exit: 'Capacitación EXIT', capacitacion_externa: 'Capacitación externa', reunion: 'Reunión' };
  const TIPOS = { viaje: '🚗 Viaje', no_habil: '📅 Día no hábil', evento: '🎓 Evento', partida: '⏸️ Horario partido' };
  const REVISION = { pendiente: ['badge-gray', 'Sin revisar'], revisado: ['badge-green', 'Revisado'], observado: ['badge-orange', 'Observado'] };
  const PREFIJO = 'gasto_pendiente_';
  let actual = null; // { id, data }

  const $ = (id) => document.getElementById(id);
  // Vista de admin solo desde el panel de admin; desde "Mi jornada" un admin ve lo suyo.
  const esAdmin = () => STATE.rol === 'admin' && !!document.getElementById('screen-admin')?.classList.contains('active');
  const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const fecha = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));
  const sinConexion = (e) => e && (e.isNetworkError || !navigator.onLine || e instanceof TypeError);

  function asegurarModal() {
    if ($('modal-viaje')) return;
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal-overlay" id="modal-viaje" style="z-index:650">
        <div class="modal" style="max-width:560px;max-height:92vh;overflow-y:auto">
          <div class="modal-handle"></div>
          <div id="viaje-contenido"></div>
          <button class="btn btn-secondary" style="width:100%;margin-top:14px" onclick="cerrarModal('modal-viaje')">Cerrar</button>
        </div>
      </div>
      <div id="viaje-visor" onclick="this.style.display='none'" style="display:none;position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.92);align-items:center;justify-content:center;padding:16px">
        <img id="viaje-visor-img" style="max-width:100%;max-height:100%;border-radius:8px" alt="Comprobante">
      </div>`;
    while (div.firstChild) document.body.appendChild(div.firstChild);
  }

  // ── Lista "Mis viajes" (empleado) ───────────────────────────────────────
  async function abrirMios() {
    asegurarModal();
    $('viaje-contenido').innerHTML = '<div class="modal-title">🧳 Mis viajes y gastos</div><p style="color:var(--text3)">Cargando…</p>';
    abrirModal('modal-viaje');
    try {
      const lista = await api('/viajes/mios');
      const pend = await pendientes();
      $('viaje-contenido').innerHTML = `<div class="modal-title">🧳 Mis viajes y gastos</div>
        ${pend.length ? `<div style="font-size:12px;color:var(--orange);margin-bottom:10px">⏳ ${pend.length} gasto${pend.length > 1 ? 's' : ''} sin enviar — se mandan solos al volver la señal.</div>` : ''}
        ${lista.length ? lista.map(v => `
          <div onclick="Viajes.abrir(${v.id})" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;margin-bottom:8px;cursor:pointer;text-align:left">
            <div style="font-weight:600;font-size:14px">${TIPOS[v.tipo] || ''} ${escHtml(v.titulo)}</div>
            <div style="font-size:12px;color:var(--text2)">${fecha(v.mis_desde)}${v.mis_hasta !== v.mis_desde ? ' → ' + fecha(v.mis_hasta) : ''}${v.lugar ? ' · ' + escHtml(v.lugar) : ''}</div>
          </div>`).join('') : '<p style="color:var(--text3);font-size:13px">No tenés viajes en los últimos 90 días. Se arman solos al cargar una jornada especial.</p>'}`;
    } catch (e) { $('viaje-contenido').innerHTML = `<p style="color:var(--red)">${escHtml(e.message)}</p>`; }
  }

  // ── Detalle de un viaje ─────────────────────────────────────────────────
  async function abrir(id) {
    asegurarModal();
    abrirModal('modal-viaje');
    $('viaje-contenido').innerHTML = '<p style="color:var(--text3)">Cargando…</p>';
    try {
      const data = await api('/viajes/' + id);
      actual = { id, data };
      await render();
    } catch (e) { $('viaje-contenido').innerHTML = `<p style="color:var(--red)">${escHtml(e.message)}</p>`; }
  }

  async function recargar() { if (actual) await abrir(actual.id); }

  async function render() {
    const { viaje: v, participantes, gastos, adelantos, vehiculos, resumen } = actual.data;
    const admin = esAdmin();
    const pend = (await pendientes()).filter(p => p.viajeId === actual.id);
    const persona = (p) => {
      const saldo = p.saldo > 0 ? `<span style="color:var(--orange)">devuelve ${pesos(p.saldo)}</span>`
        : p.saldo < 0 ? `<span style="color:var(--green)">se le debe ${pesos(-p.saldo)}</span>` : 'saldo $0';
      return `<tr><td style="padding:4px 6px">${escHtml(p.nombre)}</td><td style="text-align:right;padding:4px 6px">${pesos(p.gastos)}</td>
        <td style="text-align:right;padding:4px 6px">${pesos(p.adelantos)}</td><td style="text-align:right;padding:4px 6px">${saldo}</td></tr>`;
    };
    const mio = resumen.por_persona.find(p => p.empleado_id === STATE.empleadoId);
    $('viaje-contenido').innerHTML = `
      <div class="modal-title" style="margin-bottom:4px">${TIPOS[v.tipo] || ''} ${escHtml(v.titulo)}</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:10px">
        ${fecha(v.desde)}${v.hasta !== v.desde ? ' → ' + fecha(v.hasta) : ''}${v.lugar ? ' · 📍 ' + escHtml(v.lugar) : ''}${v.subtipo ? ' · ' + SUBTIPOS[v.subtipo] : ''}<br>
        ${participantes.map(p => `${escHtml(p.nombre.trim())}: ${p.dias} día${p.dias > 1 ? 's' : ''}${p.desde !== p.hasta ? ' (' + fecha(p.desde) + ' → ' + fecha(p.hasta) + ')' : ''}`).join(' · ')}
      </div>

      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:10px;margin-bottom:12px;font-size:13px">
        ${admin ? `
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:6px">
            <b>Total gastos ${pesos(resumen.total)}</b><span>Adelantos ${pesos(resumen.total_adelantos)}</span><span>🚗 ${resumen.km} km</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:var(--text3)"><td style="padding:4px 6px">Persona</td><td style="text-align:right;padding:4px 6px">Gastos</td><td style="text-align:right;padding:4px 6px">Adelantos</td><td style="text-align:right;padding:4px 6px">Saldo</td></tr>
            ${resumen.por_persona.map(persona).join('')}</table>
          <div style="font-size:12px;color:var(--text2);margin-top:6px">${Object.entries(resumen.por_categoria).map(([k, m]) => (CATEGORIAS[k] || k) + ' ' + pesos(m)).join(' · ') || 'Sin gastos todavía'}</div>
          <button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="Viajes.excel()">📥 Excel</button>`
        : `
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
            <span>Mis gastos <b>${pesos(mio?.gastos)}</b></span><span>Adelanto ${pesos(mio?.adelantos)}</span><span>🚗 ${resumen.km} km</span>
          </div>
          <div style="margin-top:4px">${!mio || mio.saldo === 0 ? 'Saldo $0' : mio.saldo > 0 ? `<span style="color:var(--orange)">Tenés que devolver ${pesos(mio.saldo)}</span>` : `<span style="color:var(--green)">Se te debe ${pesos(-mio.saldo)}</span>`}</div>`}
      </div>

      <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="Viajes.formGasto()">💸 Cargar gasto</button>
      <div id="viaje-form-gasto"></div>

      <div style="font-size:13px;font-weight:600;color:var(--text2);margin:12px 0 6px">Gastos${admin ? '' : ' (los míos)'}</div>
      ${pend.map(p => `<div style="font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);color:var(--orange)">⏳ ${fecha(p.body.fecha)} · ${CATEGORIAS[p.body.categoria]} ${pesos(p.body.monto)} — sin enviar (falta señal)</div>`).join('')}
      ${gastos.length ? gastos.map(g => filaGasto(g, admin)).join('') : (pend.length ? '' : '<p style="color:var(--text3);font-size:13px">Todavía no hay gastos cargados.</p>')}

      ${admin ? `
        <div style="font-size:13px;font-weight:600;color:var(--text2);margin:16px 0 6px">Adelantos</div>
        ${adelantos.map(a => `<div style="display:flex;justify-content:space-between;gap:6px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${fecha(a.fecha)} · ${escHtml(a.nombre)} · <b>${pesos(a.monto)}</b> (${a.medio})${a.nota ? ' — ' + escHtml(a.nota) : ''}</span>
            <button class="btn btn-sm btn-secondary" style="padding:1px 8px;font-size:11px" onclick="Viajes.anularAdelanto(${a.id})">Anular</button></div>`).join('') || '<p style="color:var(--text3);font-size:13px">Sin adelantos.</p>'}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">
          <select id="ad-emp">${participantes.map(p => `<option value="${p.empleado_id}">${escHtml(p.nombre)}</option>`).join('')}</select>
          <input type="date" id="ad-fecha" value="${fechaHoyAR()}">
          <input type="number" id="ad-monto" placeholder="Monto $" min="0" step="0.01">
          <select id="ad-medio"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option><option value="otro">Otro</option></select>
        </div>
        <input type="text" id="ad-nota" placeholder="Nota (opcional)" style="width:100%;margin-top:6px">
        <button class="btn btn-sm btn-secondary" style="margin-top:6px" onclick="Viajes.guardarAdelanto()">+ Registrar adelanto</button>` : (adelantos.length ? `
        <div style="font-size:13px;font-weight:600;color:var(--text2);margin:16px 0 6px">Adelantos recibidos</div>
        ${adelantos.map(a => `<div style="font-size:13px;padding:4px 0">${fecha(a.fecha)} · <b>${pesos(a.monto)}</b> (${a.medio})${a.nota ? ' — ' + escHtml(a.nota) : ''}</div>`).join('')}` : '')}

      <div style="font-size:13px;font-weight:600;color:var(--text2);margin:16px 0 6px">🚗 Kilómetros</div>
      ${vehiculos.map(x => `<div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;align-items:center;margin-bottom:6px">
          <input type="text" value="${escHtml(x.vehiculo)}" id="veh-n-${x.id}">
          <input type="number" value="${x.odometro_salida ?? ''}" placeholder="Salida" id="veh-s-${x.id}">
          <input type="number" value="${x.odometro_llegada ?? ''}" placeholder="Llegada" id="veh-l-${x.id}">
          <button class="btn btn-sm btn-secondary" style="padding:4px 8px" onclick="Viajes.guardarVehiculo(${x.id})">✓</button>
        </div>
        <div style="font-size:11px;color:var(--text3);margin:-2px 0 8px">${x.odometro_salida != null && x.odometro_llegada != null ? (Number(x.odometro_llegada) - Number(x.odometro_salida)).toFixed(1) + ' km recorridos' : 'Cargá el odómetro al volver'}</div>`).join('')}
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;align-items:center">
        <input type="text" id="veh-n-nuevo" placeholder="Vehículo (ej. Hilux AB123CD)">
        <input type="number" id="veh-s-nuevo" placeholder="Odómetro salida">
        <input type="number" id="veh-l-nuevo" placeholder="Llegada">
        <button class="btn btn-sm btn-secondary" style="padding:4px 8px" onclick="Viajes.guardarVehiculo()">+</button>
      </div>`;
  }

  function filaGasto(g, admin) {
    const [cls, txt] = REVISION[g.revision] || REVISION.pendiente;
    const propio = g.empleado_id === STATE.empleadoId;
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
      <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;flex-wrap:wrap">
        <span>${fecha(g.fecha)} · ${CATEGORIAS[g.categoria] || g.categoria} · <b>${pesos(g.monto)}</b>${admin ? ' · ' + escHtml(g.nombre.trim()) : ''}</span>
        <span class="badge ${cls}">${txt}</span>
      </div>
      ${g.descripcion ? `<div style="color:var(--text2)">${escHtml(g.descripcion)}</div>` : ''}
      ${g.revision === 'observado' && g.revision_motivo ? `<div style="color:var(--orange)">⚠ ${escHtml(g.revision_motivo)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
        ${g.tiene_comprobante ? `<button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px" onclick="Viajes.verComprobante(${g.id}, '${g.comprobante_mime}')">📎 Comprobante</button>` : '<span style="font-size:11px;color:var(--text3)">Sin comprobante</span>'}
        ${admin && !propio ? `<button class="btn btn-sm btn-success" style="padding:2px 8px;font-size:11px" onclick="Viajes.revisar(${g.id}, 'revisado')">✓ Revisado</button>
          <button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px" onclick="Viajes.revisar(${g.id}, 'observado')">⚠ Observar</button>` : ''}
        ${admin || (propio && g.revision !== 'revisado') ? `<button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px" onclick="Viajes.anularGasto(${g.id})">Anular</button>` : ''}
      </div></div>`;
  }

  // ── Formulario de gasto ─────────────────────────────────────────────────
  function formGasto() {
    const { viaje: v, participantes } = actual.data;
    const hoy = fechaHoyAR();
    const def = hoy >= v.desde && hoy <= v.hasta ? hoy : v.desde;
    const admin = esAdmin();
    $('viaje-form-gasto').innerHTML = `
      <div style="border:1px solid var(--accent);border-radius:var(--radius-sm);padding:10px;margin-bottom:10px">
        ${admin ? `<select id="g-emp" style="width:100%;margin-bottom:6px">${participantes.map(p => `<option value="${p.empleado_id}">A nombre de ${escHtml(p.nombre)}</option>`).join('')}</select>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <input type="date" id="g-fecha" value="${def}">
          <input type="number" id="g-monto" placeholder="Monto $" min="0" step="0.01" inputmode="decimal">
        </div>
        <select id="g-cat" style="width:100%;margin-top:6px">${Object.entries(CATEGORIAS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select>
        <input type="text" id="g-nota" placeholder="Nota (ej. YPF Zárate, almuerzo con el equipo)" style="width:100%;margin-top:6px">
        <div style="margin-top:8px;font-size:13px;color:var(--text2)">Comprobante: foto o PDF</div>
        <input type="file" id="g-archivo" accept="image/*,application/pdf" style="width:100%;margin-top:4px;color:var(--text)">
        <div onclick="if (event.target.tagName !== 'INPUT') { const c = document.getElementById('g-sin'); c.checked = !c.checked; }" style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:13px;cursor:pointer;color:var(--text1)">
          <input type="checkbox" id="g-sin" style="width:auto"> Gasto menor sin comprobante (contá qué fue en la nota)
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('viaje-form-gasto').innerHTML=''">Cancelar</button>
          <button class="btn btn-primary" style="flex:1" id="g-guardar" onclick="Viajes.guardarGasto()">Guardar gasto</button>
        </div>
      </div>`;
  }

  function comprimir(file, max = 1600, calidad = 0.7) {
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
  const leerDataUrl = (file) => new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => mal(new Error('No se pudo leer el archivo')); r.readAsDataURL(file); });

  async function guardarGasto() {
    const btn = $('g-guardar');
    const file = $('g-archivo').files[0];
    const sin = $('g-sin').checked;
    const body = {
      uuid: uuid(), fecha: $('g-fecha').value, categoria: $('g-cat').value,
      monto: parseFloat($('g-monto').value), descripcion: $('g-nota').value.trim(), sin_comprobante: sin,
    };
    if ($('g-emp')) body.empleado_id = parseInt($('g-emp').value);
    if (!(body.monto > 0)) return toast('Poné el monto', 'error');
    if (!sin && !file) return toast('Adjuntá la foto del comprobante o marcá "sin comprobante"', 'error', 6000);
    if (sin && body.descripcion.length < 3) return toast('Sin comprobante, contá en la nota qué fue', 'error');
    btn.disabled = true;
    try {
      if (file && !sin) {
        if (file.type === 'application/pdf') {
          if (file.size > 8 * 1024 * 1024) { toast('El PDF supera los 8 MB', 'error'); return; }
          body.comprobante = await leerDataUrl(file);
        } else {
          body.comprobante = await comprimir(file);
        }
      }
      try {
        await api(`/viajes/${actual.id}/gastos`, { method: 'POST', body: JSON.stringify(body) });
        toast('Gasto cargado ✓', 'success');
      } catch (e) {
        if (!sinConexion(e)) throw e;
        await ARStorage.set(PREFIJO + body.uuid, { viajeId: actual.id, body });
        toast('📴 Sin señal — el gasto quedó guardado en el teléfono y se envía solo al volver la conexión', 'info', 6000);
      }
      await recargar();
    } catch (e) { toast(e.message || 'No se pudo guardar', 'error', 7000); }
    finally { if ($('g-guardar')) $('g-guardar').disabled = false; }
  }

  async function pendientes() {
    try {
      const keys = await ARStorage.keys(PREFIJO);
      const out = [];
      for (const k of keys) { const x = await ARStorage.get(k); if (x) out.push({ ...x, key: k }); }
      return out;
    } catch { return []; }
  }

  // Envía los gastos que quedaron guardados sin señal (lo llama sincronizarTodoPendiente).
  async function sincronizarPendientes() {
    for (const p of await pendientes()) {
      try {
        await api(`/viajes/${p.viajeId}/gastos`, { method: 'POST', body: JSON.stringify(p.body) });
        await ARStorage.del(p.key);
      } catch (e) {
        if (sinConexion(e)) break;
        await ARStorage.del(p.key);
        toast('⚠ Un gasto guardado sin señal no se pudo enviar: ' + e.message, 'error', 8000);
      }
    }
  }

  async function verComprobante(gid, mime) {
    try {
      const r = await fetch(`${API}/viajes/${actual.id}/gastos/${gid}/comprobante`, { headers: { Authorization: 'Bearer ' + STATE.token } });
      if (!r.ok) throw new Error('No se pudo abrir el comprobante');
      const url = URL.createObjectURL(await r.blob());
      if (String(mime).startsWith('image/')) { $('viaje-visor-img').src = url; $('viaje-visor').style.display = 'flex'; }
      else window.open(url, '_blank');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function anularGasto(gid) {
    if (!confirm('¿Anular este gasto? Queda registrado como anulado.')) return;
    try { await api(`/viajes/${actual.id}/gastos/${gid}/anular`, { method: 'POST', body: '{}' }); await recargar(); }
    catch (e) { toast(e.message, 'error', 7000); }
  }

  async function revisar(gid, revision) {
    let motivo = null;
    if (revision === 'observado') {
      motivo = prompt('¿Qué se observa del gasto? (le llega al empleado)');
      if (!motivo) return;
    }
    try { await api(`/viajes/${actual.id}/gastos/${gid}/revisar`, { method: 'POST', body: JSON.stringify({ revision, motivo }) }); await recargar(); }
    catch (e) { toast(e.message, 'error', 7000); }
  }

  async function guardarAdelanto() {
    const body = { empleado_id: parseInt($('ad-emp').value), fecha: $('ad-fecha').value, monto: parseFloat($('ad-monto').value), medio: $('ad-medio').value, nota: $('ad-nota').value.trim() };
    if (!(body.monto > 0)) return toast('Poné el monto del adelanto', 'error');
    try { await api(`/viajes/${actual.id}/adelantos`, { method: 'POST', body: JSON.stringify(body) }); toast('Adelanto registrado ✓ — se le avisó al empleado', 'success'); await recargar(); }
    catch (e) { toast(e.message, 'error', 7000); }
  }

  async function anularAdelanto(aid) {
    if (!confirm('¿Anular este adelanto?')) return;
    try { await api(`/viajes/${actual.id}/adelantos/${aid}/anular`, { method: 'POST', body: '{}' }); await recargar(); }
    catch (e) { toast(e.message, 'error', 7000); }
  }

  async function guardarVehiculo(id) {
    const k = id || 'nuevo';
    const body = { id: id || undefined, vehiculo: $('veh-n-' + k).value.trim(), odometro_salida: $('veh-s-' + k).value, odometro_llegada: $('veh-l-' + k).value };
    try { await api(`/viajes/${actual.id}/vehiculos`, { method: 'POST', body: JSON.stringify(body) }); toast('Kilómetros guardados ✓', 'success'); await recargar(); }
    catch (e) { toast(e.message, 'error', 7000); }
  }

  // ── Excel para Andrea ───────────────────────────────────────────────────
  function excel() {
    const { viaje: v, gastos, adelantos, vehiculos, resumen } = actual.data;
    const wb = XLSX.utils.book_new();
    const res = [
      ['Viaje', v.titulo], ['Fechas', fecha(v.desde) + (v.hasta !== v.desde ? ' a ' + fecha(v.hasta) : '')], ['Lugar', v.lugar || ''],
      ['Total gastos', resumen.total], ['Total adelantos', resumen.total_adelantos], ['Km', resumen.km], [],
      ['Persona', 'Gastos', 'Con comprobante', 'Sin comprobante', 'Adelantos', 'Saldo (+ devuelve / − se le debe)'],
      ...resumen.por_persona.map(p => [p.nombre, p.gastos, p.con_comprobante, p.sin_comprobante, p.adelantos, p.saldo]), [],
      ['Categoría', 'Total'], ...Object.entries(resumen.por_categoria).map(([k, m]) => [CATEGORIAS[k].replace(/^\S+\s/, ''), m]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(res), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Persona', 'Categoría', 'Monto', 'Nota', 'Comprobante', 'Revisión', 'Observación'],
      ...gastos.map(g => [fecha(g.fecha), g.nombre.trim(), CATEGORIAS[g.categoria].replace(/^\S+\s/, ''), Number(g.monto), g.descripcion || '', g.tiene_comprobante ? 'Sí' : 'No', g.revision, g.revision_motivo || '']),
    ]), 'Gastos');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Persona', 'Monto', 'Medio', 'Nota'], ...adelantos.map(a => [fecha(a.fecha), a.nombre.trim(), Number(a.monto), a.medio, a.nota || '']),
    ]), 'Adelantos');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Vehículo', 'Odómetro salida', 'Odómetro llegada', 'Km'],
      ...vehiculos.map(x => [x.vehiculo, x.odometro_salida, x.odometro_llegada, x.odometro_salida != null && x.odometro_llegada != null ? Number(x.odometro_llegada) - Number(x.odometro_salida) : '']),
    ]), 'Km');
    XLSX.writeFile(wb, `Viaje_${v.desde}_${v.titulo.replace(/[^\w]+/g, '_').slice(0, 40)}.xlsx`);
  }

  // ── Lista para el admin (Reportes → Viajes y gastos) ────────────────────
  async function cargarListaAdmin(contId) {
    const cont = $(contId);
    if (!cont) return;
    const desde = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    try {
      const lista = await api('/viajes?desde=' + desde);
      cont.innerHTML = lista.length ? lista.map(v => `
        <div onclick="Viajes.abrir(${v.id})" style="padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:600">${TIPOS[v.tipo] || ''} ${escHtml(v.titulo)}</span>
            ${v.sin_revisar ? `<span class="badge badge-orange">${v.sin_revisar} sin revisar</span>` : ''}
          </div>
          <div style="font-size:12px;color:var(--text2)">${fecha(v.desde)}${v.hasta !== v.desde ? ' → ' + fecha(v.hasta) : ''} · ${v.personas} persona${v.personas > 1 ? 's' : ''} · gastos ${pesos(v.gastos)} · adelantos ${pesos(v.adelantos)}${Number(v.km) ? ' · ' + Number(v.km) + ' km' : ''}</div>
        </div>`).join('') : '<p style="color:var(--text3);font-size:13px">No hay viajes en los últimos 4 meses.</p>';
    } catch (e) { cont.innerHTML = '<p style="color:var(--red);font-size:13px">No se pudo cargar la lista de viajes</p>'; }
  }

  window.Viajes = { abrirMios, abrir, formGasto, guardarGasto, sincronizarPendientes, verComprobante, anularGasto, revisar, guardarAdelanto, anularAdelanto, guardarVehiculo, excel, cargarListaAdmin };
})();
