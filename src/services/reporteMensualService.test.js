// npm test — reglas de la firma del reporte mensual (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./reporteMensualService');

test('mes cerrado anterior, incluido el cambio de año', () => {
  assert.deepEqual(s.mesCerradoAnterior('2026-11-02'), { anio: 2026, mes: 10 });
  assert.deepEqual(s.mesCerradoAnterior('2027-01-01'), { anio: 2026, mes: 12 });
});

test('meses que toca un rango de fechas', () => {
  assert.deepEqual(s.periodosDeFechas(['2026-10-30', '2026-11-03']), [{ anio: 2026, mes: 10 }, { anio: 2026, mes: 11 }]);
  assert.deepEqual(s.periodosDeFechas(['2026-10-05']), [{ anio: 2026, mes: 10 }]);
  assert.deepEqual(s.periodosDeFechas([new Date('2026-12-31T00:00:00Z'), '2027-01-02']), [{ anio: 2026, mes: 12 }, { anio: 2027, mes: 1 }]);
  assert.deepEqual(s.periodosDeFechas([null]), []);
});

test('estado del reporte: el error marcado manda sobre las firmas', () => {
  assert.equal(s.estadoReporte({ objecionesPendientes: 0 }), 'sin_firmar');
  assert.equal(s.estadoReporte({ firmadoEmpleadoEn: 'x', objecionesPendientes: 0 }), 'firmado_empleado');
  assert.equal(s.estadoReporte({ firmadoEmpleadoEn: 'x', firmadoAdminEn: 'y', objecionesPendientes: 0 }), 'cerrado');
  assert.equal(s.estadoReporte({ firmadoAdminEn: 'y', objecionesPendientes: 0 }), 'sin_firmar');
  assert.equal(s.estadoReporte({ firmadoEmpleadoEn: 'x', objecionesPendientes: 1 }), 'incoherencia');
});

test('aviso del cron: al cerrar una vez, recordatorio diario desde el día 4, de 9 a 20', () => {
  const base = { diaDelMes: 1, minAhora: 9 * 60, estado: 'sin_firmar', yaAvisoCierre: false, yaAvisoHoy: false };
  assert.equal(s.avisoQueCorresponde(base), 'cierre');
  assert.equal(s.avisoQueCorresponde({ ...base, minAhora: 8 * 60 + 59 }), null);
  assert.equal(s.avisoQueCorresponde({ ...base, minAhora: 20 * 60 }), null);
  assert.equal(s.avisoQueCorresponde({ ...base, yaAvisoCierre: true }), null);
  assert.equal(s.avisoQueCorresponde({ ...base, diaDelMes: 4, yaAvisoCierre: true }), 'recordatorio');
  assert.equal(s.avisoQueCorresponde({ ...base, diaDelMes: 4, yaAvisoCierre: true, yaAvisoHoy: true }), null);
  assert.equal(s.avisoQueCorresponde({ ...base, estado: 'firmado_empleado' }), null);
  assert.equal(s.avisoQueCorresponde({ ...base, estado: 'incoherencia' }), null);
  // Publicado a mitad de mes: el aviso de cierre sale igual (una vez)
  assert.equal(s.avisoQueCorresponde({ ...base, diaDelMes: 15 }), 'cierre');
});

test('huella: ignora legajo y fotos, detecta horas cambiadas', () => {
  const rep = { empleado: { ultima_sincronizacion: 'a' }, dias: [{ dia: 1, ingreso: '07:00', egreso: '15:00', horasTrabajadas: 8, fotoIngreso: 'u1' }],
    totales: { horas_trabajadas: 8, banco_horas_acumulado_al_mes: 3 } };
  const igual = { ...rep, empleado: { ultima_sincronizacion: 'b' }, dias: [{ ...rep.dias[0], fotoIngreso: 'u2' }],
    totales: { ...rep.totales, banco_horas_acumulado_al_mes: 9 } };
  assert.equal(s.huellaReporte(rep), s.huellaReporte(igual));
  const corregido = { ...rep, dias: [{ ...rep.dias[0], egreso: '17:00', horasTrabajadas: 10 }], totales: { horas_trabajadas: 10 } };
  assert.notEqual(s.huellaReporte(rep), s.huellaReporte(corregido));
});

test('textos de los avisos', () => {
  assert.equal(s.textos.cierre(2026, 10).titulo, '📄 Cerró octubre: firmá tu reporte de horas');
  assert.equal(s.textos.anulado(2026, 10).accion, 'ver_reporte');
});
