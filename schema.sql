-- ============================================================
-- AsistenciaAR — Esquema completo PostgreSQL
-- Compatible con Supabase (public schema)
-- ============================================================

-- Limpiar si existe (orden inverso por dependencias)
DROP TABLE IF EXISTS public.banco_horas CASCADE;
DROP TABLE IF EXISTS public.compensaciones CASCADE;
DROP TABLE IF EXISTS public.ausencias CASCADE;
DROP TABLE IF EXISTS public.vacaciones_tomadas CASCADE;
DROP TABLE IF EXISTS public.push_subscriptions CASCADE;
DROP TABLE IF EXISTS public.movimientos CASCADE;
DROP TABLE IF EXISTS public.solicitudes_externas CASCADE;
DROP TABLE IF EXISTS public.destinos_externos CASCADE;
DROP TABLE IF EXISTS public.empleados CASCADE;
DROP TABLE IF EXISTS public.invitaciones CASCADE;
DROP TABLE IF EXISTS public.usuarios CASCADE;
DROP TABLE IF EXISTS public.jornadas_config CASCADE;
DROP TABLE IF EXISTS public.convenios CASCADE;
DROP TABLE IF EXISTS public.empleadores CASCADE;
DROP TABLE IF EXISTS public.feriados CASCADE;
DROP TABLE IF EXISTS public.categorias_salida CASCADE;

-- ============================================================
-- FERIADOS NACIONALES
-- ============================================================
CREATE TABLE public.feriados (
  id          SERIAL PRIMARY KEY,
  fecha       DATE NOT NULL UNIQUE,
  descripcion TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'inamovible' -- inamovible | trasladable | puente | no_laborable
);

