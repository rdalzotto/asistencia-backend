// Prueba de public/js/riesgo5x5.js: tiene que dar lo mismo que la matriz 5x5
// de EXIT Riesgos (RiesgoForestal/compartido).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/js/riesgo5x5.js');

test('probabilidad × severidad da el nivel de EXIT Riesgos', () => {
  assert.equal(R.evaluar(1, 1).nivel.codigo, 'BAJO');
  assert.equal(R.evaluar(2, 2).nivel.codigo, 'BAJO');
  assert.equal(R.evaluar(1, 4).nivel.codigo, 'BAJO');
  assert.equal(R.evaluar(3, 3).nivel.codigo, 'MEDIO');
  assert.equal(R.evaluar(5, 1).nivel.codigo, 'MEDIO');
  assert.equal(R.evaluar(4, 3).nivel.codigo, 'ALTO');
  assert.equal(R.evaluar(4, 4).nivel.codigo, 'ALTO');
  assert.equal(R.evaluar(4, 5).nivel.codigo, 'CRITICO');
  assert.equal(R.evaluar(5, 5).puntaje, 25);
});

test('severidad catastrófica nunca menos que Alto', () => {
  const r = R.evaluar(1, 5);
  assert.equal(r.puntaje, 5);
  assert.equal(r.nivel.codigo, 'ALTO');
  assert.ok(r.piso);
  assert.equal(R.evaluar(2, 5).nivel.codigo, 'ALTO');
  assert.equal(R.evaluar(2, 4).piso, null);
});

test('sin datos o fuera de rango no evalúa', () => {
  assert.equal(R.evaluar(null, 3), null);
  assert.equal(R.evaluar(0, 3), null);
  assert.equal(R.evaluar(3, 6), null);
});

test('plazo sugerido y gravedad vieja', () => {
  assert.equal(R.plazoSugerido(R.nivelPorCodigo('BAJO')), 'Seguimiento');
  assert.match(R.plazoSugerido(R.nivelPorCodigo('CRITICO')), /^Inmediato/);
  assert.equal(R.plazoSugerido(R.nivelPorCodigo('ALTO'), new Date(2026, 10, 26)), '30 días (hasta el 26/12/2026)');
  assert.equal(R.severidadAnterior('CRITICO'), 'ALTA');
  assert.equal(R.severidadAnterior('MEDIO'), 'MEDIA');
  assert.equal(R.nivelDeFrente('Riesgo moderado').codigo, 'MEDIO');
});
