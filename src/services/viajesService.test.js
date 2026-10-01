// npm test — reglas de viajes (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('./viajesService');

test('días del viaje: inclusive, cruza de mes', () => {
  assert.deepEqual(v.diasEntre('2026-09-03', '2026-09-05'), ['2026-09-03', '2026-09-04', '2026-09-05']);
  assert.deepEqual(v.diasEntre('2026-09-30', '2026-10-01'), ['2026-09-30', '2026-10-01']);
  assert.deepEqual(v.diasEntre('2026-09-03', '2026-09-03'), ['2026-09-03']);
});

test('asignaciones: Palermo (Rogelio y Walter 2 días, Roberto 3)', () => {
  const pal = [
    { empleado_id: 12, desde: '2026-09-03', hasta: '2026-09-04' },
    { empleado_id: 11, desde: '2026-09-03', hasta: '2026-09-04' },
    { empleado_id: 8,  desde: '2026-09-03', hasta: '2026-09-05' },
  ];
  assert.equal(v.validarAsignaciones(pal), null);
  assert.deepEqual(v.rangoViaje(pal), { desde: '2026-09-03', hasta: '2026-09-05' });
});

test('asignaciones inválidas', () => {
  assert.match(v.validarAsignaciones([]), /al menos un empleado/);
  assert.match(v.validarAsignaciones([{ empleado_id: 8, desde: '2026-09-05', hasta: '2026-09-03' }]), /anterior/);
  assert.match(v.validarAsignaciones([{ empleado_id: 8, desde: '2026-09-01', hasta: '2026-10-15' }]), /31 días/);
  assert.match(v.validarAsignaciones([{ empleado_id: 8, desde: '2026-09-01', hasta: '2026-09-01' }, { empleado_id: 8, desde: '2026-09-02', hasta: '2026-09-02' }]), /dos veces/);
});

test('comprobante: foto o PDF de hasta 8 MB', () => {
  const ok = v.leerComprobante('data:image/jpeg;base64,' + Buffer.from('foto').toString('base64'));
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal(ok.buffer.toString(), 'foto');
  assert.equal(v.leerComprobante('data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64')).mime, 'application/pdf');
  assert.match(v.leerComprobante('data:text/html;base64,PGI+').error, /foto/);
  assert.match(v.leerComprobante('basura').error, /No se pudo leer/);
  const grande = 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  assert.match(v.leerComprobante(grande).error, /8 MB/);
});

const VIAJE = { desde: '2026-09-03', hasta: '2026-09-05' };
test('gasto válido con comprobante o sin comprobante con nota', () => {
  assert.equal(v.validarGasto({ categoria: 'combustible', monto: 45000, fecha: '2026-09-03', tieneComprobante: true }, VIAJE), null);
  assert.equal(v.validarGasto({ categoria: 'comida', monto: 3500, fecha: '2026-09-04', sin_comprobante: true, descripcion: 'Café en ruta' }, VIAJE), null);
  assert.equal(v.validarGasto({ categoria: 'combustible', monto: 1, fecha: '2026-09-01', tieneComprobante: true }, VIAJE), null); // 2 días antes
});

test('gasto inválido', () => {
  assert.match(v.validarGasto({ categoria: 'regalos', monto: 1, fecha: '2026-09-03', tieneComprobante: true }, VIAJE), /categoría/);
  assert.match(v.validarGasto({ categoria: 'peaje', monto: 0, fecha: '2026-09-03', tieneComprobante: true }, VIAJE), /mayor a cero/);
  assert.match(v.validarGasto({ categoria: 'peaje', monto: 10, fecha: '2026-08-20', tieneComprobante: true }, VIAJE), /no corresponde/);
  assert.match(v.validarGasto({ categoria: 'peaje', monto: 10, fecha: '2026-09-03' }, VIAJE), /foto del comprobante/);
  assert.match(v.validarGasto({ categoria: 'peaje', monto: 10, fecha: '2026-09-03', sin_comprobante: true, tieneComprobante: true }, VIAJE), /adjuntaste/);
  assert.match(v.validarGasto({ categoria: 'peaje', monto: 10, fecha: '2026-09-03', sin_comprobante: true, descripcion: '' }, VIAJE), /nota/);
});

test('resumen: saldo = adelantos − gastos, por persona y categoría, km', () => {
  const r = v.resumenViaje({
    participantes: [{ empleado_id: 8, nombre: 'Roberto' }, { empleado_id: 11, nombre: 'Walter' }],
    gastos: [
      { empleado_id: 8, categoria: 'combustible', monto: '60000', sin_comprobante: false, revision: 'revisado' },
      { empleado_id: 8, categoria: 'comida', monto: '4500.50', sin_comprobante: true, revision: 'observado' },
      { empleado_id: 11, categoria: 'alojamiento', monto: '80000', sin_comprobante: false, revision: 'pendiente' },
    ],
    adelantos: [{ empleado_id: 8, monto: '100000' }],
    vehiculos: [{ odometro_salida: '120000', odometro_llegada: '120980.5' }, { odometro_salida: '5000', odometro_llegada: null }],
  });
  assert.equal(r.total, 144500.5);
  assert.equal(r.total_adelantos, 100000);
  assert.equal(r.km, 980.5);
  assert.deepEqual(r.por_categoria, { combustible: 60000, comida: 4500.5, alojamiento: 80000 });
  const rob = r.por_persona.find(p => p.empleado_id === 8);
  assert.deepEqual([rob.gastos, rob.con_comprobante, rob.sin_comprobante, rob.adelantos, rob.saldo, rob.observados], [64500.5, 60000, 4500.5, 100000, 35499.5, 1]);
  const wal = r.por_persona.find(p => p.empleado_id === 11);
  assert.equal(wal.saldo, -80000); // la empresa le debe
});