-- Feriados 2025 (Decreto 4/2025)
INSERT INTO public.feriados (fecha, descripcion, tipo) VALUES
  ('2025-01-01', 'Año Nuevo', 'inamovible'),
  ('2025-03-03', 'Carnaval', 'inamovible'),
  ('2025-03-04', 'Carnaval', 'inamovible'),
  ('2025-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'inamovible'),
  ('2025-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'inamovible'),
  ('2025-04-18', 'Viernes Santo', 'inamovible'),
  ('2025-05-01', 'Día del Trabajador', 'inamovible'),
  ('2025-05-25', 'Día de la Revolución de Mayo', 'inamovible'),
  ('2025-06-16', 'Paso a la Inmortalidad del Gral. Don Martín Miguel de Güemes', 'trasladable'),
  ('2025-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano', 'inamovible'),
  ('2025-07-09', 'Día de la Independencia', 'inamovible'),
  ('2025-08-17', 'Paso a la Inmortalidad del Gral. Don José de San Martín', 'trasladable'),
  ('2025-10-12', 'Día del Respeto a la Diversidad Cultural', 'trasladable'),
  ('2025-11-20', 'Día de la Soberanía Nacional', 'trasladable'),
  ('2025-12-08', 'Inmaculada Concepción de María', 'inamovible'),
  ('2025-12-25', 'Navidad', 'inamovible');

-- Feriados 2026
INSERT INTO public.feriados (fecha, descripcion, tipo) VALUES
  ('2026-01-01', 'Año Nuevo', 'inamovible'),
  ('2026-02-16', 'Carnaval', 'inamovible'),
  ('2026-02-17', 'Carnaval', 'inamovible'),
  ('2026-03-23', 'Feriado puente turístico', 'puente'),
  ('2026-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'inamovible'),
  ('2026-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'inamovible'),
  ('2026-04-03', 'Viernes Santo', 'inamovible'),
  ('2026-05-01', 'Día del Trabajador', 'inamovible'),
  ('2026-05-25', 'Día de la Revolución de Mayo', 'inamovible'),
  ('2026-06-15', 'Paso a la Inmortalidad del Gral. Don Martín Miguel de Güemes', 'trasladable'),
  ('2026-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano', 'inamovible'),
  ('2026-07-09', 'Día de la Independencia', 'inamovible'),
  ('2026-08-16', 'Paso a la Inmortalidad del Gral. Don José de San Martín', 'trasladable'),
  ('2026-10-12', 'Día del Respeto a la Diversidad Cultural', 'trasladable'),
  ('2026-11-20', 'Día de la Soberanía Nacional', 'trasladable'),
  ('2026-12-08', 'Inmaculada Concepción de María', 'inamovible'),
  ('2026-12-25', 'Navidad', 'inamovible');

-- ============================================================
-- CONVENIOS COLECTIVOS
-- ============================================================
CREATE TABLE public.convenios (
  id                        SERIAL PRIMARY KEY,
  nombre                    TEXT NOT NULL,
  numero                    TEXT,                    -- ej: "130/75" para Empleados de Comercio
  descripcion               TEXT,
  horas_diarias             NUMERIC(4,2) DEFAULT 8,
  horas_semanales           NUMERIC(5,2) DEFAULT 48,
  tolerancia_tardanza_min   INTEGER DEFAULT 10,      -- minutos LCT Art.57
  max_hs_extra_dia          NUMERIC(4,2) DEFAULT 3,  -- Decreto 484/2000
  max_hs_extra_mes          NUMERIC(5,2) DEFAULT 30,
  max_hs_extra_anio         NUMERIC(6,2) DEFAULT 200,
  recargo_extra_habitual    NUMERIC(6,2) DEFAULT 50, -- % recargo días hábiles
  recargo_extra_festivo     NUMERIC(6,2) DEFAULT 100,-- % recargo domingos/feriados
  -- Vacaciones (Empleados de Comercio / LCT)
  vacaciones_hasta_5_anios  INTEGER DEFAULT 14,      -- días corridos
  vacaciones_hasta_10_anios INTEGER DEFAULT 21,
  vacaciones_hasta_20_anios INTEGER DEFAULT 28,
  vacaciones_mas_20_anios   INTEGER DEFAULT 35,
  -- Licencias especiales (días hábiles)
  licencia_matrimonio       INTEGER DEFAULT 10,
  licencia_nacimiento       INTEGER DEFAULT 2,
  licencia_fallecimiento_familiar_directo INTEGER DEFAULT 3,
  licencia_fallecimiento_familiar_indirecto INTEGER DEFAULT 1,
  licencia_examen           INTEGER DEFAULT 2,
  -- Enfermedad
  enfermedad_max_dias_sin_cert INTEGER DEFAULT 3,
  -- Texto completo del convenio (para IA)
  texto_convenio            TEXT,
  es_default                BOOLEAN DEFAULT FALSE,
  creado_en                 TIMESTAMPTZ DEFAULT NOW()
);

-- Convenio por defecto: Empleados de Comercio
INSERT INTO public.convenios (
  nombre, numero, descripcion, es_default
) VALUES (
  'Empleados de Comercio',
  '130/75',
  'Convenio Colectivo de Trabajo N° 130/75 — Federación Argentina de Empleados de Comercio y Servicios (FAECYS)',
  TRUE
);

-- ============================================================
-- EMPLEADORES (empresas que usan el sistema)
-- ============================================================
CREATE TABLE public.empleadores (
  id                SERIAL PRIMARY KEY,
  razon_social      TEXT NOT NULL,
  nombre_fantasia   TEXT,
  cuit              TEXT NOT NULL UNIQUE,
  domicilio         TEXT,
  localidad         TEXT,
  provincia         TEXT,
  codigo_postal     TEXT,
  telefono          TEXT,
  email             TEXT,
  actividad         TEXT,
  nro_inscripcion   TEXT,            -- inscripción Ministerio de Trabajo
  logo_url          TEXT,            -- Supabase Storage
  -- Configuración visual (marca blanca)
  color_primario    TEXT DEFAULT '#1a56db',
  color_secundario  TEXT DEFAULT '#0e9f6e',
  nombre_sistema    TEXT DEFAULT 'AsistenciaAR',
  -- Ubicación de la oficina para geofencing
  oficina_lat       NUMERIC(10,7),
  oficina_lng       NUMERIC(10,7),
  oficina_radio_m   INTEGER DEFAULT 200,
  -- Convenio activo
  convenio_id       INTEGER REFERENCES public.convenios(id) DEFAULT 1,
  -- Configuración de notificaciones
  emails_admin      TEXT[],          -- array de emails que reciben alertas
  zona_horaria      TEXT DEFAULT 'America/Argentina/Buenos_Aires',
  creado_en         TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USUARIOS (admin y empleados con acceso al sistema)
-- ============================================================
CREATE TABLE public.usuarios (
  id              SERIAL PRIMARY KEY,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  rol             TEXT NOT NULL DEFAULT 'empleado', -- admin | empleado
  activo          BOOLEAN DEFAULT TRUE,
  ultimo_acceso   TIMESTAMPTZ,
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVITACIONES (link de onboarding para empleados)
-- ============================================================
CREATE TABLE public.invitaciones (
  id            SERIAL PRIMARY KEY,
  empleador_id  INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  usado         BOOLEAN DEFAULT FALSE,
  expira_en     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
  creado_en     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONFIGURACIÓN DE JORNADA POR EMPLEADO
-- ============================================================
CREATE TABLE public.jornadas_config (
  id                    SERIAL PRIMARY KEY,
  -- modalidad: corrida | partida
  modalidad             TEXT NOT NULL DEFAULT 'corrida',
  -- Jornada corrida
  hora_ingreso          TIME,        -- ej: 07:30
  hora_egreso           TIME,        -- ej: 16:30
  incluye_almuerzo      BOOLEAN DEFAULT TRUE,
  hora_almuerzo_inicio  TIME,        -- ej: 12:00
  hora_almuerzo_fin     TIME,        -- ej: 13:00
  -- Jornada partida
  hora_maniana_inicio   TIME,        -- ej: 08:00
  hora_maniana_fin      TIME,        -- ej: 12:00
  hora_tarde_inicio     TIME,        -- ej: 15:00
  hora_tarde_fin        TIME,        -- ej: 19:00
  -- Días laborables (array: 1=lunes ... 7=domingo)
  dias_laborables       INTEGER[] DEFAULT '{1,2,3,4,5,6}',
  -- Horas diarias objetivo (calculado o manual)
  horas_diarias_objetivo NUMERIC(4,2) DEFAULT 8,
  vigente_desde         DATE DEFAULT CURRENT_DATE,
  creado_en             TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- EMPLEADOS
-- ============================================================
CREATE TABLE public.empleados (
  id                  SERIAL PRIMARY KEY,
  empleador_id        INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  usuario_id          INTEGER REFERENCES public.usuarios(id),
  jornada_config_id   INTEGER REFERENCES public.jornadas_config(id),
  -- Datos laborales (cargados por admin)
  legajo              TEXT,
  categoria           TEXT,
  sector              TEXT,          -- técnico | administrativo | otro
  fecha_ingreso       DATE NOT NULL,
  salario_base        NUMERIC(12,2),
  tipo_contrato       TEXT DEFAULT 'tiempo_indeterminado',
  -- Datos personales (completados por el empleado en onboarding)
  nombre              TEXT,
  apellido            TEXT,
  dni                 TEXT,
  cuil                TEXT,
  domicilio           TEXT,
  localidad           TEXT,
  provincia           TEXT,
  telefono            TEXT,
  foto_perfil_url     TEXT,          -- Supabase Storage
  -- Domicilio habitual (para jornada desde casa)
  domicilio_lat       NUMERIC(10,7),
  domicilio_lng       NUMERIC(10,7),
  -- Estado
  activo              BOOLEAN DEFAULT TRUE,
  onboarding_completo BOOLEAN DEFAULT FALSE,
  creado_en           TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CATEGORÍAS DE SALIDA EXTERNA
-- ============================================================
CREATE TABLE public.categorias_salida (
  id            SERIAL PRIMARY KEY,
  empleador_id  INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  sector        TEXT NOT NULL DEFAULT 'todos', -- tecnico | administrativo | todos
  nombre        TEXT NOT NULL,
  descripcion   TEXT,
  requiere_destino BOOLEAN DEFAULT FALSE,
  activo        BOOLEAN DEFAULT TRUE,
  orden         INTEGER DEFAULT 0
);

-- Categorías predefinidas (se insertan al crear empleador, ver trigger)
-- técnico/comercial: visita_empresa, cotizacion, reunion_coordinacion, otras
-- administrativo: gestion_bancaria, gestion_cobro, compra_insumos, pagos, otras

-- ============================================================
-- DESTINOS EXTERNOS (empresas/lugares registrados)
-- ============================================================
CREATE TABLE public.destinos_externos (
  id            SERIAL PRIMARY KEY,
  empleador_id  INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  tipo          TEXT DEFAULT 'cliente',   -- cliente | proveedor | organismo | otro
  domicilio     TEXT,
  localidad     TEXT,
  lat           NUMERIC(10,7),
  lng           NUMERIC(10,7),
  radio_m       INTEGER DEFAULT 300,      -- para verificación de llegada
  contacto      TEXT,
  telefono      TEXT,
  activo        BOOLEAN DEFAULT TRUE,
  creado_en     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MOVIMIENTOS (registro central de asistencia)
-- ============================================================
CREATE TABLE public.movimientos (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  -- Tipo de movimiento
  tipo            TEXT NOT NULL,
  -- ingreso | salida_almuerzo | regreso_almuerzo | egreso
  -- salida_externa | regreso_externo
  -- inicio_jornada_remota | fin_jornada_remota
  -- trabajo_feriado
  -- Fecha y hora
  fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
  hora            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- GPS
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  gps_valido      BOOLEAN,
  distancia_m     INTEGER,           -- distancia al punto de referencia
  -- Para jornada remota: GPS del domicilio de partida
  es_remoto       BOOLEAN DEFAULT FALSE,
  domicilio_partida_lat NUMERIC(10,7),
  domicilio_partida_lng NUMERIC(10,7),
  -- Foto
  foto_url        TEXT,              -- Supabase Storage
  foto_capturada  BOOLEAN DEFAULT FALSE,
  -- Salida externa
  categoria_salida_id INTEGER REFERENCES public.categorias_salida(id),
  destino_id      INTEGER REFERENCES public.destinos_externos(id),
  destino_descripcion TEXT,          -- campo libre para "otras gestiones"
  -- Llegada a destino verificada (geofencing)
  llegada_destino_verificada BOOLEAN,
  llegada_destino_hora TIMESTAMPTZ,
  -- Horas extra (consentimiento del empleado LCT)
  es_hora_extra   BOOLEAN DEFAULT FALSE,
  consentimiento_extra BOOLEAN,      -- TRUE = empleado confirmó voluntariedad
  consentimiento_hora TIMESTAMPTZ,
  -- Validación admin (para jornadas remotas y casos especiales)
  validado        BOOLEAN DEFAULT FALSE,
  validado_por    INTEGER REFERENCES public.usuarios(id),
  validado_en     TIMESTAMPTZ,
  observacion_admin TEXT,
  -- Tardanza
  es_tardanza     BOOLEAN DEFAULT FALSE,
  minutos_tardanza INTEGER DEFAULT 0,
  -- Trabajo en feriado
  es_feriado      BOOLEAN DEFAULT FALSE,
  -- Cierre automático
  cierre_automatico BOOLEAN DEFAULT FALSE,
  -- Integridad
  hash_sha256     TEXT,              -- sello digital Ley 25.506
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SOLICITUDES EXTERNAS (requieren aprobación previa)
-- ============================================================
CREATE TABLE public.solicitudes_externas (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
  hora_solicitud  TIMESTAMPTZ DEFAULT NOW(),
  motivo          TEXT NOT NULL,
  categoria_salida_id INTEGER REFERENCES public.categorias_salida(id),
  destino_id      INTEGER REFERENCES public.destinos_externos(id),
  destino_descripcion TEXT,
  duracion_estimada_min INTEGER,
  -- Estado
  estado          TEXT DEFAULT 'pendiente', -- pendiente | aprobada | rechazada
  resuelto_por    INTEGER REFERENCES public.usuarios(id),
  resuelto_en     TIMESTAMPTZ,
  observacion     TEXT,
  -- Movimiento generado tras aprobación
  movimiento_id   BIGINT REFERENCES public.movimientos(id)
);

-- ============================================================
-- AUSENCIAS
-- ============================================================
CREATE TABLE public.ausencias (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  fecha_inicio    DATE NOT NULL,
  fecha_fin       DATE NOT NULL,
  tipo            TEXT NOT NULL,
  -- enfermedad_leve | enfermedad_certificada | emergencia
  -- licencia_matrimonio | licencia_nacimiento | licencia_fallecimiento
  -- licencia_examen | suspension | otro
  descripcion     TEXT,
  -- Justificación del empleado
  justificacion_texto TEXT,
  justificacion_gps_lat NUMERIC(10,7),
  justificacion_gps_lng NUMERIC(10,7),
  -- Certificado médico (PDF)
  certificado_url TEXT,              -- Supabase Storage
  -- Validación
  estado          TEXT DEFAULT 'pendiente', -- pendiente | aprobada | rechazada
  validado_por    INTEGER REFERENCES public.usuarios(id),
  validado_en     TIMESTAMPTZ,
  observacion_admin TEXT,
  -- Días descontados de licencia especial / sueldo
  dias_habiles    INTEGER,
  descuenta_sueldo BOOLEAN DEFAULT FALSE,
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VACACIONES
-- ============================================================
CREATE TABLE public.vacaciones_tomadas (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  anio            INTEGER NOT NULL,
  fecha_inicio    DATE NOT NULL,
  fecha_fin       DATE NOT NULL,
  dias_corridos   INTEGER NOT NULL,
  tipo            TEXT DEFAULT 'vacaciones', -- vacaciones | dias_particulares
  motivo          TEXT,
  aprobado_por    INTEGER REFERENCES public.usuarios(id),
  aprobado_en     TIMESTAMPTZ,
  estado          TEXT DEFAULT 'pendiente', -- pendiente | aprobada | rechazada
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BANCO DE HORAS
-- ============================================================
CREATE TABLE public.banco_horas (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  anio            INTEGER NOT NULL,
  mes             INTEGER NOT NULL,  -- 1-12
  -- Horas del período
  horas_convenio  NUMERIC(6,2) NOT NULL DEFAULT 0,   -- horas que debía trabajar
  horas_trabajadas NUMERIC(6,2) NOT NULL DEFAULT 0,  -- horas efectivamente trabajadas
  horas_extra     NUMERIC(6,2) NOT NULL DEFAULT 0,
  horas_ausencia  NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- Balance = trabajadas - convenio
  balance         NUMERIC(6,2) GENERATED ALWAYS AS (horas_trabajadas - horas_convenio) STORED,
  -- Saldo acumulado (calculado al cerrar mes)
  saldo_acumulado NUMERIC(8,2) DEFAULT 0,
  -- Estado del mes
  mes_cerrado     BOOLEAN DEFAULT FALSE,
  cerrado_en      TIMESTAMPTZ,
  cerrado_por     INTEGER REFERENCES public.usuarios(id),
  creado_en       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empleado_id, anio, mes)
);

-- ============================================================
-- COMPENSACIONES (uso de horas del banco)
-- ============================================================
CREATE TABLE public.compensaciones (
  id              BIGSERIAL PRIMARY KEY,
  empleado_id     INTEGER REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  horas_compensadas NUMERIC(6,2) NOT NULL,
  tipo            TEXT DEFAULT 'dia_libre', -- dia_libre | medio_dia | salida_anticipada
  motivo          TEXT,
  aprobado_por    INTEGER REFERENCES public.usuarios(id) NOT NULL,
  aprobado_en     TIMESTAMPTZ DEFAULT NOW(),
  observacion     TEXT
);

-- ============================================================
-- PUSH SUBSCRIPTIONS (Web Push VAPID)
-- ============================================================
CREATE TABLE public.push_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  usuario_id      INTEGER REFERENCES public.usuarios(id) ON DELETE CASCADE,
  empleador_id    INTEGER REFERENCES public.empleadores(id) ON DELETE CASCADE,
  subscription    JSONB NOT NULL,
  dispositivo     TEXT,
  activo          BOOLEAN DEFAULT TRUE,
  creado_en       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(usuario_id, subscription)
);

-- ============================================================
-- ÍNDICES PARA PERFORMANCE
-- ============================================================
CREATE INDEX idx_movimientos_empleado_fecha ON public.movimientos(empleado_id, fecha DESC);
CREATE INDEX idx_movimientos_empleador_fecha ON public.movimientos(empleador_id, fecha DESC);
CREATE INDEX idx_movimientos_tipo ON public.movimientos(tipo);
CREATE INDEX idx_ausencias_empleado ON public.ausencias(empleado_id, fecha_inicio);
CREATE INDEX idx_vacaciones_empleado ON public.vacaciones_tomadas(empleado_id, anio);
CREATE INDEX idx_banco_horas_empleado ON public.banco_horas(empleado_id, anio, mes);
CREATE INDEX idx_solicitudes_estado ON public.solicitudes_externas(empleador_id, estado);
CREATE INDEX idx_empleados_empleador ON public.empleados(empleador_id);
CREATE INDEX idx_invitaciones_token ON public.invitaciones(token);

-- ============================================================
-- FUNCIÓN: calcular días de vacaciones según antigüedad (LCT)
-- ============================================================
CREATE OR REPLACE FUNCTION public.calcular_dias_vacaciones(
  p_fecha_ingreso DATE,
  p_convenio_id INTEGER DEFAULT 1
)
RETURNS INTEGER AS $$
DECLARE
  v_anios INTEGER;
  v_conv  public.convenios%ROWTYPE;
BEGIN
  v_anios := DATE_PART('year', AGE(CURRENT_DATE, p_fecha_ingreso));
  SELECT * INTO v_conv FROM public.convenios WHERE id = p_convenio_id;

  IF v_anios < 5 THEN
    RETURN v_conv.vacaciones_hasta_5_anios;
  ELSIF v_anios < 10 THEN
    RETURN v_conv.vacaciones_hasta_10_anios;
  ELSIF v_anios < 20 THEN
    RETURN v_conv.vacaciones_hasta_20_anios;
  ELSE
    RETURN v_conv.vacaciones_mas_20_anios;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCIÓN: verificar si una fecha es feriado
-- ============================================================
CREATE OR REPLACE FUNCTION public.es_feriado(p_fecha DATE)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.feriados WHERE fecha = p_fecha);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNCIÓN: calcular horas trabajadas entre dos timestamps
-- (descuenta almuerzo automáticamente si aplica)
-- ============================================================
CREATE OR REPLACE FUNCTION public.calcular_horas_jornada(
  p_entrada TIMESTAMPTZ,
  p_salida  TIMESTAMPTZ,
  p_descontar_almuerzo BOOLEAN DEFAULT TRUE,
  p_almuerzo_inicio TIME DEFAULT '12:00',
  p_almuerzo_fin    TIME DEFAULT '13:00'
)
RETURNS NUMERIC AS $$
DECLARE
  v_total_min  NUMERIC;
  v_almuerzo   NUMERIC;
  v_fecha      DATE;
BEGIN
  IF p_entrada IS NULL OR p_salida IS NULL THEN RETURN 0; END IF;

  v_total_min := EXTRACT(EPOCH FROM (p_salida - p_entrada)) / 60;
  v_fecha := p_entrada::DATE;

  IF p_descontar_almuerzo THEN
    -- Solo descuenta si la jornada cruza el horario de almuerzo
    IF p_entrada::TIME < p_almuerzo_fin AND p_salida::TIME > p_almuerzo_inicio THEN
      v_almuerzo := EXTRACT(EPOCH FROM (
        LEAST(p_salida, (v_fecha + p_almuerzo_fin)::TIMESTAMPTZ) -
        GREATEST(p_entrada, (v_fecha + p_almuerzo_inicio)::TIMESTAMPTZ)
      )) / 60;
      v_total_min := v_total_min - GREATEST(v_almuerzo, 0);
    END IF;
  END IF;

  RETURN ROUND(v_total_min / 60.0, 2);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VISTA: estado actual de empleados (dashboard en tiempo real)
-- ============================================================
CREATE OR REPLACE VIEW public.v_estado_empleados AS
SELECT
  e.id AS empleado_id,
  e.empleador_id,
  e.nombre,
  e.apellido,
  e.legajo,
  e.sector,
  e.foto_perfil_url,
  -- Último movimiento de hoy
  m.tipo AS ultimo_movimiento,
  m.hora AS ultima_hora,
  m.es_tardanza,
  m.minutos_tardanza,
  m.es_remoto,
  -- Estado derivado
  CASE
    WHEN m.tipo IS NULL THEN 'ausente'
    WHEN m.tipo = 'ingreso' THEN 'en_oficina'
    WHEN m.tipo = 'salida_almuerzo' THEN 'en_almuerzo'
    WHEN m.tipo = 'regreso_almuerzo' THEN 'en_oficina'
    WHEN m.tipo = 'salida_externa' THEN 'en_externo'
    WHEN m.tipo = 'regreso_externo' THEN 'en_oficina'
    WHEN m.tipo = 'egreso' THEN 'retirado'
    WHEN m.tipo = 'inicio_jornada_remota' THEN 'remoto_pendiente'
    ELSE 'desconocido'
  END AS estado,
  -- Tardanzas del mes
  (SELECT COUNT(*) FROM public.movimientos
   WHERE empleado_id = e.id
     AND es_tardanza = TRUE
     AND DATE_TRUNC('month', fecha::TIMESTAMPTZ) = DATE_TRUNC('month', NOW())
  ) AS tardanzas_mes
FROM public.empleados e
LEFT JOIN LATERAL (
  SELECT tipo, hora, es_tardanza, minutos_tardanza, es_remoto
  FROM public.movimientos
  WHERE empleado_id = e.id
    AND fecha = CURRENT_DATE
  ORDER BY hora DESC
  LIMIT 1
) m ON TRUE
WHERE e.activo = TRUE;

-- ============================================================
-- VISTA: saldo de vacaciones por empleado
-- ============================================================
CREATE OR REPLACE VIEW public.v_saldo_vacaciones AS
SELECT
  e.id AS empleado_id,
  e.empleador_id,
  e.nombre,
  e.apellido,
  e.fecha_ingreso,
  EXTRACT(YEAR FROM AGE(CURRENT_DATE, e.fecha_ingreso))::INTEGER AS anios_antiguedad,
  public.calcular_dias_vacaciones(e.fecha_ingreso, emp.convenio_id) AS dias_correspondientes,
  COALESCE((
    SELECT SUM(dias_corridos)
    FROM public.vacaciones_tomadas
    WHERE empleado_id = e.id
      AND anio = EXTRACT(YEAR FROM CURRENT_DATE)
      AND estado = 'aprobada'
  ), 0) AS dias_tomados,
  public.calcular_dias_vacaciones(e.fecha_ingreso, emp.convenio_id) -
  COALESCE((
    SELECT SUM(dias_corridos)
    FROM public.vacaciones_tomadas
    WHERE empleado_id = e.id
      AND anio = EXTRACT(YEAR FROM CURRENT_DATE)
      AND estado = 'aprobada'
  ), 0) AS dias_disponibles
FROM public.empleados e
JOIN public.empleadores emp ON emp.id = e.empleador_id
WHERE e.activo = TRUE;

-- ============================================================
-- VISTA: banco de horas resumido
-- ============================================================
CREATE OR REPLACE VIEW public.v_banco_horas AS
SELECT
  e.id AS empleado_id,
  e.empleador_id,
  e.nombre,
  e.apellido,
  e.legajo,
  COALESCE(SUM(bh.balance), 0) AS saldo_total_horas,
  COALESCE(SUM(bh.horas_extra), 0) AS horas_extra_totales,
  COALESCE(SUM(CASE WHEN bh.balance < 0 THEN ABS(bh.balance) ELSE 0 END), 0) AS horas_deuda,
  COALESCE(SUM(c.horas_compensadas), 0) AS horas_compensadas,
  COALESCE(SUM(bh.balance), 0) - COALESCE(SUM(c.horas_compensadas), 0) AS saldo_disponible
FROM public.empleados e
LEFT JOIN public.banco_horas bh ON bh.empleado_id = e.id
LEFT JOIN public.compensaciones c ON c.empleado_id = e.id
WHERE e.activo = TRUE
GROUP BY e.id, e.empleador_id, e.nombre, e.apellido, e.legajo;

-- ============================================================
-- FIN DEL ESQUEMA
-- ============================================================
