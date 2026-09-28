// npm test — reglas de avisos de ausencia (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./ausenciasService');

test('hora de entrada: el horario propio del día manda sobre la jornada general', () => {
  const general = { hora_ingreso: '07:30:00', dias_laborables: [1, 2, 3, 4, 5] };
  assert.equal(s.horaIngresoDelDia({ diaSemana: 1, porDia: { hora_ingreso: '08:00:00' }, general }), '08:00:00');
  assert.equal(s.horaIngresoDelDia({ diaSemana: 1, porDia: null, general }), '07:30:00');
});

test('hora de entrada: día no laborable o fila del día sin hora = no trabaja', () => {
  const general = { hora_ingreso: '07:30', dias_laborables: [1, 2, 3, 4, 5] };
  assert.equal(s.horaIngresoDelDia({ diaSemana: 6, porDia: null, general }), null);
  assert.equal(s.horaIngresoDelDia({ diaSemana: 2, porDia: { hora_ingreso: null }, general }), null);
  assert.equal(s.horaIngresoDelDia({ diaSemana: 2, porDia: null, general: null }), null);
});

test('hora de entrada: jornada partida usa la hora de la mañana', () => {
  assert.equal(s.horaIngresoDelDia({ diaSemana: 3, porDia: { hora_man_inicio: '08:00' }, general: null }), '08:00');
  assert.equal(
    s.horaIngresoDelDia({ diaSemana: 3, porDia: null, general: { hora_maniana_inicio: '08:15', dias_laborables: [3] } }),
    '08:15',
  );
});

test('aviso sin ingreso: desde 30 minutos después, hasta 4 horas después', () => {
  const ingreso = '07:30';
  const min = (hhmm) => s.minutosDe(hhmm);
  assert.equal(s.debeAvisarSinIngreso(min('07:59'), ingreso), false);
  assert.equal(s.debeAvisarSinIngreso(min('08:00'), ingreso), true);
  assert.equal(s.debeAvisarSinIngreso(min('11:30'), ingreso), true);
  assert.equal(s.debeAvisarSinIngreso(min('11:31'), ingreso), false);
  assert.equal(s.debeAvisarSinIngreso(min('09:00'), null), false);
});

test('día de la semana: 1=lunes ... 7=domingo', () => {
  assert.equal(s.diaSemanaDe('2026-09-28'), 1); // lunes
  assert.equal(s.diaSemanaDe('2026-10-04'), 7); // domingo
});

test('comprobante: enfermedad con certificado y licencias especiales', () => {
  assert.equal(s.requiereComprobante('enfermedad_certificada'), true);
  assert.equal(s.requiereComprobante('licencia_examen'), true);
  assert.equal(s.requiereComprobante('enfermedad_leve'), false);
  assert.equal(s.requiereComprobante('tramite_personal'), false);
});

test('certificado vence 48 horas después', () => {
  const desde = new Date('2026-09-28T10:00:00Z');
  assert.equal(s.venceCertificado(desde).toISOString(), '2026-09-30T10:00:00.000Z');
});

test('ausencia del propio empleado: canal app', () => {
  const r = s.validarAusencia({ tipo: 'enfermedad_certificada', fecha_inicio: '2026-09-28' }, { esAdmin: false });
  assert.ok(r.ok);
  assert.equal(r.datos.canal, 'app');
  assert.equal(r.datos.fechaFin, '2026-09-28');
  assert.equal(r.datos.empleadoId, null);
  assert.equal(r.datos.requiereComprobante, true);
});

test('ausencia a nombre de otro: solo admin y con canal', () => {
  const base = { tipo: 'enfermedad_certificada', fecha_inicio: '2026-09-28', empleado_id: 11 };
  assert.equal(s.validarAusencia(base, { esAdmin: false }).ok, false);
  assert.equal(s.validarAusencia(base, { esAdmin: true }).ok, false);
  const r = s.validarAusencia(
    { ...base, canal_aviso: 'whatsapp', aviso_recibido_en: '2026-09-27T22:40:00-03:00' },
    { esAdmin: true },
  );
  assert.ok(r.ok);
  assert.equal(r.datos.empleadoId, 11);
  assert.equal(r.datos.canal, 'whatsapp');
  assert.equal(r.datos.avisoRecibidoEn.toISOString(), '2026-09-28T01:40:00.000Z');
});

test('ausencia: fechas inválidas', () => {
  assert.equal(s.validarAusencia({ tipo: 'x', fecha_inicio: '' }, { esAdmin: true }).ok, false);
  assert.equal(
    s.validarAusencia({ tipo: 'x', fecha_inicio: '2026-09-28', fecha_fin: '2026-09-27' }, { esAdmin: true }).ok,
    false,
  );
});

test('archivo: foto o PDF de hasta 8 MB', () => {
  assert.equal(s.validarArchivo({ mimetype: 'image/jpeg', size: 1000 }).ok, true);
  assert.equal(s.validarArchivo({ mimetype: 'application/pdf', size: 1000 }).ok, true);
  assert.equal(s.validarArchivo({ mimetype: 'text/plain', size: 10 }).ok, false);
  assert.equal(s.validarArchivo({ mimetype: 'image/png', size: 9 * 1024 * 1024 }).ok, false);
  assert.equal(s.validarArchivo(null).ok, false);
});
