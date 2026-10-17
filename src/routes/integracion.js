// API de integración v1 para el CRM de EXIT (módulo "Mi empresa"). Solo
// lectura, con token propio (ver services/integracionService.js y
// docs/api-integracion-crm.md). Sin JWT de usuario: la usa el servidor del CRM.
const router = require('express').Router();
const db     = require('../db');
const s      = require('../services/integracionService');

// Token + empleador configurado. Sin configuración la API queda apagada (503).
router.use((req, res, next) => {
  const cfg = s.config();
  if (!cfg) return res.status(503).json({ error: 'Integración no configurada' });
  if (!s.tokenValido(s.tokenDeHeader(req.headers.authorization), cfg.token)) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  req.empleadorId = cfg.empleadorId;
  next();
});

// ─── GET /api/integracion/v1/empleados ───────────────────────────────────────
// Personal activo, para elegir quién ocupa cada puesto del organigrama y para
// la antigüedad del fondo compartido. Sin datos sensibles (DNI, CUIL,
// domicilio, salario).
router.get('/empleados', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, apellido, legajo, categoria, sector, fecha_ingreso
       FROM public.empleados WHERE empleador_id = $1 AND activo = TRUE
       ORDER BY apellido NULLS LAST, nombre NULLS LAST, id`,
      [req.empleadorId]
    );
    res.json({
      empleados: rows.map(e => ({
        id: e.id,
        nombre: s.nombreCompleto(e),
        legajo: e.legajo || null,
        categoria: e.categoria || null,
        sector: e.sector || null,
        fechaIngreso: s.fechaISO(e.fecha_ingreso),
      })),
    });
  } catch (err) {
    console.error('[INTEGRACION] empleados:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /api/integracion/v1/resumen-mensual?periodo=AAAA-MM ─────────────────
// Visitas completadas y programadas (por fecha de la visita), km recorridos
// en las completadas (km reales o, si no se cargaron, los estimados) y horas
// trabajadas (banco de horas del mes), en total y por empleado. Programadas =
// todas menos canceladas, rechazadas y pendientes de aprobación. Antes del
// arranque limpio devuelve archivado=true y los valores en null.
router.get('/resumen-mensual', async (req, res) => {
  const periodo = s.leerPeriodo(req.query.periodo);
  if (!periodo) return res.status(400).json({ error: 'periodo inválido (AAAA-MM)' });
  try {
    const { rows: [emp] } = await db.query('SELECT * FROM public.empleadores WHERE id = $1', [req.empleadorId]);
    if (!emp) return res.status(404).json({ error: 'Empleador inexistente' });
    if (s.periodoArchivado(periodo, emp.fecha_inicio_registros)) {
      return res.json({
        periodo: req.query.periodo, archivado: true,
        visitasCompletadas: null, visitasProgramadas: null, kmRecorridos: null, horasTrabajadas: null, porEmpleado: [],
      });
    }
    const [{ rows: visitas }, { rows: horas }] = await Promise.all([
      db.query(
        `SELECT empleado_id,
                COUNT(*) FILTER (WHERE estado = 'completada')::int AS completadas,
                COUNT(*) FILTER (WHERE estado NOT IN ('cancelada','rechazada','pendiente_aprobacion'))::int AS programadas,
                COALESCE(SUM(COALESCE(km_reales, km_estimados, 0)) FILTER (WHERE estado = 'completada'), 0)::float AS km
         FROM public.visitas
         WHERE empleador_id = $1 AND fecha >= $2 AND fecha < $3
         GROUP BY empleado_id`,
        [req.empleadorId, periodo.desde, periodo.hasta]
      ),
      db.query(
        `SELECT empleado_id, horas_trabajadas FROM public.banco_horas
         WHERE empleador_id = $1 AND anio = $2 AND mes = $3`,
        [req.empleadorId, periodo.anio, periodo.mes]
      ),
    ]);
    const porEmpleado = new Map();
    const fila = id => {
      if (!porEmpleado.has(id)) {
        porEmpleado.set(id, { empleadoId: id, visitasCompletadas: 0, visitasProgramadas: 0, kmRecorridos: 0, horasTrabajadas: 0 });
      }
      return porEmpleado.get(id);
    };
    for (const v of visitas) {
      if (!v.empleado_id) continue;
      const e = fila(v.empleado_id);
      e.visitasCompletadas = v.completadas;
      e.visitasProgramadas = v.programadas;
      e.kmRecorridos = Math.round(Number(v.km) * 10) / 10;
    }
    for (const h of horas) fila(h.empleado_id).horasTrabajadas = Math.round(Number(h.horas_trabajadas || 0) * 10) / 10;
    const lista = [...porEmpleado.values()];
    res.json({
      periodo: req.query.periodo,
      archivado: false,
      visitasCompletadas: visitas.reduce((a, v) => a + v.completadas, 0),
      visitasProgramadas: visitas.reduce((a, v) => a + v.programadas, 0),
      kmRecorridos: Math.round(visitas.reduce((a, v) => a + Number(v.km), 0) * 10) / 10,
      horasTrabajadas: Math.round(lista.reduce((a, e) => a + e.horasTrabajadas, 0) * 10) / 10,
      porEmpleado: lista,
    });
  } catch (err) {
    console.error('[INTEGRACION] resumen-mensual:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
