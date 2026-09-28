// ausenciasService.js — Reglas de avisos de ausencia (28/09/2026)
//
// Pedido de Rogelio: que el aviso de una ausencia quede registrado en el
// sistema (fecha, hora y por qué canal llegó), que el certificado se suba a
// la app, y que el sistema pregunte si alguien no fichó ni avisó.
// Funciones puras (sin base): se prueban con `npm test`.

// Cuánto después de la hora de entrada se pregunta "¿qué pasa hoy?" si no
// hay ingreso ni aviso. Hasta VENTANA_SIN_INGRESO_MIN después ya no se avisa
// (si el servidor estuvo caído a esa hora, no tiene sentido avisar a la tarde).
const MARGEN_SIN_INGRESO_MIN = 30;
const VENTANA_SIN_INGRESO_MIN = 240;

// Plazo para subir el certificado o comprobante, desde que se carga la ausencia.
const PLAZO_CERTIFICADO_HORAS = 48;

// Tipos que exigen un comprobante: certificado médico o la documentación de la
// licencia especial (acta, constancia de examen, etc.).
const TIPOS_CON_COMPROBANTE = new Set([
  'enfermedad_certificada',
  'licencia_matrimonio',
  'licencia_nacimiento',
  'licencia_fallecimiento',
  'licencia_examen',
]);

// Cómo le llegó el aviso al empleador cuando lo carga un admin a nombre del
// empleado ("me avisó anoche por WhatsApp").
const CANALES_AVISO = ['whatsapp', 'telefono', 'personal', 'email', 'otro'];

// Archivos aceptados para el certificado (foto del celular o PDF).
const TIPOS_ARCHIVO = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const MAX_ARCHIVO_BYTES = 8 * 1024 * 1024;

// Condición SQL de "certificado vigente" de la ausencia `a` (alias `c` para
// ausencia_certificados): los subidos antes de que el admin lo observara
// ("Pedir otro certificado") no cuentan.
const SQL_CERTIFICADO_VIGENTE =
  "c.ausencia_id = a.id AND c.subido_en > COALESCE(a.certificado_observado_en, '-infinity'::timestamptz)";

// Motivo obligatorio al pedir otro certificado (lo lee el empleado).
function validarObservacion(motivo) {
  const texto = typeof motivo === 'string' ? motivo.trim() : '';
  if (!texto) return { ok: false, error: 'Escribí por qué no sirve el certificado' };
  if (texto.length > 500) return { ok: false, error: 'El motivo admite hasta 500 caracteres' };
  return { ok: true, motivo: texto };
}

function requiereComprobante(tipo) {
  return TIPOS_CON_COMPROBANTE.has(tipo);
}

function venceCertificado(desde = new Date()) {
  return new Date(desde.getTime() + PLAZO_CERTIFICADO_HORAS * 60 * 60 * 1000);
}

// 'HH:MM' o 'HH:MM:SS' -> minutos desde medianoche; null si no hay hora.
function minutosDe(hora) {
  if (!hora) return null;
  const [h, m] = String(hora).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Hora de entrada esperada para un día (1=lun ... 7=dom, como jornadas_por_dia
// y dias_laborables). Si el empleado tiene horario propio para ese día, manda
// ese (y si esa fila no tiene hora, ese día no trabaja). Si no, la jornada
// general, solo en sus días laborables. Jornada partida: la hora de la mañana.
function horaIngresoDelDia({ diaSemana, porDia, general }) {
  if (porDia) {
    return porDia.hora_ingreso || porDia.hora_man_inicio || null;
  }
  if (!general) return null;
  const dias = Array.isArray(general.dias_laborables) ? general.dias_laborables.map(Number) : [1, 2, 3, 4, 5, 6];
  if (!dias.includes(Number(diaSemana))) return null;
  return general.hora_ingreso || general.hora_maniana_inicio || null;
}

// ¿Corresponde preguntar ahora? Entre ingreso + margen y el fin de la ventana.
function debeAvisarSinIngreso(minAhora, horaIngreso) {
  const ingreso = minutosDe(horaIngreso);
  if (ingreso === null) return false;
  return minAhora >= ingreso + MARGEN_SIN_INGRESO_MIN && minAhora <= ingreso + VENTANA_SIN_INGRESO_MIN;
}

// Día de la semana (1=lun ... 7=dom) de una fecha 'YYYY-MM-DD'.
function diaSemanaDe(fechaStr) {
  const d = new Date(`${fechaStr}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

// Validación del alta de una ausencia. `esAdmin` habilita cargarla a nombre
// de un empleado, y en ese caso el canal por el que avisó es obligatorio.
function validarAusencia(body, { esAdmin }) {
  const tipo = typeof body.tipo === 'string' ? body.tipo : '';
  const fechaInicio = typeof body.fecha_inicio === 'string' ? body.fecha_inicio : '';
  const fechaFin = typeof body.fecha_fin === 'string' && body.fecha_fin ? body.fecha_fin : fechaInicio;
  if (!tipo || !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio)) return { ok: false, error: 'Datos incompletos' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaFin) || fechaFin < fechaInicio) {
    return { ok: false, error: 'La fecha "hasta" no puede ser anterior a "desde"' };
  }

  const aNombreDe = body.empleado_id !== undefined && body.empleado_id !== null && body.empleado_id !== '';
  if (aNombreDe && !esAdmin) return { ok: false, error: 'Solo un administrador carga ausencias a nombre de otro' };

  let canal = 'app';
  let avisoRecibidoEn = null;
  if (aNombreDe) {
    if (!CANALES_AVISO.includes(body.canal_aviso)) {
      return { ok: false, error: 'Indicá por dónde avisó (WhatsApp, teléfono, en persona, email u otro)' };
    }
    canal = body.canal_aviso;
    if (body.aviso_recibido_en) {
      const d = new Date(body.aviso_recibido_en);
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'La fecha y hora del aviso no es válida' };
      if (d.getTime() > Date.now() + 5 * 60 * 1000) return { ok: false, error: 'El aviso no puede ser en el futuro' };
      avisoRecibidoEn = d;
    }
  }

  return {
    ok: true,
    datos: {
      tipo,
      fechaInicio,
      fechaFin,
      empleadoId: aNombreDe ? Number(body.empleado_id) : null,
      canal,
      avisoRecibidoEn,
      descripcion: typeof body.descripcion === 'string' && body.descripcion.trim() ? body.descripcion.trim() : null,
      requiereComprobante: requiereComprobante(tipo),
    },
  };
}

function validarArchivo(archivo) {
  if (!archivo) return { ok: false, error: 'Falta el archivo' };
  if (!TIPOS_ARCHIVO.has(archivo.mimetype)) return { ok: false, error: 'Subí una foto (JPG, PNG, HEIC) o un PDF' };
  if (archivo.size > MAX_ARCHIVO_BYTES) return { ok: false, error: 'El archivo supera los 8 MB' };
  return { ok: true };
}

module.exports = {
  MARGEN_SIN_INGRESO_MIN,
  VENTANA_SIN_INGRESO_MIN,
  PLAZO_CERTIFICADO_HORAS,
  CANALES_AVISO,
  MAX_ARCHIVO_BYTES,
  SQL_CERTIFICADO_VIGENTE,
  validarObservacion,
  requiereComprobante,
  venceCertificado,
  minutosDe,
  horaIngresoDelDia,
  debeAvisarSinIngreso,
  diaSemanaDe,
  validarAusencia,
  validarArchivo,
};
