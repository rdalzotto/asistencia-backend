// npm test — agenda de ausencias (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./agendaService');

const filas = [
  { origen: 'ausencia', id: 1, empleado_id: 8, nombre: 'Roberto', apellido: 'Pereyra', desde: '2026-10-29', hasta: '2026-10-29', estado: 'aprobada', tipo: 'tramite_personal', motivo: 'banco' },
  { origen: 'ausencia', id: 2, empleado_id: 11, nombre: 'Walter', apellido: 'Ott', desde: new Date('2026-11-05T00:00:00Z'), hasta: new Date('2026-11-06T00:00:00Z'), estado: 'aprobada', tipo: 'enfermedad_certificada', motivo: 'gripe' },
  { origen: 'vacaciones', id: 3, empleado_id: 9, nombre: 'Andrea', apellido: 'Díaz', desde: '2026-11-20', hasta: '2026-11-30', estado: 'pendiente', tipo: 'vacaciones' },
  { origen: 'compensatorio', id: 4, empleado_id: 8, nombre: 'Roberto', apellido: 'Pereyra', desde: '2026-11-05', estado: 'aprobada', bloques: 2 },
  { origen: 'ausencia', id: 5, empleado_id: 9, nombre: 'Andrea', apellido: 'Díaz', desde: '2026-11-10', hasta: '2026-11-10', estado: 'rechazada', tipo: 'tramite_personal' },
];

test('días corridos', () => {
  assert.equal(s.diasCorridos('2026-11-20', '2026-11-30'), 11);
  assert.equal(s.diasCorridos('2026-10-29', '2026-10-29'), 1);
});

test('admin: ve todo menos lo rechazado, con el tipo y el motivo, ordenado por fecha', () => {
  const a = s.armarAgenda(filas, { esAdmin: true, empleadoIdPropio: null });
  assert.deepEqual(a.map(i => i.id), [1, 4, 2, 3]); // misma fecha: por nombre
  assert.equal(a.find(i => i.id === 2).tipo_texto, '🏥 Enfermedad con certificado');
  assert.equal(a.find(i => i.id === 2).motivo, 'gripe');
  assert.equal(a.find(i => i.id === 3).estado, 'pendiente');
  assert.equal(a.find(i => i.id === 4).dias, 2);
  assert.equal(a.find(i => i.id === 3).dias, 11);
});

test('empleado: lo suyo completo; de los demás solo lo aprobado y sin motivo de salud', () => {
  const r = s.armarAgenda(filas, { esAdmin: false, empleadoIdPropio: 9 });
  assert.deepEqual(r.map(i => i.id), [1, 4, 2, 3]); // ve su vacación pendiente, no ve su rechazada
  const walter = r.find(i => i.id === 2);
  assert.equal(walter.tipo_texto, '🚫 Ausente');
  assert.equal(walter.motivo, null);
  assert.equal(r.find(i => i.id === 3).propio, true);
  const deWalter = s.armarAgenda(filas, { esAdmin: false, empleadoIdPropio: 11 });
  assert.ok(!deWalter.some(i => i.id === 3), 'la vacación PENDIENTE de Andrea no la ve Walter');
  assert.equal(deWalter.find(i => i.id === 2).tipo_texto, '🏥 Enfermedad con certificado');
});

test('quién no está un día (el compensatorio cuenta desde su fecha)', () => {
  const a = s.armarAgenda(filas, { esAdmin: true });
  assert.deepEqual(s.ausentesEn(a, '2026-11-05').map(i => i.id), [4, 2]);
  assert.deepEqual(s.ausentesEn(a, '2026-10-29').map(i => i.nombre), ['Roberto Pereyra']);
  assert.deepEqual(s.ausentesEn(a, '2026-11-07'), []);
});

test('aviso de la mañana: hoy y mañana, marca lo no aprobado; nada si no falta nadie', () => {
  const a = s.armarAgenda(filas, { esAdmin: true });
  const t = s.textoAvisoDiario(s.ausentesEn(a, '2026-10-29'), s.ausentesEn(a, '2026-10-30'));
  assert.equal(t.titulo, '📅 Hoy no viene: Roberto');
  assert.equal(t.cuerpo, 'Hoy: Roberto Pereyra (Trámite personal).');
  const t2 = s.textoAvisoDiario([], s.ausentesEn(a, '2026-11-20'));
  assert.equal(t2.titulo, '📅 Mañana falta alguien');
  assert.match(t2.cuerpo, /Andrea Díaz \(Vacaciones, SIN APROBAR\)/);
  assert.equal(s.textoAvisoDiario([], []), null);
});
