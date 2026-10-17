// npm test — reglas de la API de integración con el CRM (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./integracionService');

test('token: compara exacto y rechaza vacío o distinto', () => {
  const t = 'a'.repeat(40);
  assert.equal(s.tokenValido(t, t), true);
  assert.equal(s.tokenValido(t + 'b', t), false);
  assert.equal(s.tokenValido('', t), false);
  assert.equal(s.tokenValido(null, t), false);
  assert.equal(s.tokenValido(t, undefined), false);
});

test('token del header Authorization', () => {
  assert.equal(s.tokenDeHeader('Bearer abc'), 'abc');
  assert.equal(s.tokenDeHeader('Basic abc'), null);
  assert.equal(s.tokenDeHeader('Bearer '), null);
  assert.equal(s.tokenDeHeader(undefined), null);
});

test('configuración: token largo y empleador numérico, si no la API queda apagada', () => {
  const antes = { ...process.env };
  process.env.INTEGRACION_CRM_TOKEN = 'corto';
  process.env.INTEGRACION_CRM_EMPLEADOR_ID = '1';
  assert.equal(s.config(), null);
  process.env.INTEGRACION_CRM_TOKEN = 'x'.repeat(32);
  assert.deepEqual(s.config(), { token: 'x'.repeat(32), empleadorId: 1 });
  process.env.INTEGRACION_CRM_EMPLEADOR_ID = 'abc';
  assert.equal(s.config(), null);
  process.env = antes;
});

test('periodo: formato y rango del mes (diciembre cruza de año)', () => {
  assert.deepEqual(s.leerPeriodo('2026-10'), { anio: 2026, mes: 10, desde: '2026-10-01', hasta: '2026-11-01' });
  assert.deepEqual(s.leerPeriodo('2026-12'), { anio: 2026, mes: 12, desde: '2026-12-01', hasta: '2027-01-01' });
  assert.equal(s.leerPeriodo('2026-13'), null);
  assert.equal(s.leerPeriodo('2026-1'), null);
  assert.equal(s.leerPeriodo(undefined), null);
});

test('periodo archivado: antes del arranque limpio', () => {
  const sep = s.leerPeriodo('2026-09'), oct = s.leerPeriodo('2026-10');
  assert.equal(s.periodoArchivado(sep, '2026-10-01'), true);
  assert.equal(s.periodoArchivado(oct, '2026-10-01'), false);
  assert.equal(s.periodoArchivado(oct, new Date('2026-10-01T00:00:00Z')), false);
  assert.equal(s.periodoArchivado(sep, null), false);
});

test('nombre completo', () => {
  assert.equal(s.nombreCompleto({ id: 8, nombre: 'Roberto', apellido: 'Pereyra' }), 'Roberto Pereyra');
  assert.equal(s.nombreCompleto({ id: 9, nombre: null, apellido: null }), 'Empleado 9');
});
