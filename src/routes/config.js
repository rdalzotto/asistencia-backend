// jornadaService.js — Lógica legal argentina
// LCT Art. 52, 57, 201 | Ley 11.544 | Decreto 484/2000

const db = require('../db');

// ─── Verificar si una fecha es feriado ───────────────────────────────────────
async function esFeriado(fecha) {
  const { rows } = await db.query(
    'SELECT 1 FROM public.feriados WHERE fecha = $1',
    [fecha]
  );
  return rows.length > 0;
}

// ─── Obtener jornada config de un empleado ───────────────────────────────────
async function getJornadaConfig(empleadoId, fecha) {
  // Si se pasa una fecha, buscar primero en jornadas_por_dia
  if (fecha) {
    const d = new Date(fecha);
    // getDay() devuelve 0=Dom,1=Lun,...,6=Sab → convertir a 1=Lun,...,7=Dom
    const diaSemana = d.getDay() === 0 ? 7 : d.getDay();
    const { rows: porDia } = await db.query(
      'SELECT * FROM public.jornadas_por_dia WHERE empleado_id = $1 AND dia_semana = $2',
      [empleadoId, diaSemana]
    );
    if (porDia.length > 0) {
      // Mapear campos al formato que espera calcularTardanza
      const pd = porDia[0];
      return {
        modalidad:           pd.modalidad,
        hora_ingreso:        pd.hora_ingreso,
        hora_egreso:         pd.hora_egreso,
        hora_maniana_inicio: pd.hora_man_inicio,
        hora_maniana_fin:    pd.hora_man_fin,
        hora_tarde_inicio:   pd.hora_tar_inicio,
        hora_tarde_fin:      pd.hora_tar_fin,
        horas_diarias_objetivo: pd.horas_objetivo,
        incluye_almuerzo:    false,
        _fuente: 'por_dia',
      };
    }
  }
  // Fallback: jornada general del empleado
  const { rows } = await db.query(`
    SELECT jc.* FROM public.jornadas_config jc
    JOIN public.empleados e ON e.jornada_config_id = jc.id
    WHERE e.id = $1
  `, [empleadoId]);
  return rows[0] || null;
}

// ─── Calcular tardanza ───────────────────────────────────────────────────────
function calcularTardanza(horaIngreso, jornadaConfig, convenio) {
  if (!jornadaConfig?.hora_ingreso) return { esTardanza: false, minutos: 0 };

  const tolerancia = convenio?.tolerancia_tardanza_min ?? 10;
  const [hRef, mRef] = jornadaConfig.hora_ingreso.split(':').map(Number);
  const refMs = (hRef * 60 + mRef + tolerancia) * 60 * 1000;

  const ingreso = new Date(horaIngreso);
  const inicioMsFromMidnight =
    ingreso.getHours() * 60 * 60 * 1000 +
    ingreso.getMinutes() * 60 * 1000 +
    ingreso.getSeconds() * 1000;

  if (inicioMsFromMidnight > refMs) {
    const minutos = Math.round((inicioMsFromMidnight - refMs) / 60000);
    return { esTardanza: true, minutos };
  }
  return { esTardanza: false, minutos: 0 };
}

