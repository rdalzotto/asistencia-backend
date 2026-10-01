// npm test — reglas de secuencia de fichaje (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
// db.js se conecta al cargarse: acá no hace falta base, se reemplaza por uno vacío.
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const j = require('./jornadaService');

test('desde el almuerzo se puede volver a la oficina o trabajando afuera', () => {
  assert.ok(j.tipoMovimientoPermitido('salida_almuerzo', 'regreso_almuerzo'));
  assert.ok(j.tipoMovimientoPermitido('salida_almuerzo', 'inicio_jornada_remota'));
  assert.ok(!j.tipoMovimientoPermitido('salida_almuerzo', 'egreso'));
  assert.ok(!j.tipoMovimientoPermitido('salida_almuerzo', 'salida_externa'));
});

test('fichaje manual: el regreso que faltó entre el almuerzo y el cierre de las 20 (Roberto 30/09)', () => {
  assert.equal(j.validarFichajeManual({ anterior: 'salida_almuerzo', tipo: 'regreso_almuerzo', siguiente: 'egreso' }), null);
});

test('fichaje manual: egreso que faltó al final del día', () => {
  assert.equal(j.validarFichajeManual({ anterior: 'regreso_externo', tipo: 'egreso', siguiente: null }), null);
  assert.equal(j.validarFichajeManual({ anterior: 'ingreso', tipo: 'egreso', siguiente: null }), null);
});

test('fichaje manual: ingreso olvidado a la mañana, antes de la salida al almuerzo', () => {
  assert.equal(j.validarFichajeManual({ anterior: null, tipo: 'ingreso', siguiente: 'salida_almuerzo' }), null);
});

test('fichaje manual: no encaja con el fichaje anterior', () => {
  const r = j.validarFichajeManual({ anterior: 'ingreso', tipo: 'regreso_almuerzo', siguiente: null });
  assert.match(r, /Antes de esa hora el último fichaje es "Ingreso"/);
  assert.match(j.validarFichajeManual({ anterior: null, tipo: 'egreso', siguiente: null }), /primer fichaje/);
});

test('fichaje manual: no encaja con el fichaje siguiente', () => {
  const r = j.validarFichajeManual({ anterior: 'salida_almuerzo', tipo: 'regreso_almuerzo', siguiente: 'regreso_almuerzo' });
  assert.match(r, /Después de esa hora ya hay un "Regreso almuerzo"/);
});

test('fichaje manual: tipos remotos y el flag de feriado no se cargan a mano', () => {
  assert.ok(j.validarFichajeManual({ anterior: null, tipo: 'inicio_jornada_remota', siguiente: null }));
  assert.ok(j.validarFichajeManual({ anterior: 'ingreso', tipo: 'trabajo_feriado', siguiente: null }));
});

// Octubre 2026: lunes a sábado, feriado lunes 12 → 26 días hábiles (26 × 8 = 208).
const LUN_A_SAB = [1, 2, 3, 4, 5, 6];
const FER_OCT = new Set(['2026-10-12']);

test('días hábiles: sin domingos ni feriados', () => {
  assert.equal(j.contarDiasHabiles(2026, 10, 31, LUN_A_SAB, FER_OCT), 26);
  assert.equal(j.contarDiasHabiles(2026, 10, 4, LUN_A_SAB, FER_OCT), 3); // jue 1, vie 2, sáb 3 (dom 4 no)
  assert.equal(j.contarDiasHabiles(2026, 10, 12, LUN_A_SAB, FER_OCT), 9); // sin dom 4, dom 11 ni feriado 12
  assert.equal(j.contarDiasHabiles(2026, 10, 0, LUN_A_SAB, FER_OCT), 0);
});

test('saldo a la fecha: el día 1 no arranca en -178', () => {
  const r = j.balanceALaFecha({ horasConvenio: 178, horasTrabajadas: 0, anio: 2026, mes: 10, dia: 1, diasLaborables: LUN_A_SAB, feriados: FER_OCT });
  assert.deepEqual(r, { esperadas: 0, balance: 0 });
});

test('saldo a la fecha: cuenta solo los días hábiles ya pasados', () => {
  const r = j.balanceALaFecha({ horasConvenio: 178, horasTrabajadas: 8.5, anio: 2026, mes: 10, dia: 2, diasLaborables: LUN_A_SAB, feriados: FER_OCT });
  assert.equal(r.esperadas, 6.85); // 178 / 26
  assert.equal(r.balance, 1.65);
  const d13 = j.balanceALaFecha({ horasConvenio: 178, horasTrabajadas: 60, anio: 2026, mes: 10, dia: 13, diasLaborables: LUN_A_SAB, feriados: FER_OCT });
  assert.equal(d13.esperadas, 61.62); // 178 × 9 / 26
  assert.equal(d13.balance, -1.62);
});

