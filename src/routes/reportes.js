const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ─── GET /reportes/mensual ────────────────────────────────────────────────────
// Reporte mensual por empleado (detalle día por día + totales)
router.get('/mensual', auth, async (req, res) => {
  const { empleado_id, anio, mes } = req.query;
  if (!anio || !mes) return res.status(400).json({ error: 'Anio y mes requeridos' });

  const eId = req.user.rol === 'empleado' ? req.user.empleadoId : empleado_id;
  if (!eId) return res.status(400).json({ error: 'empleado_id requerido' });

  try {
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
    `, [eId, req.user.empleadorId]);

    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

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

    // Feriados del mes
    const { rows: feriados } = await db.query(`
      SELECT fecha, descripcion FROM public.feriados
      WHERE EXTRACT(YEAR FROM fecha) = $1 AND EXTRACT(MONTH FROM fecha) = $2
    `, [anio, mes]);

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

      // Calcular horas trabajadas del día
      let horasTrabajadas = 0;
      if (ingreso && egreso) {
        horasTrabajadas = Math.round(
          (new Date(egreso.hora) - new Date(ingreso.hora)) / 3600000 * 100
        ) / 100;
        // Descontar almuerzo si aplica
        if (emp.incluye_almuerzo && horasTrabajadas > 4) {
          horasTrabajadas = Math.max(0, horasTrabajadas - 1);
        }
      }

      diasDelMes.push({
        fecha,
        dia: d,
        diaSemana,
        esFeriado,
        esSabado: diaSemana === 6,
        esDomingo: diaSemana === 0,
        ingreso:   ingreso  ? new Date(ingreso.hora).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}) : null,
        egreso:    egreso   ? new Date(egreso.hora).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}) : null,
        horasTrabajadas,
        horasObjetivo: emp.horas_diarias_objetivo || 8,
        horasExtra: Math.max(0, horasTrabajadas - (emp.horas_diarias_objetivo || 8)),
        tardanza:  tardanza ? tardanza.minutos_tardanza : 0,
        ausencia:  ausencia?.tipo || null,
        esRemoto:  ingreso?.es_remoto || false,
        movimientos: movsDia,
      });
    }

    res.json({
      empleado: emp,
      anio: Number(anio),
      mes: Number(mes),
      dias: diasDelMes,
      banco_horas: bh || null,
      feriados,
      totales: {
        dias_trabajados:   diasDelMes.filter(d => d.horasTrabajadas > 0).length,
        horas_trabajadas:  bh?.horas_trabajadas || 0,
        horas_convenio:    bh?.horas_convenio   || 0,
        horas_extra:       bh?.horas_extra       || 0,
        horas_ausencia:    bh?.horas_ausencia    || 0,
        balance:           bh?.balance           || 0,
        tardanzas:         diasDelMes.filter(d => d.tardanza > 0).length,
        ausencias:         diasDelMes.filter(d => d.ausencia).length,
      },
    });
  } catch (err) {
    console.error('[REP] Mensual error:', err.message);
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

module.exports = router;
