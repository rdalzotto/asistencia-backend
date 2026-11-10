-- 10/11/2026 — Un solo usuario y contraseña para todo EXIT (pedido de Rogelio)
-- Correr en Railway → proyecto stunning-laughter → Postgres → Data → Query,
-- UNA sentencia por vez y en orden. Nada se borra ni se cambia de lugar:
-- cada persona sigue con su misma cuenta, sus fichajes, reportes y firmas.
-- Correrla ANTES de publicar el código nuevo (commit "Usuario único de EXIT").

-- 0) Ver cómo está hoy (anotar el resultado)
SELECT u.id, u.email, u.rol, u.activo, e.id AS empleado_id, e.nombre, e.apellido FROM usuarios u LEFT JOIN empleados e ON e.usuario_id = u.id ORDER BY u.id;

-- 1) Respaldo (copia dentro de la misma base)
CREATE TABLE IF NOT EXISTS bkp_20261110_usuarios AS SELECT * FROM usuarios;

-- 2) Columnas nuevas: el mail de EXIT de cada cuenta y cuándo pasó a usarlo
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_exit TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS identidad_exit_en TIMESTAMPTZ;

-- 3) A quién le corresponde cada usuario de EXIT (por su registro de empleado).
--    Los mails tienen que ser EXACTAMENTE los del Sistema de Gestión EXIT.
UPDATE usuarios SET email_exit = 'rdalzotto@exitsa.com.ar' WHERE id = 1;
UPDATE usuarios SET email_exit = 'adiazvidal@exitsa.com.ar' WHERE id = (SELECT usuario_id FROM empleados WHERE id = 9);
UPDATE usuarios SET email_exit = 'MAIL_DE_ROBERTO@exitsa.com.ar' WHERE id = (SELECT usuario_id FROM empleados WHERE id = 8);
UPDATE usuarios SET email_exit = 'MAIL_DE_WALTER@exitsa.com.ar' WHERE id = (SELECT usuario_id FROM empleados WHERE id = 11);

-- 4) Verificación: Rogelio, Andrea, Roberto y Walter con su mail de EXIT en email_exit
SELECT u.id, u.email, u.email_exit, u.identidad_exit_en, e.nombre FROM usuarios u LEFT JOIN empleados e ON e.usuario_id = u.id WHERE u.activo ORDER BY u.id;

-- Para deshacer (solo si hiciera falta): las columnas nuevas no molestan al
-- código anterior. Para volver los mails como estaban:
-- UPDATE usuarios u SET email = b.email, password_hash = b.password_hash FROM bkp_20261110_usuarios b WHERE b.id = u.id;
