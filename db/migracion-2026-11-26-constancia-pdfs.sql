-- Copia legal del PDF final de cada constancia de visita (26/11/2026).
-- NO hace falta correrla a mano: el servidor crea la tabla sola la primera vez
-- (src/services/constanciaPdf.js). Queda acá como registro.
CREATE TABLE IF NOT EXISTS public.constancia_pdfs (
  id               SERIAL PRIMARY KEY,
  constancia_id    INTEGER NOT NULL REFERENCES public.constancias(id) ON DELETE RESTRICT,
  empleador_id     INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  pdf              BYTEA NOT NULL,
  medio            TEXT,
  destinatarios    TEXT,
  enviado_por      TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_crm_en   TIMESTAMPTZ,
  crm_documento_id TEXT,
  error            TEXT,
  intentos         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (constancia_id, sha256)
);
-- Verificación: SELECT constancia_id, sha256, enviado_crm_en, error FROM public.constancia_pdfs ORDER BY creado_en DESC;
