# API de integración para el CRM (v1) — solo lectura

La consume el CRM de EXIT (módulo **Mi empresa**: organigrama e indicadores).
Es la dirección inversa a `services/crmService.js` (AsistenciaAR → CRM).

Base: `https://<este servicio>/api/integracion/v1`

Autenticación: header `Authorization: Bearer <INTEGRACION_CRM_TOKEN>`. El token
vive solo en las variables de entorno de los dos servidores (acá
`INTEGRACION_CRM_TOKEN`, en el CRM `ASISTENCIA_API_TOKEN`), nunca en la app ni
en las tablets. `INTEGRACION_CRM_EMPLEADOR_ID` = id de EXIT S.A. en
`empleadores`. Sin las dos variables la API responde **503** (apagada).
Errores: 401 (token faltante o inválido), 400 (datos), 500.

| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/empleados` | Personal **activo** del empleador: `id`, `nombre` (nombre y apellido), `legajo`, `categoria`, `sector`. Sin DNI, CUIL, domicilio ni salario. |
| GET | `/resumen-mensual?periodo=AAAA-MM` | `visitasCompletadas` (visitas con estado `completada`, por fecha de la visita) y `horasTrabajadas` (suma de `banco_horas.horas_trabajadas` del mes), en total y `porEmpleado`. Antes del arranque limpio (`empleadores.fecha_inicio_registros`) devuelve `archivado: true` y los valores en `null`. |

Reglas:
- No escribe nada en la base.
- El CRM guarda qué empleado ocupa cada puesto
  (`me_organigrama.empleado_asistencia_id`); AsistenciaAR no guarda nada del CRM.
- El CRM guarda una copia de 5 minutos; si este servicio no responde, el CRM
  muestra "sin dato" y sigue funcionando.

Publicar (con Rogelio presente): generar el token
(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
cargar `INTEGRACION_CRM_TOKEN` e `INTEGRACION_CRM_EMPLEADOR_ID` en Railway
(requiere redeploy) y el mismo token en `ASISTENCIA_API_TOKEN` del CRM.
