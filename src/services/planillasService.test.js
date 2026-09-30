const test = require('node:test');
const assert = require('node:assert');
const s = require('./planillasService');
const { MODULOS, PLANTILLAS, itemsDeModulo } = require('../data/catalogoAgro');

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('índice ponderado: un crítico pesa 3, un menor 1', () => {
  const r = s.resumir([
    { resultado: 'C', criticidad: 3 },
    { resultado: 'NC', criticidad: 1 },
  ]);
  assert.strictEqual(r.puntos, 1);
  assert.strictEqual(r.puntos_max, 4);
  assert.strictEqual(r.indice, 25);
});

test('No aplica y No verificado no cuentan para el índice', () => {
  const r = s.resumir([
    { resultado: 'C', criticidad: 2 },
    { resultado: 'NA', criticidad: 1 },
    { resultado: 'NV', criticidad: 1 },
  ]);
  assert.strictEqual(r.indice, 100);
  assert.strictEqual(r.NA, 1);
  assert.strictEqual(r.NV, 1);
  assert.strictEqual(r.total, 3);
});

test('sin ítems aplicables no hay índice', () => {
  const r = s.resumir([{ resultado: 'NA', criticidad: 2 }]);
  assert.strictEqual(r.indice, null);
  assert.strictEqual(r.calificacion, 'sin_datos');
});

test('regla de corte: un crítico abierto deja la calificación en deficiente', () => {
  const rs = Array.from({ length: 30 }, () => ({ resultado: 'C', criticidad: 1 }));
  rs.push({ resultado: 'NC', criticidad: 1 });
  const r = s.resumir(rs);
  assert.ok(r.indice > 90);
  assert.strictEqual(r.calificacion, 'deficiente');
});

test('bandas de calificación sin críticos', () => {
  assert.strictEqual(s.calificar(90, 0), 'satisfactorio');
  assert.strictEqual(s.calificar(89.9, 0), 'aceptable');
  assert.strictEqual(s.calificar(75, 0), 'aceptable');
  assert.strictEqual(s.calificar(74.9, 0), 'deficiente');
});

test('ítem libre sin criticidad pesa como importante', () => {
  const r = s.resumir([{ resultado: 'C' }, { resultado: 'NC', criticidad: 3 }]);
  assert.strictEqual(r.puntos_max, 3);
  assert.strictEqual(r.indice, 66.7);
});

test('resumen por módulo agrupa las instancias repetidas', () => {
  const inst = [
    { id: 'a', modulo_codigo: 'M1', modulo_nombre: 'Vivienda' },
    { id: 'b', modulo_codigo: 'M1', modulo_nombre: 'Vivienda' },
    { id: 'c', modulo_codigo: 'M2', modulo_nombre: 'Tractor' },
  ];
  const resp = [
    { instancia_id: 'a', resultado: 'C', criticidad: 2 },
    { instancia_id: 'b', resultado: 'NC', criticidad: 2 },
    { instancia_id: 'c', resultado: 'C', criticidad: 1 },
  ];
  const r = s.resumirRelevamiento(inst, resp);
  const m1 = r.modulos.find(m => m.modulo_codigo === 'M1');
  assert.strictEqual(m1.instancias, 2);
  assert.strictEqual(m1.indice, 50);
  assert.strictEqual(r.total.indice, 71.4);
});

test('plazos sugeridos: crítico en el día, importante 30, menor 90', () => {
  assert.strictEqual(s.plazoSugerido(1, '2026-10-01'), '2026-10-01');
  assert.strictEqual(s.plazoSugerido(2, '2026-10-01'), '2026-10-31');
  assert.strictEqual(s.plazoSugerido(3, '2026-12-15'), '2027-03-15');
});

test('validación: acepta un envío correcto', () => {
  const e = s.validarEnvio({
    relevamiento: { id: U(1), destino_id: 5, nivel: 'B' },
    instancias: [{ id: U(2), modulo_codigo: 'M2' }],
    respuestas: [{ id: U(3), instancia_id: U(2), resultado: 'NC', criticidad: 1, item_texto: 'ROPS', fotos: [U(9)] }],
    seguimientos: [{ id: U(4), accion_id: 7, resultado: 'corregido' }],
  });
  assert.deepStrictEqual(e, []);
});

test('validación: rechaza No cumple sin criticidad y respuestas huérfanas', () => {
  const e = s.validarEnvio({
    relevamiento: { id: U(1), destino_id: 5 },
    instancias: [{ id: U(2), modulo_codigo: 'M2' }],
    respuestas: [
      { id: U(3), instancia_id: U(2), resultado: 'NC', item_texto: 'x' },
      { id: U(4), instancia_id: U(8), resultado: 'C', item_texto: 'y' },
      { id: 'no-uuid', instancia_id: U(2), resultado: 'XX', item_texto: '' },
    ],
  });
  assert.ok(e.some(x => x.includes('necesita criticidad')));
  assert.ok(e.some(x => x.includes('no pertenece')));
  assert.ok(e.some(x => x.includes('resultado inválido')));
  assert.ok(e.some(x => x.includes('id inválido')));
});

