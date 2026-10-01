-- Migración 02/10/2026 — Viajes: medio de transporte y reintegro por km.
-- SOLO AGREGA columnas (con valores por defecto). Correr ANTES de publicar.
-- Pedido de Rogelio: vehículo de la empresa (Saveiro, no se paga por km),
-- auto particular de Rogelio o Walter y moto de Roberto (se paga km × valor),
-- transporte público (solo pasajes, como gasto) y traslado del cliente.

ALTER TABLE public.viaje_vehiculos
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'empresa';
ALTER TABLE public.viaje_vehiculos DROP CONSTRAINT IF EXISTS viaje_vehiculos_tipo_check;
ALTER TABLE public.viaje_vehiculos ADD CONSTRAINT viaje_vehiculos_tipo_check
  CHECK (tipo IN ('empresa','particular','moto','transporte_publico','provisto_cliente'));
-- Dueño del vehículo particular o la moto (a quien se le reintegran los km).
ALTER TABLE public.viaje_vehiculos
  ADD COLUMN IF NOT EXISTS propietario_empleado_id INTEGER REFERENCES public.empleados(id);
-- Km cuando no se anotó el odómetro (ej. según el mapa).
ALTER TABLE public.viaje_vehiculos
  ADD COLUMN IF NOT EXISTS km_declarados NUMERIC(10,1);
-- Valor por km congelado al cargar el vehículo (no cambia si después se
-- actualiza el valor de la empresa).
ALTER TABLE public.viaje_vehiculos
  ADD COLUMN IF NOT EXISTS valor_km NUMERIC(10,2);
ALTER TABLE public.viaje_vehiculos ALTER COLUMN vehiculo DROP NOT NULL;

-- Valores por km vigentes de la empresa (los carga Andrea).
ALTER TABLE public.empleadores ADD COLUMN IF NOT EXISTS valor_km_auto NUMERIC(10,2);
ALTER TABLE public.empleadores ADD COLUMN IF NOT EXISTS valor_km_moto NUMERIC(10,2);
