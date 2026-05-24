require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('../db');

async function seed() {
  console.log('[SEED] Creando datos iniciales...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Empleador
    const { rows: [emp] } = await client.query(`
      INSERT INTO public.empleadores (
        razon_social, nombre_fantasia, cuit, domicilio,
        localidad, provincia, emails_admin
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (cuit) DO UPDATE SET razon_social = EXCLUDED.razon_social
      RETURNING id
    `, [
      process.env.RAZON_SOCIAL || 'EXIT SRL',
      process.env.NOMBRE_FANTASIA || 'EXIT',
      process.env.CUIT || '30-00000000-0',
      process.env.DOMICILIO || 'Dirección de la empresa',
      process.env.LOCALIDAD || 'Concordia',
      process.env.PROVINCIA || 'Entre Ríos',
      [process.env.ADMIN_EMAIL || 'ingrogeliodalzotto@gmail.com'],
    ]);

    console.log('[SEED] ✓ Empleador creado, id:', emp.id);

    // 2. Usuario admin
    const hash = await bcrypt.hash(
      process.env.ADMIN_PASSWORD || 'CambiarEstaPassword123!',
      12
    );
    const { rows: [usr] } = await client.query(`
      INSERT INTO public.usuarios (empleador_id, email, password_hash, rol)
      VALUES ($1,$2,$3,'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `, [emp.id, process.env.ADMIN_EMAIL || 'ingrogeliodalzotto@gmail.com', hash]);

    console.log('[SEED] ✓ Usuario admin creado, id:', usr.id);

    // 3. Categorías de salida predefinidas
    const categorias = [
      // Sector técnico/comercial
      { sector: 'tecnico', nombre: 'Visita a empresa — Técnica', requiere_destino: true, orden: 1 },
      { sector: 'tecnico', nombre: 'Visita a empresa — Reunión de Coordinación', requiere_destino: true, orden: 2 },
      { sector: 'tecnico', nombre: 'Visita para cotización', requiere_destino: false, orden: 3 },
      { sector: 'tecnico', nombre: 'Reunión con solicitante de servicio', requiere_destino: false, orden: 4 },
      { sector: 'tecnico', nombre: 'Otras gestiones (describir)', requiere_destino: false, orden: 5 },
      // Sector administrativo
      { sector: 'administrativo', nombre: 'Gestión bancaria', requiere_destino: false, orden: 1 },
      { sector: 'administrativo', nombre: 'Gestión de cobro', requiere_destino: false, orden: 2 },
      { sector: 'administrativo', nombre: 'Compra de insumos de oficina', requiere_destino: false, orden: 3 },
      { sector: 'administrativo', nombre: 'Pagos', requiere_destino: false, orden: 4 },
      { sector: 'administrativo', nombre: 'Otras gestiones (describir)', requiere_destino: false, orden: 5 },
      // Todos los sectores
      { sector: 'todos', nombre: 'Trámite administrativo general', requiere_destino: false, orden: 10 },
    ];

    for (const cat of categorias) {
      await client.query(`
        INSERT INTO public.categorias_salida
          (empleador_id, sector, nombre, requiere_destino, orden)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING
      `, [emp.id, cat.sector, cat.nombre, cat.requiere_destino, cat.orden]);
    }

    console.log('[SEED] ✓ Categorías de salida creadas');

    // 4. Jornada config por defecto (corrida, 07:30-16:30)
    await client.query(`
      INSERT INTO public.jornadas_config (
        modalidad, hora_ingreso, hora_egreso,
        incluye_almuerzo, hora_almuerzo_inicio, hora_almuerzo_fin,
        dias_laborables, horas_diarias_objetivo
      ) VALUES ('corrida','07:30','16:30',true,'12:00','13:00','{1,2,3,4,5,6}',8)
      ON CONFLICT DO NOTHING
    `);

    console.log('[SEED] ✓ Jornada config por defecto creada');

    await client.query('COMMIT');
    console.log('[SEED] ✓ Seed completado exitosamente');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED] Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
