// npm test — textos de los avisos al empleado (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./avisosEmpleadoService');

test('fechas: string y Date (columna DATE) dan lo mismo', () => {
  assert.equal(s.fechaCorta('2026-10-30'), '30/10');
  assert.equal(s.fechaCorta(new Date('2026-10-30T00:00:00Z')), '30/10');
  assert.equal(s.fechaCorta(null), '');
});

test('hora en Argentina aunque el servidor esté en UTC', () => {
  assert.equal(s.horaArg('2026-10-30T09:37:23Z'), '06:37');
});

test('fichaje validado y rechazado, con y sin motivo', () => {
  const mov = { tipo: 'ingreso', fecha: '2026-10-30', hora: '2026-10-30T09:37:23Z', observacion_admin: null };
  const ok = s.fichajeValidado(mov, true);
  assert.equal(ok.titulo, '✅ Fichaje validado');
  assert.equal(ok.cuerpo, 'Ingreso del 30/10 a las 06:37: ya cuenta en tus horas.');
  const no = s.fichajeValidado({ ...mov, observacion_admin: 'no estabas en la oficina' }, false);
  assert.equal(no.tipo, 'fichaje_rechazado');
  assert.match(no.cuerpo, /no se cuenta en tus horas\. .* Motivo: no estabas en la oficina$/);
});

test('ausencia: un día o rango, abre Ausencias', () => {
  const a = s.ausenciaResuelta({ estado: 'aprobada', tipo: 'enfermedad_certificada', fecha_inicio: '2026-10-30', fecha_fin: '2026-10-30' });
  assert.equal(a.cuerpo, 'enfermedad certificada del 30/10.');
  assert.equal(a.accion, 'ver_ausencias');
  const r = s.ausenciaResuelta({ estado: 'rechazada', tipo: 'tramite', fecha_inicio: '2026-10-30', fecha_fin: '2026-10-31', observacion_admin: 'sin aviso' });
  assert.equal(r.titulo, '❌ Ausencia rechazada');
  assert.equal(r.cuerpo, 'tramite del 30/10 al 31/10. Motivo: sin aviso');
});

test('vacaciones y compensatorio', () => {
  assert.equal(s.vacacionesResueltas({ estado: 'aprobada', fecha_inicio: '2026-12-26', fecha_fin: '2027-01-09' }).cuerpo, 'Del 26/12 al 09/01.');
  const c = s.compensatorioResuelto({ estado: 'aprobada', bloques_8hs: 2, fecha_solicitada: '2026-11-06' });
  assert.equal(c.cuerpo, '2 días (16 hs) para el 06/11. Se descuenta de tu banco de horas.');
  assert.equal(s.compensatorioResuelto({ estado: 'rechazada', bloques_8hs: 1, fecha_solicitada: '2026-11-06' }).tipo, 'compensatorio_rechazado');
});

test('objeción del reporte mensual, egreso manual y problema respondido', () => {
  assert.equal(s.objecionResuelta({ mes: 10, anio: 2026, respuesta_admin: ' Corregido ' }).cuerpo, 'Reporte de octubre 2026: Corregido');
  assert.match(s.objecionResuelta({ mes: 10, anio: 2026 }).cuerpo, /se marcó como resuelta/);
  assert.equal(s.egresoManual('2026-10-30', '18:05:00').cuerpo, 'Se registró tu salida del 30/10 a las 18:05.');
  assert.match(s.problemaRespondido({ respuesta: '' }).cuerpo, /resuelto/);
});
