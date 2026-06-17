const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin }   = require('../middleware/auth');
const jornada = require('../services/jornadaService');
const push    = require('../services/pushService');

// ─── POST /movimientos/registrar ──────────────────────────────────────────────
router.post('/registrar', auth, async (req, res) => {
  const {
    tipo, lat, lng, foto_url,
    categoria_salida_id, destino_id, destino_descripcion,
    es_remoto, domicilio_partida_lat, domicilio_partida_lng,
    consentimiento_extra,
  } = req.body;

  const TIPOS_VALIDOS = [
    'ingreso', 'salida_almuerzo', 'regreso_almuerzo', 'egreso',
    'salida_externa', 'regreso_externo',
    'inicio_jornada_remota', 'fin_jornada_remota',
    'trabajo_feriado',
  ];
  if (!TIPOS_VALIDOS.includes(tipo))
    return res.status(400).json({ error: 'Tipo de movimiento inválido' });

  const empleadoId = req.user.empleadoId;
  if (!empleadoId)
    return res.status(400).json({ error: 'Usuario sin empleado asociado' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const hoy     = new Date().toISOString().split('T')[0];
    const feriado = await jornada.esFeriado(hoy);

    // ─ Normalizar lat/lng: tratamos undefined, null y string vacío como "sin GPS" (NULL real en la base,
    // nunca NaN). parseFloat(null) da NaN en JS, por eso antes quedaba guardado "NaN" en vez de NULL. ─
    const latNum = (lat !== undefined && lat !== null && lat !== '') ? parseFloat(lat) : NaN;
    const lngNum = (lng !== undefined && lng !== null && lng !== '') ? parseFloat(lng) : NaN;
    const latVal = Number.isFinite(latNum) ? latNum : null;
    const lngVal = Number.isFinite(lngNum) ? lngNum : null;
    const tieneGps = latVal !== null && lngVal !== null;

    // ─ Verificar GPS (solo para movimientos de oficina, no remotos) ─
    let gpsValido = true;
    let distanciaM = null;
    let observacionAuto = null;

    if (!es_remoto && ['ingreso','egreso','salida_almuerzo','regreso_almuerzo'].includes(tipo)) {
      if (!tieneGps) {
        // Sin señal GPS al fichar: no bloqueamos el fichaje (el empleado podría estar realmente en la
        // oficina y solo falló el GPS del teléfono), pero tampoco lo damos por válido en silencio —
        // queda marcado para que el admin lo revise y decida.
        gpsValido = false;
        observacionAuto = 'Sin señal GPS al fichar — pendiente de validación manual';
      } else {
        const { rows: [emp] } = await client.query(
          'SELECT oficina_lat, oficina_lng, oficina_radio_m FROM public.empleadores WHERE id = $1',
          [req.user.empleadorId]
        );
        if (emp && emp.oficina_lat != null && emp.oficina_lng != null) {
          distanciaM = Math.round(calcularDistancia(
            latVal, lngVal,
            parseFloat(emp.oficina_lat),
            parseFloat(emp.oficina_lng)
          ));
          const radioPermitido = parseInt(emp.oficina_radio_m) || 300;
          gpsValido = distanciaM <= radioPermitido;
          if (!gpsValido)
            return res.status(400).json({
              error: `GPS fuera del área permitida (${distanciaM}m de distancia)`,
              distanciaM,
            });
        }
      }
    }

    // ─ Calcular tardanza (solo para ingreso habitual) ─
    let esTardanza    = false;
    let minutosTardanza = 0;

    if (tipo === 'ingreso' && !es_remoto) {
      const jc   = await jornada.getJornadaConfig(empleadoId);
      const { rows: [conv] } = await client.query(`
        SELECT c.* FROM public.convenios c
        JOIN public.empleadores e ON e.convenio_id = c.id
        WHERE e.id = $1
      `, [req.user.empleadorId]);
      const tardanza = jornada.calcularTardanza(new Date(), jc, conv);
      esTardanza     = tardanza.esTardanza;
      minutosTardanza = tardanza.minutos;
    }

    // ─ Hash SHA-256 (Ley 25.506) ─
    const hashData = {
      tipo, empleadoId, empleadorId: req.user.empleadorId,
      hora: new Date().toISOString(), lat: latVal, lng: lngVal,
    };
    const hash = jornada.generarHash(hashData);

    // ─ Insertar movimiento ─
    const { rows: [mov] } = await client.query(`
      INSERT INTO public.movimientos (
        empleado_id, empleador_id, tipo, fecha, hora,
        lat, lng, gps_valido, distancia_m,
        es_remoto, domicilio_partida_lat, domicilio_partida_lng,
        foto_url, foto_capturada,
        categoria_salida_id, destino_id, destino_descripcion,
        es_tardanza, minutos_tardanza,
        es_feriado,
        consentimiento_extra, consentimiento_hora,
        validado, hash_sha256, observacion_admin
      ) VALUES (
        $1,$2,$3,CURRENT_DATE,NOW(),
        $4,$5,$6,$7,
        $8,$9,$10,
        $11,$12,
        $13,$14,$15,
        $16,$17,
        $18,
        $19, CASE WHEN $19 THEN NOW() ELSE NULL END,
        $20,$21,$22
      ) RETURNING *
    `, [
      empleadoId, req.user.empleadorId, tipo,
      latVal, lngVal,
      gpsValido, distanciaM,
      es_remoto || false,
      domicilio_partida_lat !== undefined ? parseFloat(domicilio_partida_lat) : null,
      domicilio_partida_lng !== undefined ? parseFloat(domicilio_partida_lng) : null,
      foto_url || null, !!foto_url,
      categoria_salida_id ? parseInt(categoria_salida_id) : null,
      destino_id ? parseInt(destino_id) : null,
      destino_descripcion || null,
      esTardanza, minutosTardanza,
      feriado,
      consentimiento_extra || null,
      es_remoto ? false : gpsValido,
      hash,
      observacionAuto,
    ]);

    // ─ Actualizar banco de horas ─
    await jornada.actualizarBancoHoras(empleadoId, hoy, client);

    await client.query('COMMIT');

    // ─ Notificaciones push a admins ─
    const { rows: [emp] } = await db.query(
      'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [empleadoId]
    );
    const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
    const hora   = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    if (tipo === 'ingreso') {
      const n = push.notif.ingreso(nombre, hora, esTardanza ? minutosTardanza : null);
      await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);

      if (esTardanza) {
        const { rows: [cnt] } = await db.query(`
          SELECT COUNT(*) as total FROM public.movimientos
          WHERE empleado_id = $1 AND es_tardanza = TRUE
            AND DATE_TRUNC('month', fecha::TIMESTAMPTZ) = DATE_TRUNC('month', NOW())
        `, [empleadoId]);
        if (Number(cnt.total) >= 3) {
          const na = push.notif.tardanzasAcumuladas(nombre, cnt.total);
          await push.pushAdmins(req.user.empleadorId, na.titulo, na.cuerpo);
        }
      }
    } else if (tipo === 'egreso') {
      const n = push.notif.egreso(nombre, hora);
      await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    } else if (tipo === 'salida_externa') {
      const n = push.notif.salidaExterna(nombre, destino_descripcion || 'Gestión externa');
      await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    } else if (tipo === 'inicio_jornada_remota') {
      const n = push.notif.jornadaRemota(nombre, hora);
      await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    }

    res.json({ ok: true, movimiento: mov });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[MOV] Error:', err.message);
    res.status(500).json({ error: 'Error al registrar movimiento' });
  } finally {
    client.release();
  }
});