test('saldo a la fecha: sin convenio cargado no inventa horas', () => {
  const r = j.balanceALaFecha({ horasConvenio: 0, horasTrabajadas: 5, anio: 2026, mes: 10, dia: 20, diasLaborables: LUN_A_SAB, feriados: FER_OCT });
  assert.deepEqual(r, { esperadas: 0, balance: 5 });
});

// ── Jornada especial ─────────────────────────────────────────────────────────
const JE = { tipo: 'viaje', motivo: 'Viaje a Federal', fecha: '2026-10-01', hoy: '2026-10-01', esAdmin: false };

test('jornada especial: datos válidos', () => {
  assert.equal(j.validarJornadaEspecial(JE), null);
  assert.equal(j.validarJornadaEspecial({ ...JE, tipo: 'evento', alcance: 'medio' }), null);
  assert.equal(j.validarJornadaEspecial({ ...JE, fecha: '2026-10-31' }), null); // 30 días
});

test('jornada especial: datos que faltan o no corresponden', () => {
  assert.match(j.validarJornadaEspecial({ ...JE, tipo: 'paseo' }), /tipo/);
  assert.match(j.validarJornadaEspecial({ ...JE, tipo: 'evento' }), /completo o medio/);
  assert.match(j.validarJornadaEspecial({ ...JE, motivo: 'x' }), /motivo/);
  assert.match(j.validarJornadaEspecial({ ...JE, fecha: '01/10/2026' }), /Fecha/);
});

test('jornada especial: el empleado no carga días pasados ni a más de 30 días; el admin sí regulariza', () => {
  assert.match(j.validarJornadaEspecial({ ...JE, fecha: '2026-09-30' }), /días anteriores/);
  assert.match(j.validarJornadaEspecial({ ...JE, fecha: '2026-11-01' }), /30 días/);
  assert.equal(j.validarJornadaEspecial({ ...JE, fecha: '2026-09-30', esAdmin: true }), null);
  assert.match(j.validarJornadaEspecial({ ...JE, fecha: '2026-07-01', esAdmin: true }), /2 meses/);
  assert.equal(j.validarJornadaEspecial({ ...JE, fecha: '2026-11-30', esAdmin: true }), null);
});

test('evento: 8 hs fijas el día completo; medio día = 4 + lo fichado', () => {
  assert.equal(j.horasEventoDelDia('completo', 11), 8);
  assert.equal(j.horasEventoDelDia('medio', 0), 4);
  assert.equal(j.horasEventoDelDia('medio', 3.5), 7.5);
});

test('cierre de seguridad: hora estimada + 1 h recordatorio y + 4 h cierre', () => {
  const r = j.horariosJornadaEspecial({ fecha: '2026-10-01', horaFinEstimada: '18:30', apertura: new Date('2026-10-01T07:30:00-03:00') });
  assert.equal(r.recordatorio.toISOString(), new Date('2026-10-01T19:30:00-03:00').toISOString());
  assert.equal(r.cierre.toISOString(), new Date('2026-10-01T22:30:00-03:00').toISOString());
});

test('cierre de seguridad: nunca pasa de las 23:55 del día', () => {
  const r = j.horariosJornadaEspecial({ fecha: '2026-10-01', horaFinEstimada: '21:00', apertura: null });
  assert.equal(r.cierre.toISOString(), new Date('2026-10-01T23:55:00-03:00').toISOString());
  const r2 = j.horariosJornadaEspecial({ fecha: '2026-10-01', horaFinEstimada: '23:30', apertura: null });
  assert.equal(r2.recordatorio.toISOString(), new Date('2026-10-01T23:55:00-03:00').toISOString());
});

test('cierre de seguridad sin hora estimada: 14 h desde que empezó (sin recordatorio)', () => {
  const r = j.horariosJornadaEspecial({ fecha: '2026-10-03', horaFinEstimada: null, apertura: new Date('2026-10-03T06:00:00-03:00') });
  assert.equal(r.recordatorio, null);
  assert.equal(r.cierre.toISOString(), new Date('2026-10-03T20:00:00-03:00').toISOString());
  const tarde = j.horariosJornadaEspecial({ fecha: '2026-10-03', horaFinEstimada: null, apertura: new Date('2026-10-03T13:00:00-03:00') });
  assert.equal(tarde.cierre.toISOString(), new Date('2026-10-03T23:55:00-03:00').toISOString());
});