// ─── Calcular horas trabajadas en una jornada ────────────────────────────────
async function calcularHorasJornada(empleadoId, fecha) {
  // Obtener todos los movimientos del día ordenados
  const { rows: movs } = await db.query(`
    SELECT tipo, hora FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = $2
    ORDER BY hora ASC
  `, [empleadoId, fecha]);

  if (movs.length === 0) return 0;

  let totalMinutos = 0;
  let horaEntrada = null;
  let enAlmuerzo = false;
  let horaAlmuerzo = null;

  for (const m of movs) {
    switch (m.tipo) {
      case 'ingreso':
      case 'regreso_almuerzo':
      case 'regreso_externo':
      case 'inicio_jornada_remota':
        horaEntrada = new Date(m.hora);
        enAlmuerzo = false;
        break;

      case 'salida_almuerzo':
        if (horaEntrada) {
          totalMinutos += (new Date(m.hora) - horaEntrada) / 60000;
          horaEntrada = null;
          enAlmuerzo = true;
        }
        break;

      case 'salida_externa':
        if (horaEntrada) {
          totalMinutos += (new Date(m.hora) - horaEntrada) / 60000;
          horaEntrada = null;
        }
        break;

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

// ─── Calcular horas extra del período ────────────────────────────────────────
async function calcularHorasExtra(empleadoId, anio, mes) {
  const { rows: [emp] } = await db.query(`
    SELECT e.*, emp.convenio_id
    FROM public.empleados e
    JOIN public.empleadores emp ON emp.id = e.empleador_id
    WHERE e.id = $1
  `, [empleadoId]);

  if (!emp) return null;

  const { rows: [conv] } = await db.query(
    'SELECT * FROM public.convenios WHERE id = $1',
    [emp.convenio_id]
  );

  // Obtener banco de horas del mes
  const { rows: [bh] } = await db.query(`
    SELECT * FROM public.banco_horas
    WHERE empleado_id = $1 AND anio = $2 AND mes = $3
  `, [empleadoId, anio, mes]);

  if (!bh) return { horasExtra: 0, importeExtra50: 0, importeExtra100: 0 };

  const horasExtra = Math.max(0, bh.horas_extra);
  const salario   = Number(emp.salario_base) || 0;
  const horasMes  = bh.horas_convenio || (conv.horas_semanales / 5 * 22); // estimado
  const valorHora = horasMes > 0 ? salario / horasMes : 0;

  // Simplificación: 50% días hábiles, 100% feriados/domingo
  // El cálculo detallado por día requiere consultar cada movimiento
  const extra50  = horasExtra * valorHora * (1 + conv.recargo_extra_habitual / 100);
  const extra100 = 0; // Se calcula en detalle por el reporte

  return {
    horasExtra,
    valorHora: Math.round(valorHora * 100) / 100,
    importeEstimado: Math.round(extra50 * 100) / 100,
  };
}

// ─── Verificar límites Decreto 484/2000 ──────────────────────────────────────
async function verificarLimitesExtra(empleadoId, convenioId) {
  const { rows: [conv] } = await db.query(
    'SELECT * FROM public.convenios WHERE id = $1', [convenioId]
  );

  const hoy   = new Date();
  const anio  = hoy.getFullYear();
  const mes   = hoy.getMonth() + 1;

  // Horas extra de hoy
  const { rows: [hoyRow] } = await db.query(`
    SELECT COALESCE(SUM(
      CASE WHEN tipo = 'egreso' THEN
        EXTRACT(EPOCH FROM (hora - lag(hora) OVER (ORDER BY hora))) / 3600
      ELSE 0 END
    ), 0) as horas
    FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = CURRENT_DATE AND es_hora_extra = TRUE
  `, [empleadoId]);

  // Horas extra del mes
  const { rows: [mesRow] } = await db.query(`
    SELECT COALESCE(horas_extra, 0) as horas
    FROM public.banco_horas
    WHERE empleado_id = $1 AND anio = $2 AND mes = $3
  `, [empleadoId, anio, mes]);

  // Horas extra del año
  const { rows: [anioRow] } = await db.query(`
    SELECT COALESCE(SUM(horas_extra), 0) as horas
    FROM public.banco_horas
    WHERE empleado_id = $1 AND anio = $2
  `, [empleadoId, anio]);

  return {
    hoy:  { actuales: Number(hoyRow?.horas || 0),  limite: conv.max_hs_extra_dia },
    mes:  { actuales: Number(mesRow?.horas || 0),  limite: conv.max_hs_extra_mes },
    anio: { actuales: Number(anioRow?.horas || 0), limite: conv.max_hs_extra_anio },
    superaLimite:
      Number(hoyRow?.horas  || 0) >= conv.max_hs_extra_dia  ||
      Number(mesRow?.horas  || 0) >= conv.max_hs_extra_mes  ||
      Number(anioRow?.horas || 0) >= conv.max_hs_extra_anio,
  };
}

// ─── Actualizar banco de horas del mes ───────────────────────────────────────
async function actualizarBancoHoras(empleadoId, fecha, client) {
  const d    = new Date(fecha);
  const anio = d.getFullYear();
  const mes  = d.getMonth() + 1;

  // Horas trabajadas en el mes
  const { rows: movDias } = await client.query(`
    SELECT DISTINCT fecha FROM public.movimientos
    WHERE empleado_id = $1
      AND EXTRACT(YEAR FROM fecha::DATE) = $2
      AND EXTRACT(MONTH FROM fecha::DATE) = $3
  `, [empleadoId, anio, mes]);

  let horasTrabajadas = 0;
  for (const { fecha: f } of movDias) {
    horasTrabajadas += await calcularHorasJornada(empleadoId, f);
  }

  // Horas de ausencias justificadas del mes
  const { rows: [ausRow] } = await client.query(`
    SELECT COALESCE(SUM(dias_habiles), 0) * 8 as horas
    FROM public.ausencias
    WHERE empleado_id = $1
      AND estado = 'aprobada'
      AND EXTRACT(YEAR FROM fecha_inicio) = $2
      AND EXTRACT(MONTH FROM fecha_inicio) = $3
  `, [empleadoId, anio, mes]);

  // Calcular horas de convenio para el mes (días laborables × horas diarias)
  const { rows: [jc] } = await client.query(`
    SELECT jc.horas_diarias_objetivo, jc.dias_laborables
    FROM public.jornadas_config jc
    JOIN public.empleados e ON e.jornada_config_id = jc.id
    WHERE e.id = $1
  `, [empleadoId]);

  // Contar días laborables del mes según config del empleado
  const diasConvenio = await contarDiasLaborablesDelMes(
    anio, mes, jc?.dias_laborables || [1,2,3,4,5,6]
  );
  const horasConvenio = diasConvenio * (jc?.horas_diarias_objetivo || 8);
  const horasExtra    = Math.max(0, horasTrabajadas - horasConvenio);
  const horasAusencia = Number(ausRow?.horas || 0);

  await client.query(`
    INSERT INTO public.banco_horas
      (empleado_id, empleador_id, anio, mes, horas_convenio, horas_trabajadas, horas_extra, horas_ausencia)
    SELECT $1, empleador_id, $2, $3, $4, $5, $6, $7
    FROM public.empleados WHERE id = $1
    ON CONFLICT (empleado_id, anio, mes)
    DO UPDATE SET
      horas_convenio  = EXCLUDED.horas_convenio,
      horas_trabajadas = EXCLUDED.horas_trabajadas,
      horas_extra     = EXCLUDED.horas_extra,
      horas_ausencia  = EXCLUDED.horas_ausencia
  `, [empleadoId, anio, mes, horasConvenio, horasTrabajadas, horasExtra, horasAusencia]);
}

async function contarDiasLaborablesDelMes(anio, mes, diasLaborables) {
  const primerDia = new Date(anio, mes - 1, 1);
  const ultimoDia = new Date(anio, mes, 0);
  let count = 0;

  for (let d = new Date(primerDia); d <= ultimoDia; d.setDate(d.getDate() + 1)) {
    const diaSemana = d.getDay() === 0 ? 7 : d.getDay(); // 1=lun...7=dom
    if (diasLaborables.includes(diaSemana)) {
      // Verificar que no sea feriado
      const fecha = d.toISOString().split('T')[0];
      const feriado = await esFeriado(fecha);
      if (!feriado) count++;
    }
  }
  return count;
}

// ─── Generar hash SHA-256 del movimiento (Ley 25.506) ───────────────────────
function generarHash(datos) {
  const crypto = require('crypto');
  const str = JSON.stringify(datos);
  return crypto.createHash('sha256').update(str).digest('hex');
}

module.exports = {
  esFeriado,
  getJornadaConfig,
  calcularTardanza,
  calcularHorasJornada,
  calcularHorasExtra,
  verificarLimitesExtra,
  actualizarBancoHoras,
  generarHash,
};
