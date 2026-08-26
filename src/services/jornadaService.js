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

// ─── Fecha/hora Argentina (offset fijo UTC-3, sin horario de verano) ────────
// Mismo patrón que ya usan visitas.js e index.js por separado — el servidor
// (Railway) corre en UTC, así que new Date() crudo no sirve para comparar
// contra horarios locales.
function fechaHoyArgentina() {
  const ahoraArg = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return ahoraArg.toISOString().split('T')[0];
}

function horaAhoraArgentina() {
  const ahoraArg = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { h: ahoraArg.getHours(), m: ahoraArg.getMinutes(), dow: ahoraArg.getDay() };
}

// ─── Ventana fija de excepción horaria (18:00 a 05:00, hora Argentina) ──────
// Fuera de este rango, un fichaje de oficina sin GPS se acepta con validación
// manual normal (POST /movimientos/validar-remoto). Dentro de este rango, sin
// GPS, se bloquea directamente salvo que haya una visita autorizada de
// antemano (ver tieneVisitaAutorizadaHoy) — Bug 1, punto 1 del spec.
function estaEnVentanaExcepcional() {
  const { h } = horaAhoraArgentina();
  return h >= 18 || h < 5;
}

// Misma ventana, pero evaluada sobre una hora arbitraria "HH:MM" (para
// visitas programadas de antemano, en vez de la hora actual).
function horaEnVentanaExcepcional(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return false;
  const h = parseInt(hhmm.split(':')[0], 10);
  if (Number.isNaN(h)) return false;
  return h >= 18 || h < 5;
}

// ─── ¿Hay una visita programada y ya aprobada por el admin que autorice el
// fichaje excepcional de hoy? ─────────────────────────────────────────────
// Se apoya en la columna visita_horario_excepcional (marcada al crear la
// visita cuando cae en la ventana 18-05) y en que el estado haya salido de
// 'pendiente_aprobacion' (el admin la aprobó vía el flujo ya existente de
// visitas). Bug 1, punto 2.
async function tieneVisitaAutorizadaHoy(empleadoId, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const fecha = fechaHoyArgentina();
  const { rows } = await queryFn(`
    SELECT 1 FROM public.visitas
    WHERE empleado_id = $1 AND fecha = $2
      AND visita_horario_excepcional = TRUE
      AND estado IN ('programada', 'en_curso', 'completada')
    LIMIT 1
  `, [empleadoId, fecha]);
  return rows.length > 0;
}

// ─── ¿Tiene una visita propia programada para HOY (sin restricción de horario
// excepcional)? ────────────────────────────────────────────────────────────
// Se usa para el fichaje "Externo" sin GPS/fuera de radio: si el colaborador
// ya tiene una visita propia cargada para hoy, el fichaje como Externo queda
// auto-aprobado sin pasar por validación del admin (Parte A, Caso 1 del
// rediseño de fichaje sin GPS de oficina — 26/08/2026).
async function tieneVisitaPropiaHoy(empleadoId, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const fecha = fechaHoyArgentina();
  const { rows } = await queryFn(`
    SELECT 1 FROM public.visitas
    WHERE empleado_id = $1 AND fecha = $2
      AND estado IN ('programada', 'en_curso', 'completada')
    LIMIT 1
  `, [empleadoId, fecha]);
  return rows.length > 0;
}

// ─── ¿La hora actual cae dentro de la jornada habitual del empleado (con
// margen de 60 min antes del ingreso)? ────────────────────────────────────
// Se usa para validar el arranque de una jornada remota cuando SÍ hay GPS
// pero cae fuera del radio de oficina — evita que "remoto" se use como
// excusa para arrancar en cualquier horario. Mismo fallback jornadas_por_dia
// → jornadas_config que ya usa GET /movimientos/horario-hoy. Sin jornada
// configurada, no bloquea (fail-open, igual criterio que el resto del
// código cuando falta configuración). Bug 1, punto 4.
async function validarHorarioRemoto(empleadoId) {
  const { h, m, dow } = horaAhoraArgentina();

  const { rows: jornadaDia } = await db.query(
    `SELECT hora_ingreso, hora_egreso FROM public.jornadas_por_dia WHERE empleado_id = $1 AND dia_semana = $2`,
    [empleadoId, dow]
  );
  let horario = jornadaDia[0]?.hora_egreso ? jornadaDia[0] : null;
  if (!horario) {
    const { rows: jc } = await db.query(
      `SELECT jc.hora_ingreso, jc.hora_egreso FROM public.empleados e
       LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
       WHERE e.id = $1`,
      [empleadoId]
    );
    horario = jc[0]?.hora_egreso ? jc[0] : null;
  }
  if (!horario?.hora_ingreso || !horario?.hora_egreso) return true;

  const minAhora    = h * 60 + m;
  const [hIng, mIng] = horario.hora_ingreso.split(':').map(Number);
  const [hEgr, mEgr] = horario.hora_egreso.split(':').map(Number);
  const minIngreso  = hIng * 60 + mIng - 60; // margen de 60 min antes del ingreso habitual
  const minEgreso   = hEgr * 60 + mEgr;

  return minAhora >= minIngreso && minAhora <= minEgreso;
}

