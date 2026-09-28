-- 28/09/2026 — Unificar cuentas con email de EXIT (aprobado por Rogelio)
-- Correr en Railway → proyecto stunning-laughter → Postgres → Data → Query,
-- UNA sentencia por vez y en orden. Nada se borra.
-- Requisito: que ya esté publicado el commit 4673074 ("Mi jornada" para admins).

-- 0) Ver cómo está hoy (anotar el resultado)
SELECT u.id, u.email, u.rol, u.activo, e.id AS empleado_id, e.nombre, e.activo AS emp_activo FROM usuarios u LEFT JOIN empleados e ON e.usuario_id = u.id ORDER BY u.id;

-- 1) Respaldos (copias dentro de la misma base)
CREATE TABLE IF NOT EXISTS bkp_20260928_usuarios AS SELECT * FROM usuarios;
CREATE TABLE IF NOT EXISTS bkp_20260928_empleados AS SELECT * FROM empleados;
CREATE TABLE IF NOT EXISTS bkp_20260928_push_subscriptions AS SELECT * FROM push_subscriptions;
CREATE TABLE IF NOT EXISTS bkp_20260928_firmas_guardadas AS SELECT * FROM firmas_guardadas;

-- 2) Rogelio: una sola cuenta (la de admin, id 1) con el email de EXIT.
--    Conserva la contraseña actual de administrador.
UPDATE usuarios SET email = 'rdalzotto@exitsa.com.ar' WHERE id = 1;

-- 3) El registro de empleado con todos los fichajes (id 12) pasa a la cuenta
--    unificada; el registro viejo e inactivo (id 10) queda con la cuenta vieja.
UPDATE empleados SET usuario_id = 5 WHERE id = 10;
UPDATE empleados SET usuario_id = 1 WHERE id = 12;

-- 4) Notificaciones del celular y firmas guardadas pasan a la cuenta unificada
UPDATE push_subscriptions SET usuario_id = 1 WHERE usuario_id = 5;
UPDATE firmas_guardadas SET usuario_id = 1 WHERE usuario_id = 5 AND tipo NOT IN (SELECT tipo FROM firmas_guardadas WHERE usuario_id = 1);

-- 5) La cuenta de Gmail de empleado queda desactivada (no se borra)
UPDATE usuarios SET activo = FALSE WHERE id = 5;

-- 6) Andrea pasa a administradora (sigue siendo empleada: usa "Mi jornada")
UPDATE usuarios SET rol = 'admin' WHERE id = 3 AND email = 'adiazvidal@exitsa.com.ar';

-- 7) Verificación: tiene que mostrar
--    1 | rdalzotto@exitsa.com.ar  | admin    | t | 12 | Rogelio  | t
--    3 | adiazvidal@exitsa.com.ar | admin    | t |  9 | Andrea   | t
--    5 | rogelio.dalzotto@gmail.com | empleado | f | 10 | ...     | f
SELECT u.id, u.email, u.rol, u.activo, e.id AS empleado_id, e.nombre, e.activo AS emp_activo FROM usuarios u LEFT JOIN empleados e ON e.usuario_id = u.id ORDER BY u.id;

-- Para deshacer (solo si hiciera falta):
-- UPDATE usuarios u SET email = b.email, rol = b.rol, activo = b.activo FROM bkp_20260928_usuarios b WHERE b.id = u.id;
-- UPDATE empleados e SET usuario_id = b.usuario_id FROM bkp_20260928_empleados b WHERE b.id = e.id;
