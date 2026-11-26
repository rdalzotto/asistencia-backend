// riesgo5x5.js — Valoración del riesgo de los desvíos, IGUAL a EXIT Riesgos
// (matriz 5x5: probabilidad × severidad). Pedido de Rogelio, 26/11/2026: que
// la constancia de visita valore el riesgo con el mismo criterio que el
// análisis de riesgos.
//
// Copia de RiesgoForestal/compartido/src/config/predeterminada.ts
// (ESCALA_PROBABILIDAD_5X5, ESCALA_SEVERIDAD_PERSONAS_5X5, CLASIFICACION_5X5 y
// REGLAS_PISO.MATRIZ_5X5). Si allá cambian, hay que cambiarlo acá también.
// Funciona en el navegador (window.Riesgo5x5) y en Node (para las pruebas).

(function (raiz) {
  const PROBABILIDAD = [
    { valor: 1, nombre: 'Rara', descripcion: 'No se espera que ocurra. No hay antecedentes en tareas y condiciones similares.' },
    { valor: 2, nombre: 'Improbable', descripcion: 'Podría ocurrir alguna vez. Hay antecedentes aislados en el rubro.' },
    { valor: 3, nombre: 'Posible', descripcion: 'Puede ocurrir en algún momento. Hay antecedentes ocasionales en la empresa o en el rubro.' },
    { valor: 4, nombre: 'Probable', descripcion: 'Es probable que ocurra. Hay antecedentes frecuentes en el rubro o en la empresa.' },
    { valor: 5, nombre: 'Casi segura', descripcion: 'Se espera que ocurra en la mayoría de las jornadas. Pasa con regularidad.' },
  ];
  const SEVERIDAD = [
    { valor: 1, nombre: 'Insignificante', descripcion: 'Primeros auxilios. Sin pérdida de jornada.' },
    { valor: 2, nombre: 'Menor', descripcion: 'Lesión con atención médica y baja corta. Recuperación total.' },
    { valor: 3, nombre: 'Moderada', descripcion: 'Lesión con baja prolongada. Recuperación total.' },
    { valor: 4, nombre: 'Mayor', descripcion: 'Incapacidad permanente, parcial o total.' },
    { valor: 5, nombre: 'Catastrófica', descripcion: 'Muerte o lesiones graves de varias personas.' },
  ];
  const NIVELES = [
    { codigo: 'BAJO', nombre: 'Bajo', desde: 1, hasta: 4, fondo: '#1B7F3B', texto: '#FFFFFF', plazoDias: null, accion: 'Seguimiento. Mantener los controles.' },
    { codigo: 'MEDIO', nombre: 'Medio', desde: 5, hasta: 9, fondo: '#F2C200', texto: '#000000', plazoDias: 90, accion: 'Acción correctiva dentro de los 90 días.' },
    { codigo: 'ALTO', nombre: 'Alto', desde: 10, hasta: 16, fondo: '#E36C0A', texto: '#000000', plazoDias: 30, accion: 'Acción correctiva dentro de los 30 días. Verificar los controles críticos.' },
    { codigo: 'CRITICO', nombre: 'Crítico', desde: 20, hasta: 25, fondo: '#B00020', texto: '#FFFFFF', plazoDias: 0, accion: 'Acción inmediata. Suspender la tarea hasta controlarlo.' },
  ];
  // Regla de piso: severidad catastrófica nunca menos que Alto.
  const PISO = { severidadDesde: 5, nivelMinimo: 'ALTO', motivo: 'Consecuencia catastrófica: nunca menos que alto, aunque la probabilidad sea baja.' };

  const nivelPorCodigo = (c) => NIVELES.find((n) => n.codigo === c) || null;

  /** Probabilidad y severidad (1 a 5) → { puntaje, nivel, piso }. null si falta alguna. */
  function evaluar(probabilidad, severidad) {
    const p = Number(probabilidad), s = Number(severidad);
    if (!(p >= 1 && p <= 5 && s >= 1 && s <= 5) || !Number.isInteger(p) || !Number.isInteger(s)) return null;
    const puntaje = p * s;
    let nivel = NIVELES.find((n) => puntaje >= n.desde && puntaje <= n.hasta) || NIVELES[NIVELES.length - 1];
    let piso = null;
    if (s >= PISO.severidadDesde) {
      const minimo = nivelPorCodigo(PISO.nivelMinimo);
      if (NIVELES.indexOf(nivel) < NIVELES.indexOf(minimo)) { nivel = minimo; piso = PISO.motivo; }
    }
    return { puntaje, nivel, piso };
  }

  /** Texto del plazo según el nivel, contado desde `desde` (fecha). */
  function plazoSugerido(nivel, desde) {
    if (!nivel) return '';
    if (nivel.plazoDias === null) return 'Seguimiento';
    if (nivel.plazoDias === 0) return 'Inmediato — suspender la tarea hasta controlarlo';
    const d = new Date(desde || Date.now());
    d.setDate(d.getDate() + nivel.plazoDias);
    const f = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    return nivel.plazoDias + ' días (hasta el ' + f + ')';
  }

  /** Gravedad vieja (BAJA/MEDIA/ALTA) que siguen usando otras pantallas, a partir del nivel. */
  function severidadAnterior(codigo) {
    return codigo === 'BAJO' ? 'BAJA' : codigo === 'MEDIO' ? 'MEDIA' : codigo ? 'ALTA' : 'MEDIA';
  }

  // Frentes de trabajo: mismos nombres que los niveles. Los valores viejos se leen igual.
  const FRENTE = { 'Bajo riesgo': 'BAJO', 'Riesgo moderado': 'MEDIO', 'Riesgo medio': 'MEDIO', 'Alto riesgo': 'ALTO', 'Riesgo alto': 'ALTO', 'Riesgo bajo': 'BAJO', 'Riesgo crítico': 'CRITICO' };
  const nivelDeFrente = (texto) => nivelPorCodigo(FRENTE[texto] || '');

  const api = { PROBABILIDAD, SEVERIDAD, NIVELES, PISO, evaluar, plazoSugerido, severidadAnterior, nivelPorCodigo, nivelDeFrente };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Riesgo5x5 = api;
})(typeof window !== 'undefined' ? window : globalThis);