// ─── Obtener jornada config de un empleado ───────────────────────────────────
async function getJornadaConfig(empleadoId) {
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

  // Convertir a hora Argentina antes de extraer hs/min — el servidor (Railway)
  // corre en UTC, así que ingreso.getHours() crudo devolvía la hora UTC y
  // marcaba tardanza de ~3hs (el offset ART) en ingresos que en realidad
  // llegaron a horario.
  const ingreso = new Date(new Date(horaIngreso).toLocaleString('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires'
  }));
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
// contarAbierta=true: si la jornada sigue abierta (no fichó egreso todavía),
// suma también el tramo abierto hasta el momento actual. Útil para mostrarle
// al técnico "cuántas horas llevás" antes de que cierre el día.
async function calcularHorasJornada(empleadoId, fecha, client, contarAbierta = false) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);

  // Si el día tiene algún fichaje sin validar por el admin —ya sea de oficina
  // sin GPS (gps_valido=false) o remoto/externo sin auto-aprobación
  // (es_remoto=true, validado=false)— el día completo no suma horas hasta que
  // se valide (Bug 1, puntos 2 y 3 del spec original; extendido a jornadas
  // remotas/externas en el rediseño del 26/08/2026, Parte A) — ni siquiera el
  // tramo previo al fichaje dudoso, para no dar una falsa sensación de "ya
  // está resuelto" en el banco de horas mientras sigue pendiente. Los
  // movimientos remotos auto-aprobados (Caso 1/4 — visita propia o
  // acompañante) ya nacen con validado=true, así que no caen acá.
  const { rows: pendientes } = await queryFn(`
    SELECT 1 FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = $2
      AND validado = FALSE
      AND (gps_valido = FALSE OR es_remoto = TRUE)
    LIMIT 1
  `, [empleadoId, fecha]);
  if (pendientes.length > 0) return 0;

  // Obtener todos los movimientos del día ordenados
  const { rows: movs } = await queryFn(`
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

  // Tramo todavía abierto (no fichó egreso) — solo si se pidió explícitamente
  if (contarAbierta && horaEntrada) {
    totalMinutos += (new Date() - horaEntrada) / 60000;
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
    horasTrabajadas += await calcularHorasJornada(empleadoId, f, client);
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

// ─── Secuencia lógica válida de fichaje ──────────────────────────────────────
// Define qué tipo de movimiento puede registrarse a continuación según el
// último movimiento del día. Usamos null como clave para "todavía no fichó nada hoy".
const TRANSICIONES_FICHAJE = {
  null:                   ['ingreso', 'inicio_jornada_remota'],
  ingreso:                ['salida_almuerzo', 'salida_externa', 'egreso'],
  salida_almuerzo:        ['regreso_almuerzo'],
  regreso_almuerzo:       ['salida_externa', 'egreso'],
  salida_externa:         ['regreso_externo'],
  regreso_externo:        ['salida_externa', 'egreso'],
  egreso:                 ['ingreso'],
  inicio_jornada_remota:  ['fin_jornada_remota'],
  fin_jornada_remota:     ['ingreso'],
};

function tipoMovimientoPermitido(ultimoTipo, tipoNuevo) {
  // 'trabajo_feriado' es un flag informativo aparte, no forma parte de la secuencia de fichaje
  if (tipoNuevo === 'trabajo_feriado') return true;
  const permitidos = TRANSICIONES_FICHAJE[ultimoTipo || null] || [];
  return permitidos.includes(tipoNuevo);
}

// ─── Último movimiento de hoy de un empleado ────────────────────────────────
async function obtenerUltimoMovimientoHoy(empleadoId, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const { rows } = await queryFn(`
    SELECT tipo, hora FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = CURRENT_DATE
    ORDER BY hora DESC LIMIT 1
  `, [empleadoId]);
  return rows[0] || null;
}

// ─── ¿Tiene jornada activa ahora mismo? (fichó ingreso/remoto y no cerró) ────
async function jornadaActivaHoy(empleadoId, client) {
  const ultimo = await obtenerUltimoMovimientoHoy(empleadoId, client);
  if (!ultimo) return false;
  return !['egreso', 'fin_jornada_remota'].includes(ultimo.tipo);
}

// ─── ¿Tiene jornada activa en una FECHA arbitraria? ──────────────────────────
// Igual que jornadaActivaHoy pero para cualquier fecha (no solo CURRENT_DATE).
// Se usa para permitir múltiples ciclos ingreso/egreso dentro del mismo día
// (ej: arrancar remoto, pasar a oficina con fin_jornada_remota + ingreso, y
// recién ahí cerrar con el egreso real) sin que un cierre intermedio de
// contexto sea confundido con el cierre final de la jornada.
async function jornadaActivaEnFecha(empleadoId, fecha, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const { rows } = await queryFn(`
    SELECT tipo FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = $2
    ORDER BY hora DESC LIMIT 1
  `, [empleadoId, fecha]);
  if (!rows[0]) return false;
  return !['egreso', 'fin_jornada_remota'].includes(rows[0].tipo);
}

// ─── ¿Fichó Ingreso (o inició jornada remota) en una fecha dada? ─────────────
// A diferencia de jornadaActivaHoy (estado EN ESTE INSTANTE), esto chequea si
// hubo fichaje ESE DÍA sin importar si ya cerró jornada. Se usa para validar
// acciones que pueden sincronizarse tarde por conexión offline (ej. un
// relevamiento de extintores cargado sin señal y sincronizado horas después,
// cuando el técnico ya fichó egreso) — así no se rechaza trabajo legítimo
// solo porque la sincronización llegó después de cerrar el día.
async function tuvoIngresoEnFecha(empleadoId, fecha, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const { rows } = await queryFn(`
    SELECT 1 FROM public.movimientos
    WHERE empleado_id = $1 AND fecha = $2
      AND tipo IN ('ingreso', 'inicio_jornada_remota')
    LIMIT 1
  `, [empleadoId, fecha]);
  return rows.length > 0;
}

// ─── ¿Tiene vacaciones o ausencia APROBADA para hoy? ─────────────────────────
async function tieneAusenciaOVacacionHoy(empleadoId, client) {
  const queryFn = client ? client.query.bind(client) : db.query.bind(db);
  const { rows } = await queryFn(`
    SELECT 1 FROM public.ausencias
    WHERE empleado_id = $1 AND estado = 'aprobada'
      AND CURRENT_DATE BETWEEN fecha_inicio AND fecha_fin
    UNION ALL
    SELECT 1 FROM public.vacaciones_tomadas
    WHERE empleado_id = $1 AND estado = 'aprobada'
      AND CURRENT_DATE BETWEEN fecha_inicio AND fecha_fin
    LIMIT 1
  `, [empleadoId]);
  return rows.length > 0;
}

module.exports = {
  esFeriado,
  fechaHoyArgentina,
  horaAhoraArgentina,
  estaEnVentanaExcepcional,
  horaEnVentanaExcepcional,
  tieneVisitaAutorizadaHoy,
  tieneVisitaPropiaHoy,
  validarHorarioRemoto,
  getJornadaConfig,
  calcularTardanza,
  calcularHorasJornada,
  calcularHorasExtra,
  verificarLimitesExtra,
  actualizarBancoHoras,
  generarHash,
  TRANSICIONES_FICHAJE,
  tipoMovimientoPermitido,
  obtenerUltimoMovimientoHoy,
  jornadaActivaHoy,
  jornadaActivaEnFecha,
  tuvoIngresoEnFecha,
  tieneAusenciaOVacacionHoy,
};
