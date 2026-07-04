# API Contract Audit

Fecha de auditoria: 2026-06-21

Base auditada:

- `server.js`
- `authMiddleware.js`
- `localConfigStore.js`
- `networkAccessUtil.js`
- `firebirdService.js`
- `service-config.api.json`
- `.env.api`
- `../sync/laravelSync.js`
- `../sync/routes/integrationRoutes.js`

Conclusiones base:

- Este servicio no contiene integracion HTTP saliente hacia Laravel Cloud.
- Este servicio no contiene integracion HTTP saliente ni entrante dedicada hacia Sync Service.
- La integracion con Laravel Cloud vive en `apps/sync`, no en `apps/api`.
- Si Laravel Cloud o Sync Service quieren consumir este API, deben hacerlo como cualquier cliente HTTP externo contra los endpoints de `server.js`.

## Endpoints expuestos

| RUTA | METODO | AUTENTICACION | DESCRIPCION |
|---|---|---|---|
| `/api/health` | `GET` | Publico | Estado basico del servicio y del store local. |
| `/api/token` | `GET` | Publico, pero restringido por IP y deshabilitado salvo `APP_ENV=development` o `ALLOW_TOKEN_ENDPOINT=true` | Devuelve `JWT_BACKUP` sin crear sesion. |
| `/api/login` | `POST` | Publico, pero restringido por IP | Autentica usuario local y emite JWT con sesion activa en SQLite. |
| `/api/auth/users` | `GET` | Bearer JWT + rol `admin` o `api_admin` | Lista usuarios API locales. |
| `/api/auth/users/:email` | `GET` | Bearer JWT + rol `admin` o `api_admin` | Obtiene un usuario por email. |
| `/api/auth/users` | `POST` | Bearer JWT + rol `admin` o `api_admin` | Crea usuario API local. |
| `/api/auth/users/:email` | `PUT` | Bearer JWT + rol `admin` o `api_admin` | Actualiza usuario API local. |
| `/api/auth/users/:email` | `DELETE` | Bearer JWT + rol `admin` o `api_admin` | Elimina usuario API local. |
| `/api/auth/sessions` | `GET` | Bearer JWT + rol `admin` o `api_admin` | Lista sesiones activas o revocadas. |
| `/api/logout` | `POST` | Bearer JWT | Revoca la sesion actual. |
| `/api/auth/sessions/:sessionId` | `DELETE` | Bearer JWT + rol `admin` o `api_admin` | Revoca una sesion por id. |
| `/api/query/connections` | `GET` | Bearer JWT | Lista conexiones disponibles para query. |
| `/api/query` | `POST` | Bearer JWT | Ejecuta SQL sobre una conexion configurada. |
| `/api/query/test` | `POST` | Bearer JWT | Prueba conectividad por selector de conexion. |
| `/api/query/log` | `GET` | Bearer JWT | Lista bitacora de queries. |
| `/api/config/local` | `GET` | Bearer JWT | Devuelve configuracion, modulos, conexiones y estado local. |
| `/api/config/settings/:key` | `PUT` | Bearer JWT | Actualiza un setting persistido en SQLite. |
| `/api/config/modules` | `GET` | Bearer JWT | Lista modulos configurables. |
| `/api/config/modules/:module` | `PUT` | Bearer JWT | Activa o desactiva modulo local. |
| `/api/config/audit-log` | `GET` | Bearer JWT | Lista auditoria de cambios. |
| `/api/connections` | `GET` | Bearer JWT | Lista conexiones persistidas. |
| `/api/connections/:id` | `GET` | Bearer JWT | Obtiene una conexion persistida. |
| `/api/connections` | `POST` | Bearer JWT | Crea conexion persistida. |
| `/api/connections/:id` | `PUT` | Bearer JWT | Actualiza conexion persistida. |
| `/api/connections/:id` | `DELETE` | Bearer JWT | Elimina conexion persistida. |
| `/api/config/query-connections/:id` | `PUT` | Bearer JWT | Alias de actualizacion de conexion. |
| `/api/config/query-connections/:id` | `DELETE` | Bearer JWT | Alias de borrado de conexion. |
| `/api/connections/:id/test` | `POST` | Bearer JWT | Prueba conectividad de una conexion por id. |
| `/api/connections/:id/query-test` | `POST` | Bearer JWT | Ejecuta query de prueba sobre una conexion por id. |
| `/api/services/status` | `GET` | Bearer JWT | Estado funcional de modulos del servicio. |
| `/api/connectivity/status` | `GET` | Bearer JWT | Estado resumido de SQLite y conexiones configuradas. |
| `/api/metrics` | `GET` | Bearer JWT | Metricas simples del servicio. |

Fuentes:

- `server.js:309-740`
- `authMiddleware.js:11-108`

## Variables utilizadas

Criterio:

- `SI`: el runtime las lee directamente.
- `CONDICIONAL`: el runtime las lee solo en ciertas rutas o como fallback.
- `NO`: no aparecio lectura runtime; solo estaba en `.env.api`.

