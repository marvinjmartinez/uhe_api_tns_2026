# TNS Local API Query Service

Este subproyecto es independiente y contiene todo lo necesario para ejecutar el servicio de API Query.

## Ejecutar localmente

1. Abrir terminal en `apps/api`
2. `npm install`
3. `npm start`

El servicio escucha por defecto en `http://127.0.0.1:8086`.

## Variables de entorno

Copiar `apps/api/.env.example` a `apps/api/.env` y ajustar los valores.

Variables clave:

- `SERVICE_ROLE=api`
- `PORT=8086`
- `HOST=127.0.0.1`
- `NETWORK_MODE=lan`
- `TNS_SECRET`
- `API_KEY_MJ01`
- `JWT_BACKUP`
- `API_QUERY_ENABLED`
- `API_CONNECTIONS_FILE=./api-query-connections.json`
- `LOCAL_CONFIG_DB=./data/local-config-api.sqlite`

## Endpoints principales

- `GET /api/health`
- `GET /api/token`
- `POST /api/query`
- `POST /api/query/test`
- `GET /api/query/log`
- `GET /api/query/connections`
- `GET /api/connections`
- `GET /api/connections/:id`
- `POST /api/connections`
- `PUT /api/connections/:id`
- `DELETE /api/connections/:id`
- `GET /api/config/local`
- `PUT /api/config/settings/:key`
- `GET /api/config/modules`
- `PUT /api/config/modules/:module`
- `GET /api/services/status`
- `GET /api/connectivity/status`
- `GET /api/metrics`

## Instalación en Windows

Los instaladores están en `apps/api/deploy/windows`:

- `install-api-query.bat`
- `precheck-api-query.bat`
- `uninstall-api-query.bat`

## Base de datos local

El estado local se guarda en `apps/api/data/local-config-api.sqlite`.