test('validación: pide establecimiento', () => {
  const e = s.validarEnvio({ relevamiento: { id: U(1) } });
  assert.ok(e.includes('Falta el establecimiento'));
});

test('seguimiento: corregido verifica, en curso acuerda una propuesta', () => {
  assert.strictEqual(s.estadoTrasSeguimiento('acordada', 'corregido'), 'verificada');
  assert.strictEqual(s.estadoTrasSeguimiento('propuesta', 'en_curso'), 'acordada');
  assert.strictEqual(s.estadoTrasSeguimiento('acordada', 'sin_cambios'), 'acordada');
});

test('catálogo: códigos únicos, valores válidos y plantillas con módulos existentes', () => {
  const codigosMod = new Set();
  for (const m of MODULOS) {
    assert.ok(!codigosMod.has(m.codigo), `módulo repetido ${m.codigo}`);
    codigosMod.add(m.codigo);
    const vistos = new Set();
    for (const it of itemsDeModulo(m)) {
      assert.ok(!vistos.has(it.codigo), `ítem repetido ${it.codigo}`);
      vistos.add(it.codigo);
      assert.ok(['L', 'BP', 'C'].includes(it.tipo), `tipo inválido en ${it.codigo}`);
      assert.ok([1, 2, 3].includes(it.criticidad), `criticidad inválida en ${it.codigo}`);
      assert.ok(['B', 'A', 'C'].includes(it.nivel), `nivel inválido en ${it.codigo}`);
      assert.ok(it.texto && it.ref_normativa, `falta texto o referencia en ${it.codigo}`);
    }
    if (m.repetible) assert.ok(m.campos.some(c => c.clave === 'nombre'), `${m.codigo} repetible sin campo nombre`);
  }
  for (const p of PLANTILLAS) for (const c of p.modulos) assert.ok(codigosMod.has(c), `${p.codigo} usa ${c} inexistente`);
});

test('catálogo: ninguna cita al Dec. 617/97 pasa del art. 50', () => {
  for (const m of MODULOS) for (const it of itemsDeModulo(m)) {
    const ref = it.ref_normativa;
    const tramo = ref.match(/Dec\. 617\/97 arts?\. ([^·]+)/);
    if (!tramo) continue;
    const nums = (tramo[1].match(/\d+/g) || []).map(Number);
    for (const n of nums) assert.ok(n >= 1 && n <= 50, `${it.codigo} cita art. ${n}`);
  }
});

test('fotos: se validan en ítems, módulos y seguimientos (máximo 20)', () => {
  const base = {
    relevamiento: { id: U(1), destino_id: 5 },
    instancias: [{ id: U(2), modulo_codigo: 'M1', fotos: [U(10)] }],
    respuestas: [{ id: U(3), instancia_id: U(2), resultado: 'C', item_texto: 'x', fotos: [U(11)] }],
    seguimientos: [{ id: U(4), accion_id: 7, resultado: 'corregido', fotos: [U(12)] }],
  };
  assert.deepStrictEqual(s.validarEnvio(base), []);
  const mal = JSON.parse(JSON.stringify(base));
  mal.instancias[0].fotos = ['no-uuid'];
  mal.seguimientos[0].fotos = Array.from({ length: 21 }, (_, n) => U(100 + n));
  const e = s.validarEnvio(mal);
  assert.ok(e.some(x => x.startsWith('Módulo 1: fotos')));
  assert.ok(e.some(x => x.startsWith('Seguimiento 1: fotos')));
});

test('evolución de un ítem entre visitas', () => {
  assert.strictEqual(s.evolucion('NC', 'C'), 'mejoro');
  assert.strictEqual(s.evolucion('C', 'NC'), 'empeoro');
  assert.strictEqual(s.evolucion('NC', 'NC'), 'sigue_nc');
  assert.strictEqual(s.evolucion('C', 'C'), 'sigue_c');
  assert.strictEqual(s.evolucion('NA', 'C'), null);
  assert.strictEqual(s.evolucion(undefined, 'NC'), null);
});

test('comparación con la visita anterior usa los mismos ítems', () => {
  const c = s.comparar([
    { antes: { resultado: 'NC', criticidad: 1 }, ahora: { resultado: 'C', criticidad: 1 } },   // mejoró (peso 3)
    { antes: { resultado: 'C', criticidad: 3 }, ahora: { resultado: 'NC', criticidad: 3 } },   // empeoró (peso 1)
    { antes: { resultado: 'NC', criticidad: 2 }, ahora: { resultado: 'NC', criticidad: 2 } },  // sigue (peso 2)
    { antes: null, ahora: { resultado: 'NC', criticidad: 2 } },                                  // nuevo: no comparable
    { antes: { resultado: 'NV', criticidad: 2 }, ahora: { resultado: 'C', criticidad: 2 } },   // no comparable
  ]);
  assert.strictEqual(c.comparables, 3);
  assert.deepStrictEqual([c.mejoro, c.empeoro, c.sigue_nc, c.sigue_c], [1, 1, 1, 0]);
  assert.strictEqual(c.indice_antes, 16.7);  // 1 de 6
  assert.strictEqual(c.indice_ahora, 50);    // 3 de 6
});