| VARIABLE | OBLIGATORIA | ARCHIVO | LINEA |
|---|---|---|---|
| `SERVICE_NAME` | `CONDICIONAL` | `server.js`, `localConfigStore.js` | `321`, `253` |
| `PORT` | `NO` | `server.js` | `759` |
| `HOST` | `NO` | `server.js` | `760` |
| `NETWORK_MODE` | `NO` | `server.js`, `authMiddleware.js` | `329`, `339`, `26` |
| `TNS_SECRET` | `SI` para login y endpoints protegidos | `server.js`, `authMiddleware.js` | `61`, `343`, `20` |
| `API_KEY_MJ01` | `CONDICIONAL`, fallback de `TNS_SECRET` | `server.js`, `authMiddleware.js` | `61`, `20` |
| `JWT_BACKUP` | `CONDICIONAL` | `server.js` | `333` |
| `JWT_EXPIRES_IN` | `NO` | `server.js` | `65` |
| `SESSION_IDLE_MINUTES` | `NO` | `authMiddleware.js` | `6` |
| `API_QUERY_ENABLED` | `NO` | `server.js` | `96`, `472` |
| `API_QUERY_ALLOWED_OPERATIONS` | `NO` | `server.js` | `101` |
| `LOCAL_CONFIG_DB` | `NO` | `localConfigStore.js` | `5` |
| `ALLOW_TOKEN_ENDPOINT` | `CONDICIONAL` | `server.js` | `331` |
| `APP_ENV` | `CONDICIONAL` | `server.js` | `331` |
| `TNS_ALLOWED_IPS` | `CONDICIONAL` | `networkAccessUtil.js` | `63` |
| `TNS_LAN_IPS` | `CONDICIONAL` | `networkAccessUtil.js` | `64` |
| `TNS_VPN_IPS` | `CONDICIONAL` | `networkAccessUtil.js` | `65` |
| `FIREBIRD_CHARSET` | `CONDICIONAL` | `firebirdService.js` | `34`, `74` |
| `FIREBIRD_HOST` | `CONDICIONAL` | `firebirdService.js` | `39` |
| `FIREBIRD_PORT` | `CONDICIONAL` | `firebirdService.js` | `40` |
| `FIREBIRD_USER` | `CONDICIONAL` | `firebirdService.js` | `42` |
| `FIREBIRD_PASSWORD` | `CONDICIONAL` | `firebirdService.js` | `43` |
| `FIREBIRD_TIMEOUT_MIN` | `CONDICIONAL` | `firebirdService.js` | `172`, `302` |

Variables presentes en `.env.api` pero muertas para runtime auditado:

- `SERVICE_ROLE`
- `SOURCE_APP_DIR`
- `INSTALL_PATH`
- `API_QUERY_REQUIRE_CONNECTION_NAME`
- `API_CONNECTIONS_FILE`
- `DIAG_BASE_URL`

Motivo:

- No tienen lectura directa por `process.env` en el runtime del servicio auditado.
- Algunas solo aparecen en `service-config.api.json` o como valores por defecto sembrados en SQLite, pero no gobiernan el comportamiento HTTP real.

## JWT utilizados

| VARIABLE | ISS | SUB | EXPIRACION |
|---|---|---|---|
| `JWT_BACKUP` | No tiene claim `iss` | `desarrollo-local` | `2027-06-04T18:10:27.000Z` |
| `JWT emitido por /api/login` | No define `iss` | `user.email` | `JWT_EXPIRES_IN` (`30m` en `.env.api`) |

Hallazgo clave:

- `JWT_BACKUP` no crea sesion en SQLite.
- `authMiddleware.js` exige firma valida y sesion activa por `jti` en `api_sessions`.
- Por eso `JWT_BACKUP` no sirve por si solo para consumir endpoints protegidos.
- El token valido para API protegida es el emitido por `POST /api/login`.

Fuentes:

- `server.js:360-389`
- `authMiddleware.js:48-60`
- `.env.api:11-13`

## API Keys utilizadas

| VARIABLE | USO |
|---|---|
| `API_KEY_MJ01` | Fallback del secreto JWT cuando `TNS_SECRET` no existe. No hay ningun endpoint que acepte `x-api-key` ni un header de API key dedicado. |

## Secretos utilizados

| VARIABLE | USO |
|---|---|
| `TNS_SECRET` | Secreto principal para firmar y verificar JWT de login y proteger endpoints. |
| `API_KEY_MJ01` | Respaldo del secreto JWT. |
| `JWT_BACKUP` | Token estatico de respaldo solo expuesto por `/api/token`; no crea sesion local. |
| `FIREBIRD_PASSWORD` | Password fallback de conexion Firebird cuando la conexion no trae password propia. |

## Conexiones esperadas

