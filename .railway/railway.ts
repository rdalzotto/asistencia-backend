import { defineRailway, image, postgres, project, service } from "railway/iac";

// Solo administra el servicio "respaldos" (26/10/2026): el resto del
// proyecto (asistencia-backend, Postgres) se sigue manejando desde Railway.
export const partial = "respaldos";

// Respaldo diario de la base en Backblaze B2, igual que el del CRM
// (crm-exit/.railway/railway.ts). Bucket privado con Object Lock de 90 dias;
// la clave B2 solo puede escribir y la cargo Rogelio como Shared Variables del
// proyecto (B2_KEY_ID, B2_APPLICATION_KEY). Imagen oficial de Postgres de la
// misma version que la base (18). El servicio corre, sube la copia y termina.
const RESPALDO_INICIO = [
  "set -e",
  "apk add --no-cache -q aws-cli openssl",
  'F="/tmp/$PREFIJO-$(date -u +%Y-%m-%d-%H%M).dump"',
  'pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$F"',
  'test -s "$F"',
  'MD5="$(openssl dgst -md5 -binary "$F" | base64)"',
  'aws s3api put-object --endpoint-url "$B2_ENDPOINT" --bucket "$B2_BUCKET" --key "$PREFIJO/$(basename "$F")" --body "$F" --content-md5 "$MD5" > /dev/null',
  'echo "Respaldo subido: $PREFIJO/$(basename "$F") ($(wc -c < "$F") bytes)"',
].join("; ");

export default defineRailway((ctx) => {
  const Postgres = postgres("Postgres", { region: "iad" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };

  // Todos los dias a las 21:00 de Argentina (0:00 UTC), elegido por Rogelio
  // desde el panel de Railway el 26/10. Ojo: `config plan` muestra "crear
  // service respaldos" porque Railway clasifica como base de datos a todo
  // servicio con imagen de Postgres; no aplicar ese cambio sin revisarlo.
  const respaldos = service("respaldos", {
    source: image("postgres:18-alpine"),
    start: `sh -c '${RESPALDO_INICIO}'`,
    deploy: { cronSchedule: "0 0 * * *", restartPolicyType: "NEVER" },
    env: {
      B2_BUCKET: "exit-sa-respaldos-2026-1",
      B2_ENDPOINT: "https://s3.us-east-005.backblazeb2.com",
      AWS_DEFAULT_REGION: "us-east-005",
      // B2 no acepta los checksums nuevos que el CLI de AWS manda por defecto.
      AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
      PREFIJO: "asistenciaar",
      DATABASE_URL: Postgres.env.DATABASE_URL,
      AWS_ACCESS_KEY_ID: ctx.shared.B2_KEY_ID,
      AWS_SECRET_ACCESS_KEY: ctx.shared.B2_APPLICATION_KEY,
    },
  });

  return project("stunning-laughter", {
    resources: [respaldos, Postgres],
  });
});
