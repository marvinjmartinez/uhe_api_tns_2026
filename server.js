const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const mssql = require('mssql');
const { Client: PgClient } = require('pg');

const { evaluateNetworkAccess } = require('./networkAccessUtil');
const authMiddleware = require('./authMiddleware');
const firebirdService = require('./firebirdService');
const localConfigStore = require('./localConfigStore');

loadEnv(['.env.api', '.env.example']);

const app = express();
app.use(express.json({ limit: '2mb' }));

const VIEWS_DIR = path.join(__dirname, 'views');
const VIEW_ALLOW_LIST = new Set([
  'login.html',
  'index.html',
  'config.html',
  'config-connections.html',
  'config-modules.html',
  'config-settings.html',
  'activity.html',
  'health.html',
  'docs.html',
  'users.html',
  'shared.css',
  'shared.js',
  'openapi.api.json'
]);
const PUBLIC_VIEW_FILES = new Set(['login.html', 'shared.css', 'shared.js', 'openapi.api.json']);

function loadEnv(files) {
  for (const file of files) {
    const candidates = [
      path.join(__dirname, file),
      path.join(__dirname, '..', '..', file)
    ];
    for (const abs of candidates) {
      if (fs.existsSync(abs)) {
        dotenv.config({ path: abs, override: false });
        return abs;
      }
    }
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function asBool(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getJwtSecret() {
  return String(process.env.TNS_SECRET || process.env.API_KEY_MJ01 || '').trim();
}

function getJwtExpiresIn() {
  return String(process.env.JWT_EXPIRES_IN || '30m').trim() || '30m';
}

function requestActor(req) {
  return {
    userName: req.user?.email || req.user?.sub || req.user?.role || 'api-client',
    ipAddress: req.ip || null
  };
}

function requireRoles(...roles) {
  const allowed = new Set(roles.map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
  return (req, res, next) => {
    const currentRole = String(req.user?.role || '').trim().toLowerCase();
    if (allowed.has(currentRole)) return next();
    return res.status(403).json({ success: false, error: 'Permisos insuficientes' });
  };
}

function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return nowIso();
  return new Date(seconds * 1000).toISOString();
}

function getSettingsMap() {
  return Object.fromEntries(localConfigStore.listSettings().map(item => [item.key, item.value]));
}

function getApiQueryEnabled() {
  const settings = getSettingsMap();
  return asBool(settings.API_QUERY_ENABLED ?? process.env.API_QUERY_ENABLED, true);
}

function getGlobalAllowedOperations() {
  const settings = getSettingsMap();
  const raw = settings.API_QUERY_ALLOWED_OPERATIONS ?? process.env.API_QUERY_ALLOWED_OPERATIONS ?? 'SELECT';
  return new Set(String(raw).split(/[\s,;|]+/g).map(item => item.trim().toUpperCase()).filter(item => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(item)));
}

function normalizeQueryEngine(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (normalized === 'mssql') return 'sqlserver';
  if (['firebird', 'mysql', 'sqlserver', 'postgres'].includes(normalized)) return normalized;
  return null;
}

function stripLeadingSqlComments(sql) {
  let text = String(sql || '');
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = text.trimStart();
    if (trimmed.startsWith('--')) {
      const newlineIndex = trimmed.indexOf('\n');
      text = newlineIndex >= 0 ? trimmed.slice(newlineIndex + 1) : '';
      changed = true;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const endIndex = trimmed.indexOf('*/');
      text = endIndex >= 0 ? trimmed.slice(endIndex + 2) : '';
      changed = true;
    }
  }
  return text.trimStart();
}

function detectSqlOperation(sql) {
  const normalized = stripLeadingSqlComments(sql);
  const match = normalized.match(/^([a-zA-Z]+)/);
  return match ? String(match[1]).toUpperCase() : null;
}

function normalizeRow(row) {
  const normalized = {};
  Object.keys(row || {}).forEach((key) => {
    const value = row[key];
    if (Buffer.isBuffer(value)) {
      normalized[key] = value.toString('utf8').trim();
    } else if (value instanceof Date) {
      normalized[key] = value.toISOString();
    } else {
      normalized[key] = value;
    }
  });
  return normalized;
}

async function executeSqlByEngine(engine, sql, connection, dbPathFallback) {
  const normalizedEngine = normalizeQueryEngine(engine);
  if (!normalizedEngine) throw new Error('engine no soportado. Use firebird, mysql, sqlserver o postgres');

  if (normalizedEngine === 'firebird') {
    const dbPath = String(connection?.dbPath || connection?.database || dbPathFallback || '').trim();
    if (!dbPath) throw new Error('dbPath es requerido para engine=firebird');
    const rows = await firebirdService.query(dbPath, sql, {
      host: connection?.host,
      port: connection?.port,
      user: connection?.user,
      password: connection?.password,
      timeoutMs: Number(connection?.timeoutMs || 12000)
    });
    const normalizedRows = Array.isArray(rows) ? rows.map(normalizeRow) : [];
    return { rows: normalizedRows, rowCount: normalizedRows.length, targetDb: dbPath };
  }

  if (normalizedEngine === 'mysql') {
    let connectionHandle;
    try {
      connectionHandle = await mysql.createConnection({
        host: connection?.host,
        port: Number(connection?.port || 3306),
        database: connection?.database,
        user: connection?.user,
        password: connection?.password || ''
      });
      const [rows] = await connectionHandle.query(sql);
      const normalizedRows = Array.isArray(rows) ? rows.map(normalizeRow) : [];
      return { rows: normalizedRows, rowCount: normalizedRows.length, targetDb: connection?.database || null };
    } finally {
      if (connectionHandle) await connectionHandle.end().catch(() => {});
    }
  }

  if (normalizedEngine === 'sqlserver') {
    const pool = new mssql.ConnectionPool({
      user: connection?.user,
      password: connection?.password,
      server: connection?.host,
      port: Number(connection?.port || 1433),
      database: connection?.database,
      options: {
        encrypt: false,
        trustServerCertificate: true,
        ...(connection?.options || {})
      }
    });
    try {
      await pool.connect();
      const result = await pool.request().query(sql);
      const normalizedRows = Array.isArray(result?.recordset) ? result.recordset.map(normalizeRow) : [];
      return { rows: normalizedRows, rowCount: normalizedRows.length, targetDb: connection?.database || null };
    } finally {
      await pool.close().catch(() => {});
    }
  }

  const client = new PgClient({
    host: connection?.host,
    port: Number(connection?.port || 5432),
    database: connection?.database,
    user: connection?.user,
    password: connection?.password,
    ...(connection?.options || {})
  });
  try {
    await client.connect();
    const result = await client.query(sql);
    const normalizedRows = Array.isArray(result?.rows) ? result.rows.map(normalizeRow) : [];
    return { rows: normalizedRows, rowCount: normalizedRows.length, targetDb: connection?.database || null };
  } finally {
    await client.end().catch(() => {});
  }
}

function serializeConnectionForApi(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    engine: item.engine,
    driver: item.engine,
    host: item.host,
    port: item.port,
    database: item.database || item.dbPath || null,
    databasePath: item.dbPath || null,
    databaseName: item.database || null,
    username: item.user,
    hasPassword: Boolean(item.password),
    active: item.active,
    timeoutMs: item.timeoutMs ?? null,
    allowedOperations: item.allowedOperations,
    source: item.source,
    options: item.options || {},
    updatedAt: item.updatedAt
  };
}

function buildActor(req) {
  return {
    userName: req.user?.sub || req.user?.role || 'api-client',
    ipAddress: req.ip || req.socket?.remoteAddress || null
  };
}

function getQueryConnections() {
  return localConfigStore.getConnectionsSnapshot().map(item => ({
    ...item,
    allowedOperations: Array.isArray(item.allowedOperations) ? item.allowedOperations : ['SELECT']
  }));
}

function normalizeDbPathCandidate(value) {
  return String(value || '').trim().toLowerCase();
}

function getConnectionByNameIdOrDbPath(selector) {
  const normalizedId = String(selector?.connectionName || selector?.connectionId || selector?.nameOrId || '').trim().toLowerCase();
  const normalizedDbPath = normalizeDbPathCandidate(
    selector?.dbPath || selector?.databasePath || selector?.database || selector?.path
  );
  return getQueryConnections().find(item =>
    (normalizedId && (
      item.id.toLowerCase() === normalizedId ||
      String(item.name || '').trim().toLowerCase() === normalizedId
    )) ||
    (normalizedDbPath && (
      normalizeDbPathCandidate(item.dbPath) === normalizedDbPath ||
      normalizeDbPathCandidate(item.databasePath) === normalizedDbPath ||
      normalizeDbPathCandidate(item.database) === normalizedDbPath
    ))
  ) || null;
}

async function testConnectionBySelector(selector, sqlOverride) {
  const connection = getConnectionByNameIdOrDbPath(selector);
  const label = selector?.connectionId || selector?.connectionName || selector?.dbPath || selector?.databasePath || selector?.database;
  if (!connection) throw new Error(`Conexion no encontrada: ${label}`);
  const engine = normalizeQueryEngine(connection.engine);
  const sql = sqlOverride || (engine === 'firebird' ? 'SELECT 1 AS OK FROM RDB$DATABASE' : 'SELECT 1 AS ok');
  const startedAt = Date.now();
  const result = await executeSqlByEngine(engine, sql, connection, connection.dbPath || connection.database);
  return {
    connectionId: connection.id,
    driver: engine,
    status: 'ok',
    latencyMs: Date.now() - startedAt,
    rowsCount: result.rowCount,
    sample: result.rows?.[0] || null
  };
}

app.get('/api/health', (_req, res) => {
  const systemInfo = localConfigStore.getSystemInfo();
  const modules = Object.fromEntries(localConfigStore.listFeatures().map(item => [item.key, item]));
  res.json({
    success: true,
    status: 'ok',
    healthy: true,
    healthLevel: 'ok',
    timestamp: nowIso(),
    version: systemInfo?.version || '1.0.0',
    uptime_seconds: Math.floor(process.uptime()),
    serviceRole: 'api',
    serviceName: process.env.SERVICE_NAME || 'TNS Local API Query Service',
    apiQueryEnabled: Boolean(modules.api_query?.enabled && getApiQueryEnabled()),
    sqlite: localConfigStore.isReady(),
    localConfigStore: localConfigStore.getStatus()
  });
});

app.get('/api/token', (req, res) => {
  const access = evaluateNetworkAccess(req.ip, process.env.NETWORK_MODE || 'lan');
  if (!access.allowed) return res.status(403).json({ error: `IP no autorizada: ${access.clientIp}` });
  const enabled = process.env.APP_ENV === 'development' || asBool(process.env.ALLOW_TOKEN_ENDPOINT, false);
  if (!enabled) return res.status(404).json({ error: 'Endpoint deshabilitado' });
  const token = String(process.env.JWT_BACKUP || '').trim();
  if (!token) return res.status(404).json({ error: 'JWT_BACKUP no configurado' });
  return res.json({ token });
});

app.post('/api/login', (req, res) => {
  const access = evaluateNetworkAccess(req.ip, process.env.NETWORK_MODE || 'lan');
  if (!access.allowed) return res.status(403).json({ error: `IP no autorizada: ${access.clientIp}` });
  if (!localConfigStore.isReady()) return res.status(503).json({ success: false, error: 'Store local no disponible' });

  const jwtSecret = getJwtSecret();
  if (!jwtSecret) {
    return res.status(500).json({ success: false, error: 'Secreto JWT no configurado (TNS_SECRET/API_KEY_MJ01)' });
  }

  const email = String(req.body?.email || req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email y password son requeridos' });
  }

  const user = localConfigStore.authenticateApiUser(email, password);
  if (!user) {
    localConfigStore.addAuditEntry(`auth:login:${email || 'unknown'}`, '', 'failed', requestActor(req));
    return res.status(401).json({ success: false, error: 'Credenciales invalidas' });
  }

  const expiresIn = getJwtExpiresIn();
  const jti = crypto.randomUUID();
  const token = jwt.sign({
    sub: user.email,
    role: user.role,
    email: user.email,
    jti
  }, jwtSecret, { expiresIn });
  const decoded = jwt.decode(token) || {};
  const session = localConfigStore.createApiSession({
    sessionId: jti,
    jti,
    email: user.email,
    role: user.role,
    issuedAt: isoFromUnixSeconds(decoded.iat),
    expiresAt: isoFromUnixSeconds(decoded.exp),
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null
  });

  return res.json({
    success: true,
    token,
    tokenType: 'Bearer',
    expiresIn,
    session: {
      sessionId: session.sessionId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt
    },
    user: {
      email: user.email,
      role: user.role
    }
  });
});

app.get('/api/auth/users', authMiddleware, requireRoles('admin', 'api_admin'), (_req, res) => {
  const items = localConfigStore.listApiUsers();
  res.json({ success: true, total: items.length, users: items });
});

app.get('/api/auth/users/:email', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  const item = localConfigStore.getApiUserByEmail(req.params.email);
  if (!item) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
  const { passwordHash, ...user } = item;
  res.json({ success: true, user });
});