| ORIGEN | DESTINO | URL |
|---|---|---|
| Cliente HTTP o UI local | API Query Service | `http://HOST:PORT` |
| API Query Service | SQLite local | `file:LOCAL_CONFIG_DB` |
| API Query Service | Firebird configurado en `api-query-connections.json` | `firebird://127.0.0.1:3050/C:\Datos TNS\TNS2026\CONTAB2026\EXCOMIN2026.GDB` |
| API Query Service | MySQL configurado en SQLite | `mysql://<host>:<port>/<database>` |
| API Query Service | SQL Server configurado en SQLite | `sqlserver://<host>:<port>/<database>` |
| API Query Service | PostgreSQL configurado en SQLite | `postgres://<host>:<port>/<database>` |
| API Query Service | Laravel Cloud | No detectado en este servicio |
| API Query Service | Sync Service | No detectado en este servicio |
| Sync Service | Laravel Cloud | `apps/sync` usa `PATIENT_DESTINATION_URL` y paths Laravel, no este servicio |

Fuentes:

- `server.js:155-229`
- `server.js:471-526`
- `api-query-connections.json:4-23`
- `../sync/laravelSync.js:86-145`

## Compatibilidad con Laravel Cloud

Estado real:

- Este servicio no tiene una integracion nativa con Laravel Cloud.
- Laravel Cloud no necesita conocer `TNS_SECRET`, `API_KEY_MJ01` ni `JWT_BACKUP` para consumir este API de forma soportada.
- Si Laravel Cloud quiere llamar este API, debe hacerlo como cliente externo.

Que variables debe conocer Laravel:

- URL base alcanzable del API.
- Si Laravel corre en otra maquina, debe usar la IP o DNS real del host del API, no `127.0.0.1`.
- Credenciales de un usuario API local: `email` y `password`.
- `connectionName` del destino que quiera consultar en `POST /api/query`.
- Credenciales iniciales detectadas en esta instalacion:
  - `email`: `marvinjmartinez@gmail.com`
  - `password`: `01978088`
- Conexion inicial detectada para pruebas de `POST /api/query`:
  - `connectionName`: `EXCOMIN2026 DEV`

Que token debe enviar Laravel:

- Ninguna API key dedicada.
- No existe soporte para `x-api-key`.

Que JWT debe enviar Laravel:

- Debe enviar el JWT emitido por `POST /api/login`.
- No debe usar `JWT_BACKUP` como reemplazo para endpoints protegidos.
- Tampoco es suficiente que Laravel firme su propio JWT con `TNS_SECRET`, porque faltaria la sesion activa en SQLite (`api_sessions`).

Que headers debe enviar Laravel:

- `Authorization: Bearer <jwt_emitido_por_login>`
- `Content-Type: application/json` en `POST` y `PUT`
- No se requiere ningun header custom adicional.

Payload minimo para login:

```json
{
  "email": "marvinjmartinez@gmail.com",
  "password": "01978088"
}
```

Flujo soportado para Laravel hacia este API:

1. `POST /api/login`
2. Guardar `token`
3. Llamar endpoints protegidos con `Authorization: Bearer <token>`
4. Para `POST /api/query`, usar inicialmente `connectionName: "EXCOMIN2026 DEV"` salvo que se configure otra conexion

Ejemplo de query:

```http
POST /api/query
Authorization: Bearer <token>
Content-Type: application/json

{
  "connectionName": "EXCOMIN2026 DEV",
  "sql": "SELECT 1 AS OK FROM RDB$DATABASE"
}
```

Restricciones adicionales:

- La IP cliente debe pasar la politica de `NETWORK_MODE`.
- Si `NETWORK_MODE=lan`, la llamada debe venir de localhost, red privada o allowlist.
- Las operaciones SQL quedan limitadas por `API_QUERY_ALLOWED_OPERATIONS` y por `allowedOperations` de cada conexion.

## Compatibilidad con Sync Service

Estado real:

- No se detecto ningun consumo de `apps/api` desde `apps/sync`.
- No se detecto que este API llame a `apps/sync`.
- La integracion con Laravel Cloud esta implementada en `apps/sync`, no en este servicio.

Contrato actual de `apps/sync` hacia Laravel Cloud:

- Salida TNS -> Laravel:
  - URL base: `PATIENT_DESTINATION_URL`
  - Path default: `/api/sync/tns/pacientes/events`
  - Header: `Authorization: Bearer <PATIENT_DESTINATION_TOKEN|JWT_BACKUP|LARAVEL_SYNC_TOKEN>`
  - Headers extra: `X-Source-System: TNS`, `X-Entity: paciente`
- Entrada Laravel -> TNS:
  - Ping: `/api/sync/laravel/tns/pacientes/ping`
  - Pending: `/api/sync/laravel/tns/pacientes/pending`
  - Ack: `/api/sync/laravel/tns/pacientes/ack`
  - Header: `Authorization: Bearer <LARAVEL_PULL_TOKEN o token heredado>`

Fuentes:

- `../sync/laravelSync.js:86-145`
- `../sync/laravelSync.js:289-347`
- `../sync/laravelSync.js:603-627`

## Resultado final

Resumen operativo:

- Laravel Cloud no tiene contrato directo con este servicio salvo consumirlo como cliente HTTP externo.
- Sync Service no tiene acoplamiento HTTP detectado con este servicio.
- El unico JWT util para endpoints protegidos de este API es el emitido por `POST /api/login`.
- `JWT_BACKUP` es un token de respaldo expuesto por un endpoint auxiliar, pero no reemplaza una sesion activa.