// ─── GET /movimientos/hoy ─────────────────────────────────────────────────────
router.get('/hoy', auth, async (req, res) => {
  const empleadoId = req.user.empleadoId;
  try {
    const { rows } = await db.query(`
      SELECT m.*, cs.nombre as categoria_nombre, d.nombre as destino_nombre
      FROM public.movimientos m
      LEFT JOIN public.categorias_salida cs ON cs.id = m.categoria_salida_id
      LEFT JOIN public.destinos_externos d ON d.id = m.destino_id
      WHERE m.empleado_id = $1 AND m.fecha = CURRENT_DATE
      ORDER BY m.hora ASC
    `, [empleadoId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /movimientos/historial ───────────────────────────────────────────────
router.get('/historial', auth, async (req, res) => {
  const {
    empleado_id, desde, hasta, tipo,
    page = 1, limit = 50
  } = req.query;

  const offset = (Number(page) - 1) * Number(limit);
  const params = [req.user.empleadorId];
  let where = 'WHERE m.empleador_id = $1';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND m.empleado_id = $${params.length}`;
  } else if (empleado_id) {
    params.push(empleado_id);
    where += ` AND m.empleado_id = $${params.length}`;
  }

  if (desde) { params.push(desde); where += ` AND m.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); where += ` AND m.fecha <= $${params.length}`; }
  if (tipo)  { params.push(tipo);  where += ` AND m.tipo = $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT m.*,
        e.nombre, e.apellido, e.legajo,
        cs.nombre as categoria_nombre,
        d.nombre as destino_nombre
      FROM public.movimientos m
      JOIN public.empleados e ON e.id = m.empleado_id
      LEFT JOIN public.categorias_salida cs ON cs.id = m.categoria_salida_id
      LEFT JOIN public.destinos_externos d ON d.id = m.destino_id
      ${where}
      ORDER BY m.hora DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error('[MOV] Historial error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /movimientos/validar-remoto (admin) ─────────────────────────────────
// A pesar del nombre (histórico), este endpoint hoy valida CUALQUIER movimiento pendiente
// de revisión humana: jornadas remotas, o fichajes de oficina sin señal GPS.
router.post('/validar-remoto/:id', auth, soloAdmin, async (req, res) => {
  const { id } = req.params;
  const { aprobado, observacion } = req.body;

  try {
    const { rows: [mov] } = await db.query(`
      UPDATE public.movimientos SET
        validado = $1,
        validado_por = $2,
        validado_en = NOW(),
        observacion_admin = $3
      WHERE id = $4 AND empleador_id = $5 AND (es_remoto = TRUE OR gps_valido = FALSE)
      RETURNING *
    `, [aprobado !== false, req.user.id, observacion || null, id, req.user.empleadorId]);

    if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });

    if (aprobado !== false) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await jornada.actualizarBancoHoras(mov.empleado_id, mov.fecha, client);
        await client.query('COMMIT');
      } finally { client.release(); }
    }

    res.json({ ok: true, movimiento: mov });
  } catch (err) {
    console.error('[MOV] Validar remoto error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /movimientos/pendientes-validacion (admin) ───────────────────────────
router.get('/pendientes-validacion', auth, soloAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT m.*, e.nombre, e.apellido, e.legajo
      FROM public.movimientos m
      JOIN public.empleados e ON e.id = m.empleado_id
      WHERE m.empleador_id = $1
        AND (m.es_remoto = TRUE OR m.gps_valido = FALSE)
        AND m.validado = FALSE
        AND m.hora >= NOW() - INTERVAL '48 hours'
      ORDER BY m.hora DESC
    `, [req.user.empleadorId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── Función auxiliar: distancia Haversine ───────────────────────────────────
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = router;
