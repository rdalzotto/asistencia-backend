# AsistenciaAR v2.0 — Guía de Deploy

## Paso 1 — Supabase (base de datos)

1. Entrá a https://supabase.com → proyecto `pthvoaqjyzrjykxjwiid`
2. Ir a **SQL Editor**
3. Pegar el contenido completo de `schema.sql` y ejecutar
4. Verificar que se crearon las 16 tablas

Para obtener la DATABASE_URL:
- Supabase → Settings → Database → Connection string → URI
- Usar la versión **Transaction pooler** (puerto 5432)

---

## Paso 2 — GitHub (repo limpio)

1. Borrar repo `rdalzotto/asistencia-backend` en GitHub → Settings → Delete
2. Crear repo nuevo: GitHub → + → New repository → `asistencia-backend`
3. En tu PC, desde la carpeta del proyecto:

```
git init
git add .
git commit -m "AsistenciaAR v2.0 - inicio limpio"
git branch -M main
git remote add origin https://github.com/rdalzotto/asistencia-backend.git
git push -u origin main
```

---

## Paso 3 — Generar claves VAPID

En tu PC (necesitás Node instalado):

```
npx web-push generate-vapid-keys
```

Guarda los dos valores que genera (PUBLIC_KEY y PRIVATE_KEY).

---

## Paso 4 — Railway (backend)

1. railway.app → proyecto `stunning-laughter` → eliminar servicios anteriores
2. New Service → GitHub Repo → elegir `rdalzotto/asistencia-backend`
3. Railway detecta Node automáticamente

**Variables de entorno a cargar en Railway:**

```
DATABASE_URL        = [Transaction pooler URL de Supabase]
JWT_SECRET          = [cadena aleatoria larga, mínimo 64 chars]
VAPID_PUBLIC_KEY    = [generada en paso 3]
VAPID_PRIVATE_KEY   = [generada en paso 3]
VAPID_EMAIL         = ingrogeliodalzotto@gmail.com
FRONTEND_URL        = https://roaring-dolphin-29bc4e.netlify.app
RAZON_SOCIAL        = EXIT SRL
CUIT                = 30-00000000-0
LOCALIDAD           = Concordia
PROVINCIA           = Entre Ríos
ADMIN_EMAIL         = ingrogeliodalzotto@gmail.com
ADMIN_PASSWORD      = [tu contraseña real]
NODE_ENV            = production
HORA_CIERRE_AUTO    = 20
```

4. Railway despliega automáticamente al detectar el push

---

## Paso 5 — Inicializar la base de datos

Una vez que Railway desplegó el backend, desde tu PC:

```
# Instalar dependencias localmente
npm install

# Copiar .env.example a .env y completar DATABASE_URL real
cp .env.example .env

# Ejecutar seed (crea empleador + admin + categorías + jornada default)
npm run db:seed
```

---

## Paso 6 — Verificar que funciona

Abrir en el navegador:
```
https://[tu-url-railway].up.railway.app/health
```

Debe responder:
```json
{"status":"ok","version":"2.0.0"}
```

Probar login:
```
POST https://[tu-url-railway].up.railway.app/api/auth/login
Content-Type: application/json

{"email":"ingrogeliodalzotto@gmail.com","password":"[tu_password]"}
```

---

## Paso 7 — Frontend

El frontend (Netlify) ya está desplegado. Solo hay que actualizar la URL del backend en el HTML:

```javascript
const API = 'https://[tu-url-railway].up.railway.app/api';
```

---

## Estructura del proyecto

```
asistencia-backend/
├── schema.sql              ← Base de datos completa (ejecutar en Supabase)
├── package.json
├── .env.example            ← Copiar como .env
├── DEPLOY.md               ← Esta guía
└── src/
    ├── index.js            ← Servidor principal
    ├── db.js               ← Conexión PostgreSQL
    ├── db/
    │   ├── migrate.js
    │   └── seed.js         ← npm run db:seed
    ├── middleware/
    │   └── auth.js         ← JWT + roles
    ├── services/
    │   ├── jornadaService.js  ← Lógica legal LCT
    │   └── pushService.js     ← Web Push VAPID
    └── routes/
        ├── auth.js            ← Login, invitaciones, onboarding
        ├── movimientos.js     ← Registro asistencia
        ├── licencias.js       ← Ausencias, vacaciones, banco horas
        ├── config.js          ← Empleador, empleados, jornadas, convenios
        ├── reportes.js        ← Mensual, horas extra, LCT Art.52
        └── notificaciones.js  ← Push + solicitudes externas
```

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/login | Login |
| GET | /api/auth/me | Perfil del usuario |
| POST | /api/auth/invitar | Admin invita empleado |
| POST | /api/auth/onboarding | Empleado completa perfil |
| POST | /api/movimientos/registrar | Registrar ingreso/egreso |
| GET | /api/movimientos/hoy | Movimientos del día |
| GET | /api/movimientos/historial | Historial con filtros |
| POST | /api/movimientos/validar-remoto/:id | Admin valida jornada remota |
| GET | /api/config/dashboard | Dashboard tiempo real |
| GET | /api/config/empleados | Lista empleados |
| POST | /api/config/jornada | Crear config de jornada |
| POST | /api/config/destinos | Agregar destino externo |
| POST | /api/licencias/ausencia | Reportar ausencia |
| GET | /api/licencias/vacaciones/saldo | Saldo de vacaciones |
| GET | /api/licencias/banco-horas | Banco de horas |
| GET | /api/reportes/mensual | Reporte mensual |
| GET | /api/reportes/libro-lct | Libro LCT Art.52 |
| GET | /api/reportes/estadisticas-empleado | Stats anuales |
| POST | /api/notificaciones/suscribir | Registrar push |
| POST | /api/notificaciones/solicitud | Solicitar salida externa |