app.post('/api/auth/users', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  try {
    const saved = localConfigStore.saveApiUser(req.body || {}, requestActor(req));
    const { passwordHash, ...user } = saved;
    res.status(201).json({ success: true, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/auth/users/:email', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  try {
    const payload = { ...(req.body || {}), email: req.params.email };
    const saved = localConfigStore.saveApiUser(payload, requestActor(req));
    const { passwordHash, ...user } = saved;
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/auth/users/:email', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  try {
    localConfigStore.deleteApiUser(req.params.email, requestActor(req));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/sessions', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  const items = localConfigStore.listApiSessions({
    email: req.query.email,
    limit: req.query.limit,
    includeRevoked: req.query.includeRevoked
  });
  res.json({ success: true, total: items.length, sessions: items });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  try {
    const session = localConfigStore.revokeApiSession(req.user.jti, 'logout', requestActor(req));
    res.json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/auth/sessions/:sessionId', authMiddleware, requireRoles('admin', 'api_admin'), (req, res) => {
  try {
    const session = localConfigStore.revokeApiSession(req.params.sessionId, 'admin-close', requestActor(req));
    res.json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/query/connections', authMiddleware, (_req, res) => {
  const connections = getQueryConnections().map(serializeConnectionForApi);
  res.json({ success: true, total: connections.length, connections });
});

app.post('/api/query', authMiddleware, async (req, res) => {
  const apiQueryEnabled = getApiQueryEnabled();
  if (!apiQueryEnabled) return res.status(403).json({ success: false, error: 'API Query deshabilitado' });

  const sql = String(req.body?.sql || '').trim();
  const connectionName = String(req.body?.connectionName || '').trim();
  if (!sql) return res.status(400).json({ success: false, error: 'sql es requerido' });
  if (!connectionName) return res.status(400).json({ success: false, error: 'connectionName es requerido' });

  const connection = getConnectionByNameIdOrDbPath({ connectionName });
  if (!connection) return res.status(404).json({ success: false, error: `Conexion no encontrada: ${connectionName}` });
  if (!connection.active) return res.status(403).json({ success: false, error: `Conexion inactiva: ${connection.name}` });

  const operation = detectSqlOperation(sql);
  if (!operation) return res.status(400).json({ success: false, error: 'No se pudo detectar la operacion SQL' });
  const globalAllowed = getGlobalAllowedOperations();
  const localAllowed = new Set((connection.allowedOperations || []).map(item => String(item).toUpperCase()));
  if (!globalAllowed.has(operation)) return res.status(403).json({ success: false, error: `Operacion no permitida globalmente: ${operation}` });
  if (!localAllowed.has(operation)) return res.status(403).json({ success: false, error: `Operacion no permitida para la conexion: ${operation}` });

  const startedAt = Date.now();
  try {
    const result = await executeSqlByEngine(connection.engine, sql, connection, connection.dbPath || connection.database);
    localConfigStore.recordQueryLog({
      ts: nowIso(),
      status: 'ok',
      type: operation.toLowerCase(),
      connectionId: connection.id,
      connectionName: connection.name,
      engine: connection.engine,
      sql: sql.slice(0, 4000),
      rows: result.rowCount,
      durationMs: Date.now() - startedAt
    });
    return res.json({
      success: true,
      connection: serializeConnectionForApi(connection),
      operation,
      rowCount: result.rowCount,
      rows: result.rows
    });
  } catch (error) {
    localConfigStore.recordQueryLog({
      ts: nowIso(),
      status: 'error',
      type: operation.toLowerCase(),
      connectionId: connection.id,
      connectionName: connection.name,
      engine: connection.engine,
      sql: sql.slice(0, 4000),
      rows: 0,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/query/test', authMiddleware, async (req, res) => {
  try {
    const selector = {
      connectionId: req.body?.connectionId,
      connectionName: req.body?.connectionName,
      dbPath: req.body?.dbPath,
      databasePath: req.body?.databasePath,
      database: req.body?.database
    };
    const label = selector.connectionId || selector.connectionName || selector.dbPath || selector.databasePath || selector.database;
    if (!label) return res.status(400).json({ success: false, error: 'connectionId, connectionName o dbPath es requerido' });
    return res.json({ success: true, ...(await testConnectionBySelector(selector, req.body?.sql)) });
  } catch (error) {
    return res.status(500).json({ success: false, status: 'error', error: error.message });
  }
});

app.get('/api/query/log', authMiddleware, (req, res) => {
  const payload = localConfigStore.listQueryLogs({
    limit: req.query.limit,
    offset: req.query.offset,
    status: req.query.status,
    type: req.query.type,
    search: req.query.search,
    minDurationMs: req.query.minDurationMs
  });
  res.json({
    success: true,
    total: payload.total,
    filteredTotal: payload.filteredTotal,
    limit: Math.max(1, Math.min(Number(req.query.limit) || 100, 500)),
    offset: Math.max(0, Number(req.query.offset) || 0),
    entries: payload.entries
  });
});

app.get('/api/config/local', authMiddleware, (_req, res) => {
  res.json({
    success: true,
    store: localConfigStore.getStatus(),
    system: localConfigStore.getSystemInfo(),
    settings: localConfigStore.listSettings(),
    modules: localConfigStore.listFeatures(),
    connections: localConfigStore.getConnectionsSnapshot().map(serializeConnectionForApi)
  });
});

app.put('/api/config/settings/:key', authMiddleware, (req, res) => {
  try {
    const value = Object.prototype.hasOwnProperty.call(req.body || {}, 'value') ? req.body.value : req.body;
    const setting = localConfigStore.updateSetting(req.params.key, value, buildActor(req));
    return res.json({ success: true, restart_required: setting.requiresRestart, setting });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/config/modules', authMiddleware, (_req, res) => {
  res.json({ success: true, modules: localConfigStore.listFeatures() });
});

app.put('/api/config/modules/:module', authMiddleware, (req, res) => {
  try {
    const enabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled') ? req.body.enabled : req.body;
    const moduleInfo = localConfigStore.updateFeature(req.params.module, enabled, buildActor(req));
    return res.json({ success: true, restart_required: moduleInfo.restartRequired, module: moduleInfo });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/config/audit-log', authMiddleware, (req, res) => {
  res.json({ success: true, items: localConfigStore.listAuditLog(req.query.limit, req.query.offset) });
});

app.get('/api/connections', authMiddleware, (_req, res) => {
  const items = localConfigStore.getConnectionsSnapshot().map(serializeConnectionForApi);
  res.json({ success: true, total: items.length, connections: items });
});

app.get('/api/connections/:id', authMiddleware, (req, res) => {
  const item = serializeConnectionForApi(localConfigStore.getConnection(req.params.id));
  if (!item) return res.status(404).json({ success: false, error: `Conexion no encontrada: ${req.params.id}` });
  return res.json({ success: true, connection: item });
});

app.post('/api/connections', authMiddleware, (req, res) => {
  try {
    const connection = localConfigStore.upsertConnection(req.body || {}, 'sqlite', buildActor(req));
    res.status(201).json({ success: true, connection: serializeConnectionForApi(connection) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/connections/:id', authMiddleware, (req, res) => {
  try {
    const existing = localConfigStore.getConnection(req.params.id) || {};
    const payload = { ...existing, ...(req.body || {}), id: req.params.id };
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) delete payload.password;
    const connection = localConfigStore.upsertConnection(payload, 'sqlite', buildActor(req));
    res.json({ success: true, connection: serializeConnectionForApi(connection) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/connections/:id', authMiddleware, (req, res) => {
  try {
    localConfigStore.deleteConnection(req.params.id, buildActor(req));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/config/query-connections/:id', authMiddleware, (req, res) => {
  try {
    const existing = localConfigStore.getConnection(req.params.id) || {};
    const payload = { ...existing, ...(req.body || {}), id: req.params.id };
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) delete payload.password;
    const connection = localConfigStore.upsertConnection(payload, 'sqlite', buildActor(req));
    res.json({ success: true, connection: serializeConnectionForApi(connection) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/config/query-connections/:id', authMiddleware, (req, res) => {
  try {
    localConfigStore.deleteConnection(req.params.id, buildActor(req));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/connections/:id/test', authMiddleware, async (req, res) => {
  try {
    res.json({ success: true, ...(await testConnectionBySelector({ connectionId: req.params.id })) });
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', error: error.message });
  }
});

app.post('/api/connections/:id/query-test', authMiddleware, async (req, res) => {
  try {
    const sql = typeof req.body?.sql === 'string' && req.body.sql.trim() ? req.body.sql.trim() : null;
    res.json({ success: true, ...(await testConnectionBySelector({ connectionId: req.params.id }, sql)) });
  } catch (error) {
    res.status(500).json({ success: false, status: 'error', error: error.message });
  }
});

app.get('/api/services/status', authMiddleware, (_req, res) => {
  const modules = Object.fromEntries(localConfigStore.listFeatures().map(item => [item.key, item]));
  res.json({
    success: true,
    api_query: {
      enabled: Boolean(modules.api_query?.enabled && getApiQueryEnabled()),
      running: Boolean(getApiQueryEnabled()),
      status: getApiQueryEnabled() ? 'online' : 'disabled'
    },
    sqlite: {
      enabled: true,
      running: localConfigStore.isReady(),
      status: localConfigStore.isReady() ? 'online' : 'error'
    },
    connectivity_tests: {
      enabled: Boolean(modules.connectivity_tests?.enabled),
      running: true,
      status: 'online'
    },
    metrics: {
      enabled: Boolean(modules.metrics?.enabled),
      running: true,
      status: 'online'
    }
  });
});

app.get('/api/connectivity/status', authMiddleware, (_req, res) => {
  const connections = localConfigStore.getConnectionsSnapshot();
  res.json({
    success: true,
    sqlite: {
      status: localConfigStore.isReady() ? 'ok' : 'error',
      latencyMs: 0,
      dbPath: localConfigStore.getStatus().dbPath
    },
    connections: connections.map(item => ({
      id: item.id,
      driver: item.engine,
      status: item.active ? 'configured' : 'disabled',
      latencyMs: null,
      lastManualCheckAt: null
    }))
  });
});

app.get('/api/metrics', authMiddleware, (_req, res) => {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const logs = localConfigStore.listQueryLogs({ limit: 500, offset: 0 }).entries;
  const today = logs.filter(item => String(item.ts || '').startsWith(todayPrefix));
  res.json({
    success: true,
    queries_today: today.length,
    query_errors: today.filter(item => item.status === 'error').length,
    connections_total: localConfigStore.getConnectionsSnapshot().length,
    connections_active: localConfigStore.getConnectionsSnapshot().filter(item => item.active).length
  });
});

app.get('/', (_req, res) => res.redirect('/login.html'));
app.get('/:file', (req, res) => {
  const file = String(req.params.file || '').trim();
  if (!VIEW_ALLOW_LIST.has(file)) return res.status(404).send('Not Found');
  if (PUBLIC_VIEW_FILES.has(file)) {
    return res.sendFile(path.join(VIEWS_DIR, file));
  }
  return authMiddleware(req, res, () => res.sendFile(path.join(VIEWS_DIR, file)));
});

async function start() {
  await localConfigStore.initialize({
    serviceConfigPath: path.join(__dirname, 'service-config.api.json'),
    connectionsPath: path.join(__dirname, 'api-query-connections.json'),
    authUsersPath: path.join(__dirname, 'api-auth-users.json'),
    packageJsonPath: path.join(__dirname, 'package.json')
  });
  const port = Number(process.env.PORT || 8086);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`[api] listening on http://${host}:${port}`);
  });
}

start().catch((error) => {
  console.error('[api] startup error', error);
  process.exitCode = 1;
});
