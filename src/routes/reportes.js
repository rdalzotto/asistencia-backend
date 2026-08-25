const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push    = require('../services/pushService');

// ─── GET /reportes/mensual ────────────────────────────────────────────────────
// Reporte mensual por empleado (detalle día por día + totales)
router.get('/mensual', auth, async (req, res) => {
  const { empleado_id, anio, mes } = req.query;
  if (!anio || !mes) return res.status(400).json({ error: 'Anio y mes requeridos' });

  const eId = req.user.rol === 'empleado' ? req.user.empleadoId : empleado_id;
  if (!eId) return res.status(400).json({ error: 'empleado_id requerido' });

  try {
    const reporte = await construirReporteMensual(eId, req.user.empleadorId, anio, mes);
    if (!reporte) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(reporte);
  } catch (err) {
    console.error('[REP] Mensual error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── Construye el reporte mensual completo de un empleado ────────────────────
// Extraída como función independiente para que tanto GET /mensual (vista en
// vivo) como POST /mensual/firmar (snapshot legal firmado) usen exactamente
// la misma lógica de cálculo — así lo que se firma es siempre idéntico a lo
// que se vio en pantalla antes de firmar.
async function construirReporteMensual(eId, empleadorId, anio, mes) {
  // Datos del empleado
  const { rows: [emp] } = await db.query(`
    SELECT e.*, u.email,
      jc.hora_ingreso, jc.hora_egreso, jc.modalidad, jc.horas_diarias_objetivo,
      jc.incluye_almuerzo, jc.hora_almuerzo_inicio, jc.hora_almuerzo_fin,
      emp2.razon_social, emp2.cuit, emp2.domicilio as emp_domicilio,
      emp2.logo_url, emp2.nombre_fantasia,
      c.nombre as convenio_nombre, c.recargo_extra_habitual, c.recargo_extra_festivo
    FROM public.empleados e
    JOIN public.usuarios u ON u.id = e.usuario_id
    LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
    JOIN public.empleadores emp2 ON emp2.id = e.empleador_id
    LEFT JOIN public.convenios c ON c.id = emp2.convenio_id
    WHERE e.id = $1 AND e.empleador_id = $2
  `, [eId, empleadorId]);

  if (!emp) return null;

  // Movimientos del mes
  const { rows: movs } = await db.query(`
    SELECT m.*, cs.nombre as categoria_nombre, d.nombre as destino_nombre
    FROM public.movimientos m
    LEFT JOIN public.categorias_salida cs ON cs.id = m.categoria_salida_id
    LEFT JOIN public.destinos_externos d ON d.id = m.destino_id
    WHERE m.empleado_id = $1
      AND EXTRACT(YEAR FROM m.fecha) = $2
      AND EXTRACT(MONTH FROM m.fecha) = $3
    ORDER BY m.hora ASC
  `, [eId, anio, mes]);

  // Ausencias del mes
  const { rows: ausencias } = await db.query(`
    SELECT * FROM public.ausencias
    WHERE empleado_id = $1
      AND estado = 'aprobada'
      AND EXTRACT(YEAR FROM fecha_inicio) = $2
      AND EXTRACT(MONTH FROM fecha_inicio) = $3
  `, [eId, anio, mes]);

  // Banco de horas del mes
  const { rows: [bh] } = await db.query(`
    SELECT * FROM public.banco_horas
    WHERE empleado_id = $1 AND anio = $2 AND mes = $3
  `, [eId, anio, mes]);

  // Saldo acumulado de banco de horas HASTA este mes inclusive (no el total a
  // hoy — el reporte es de un período pasado, así que el saldo debe reflejar
  // el acumulado hasta el cierre de ese mes, no incluir meses posteriores).
  const diasEnMesCalc = new Date(anio, mes, 0).getDate();
  const finDeMes = `${anio}-${String(mes).padStart(2,'0')}-${String(diasEnMesCalc).padStart(2,'0')}`;
  const { rows: [saldoBrutoRow] } = await db.query(`
    SELECT COALESCE(SUM(balance), 0) as saldo_bruto
    FROM public.banco_horas
    WHERE empleado_id = $1 AND (anio < $2 OR (anio = $2 AND mes <= $3))
  `, [eId, anio, mes]);
  const { rows: [compensadasRow] } = await db.query(`
    SELECT COALESCE(SUM(horas_compensadas), 0) as horas_comp
    FROM public.compensaciones
    WHERE empleado_id = $1 AND fecha <= $2
  `, [eId, finDeMes]);
  const bancoHorasAcumulado =
    Number(saldoBrutoRow.saldo_bruto) - Number(compensadasRow.horas_comp);

  // Feriados del mes
  const { rows: feriados } = await db.query(`
    SELECT fecha, descripcion FROM public.feriados
    WHERE EXTRACT(YEAR FROM fecha) = $1 AND EXTRACT(MONTH FROM fecha) = $2
  `, [anio, mes]);

  // Visitas completadas del mes (para "clientes visitados" y para saber qué
  // días trabajó externo/en cliente)
  const { rows: visitasMes } = await db.query(`
    SELECT v.id, v.fecha, v.estado, v.hora_inicio_real,
      (SELECT json_agg(vd.cliente_nombre ORDER BY vd.orden)
       FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as clientes
    FROM public.visitas v
    WHERE v.empleado_id = $1
      AND EXTRACT(YEAR FROM v.fecha) = $2
      AND EXTRACT(MONTH FROM v.fecha) = $3
      AND v.estado = 'completada'
    ORDER BY v.fecha ASC
  `, [eId, anio, mes]);

  // Construir días del mes
  const diasDelMes = [];
  const diasEnMes  = new Date(anio, mes, 0).getDate();

  for (let d = 1; d <= diasEnMes; d++) {
    const fecha = `${anio}-${String(mes).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const esFeriado = feriados.some(f => f.fecha.toISOString?.().split('T')[0] === fecha || f.fecha === fecha);
    const diaSemana = new Date(fecha).getDay(); // 0=dom,6=sab

    const movsDia = movs.filter(m => {
      const mFecha = m.fecha instanceof Date ? m.fecha.toISOString().split('T')[0] : String(m.fecha).split('T')[0];
      return mFecha === fecha;
    });

    const ingreso   = movsDia.find(m => ['ingreso','inicio_jornada_remota'].includes(m.tipo));
    const egreso    = movsDia.find(m => ['egreso','fin_jornada_remota'].includes(m.tipo));
    const ausencia  = ausencias.find(a => fecha >= a.fecha_inicio && fecha <= a.fecha_fin);
    const tardanza  = movsDia.find(m => m.es_tardanza);
    const visitasDia = visitasMes.filter(v => {
      const vFecha = v.fecha instanceof Date ? v.fecha.toISOString().split('T')[0] : String(v.fecha).split('T')[0];
      return vFecha === fecha;
    });
    const clientesDelDia = [...new Set(visitasDia.flatMap(v => v.clientes || []))];

    // Lugar de trabajo del día: si hubo una visita a cliente ese día, prioriza
    // "externo" (aunque haya fichado en oficina antes/después de salir).
    // Si no, se toma del tipo de ingreso / contexto informado al fichar.
    let lugarTrabajo = null;
    if (clientesDelDia.length > 0 || movsDia.some(m => m.tipo === 'salida_externa')) {
      lugarTrabajo = 'externo';
    } else if (ingreso?.tipo === 'inicio_jornada_remota' || ingreso?.contexto_remoto === 'domicilio') {
      lugarTrabajo = 'remoto';
    } else if (ingreso?.contexto_remoto === 'externo') {
      lugarTrabajo = 'externo';
    } else if (ingreso) {
      lugarTrabajo = 'oficina';
    }

    // Calcular horas trabajadas del día usando los movimientos reales (ingreso→egreso),
    // descontando el almuerzo SOLO si el empleado efectivamente marcó salida/regreso de
    // almuerzo (con su duración real) — si no lo marcó (ej. almuerza en oficina mientras
    // trabaja), esas horas siguen contando normalmente, sin descuento fijo de 1 hora.
    let horasTrabajadas = 0;
    if (ingreso && egreso) {
      horasTrabajadas = calcularHorasDesdeMovimientos(movsDia);
    }

    diasDelMes.push({
      fecha,
      dia: d,
      diaSemana,
      esFeriado,
      esSabado: diaSemana === 6,
      esDomingo: diaSemana === 0,
      ingreso:   ingreso  ? new Date(ingreso.hora).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : null,
      egreso:    egreso   ? new Date(egreso.hora).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : null,
      horasTrabajadas,
      horasObjetivo: emp.horas_diarias_objetivo || 8,
      horasExtra: Math.max(0, horasTrabajadas - (emp.horas_diarias_objetivo || 8)),
      tardanza:  tardanza ? tardanza.minutos_tardanza : 0,
      ausencia:  ausencia?.tipo || null,
      esRemoto:  ingreso?.es_remoto || false,
      lugarTrabajo,
      clientesVisitados: clientesDelDia,
      fotoIngreso: (ingreso?.foto_capturada && ingreso?.foto_url) ? ingreso.foto_url : null,
      gpsIngreso: (ingreso?.lat != null && ingreso?.lng != null)
        ? { lat: Number(ingreso.lat), lng: Number(ingreso.lng), valido: ingreso.gps_valido }
        : null,
      movimientos: movsDia,
    });
  }

  // Detalle de tardanzas del mes (solo los días con llegada tarde)
  const detalleTardanzas = diasDelMes
    .filter(d => d.tardanza > 0)
    .map(d => ({
      fecha: d.fecha,
      dia: d.dia,
      diaSemana: d.diaSemana,
      horaIngreso: d.ingreso,
      horaIngresoConfigurada: emp.hora_ingreso || null,
      minutosTarde: d.tardanza,
    }));

  // Resumen de clientes visitados en el mes (nombre + cantidad de visitas)
  const conteoClientes = {};
  for (const dia of diasDelMes) {
    for (const cliente of dia.clientesVisitados) {
      conteoClientes[cliente] = (conteoClientes[cliente] || 0) + 1;
    }
  }
  const clientesVisitadosResumen = Object.entries(conteoClientes)
    .map(([cliente, visitas]) => ({ cliente, visitas }))
    .sort((a, b) => b.visitas - a.visitas);

  // % de cumplimiento de horas según convenio del mes
  const horasConvenioMes = Number(bh?.horas_convenio || 0);
  const horasTrabajadasMes = Number(bh?.horas_trabajadas || 0);
  const porcentajeCumplimiento = horasConvenioMes > 0
    ? Math.round((horasTrabajadasMes / horasConvenioMes) * 10000) / 100
    : null;

  return {
    empleado: emp,
    anio: Number(anio),
    mes: Number(mes),
    dias: diasDelMes,
    banco_horas: bh || null,
    feriados,
    detalleTardanzas,
    clientesVisitadosResumen,
    totales: {
      dias_trabajados:   diasDelMes.filter(d => d.horasTrabajadas > 0).length,
      dias_oficina:      diasDelMes.filter(d => d.lugarTrabajo === 'oficina').length,
      dias_remoto:       diasDelMes.filter(d => d.lugarTrabajo === 'remoto').length,
      dias_externo:      diasDelMes.filter(d => d.lugarTrabajo === 'externo').length,
      horas_trabajadas:  bh?.horas_trabajadas || 0,
      horas_convenio:    bh?.horas_convenio   || 0,
      horas_extra:       bh?.horas_extra       || 0,
      horas_ausencia:    bh?.horas_ausencia    || 0,
      balance:           bh?.balance           || 0, // negativo = faltan hs, positivo = sobran
      porcentaje_cumplimiento_horas: porcentajeCumplimiento,
      banco_horas_acumulado_al_mes:  Math.round(bancoHorasAcumulado * 100) / 100,
      tardanzas:         diasDelMes.filter(d => d.tardanza > 0).length,
      minutos_tardanza_total: diasDelMes.reduce((s, d) => s + (d.tardanza || 0), 0),
      ausencias:         diasDelMes.filter(d => d.ausencia).length,
      dias_sin_foto:     diasDelMes.filter(d => d.ingreso && !d.fotoIngreso).length,
      dias_sin_gps:      diasDelMes.filter(d => d.ingreso && !d.gpsIngreso).length,
      // Contadores de validación manual del mes, separados a propósito (Bug 1,
      // punto 7 del spec): "sin GPS" es una elección legítima del empleado (ej.
      // celular personal sin ubicación compartida) y "fuera de radio" puede ser
      // negligencia real — mezclarlos generaría un reclamo injusto.
      validaciones_sin_gps:     movs.filter(m => m.gps_valido === false && !m.es_remoto).length,
      validaciones_fuera_radio: movs.filter(m => m.salida_fuera_radio === true).length,
    },
  };
}

// ─── POST /reportes/mensual/firmar ────────────────────────────────────────────
// Firma digital del reporte mensual (empleado y/o admin). La primera firma
// congela un snapshot de los datos (JSON) — si ya existe snapshot, las firmas
// siguientes se agregan sobre ESE mismo snapshot, no se recalcula, para que
// ambas firmas correspondan siempre a los mismos números. Hash SHA-256 sobre
// el snapshot + firma para trazabilidad (Ley 25.506, mismo criterio que ya
// se usa para el hash de movimientos de fichaje).
router.post('/mensual/firmar', auth, async (req, res) => {
  const { empleado_id, anio, mes, tipo, nombre_apellido, cargo, firma_svg } = req.body;
  if (!empleado_id || !anio || !mes || !tipo || !firma_svg || !nombre_apellido) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  if (!['empleado', 'admin'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de firma inválido' });
  }
  // Solo el propio empleado puede poner la firma "empleado"; solo un admin
  // puede poner la firma "admin".
  if (tipo === 'empleado' && req.user.rol === 'empleado' && req.user.empleadoId != empleado_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  if (tipo === 'admin' && req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede firmar como responsable' });
  }

  // No se puede firmar como empleado si hay una objeción sin resolver para
  // ese período — primero el admin tiene que revisarla y resolverla.
  if (tipo === 'empleado') {
    const { rows: [pendiente] } = await db.query(`
      SELECT id FROM public.reportes_mensuales_objeciones
      WHERE empleado_id = $1 AND anio = $2 AND mes = $3 AND estado = 'pendiente'
      LIMIT 1
    `, [empleado_id, anio, mes]);
    if (pendiente) {
      return res.status(409).json({ error: 'Hay una incoherencia pendiente de resolver en este reporte. No se puede firmar hasta que el administrador la responda.' });
    }
  }

  try {
    const { rows: [existente] } = await db.query(`
      SELECT * FROM public.reportes_mensuales_firmados
      WHERE empleado_id = $1 AND anio = $2 AND mes = $3
    `, [empleado_id, anio, mes]);

    let snapshot = existente?.datos_snapshot;
    if (!snapshot) {
      snapshot = await construirReporteMensual(empleado_id, req.user.empleadorId, anio, mes);
      if (!snapshot) return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify(snapshot) + tipo + firma_svg + new Date().toISOString())
      .digest('hex');

    let firmado;
    if (tipo === 'empleado') {
      ({ rows: [firmado] } = await db.query(`
        INSERT INTO public.reportes_mensuales_firmados
          (empleado_id, empleador_id, anio, mes, datos_snapshot,
           firma_empleado_svg, firma_empleado_nombre, firmado_empleado_en, hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)
        ON CONFLICT (empleado_id, anio, mes) DO UPDATE SET
          firma_empleado_svg    = EXCLUDED.firma_empleado_svg,
          firma_empleado_nombre = EXCLUDED.firma_empleado_nombre,
          firmado_empleado_en   = NOW(),
          hash                  = EXCLUDED.hash
        RETURNING *
      `, [empleado_id, req.user.empleadorId, anio, mes, JSON.stringify(snapshot), firma_svg, nombre_apellido, hash]));
    } else {
      ({ rows: [firmado] } = await db.query(`
        INSERT INTO public.reportes_mensuales_firmados
          (empleado_id, empleador_id, anio, mes, datos_snapshot,
           firma_admin_svg, firma_admin_nombre, firma_admin_cargo, firmado_admin_en, hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
        ON CONFLICT (empleado_id, anio, mes) DO UPDATE SET
          firma_admin_svg    = EXCLUDED.firma_admin_svg,
          firma_admin_nombre = EXCLUDED.firma_admin_nombre,
          firma_admin_cargo  = EXCLUDED.firma_admin_cargo,
          firmado_admin_en   = NOW(),
          hash               = EXCLUDED.hash
        RETURNING *
      `, [empleado_id, req.user.empleadorId, anio, mes, JSON.stringify(snapshot), firma_svg, nombre_apellido, cargo || null, hash]));
    }

    res.json({ ok: true, firmado });
  } catch (err) {
    console.error('[REP] Firmar mensual error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/mensual/firmado ────────────────────────────────────────────
// Devuelve el reporte firmado (si existe) con su snapshot congelado.
router.get('/mensual/firmado', auth, async (req, res) => {
  const { empleado_id, anio, mes } = req.query;
  const eId = req.user.rol === 'empleado' ? req.user.empleadoId : empleado_id;
  if (!eId || !anio || !mes) return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const { rows: [firmado] } = await db.query(`
      SELECT * FROM public.reportes_mensuales_firmados
      WHERE empleado_id = $1 AND anio = $2 AND mes = $3
    `, [eId, anio, mes]);
    res.json(firmado || null);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /reportes/mensual/objetar ───────────────────────────────────────────
// El empleado marca una incoherencia en el reporte ANTES de firmar. Mientras
// haya una objeción pendiente, el backend rechaza cualquier intento de firma
// "empleado" para ese período (ver /mensual/firmar).
router.post('/mensual/objetar', auth, async (req, res) => {
  const { empleado_id, anio, mes, comentario } = req.body;
  if (!empleado_id || !anio || !mes || !comentario?.trim()) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  if (req.user.rol === 'empleado' && req.user.empleadoId != empleado_id) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const { rows: [obj] } = await db.query(`
      INSERT INTO public.reportes_mensuales_objeciones
        (empleado_id, empleador_id, anio, mes, comentario, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [empleado_id, req.user.empleadorId, anio, mes, comentario.trim(), req.user.id]);

    const { rows: [emp] } = await db.query(
      'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [empleado_id]
    );
    const meses = ['','enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
    await push.pushAdmins(
      req.user.empleadorId,
      '⚠️ Incoherencia en reporte mensual',
      `${nombre} marcó una incoherencia en su reporte de ${meses[mes]} ${anio}: "${comentario.trim()}"`
    );

    res.json({ ok: true, objecion: obj });
  } catch (err) {
    console.error('[REP] Objetar mensual error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/mensual/objeciones ─────────────────────────────────────────
router.get('/mensual/objeciones', auth, async (req, res) => {
  const { empleado_id, anio, mes } = req.query;
  const eId = req.user.rol === 'empleado' ? req.user.empleadoId : empleado_id;
  if (!eId || !anio || !mes) return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const { rows } = await db.query(`
      SELECT o.*, e2.nombre as creado_por_nombre, e2.apellido as creado_por_apellido
      FROM public.reportes_mensuales_objeciones o
      LEFT JOIN public.usuarios u ON u.id = o.creado_por
      LEFT JOIN public.empleados e2 ON e2.usuario_id = u.id
      WHERE o.empleado_id = $1 AND o.anio = $2 AND o.mes = $3
      ORDER BY o.creado_en DESC
    `, [eId, anio, mes]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PATCH /reportes/mensual/objeciones/:id/resolver ──────────────────────────
// Solo admin. Marca la objeción como resuelta con una respuesta — el admin
// debería haber corregido el fichaje correspondiente antes de resolver.
router.patch('/mensual/objeciones/:id/resolver', auth, soloAdmin, async (req, res) => {
  const { respuesta_admin } = req.body;
  try {
    const { rows: [obj] } = await db.query(`
      UPDATE public.reportes_mensuales_objeciones
      SET estado = 'resuelta', respuesta_admin = $1, resuelta_por = $2, resuelta_en = NOW()
      WHERE id = $3 AND empleador_id = $4
      RETURNING *
    `, [respuesta_admin || null, req.user.id, req.params.id, req.user.empleadorId]);
    if (!obj) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true, objecion: obj });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/horas-extra ────────────────────────────────────────────────
router.get('/horas-extra', auth, async (req, res) => {
  const { anio, mes, empleado_id } = req.query;

  const params = [req.user.empleadorId];
  let where = 'WHERE bh.empleador_id = $1';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND bh.empleado_id = $${params.length}`;
  } else if (empleado_id) {
    params.push(empleado_id);
    where += ` AND bh.empleado_id = $${params.length}`;
  }
  if (anio) { params.push(anio); where += ` AND bh.anio = $${params.length}`; }
  if (mes)  { params.push(mes);  where += ` AND bh.mes  = $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT bh.*,
        e.nombre, e.apellido, e.legajo, e.salario_base,
        c.recargo_extra_habitual, c.recargo_extra_festivo,
        c.max_hs_extra_mes, c.max_hs_extra_anio
      FROM public.banco_horas bh
      JOIN public.empleados e ON e.id = bh.empleado_id
      JOIN public.empleadores emp ON emp.id = bh.empleador_id
      JOIN public.convenios c ON c.id = emp.convenio_id
      ${where}
      ORDER BY bh.anio DESC, bh.mes DESC, e.apellido
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('[REP] Horas extra error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/tardanzas ──────────────────────────────────────────────────
router.get('/tardanzas', auth, async (req, res) => {
  const { anio, mes, empleado_id } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE m.empleador_id = $1 AND m.es_tardanza = TRUE';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND m.empleado_id = $${params.length}`;
  } else if (empleado_id) {
    params.push(empleado_id);
    where += ` AND m.empleado_id = $${params.length}`;
  }
  if (anio) { params.push(anio); where += ` AND EXTRACT(YEAR FROM m.fecha) = $${params.length}`; }
  if (mes)  { params.push(mes);  where += ` AND EXTRACT(MONTH FROM m.fecha) = $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT m.fecha, m.hora, m.minutos_tardanza,
        e.nombre, e.apellido, e.legajo
      FROM public.movimientos m
      JOIN public.empleados e ON e.id = m.empleado_id
      ${where}
      ORDER BY m.hora DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/estadisticas-empleado ─────────────────────────────────────
router.get('/estadisticas-empleado', auth, async (req, res) => {
  const { empleado_id, anio } = req.query;
  const anioConsulta = anio || new Date().getFullYear();
  const eId = req.user.rol === 'empleado' ? req.user.empleadoId : empleado_id;
  if (!eId) return res.status(400).json({ error: 'empleado_id requerido' });

  try {
    const { rows } = await db.query(`
      SELECT
        bh.mes,
        bh.horas_convenio,
        bh.horas_trabajadas,
        bh.horas_extra,
        bh.horas_ausencia,
        bh.balance,
        bh.saldo_acumulado,
        (SELECT COUNT(*) FROM public.movimientos
          WHERE empleado_id = $1
            AND es_tardanza = TRUE
            AND EXTRACT(YEAR FROM fecha) = $2
            AND EXTRACT(MONTH FROM fecha) = bh.mes
        ) as tardanzas_mes,
        (SELECT COUNT(*) FROM public.ausencias
          WHERE empleado_id = $1
            AND estado = 'aprobada'
            AND EXTRACT(YEAR FROM fecha_inicio) = $2
            AND EXTRACT(MONTH FROM fecha_inicio) = bh.mes
        ) as ausencias_mes
      FROM public.banco_horas bh
      WHERE bh.empleado_id = $1 AND bh.anio = $2
      ORDER BY bh.mes ASC
    `, [eId, anioConsulta]);

    // Calcular acumulados anuales
    const acumulado = rows.reduce((acc, r) => ({
      horas_convenio:   acc.horas_convenio   + Number(r.horas_convenio),
      horas_trabajadas: acc.horas_trabajadas + Number(r.horas_trabajadas),
      horas_extra:      acc.horas_extra      + Number(r.horas_extra),
      balance_anual:    acc.balance_anual    + Number(r.balance),
      tardanzas:        acc.tardanzas        + Number(r.tardanzas_mes),
      ausencias:        acc.ausencias        + Number(r.ausencias_mes),
    }), { horas_convenio:0, horas_trabajadas:0, horas_extra:0, balance_anual:0, tardanzas:0, ausencias:0 });

    res.json({ meses: rows, anual: acumulado, anio: Number(anioConsulta) });
  } catch (err) {
    console.error('[REP] Estadísticas error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /reportes/libro-lct ──────────────────────────────────────────────────
// Formato LCT Art. 52 para rúbrica Ministerio de Trabajo
router.get('/libro-lct', auth, soloAdmin, async (req, res) => {
  const { anio, mes } = req.query;
  if (!anio || !mes) return res.status(400).json({ error: 'Anio y mes requeridos' });

  try {
    const { rows: [empleador] } = await db.query(
      'SELECT * FROM public.empleadores WHERE id = $1', [req.user.empleadorId]
    );
    const { rows: empleados } = await db.query(
      'SELECT * FROM public.empleados WHERE empleador_id = $1 AND activo = TRUE ORDER BY legajo',
      [req.user.empleadorId]
    );

    // Para cada empleado, obtener resumen del mes
    const resumen = await Promise.all(empleados.map(async (emp) => {
      const { rows: [bh] } = await db.query(`
        SELECT * FROM public.banco_horas
        WHERE empleado_id = $1 AND anio = $2 AND mes = $3
      `, [emp.id, anio, mes]);

      return {
        ...emp,
        banco_horas: bh || { horas_convenio:0, horas_trabajadas:0, horas_extra:0, balance:0 },
      };
    }));

    res.json({
      empleador,
      anio: Number(anio),
      mes: Number(mes),
      empleados: resumen,
      generado_en: new Date().toISOString(),
      referencias_legales: [
        'LCT Art. 52 — Libro especial de registro',
        'LCT Art. 57 — Tolerancia en llegadas',
        'LCT Art. 201 — Horas extraordinarias',
        'Ley 11.544 — Jornada de trabajo',
        'Decreto 484/2000 — Límites horas extra',
        'Ley 25.506 — Firma digital',
      ],
    });
  } catch (err) {
    console.error('[REP] Libro LCT error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── Calcular horas trabajadas de un día a partir de sus movimientos ordenados ──
// Misma lógica que jornadaService.calcularHorasJornada, pero operando sobre
// movimientos ya cargados en memoria (evita una query extra por cada día del mes).
// El almuerzo solo se descuenta si hay un tramo real salida_almuerzo→regreso_almuerzo.
function calcularHorasDesdeMovimientos(movsDia) {
  let totalMinutos = 0;
  let horaEntrada = null;

  for (const m of movsDia) {
    switch (m.tipo) {
      case 'ingreso':
      case 'regreso_almuerzo':
      case 'regreso_externo':
      case 'inicio_jornada_remota':
        horaEntrada = new Date(m.hora);
        break;

      case 'salida_almuerzo':
      case 'salida_externa':
      case 'egreso':
      case 'fin_jornada_remota':
        if (horaEntrada) {
          totalMinutos += (new Date(m.hora) - horaEntrada) / 60000;
          horaEntrada = null;
        }
        break;
    }
  }

  return Math.round((totalMinutos / 60) * 100) / 100;
}

module.exports = router;
