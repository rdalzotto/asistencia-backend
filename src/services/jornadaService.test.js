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
