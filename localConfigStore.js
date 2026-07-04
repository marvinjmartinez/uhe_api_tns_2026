const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_RELATIVE_PATH = process.env.LOCAL_CONFIG_DB || path.join('data', 'local-config-api.sqlite');
const dbPath = path.isAbsolute(DB_RELATIVE_PATH)
  ? DB_RELATIVE_PATH
  : path.join(__dirname, DB_RELATIVE_PATH);

const DEFAULT_FEATURES = [
  ['api_query', 'API Query', true],
  ['query_logs', 'Logs API Query', true],
  ['connectivity_tests', 'Pruebas de conectividad', true],
  ['metrics', 'Metricas', true],
  ['audit', 'Auditoria', true],
  ['config_views', 'Vistas de configuracion', true]
];

const DEFAULT_SETTING_VALUES = {
  SERVICE_ROLE: 'api',
  SERVICE_NAME: 'TNS Local API Query Service',
  PORT: '8086',
  HOST: '127.0.0.1',
  NETWORK_MODE: 'lan',
  LOCAL_CONFIG_DB: path.join('data', 'local-config-api.sqlite'),
  API_QUERY_ENABLED: 'true',
  API_QUERY_REQUIRE_CONNECTION_NAME: 'true',
  API_QUERY_ALLOWED_OPERATIONS: 'SELECT,INSERT,UPDATE,DELETE',
  API_CONNECTIONS_FILE: './api-query-connections.json',
  SYNC_LOG_LEVEL: 'info',
  SYNC_LOG_DIR: './logs',
  DIAG_BASE_URL: 'http://127.0.0.1:8086'
};

let SQL = null;
let db = null;
let ready = false;
let lastError = null;

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function persist() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function redactSensitiveValue(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('token') || normalizedKey.includes('secret') || normalizedKey.includes('password') || normalizedKey.includes('key')) {
    return value ? '********' : '';
  }
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function addAuditEntry(key, oldValue, newValue, actor = {}) {
  run(`
    INSERT INTO config_audit_log (setting_key, old_value, new_value, user_name, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    String(key || '').trim(),
    redactSensitiveValue(key, oldValue),
    redactSensitiveValue(key, newValue),
    actor.userName || 'api-service',
    actor.ipAddress || null,
    nowIso()
  ]);
}

function ensureSchema() {
  run(`
    CREATE TABLE IF NOT EXISTS system_info (
      installation_id TEXT PRIMARY KEY,
      service_name TEXT,
      service_role TEXT,
      version TEXT,
      installed_at TEXT,
      upgraded_at TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS service_settings (
      key TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      value_json TEXT NOT NULL,
      description TEXT,
      editable INTEGER NOT NULL DEFAULT 1,
      requires_restart INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS feature_settings (
      feature_key TEXT PRIMARY KEY,
      feature_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      restart_required INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'sqlite',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS config_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT,
      old_value TEXT,
      new_value TEXT,
      user_name TEXT,
      ip_address TEXT,
      created_at TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS query_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      engine TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      database_name TEXT,
      db_path TEXT,
      username TEXT,
      password TEXT,
      timeout_ms INTEGER,
      allowed_operations_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sqlite',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS api_query_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      status TEXT NOT NULL,
      query_type TEXT,
      connection_id TEXT,
      connection_name TEXT,
      engine TEXT,
      sql_text TEXT,
      row_count INTEGER,
      duration_ms INTEGER,
      error_text TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS local_config_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS api_users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'api',
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'sqlite',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS api_sessions (
      session_id TEXT PRIMARY KEY,
      jwt_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'api',
      status TEXT NOT NULL DEFAULT 'active',
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_seen_ip TEXT,
      user_agent TEXT,
      revoked_at TEXT,
      revoke_reason TEXT
    )
  `);
}

function seedSystemInfo(packageJsonPath) {
  const existing = get('SELECT installation_id FROM system_info LIMIT 1');
  const pkg = readJsonFile(packageJsonPath, {});
  if (existing) {
    run('UPDATE system_info SET upgraded_at = ?, version = ? WHERE installation_id = ?', [
      nowIso(),
      pkg.version || '1.0.0',
      existing.installation_id
    ]);
    return;
  }

  run(`
    INSERT INTO system_info (installation_id, service_name, service_role, version, installed_at, upgraded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    `api-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    process.env.SERVICE_NAME || 'TNS Local API Query Service',
    'api',
    pkg.version || '1.0.0',
    nowIso(),
    nowIso()
  ]);
}

function seedSettings(serviceConfigPath, envValues = process.env) {
  const serviceConfig = readJsonFile(serviceConfigPath, {});
  const required = serviceConfig.requiredEnv || {};
  const optional = serviceConfig.optionalEnv || {};
  const keys = [
    ...Object.entries(required).flatMap(([category, items]) => items.map(key => ({ key, category, required: true }))),
    ...Object.entries(optional).flatMap(([category, items]) => items.map(key => ({ key, category, required: false })))
  ];
  const uniqueKeys = new Map(keys.map(item => [item.key, item]));

  for (const item of uniqueKeys.values()) {
    const exists = get('SELECT key FROM service_settings WHERE key = ?', [item.key]);
    if (exists) continue;
    const envValue = Object.prototype.hasOwnProperty.call(envValues, item.key)
      ? envValues[item.key]
      : DEFAULT_SETTING_VALUES[item.key] ?? '';
    run(`
      INSERT INTO service_settings (key, category, value_json, description, editable, requires_restart, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, ?)
    `, [
      item.key,
      item.category,
      JSON.stringify(envValue),
      item.required ? 'Variable requerida del servicio API.' : 'Variable opcional del servicio API.',
      nowIso()
    ]);
  }
}

function seedFeatures() {
  for (const [key, name, enabled] of DEFAULT_FEATURES) {
    const exists = get('SELECT feature_key FROM feature_settings WHERE feature_key = ?', [key]);
    if (exists) continue;
    run(`
      INSERT INTO feature_settings (feature_key, feature_name, enabled, restart_required, source, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'sqlite', ?, ?)
    `, [key, name, enabled ? 1 : 0, nowIso(), nowIso()]);
  }
}

function normalizeConnection(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('id es requerido');

  const engine = String(input.engine || '').trim().toLowerCase();
  if (!['firebird', 'mysql', 'sqlserver', 'mssql', 'postgres', 'postgresql'].includes(engine)) {
    throw new Error('engine debe ser firebird, mysql, sqlserver o postgres');
  }

  const allowedOperationsRaw = Array.isArray(input.allowedOperations)
    ? input.allowedOperations
    : safeJsonParse(input.allowed_operations_json, ['SELECT']);
  const allowedOperations = allowedOperationsRaw
    .map(item => String(item || '').trim().toUpperCase())
    .filter(item => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(item));

  return {
    id,
    name: String(input.name || id).trim(),
    active: !(input.active === false || input.active === 0 || String(input.active).toLowerCase() === 'false'),
    engine: engine === 'mssql' ? 'sqlserver' : engine === 'postgresql' ? 'postgres' : engine,
    host: input.host ? String(input.host).trim() : null,
    port: input.port === '' || input.port === undefined || input.port === null ? null : Number(input.port),
    database: input.database || input.database_name || null,
    dbPath: input.dbPath || input.db_path || null,
    user: input.user || input.username || null,
    password: input.password || null,
    timeoutMs: input.timeoutMs || input.timeout_ms || null,
    allowedOperations: allowedOperations.length ? allowedOperations : ['SELECT'],
    options: input.options && typeof input.options === 'object' ? input.options : safeJsonParse(input.options_json, {})
  };
}

function seedConnections(connectionsPath) {
  const seeded = get('SELECT value FROM local_config_meta WHERE key = ?', ['connectionsSeeded']);
  if (seeded?.value === 'true') return;

  const parsed = readJsonFile(connectionsPath, {});
  const list = Array.isArray(parsed.connections) ? parsed.connections : [];
  for (const item of list) {
    upsertConnection(item, 'bootstrap-json', { userName: 'bootstrap', ipAddress: null }, false);
  }
  run('INSERT OR REPLACE INTO local_config_meta (key, value, updated_at) VALUES (?, ?, ?)', [
    'connectionsSeeded',
    'true',
    nowIso()
  ]);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const normalizedPassword = String(password || '');
  if (!normalizedPassword) throw new Error('password es requerido');
  const hash = crypto.scryptSync(normalizedPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const normalizedHash = String(passwordHash || '').trim();
  const normalizedPassword = String(password || '');
  if (!normalizedHash || !normalizedPassword) return false;

  const [algorithm, salt, expectedHex] = normalizedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;

  const actual = crypto.scryptSync(normalizedPassword, salt, expectedHex.length / 2);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeApiUser(input = {}) {
  const email = String(input.email || input.username || input.user || '').trim().toLowerCase();
  if (!email) throw new Error('email es requerido');

  const passwordHash = String(
    input.passwordHash
    || input.password_hash
    || (input.password ? hashPassword(input.password) : '')
  ).trim();
  if (!passwordHash) throw new Error('passwordHash o password es requerido');

  return {
    email,
    passwordHash,
    role: String(input.role || 'api').trim() || 'api',
    active: !(input.active === false || input.active === 0 || String(input.active).toLowerCase() === 'false')
  };
}

function upsertApiUser(input, source = 'sqlite') {
  const item = normalizeApiUser(input);
  const existing = get('SELECT * FROM api_users WHERE email = ?', [item.email]);
  const createdAt = existing?.created_at || nowIso();
  run(`
    INSERT OR REPLACE INTO api_users (
      email, password_hash, role, active, source, created_at, updated_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    item.email,
    item.passwordHash,
    item.role,
    item.active ? 1 : 0,
    existing?.source || source,
    createdAt,
    nowIso(),
    existing?.last_login_at || null
  ]);
}

function seedApiUsers(usersPath) {
  const seeded = get('SELECT value FROM local_config_meta WHERE key = ?', ['apiUsersSeeded']);
  const parsed = readJsonFile(usersPath, {});
  const list = Array.isArray(parsed.users) ? parsed.users : [];
  if (seeded?.value === 'true') {
    for (const item of list) {
      const normalized = normalizeApiUser(item);
      const existing = getApiUserByEmail(normalized.email);
      if (!existing) {
        upsertApiUser(item, 'bootstrap-json');
        continue;
      }
      if (existing.source === 'bootstrap-json' && (existing.role !== normalized.role || existing.active !== normalized.active)) {
        upsertApiUser({
          email: normalized.email,
          role: normalized.role,
          active: normalized.active,
          passwordHash: existing.passwordHash
        }, 'bootstrap-json');
      }
    }
    return;
  }

  for (const item of list) {
    upsertApiUser(item, 'bootstrap-json');
  }
  run('INSERT OR REPLACE INTO local_config_meta (key, value, updated_at) VALUES (?, ?, ?)', [
    'apiUsersSeeded',
    'true',
    nowIso()
  ]);
}

function getApiUserByEmail(email) {
  if (!email) return null;
  const row = get('SELECT * FROM api_users WHERE lower(email) = ?', [String(email).trim().toLowerCase()]);
  if (!row) return null;
  return {
    email: row.email,
    role: row.role || 'api',
    active: Boolean(row.active),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null,
    passwordHash: row.password_hash
  };
}

function listApiUsers() {
  return all('SELECT * FROM api_users ORDER BY email COLLATE NOCASE').map(row => ({
    email: row.email,
    role: row.role || 'api',
    active: Boolean(row.active),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null
  }));
}

function saveApiUser(input, actor = {}) {
  const email = String(input?.email || '').trim().toLowerCase();
  if (!email) throw new Error('email es requerido');

  const existing = getApiUserByEmail(email);
  const payload = {
    email,
    role: input?.role,
    active: input?.active
  };

  if (input?.password !== undefined && String(input.password) !== '') {
    payload.password = input.password;
  } else if (input?.passwordHash) {
    payload.passwordHash = input.passwordHash;
  } else if (existing?.passwordHash) {
    payload.passwordHash = existing.passwordHash;
  }

  if (!payload.password && !payload.passwordHash) {
    throw new Error('password es requerido para crear usuario');
  }

  upsertApiUser(payload, existing?.source || 'sqlite');
  if (existing?.active && payload.active === false) {
    revokeApiSessionsByEmail(email, 'user-disabled', actor);
  }
  addAuditEntry(`api-user:${email}`, existing ? 'updated' : '', 'saved', actor);
  persist();
  return getApiUserByEmail(email);
}

function deleteApiUser(email, actor = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const existing = getApiUserByEmail(normalizedEmail);
  if (!existing) throw new Error(`Usuario no encontrado: ${normalizedEmail}`);

  const activeUsers = listApiUsers().filter(item => item.active);
  if (existing.active && activeUsers.length <= 1) {
    throw new Error('No se puede eliminar el ultimo usuario activo');
  }

  revokeApiSessionsByEmail(normalizedEmail, 'user-deleted', actor);
  run('DELETE FROM api_users WHERE email = ?', [normalizedEmail]);
  addAuditEntry(`api-user:${normalizedEmail}`, 'existing', 'deleted', actor);
  persist();
}

function authenticateApiUser(email, password) {
  const user = getApiUserByEmail(email);
  if (!user || !user.active) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  run('UPDATE api_users SET last_login_at = ?, updated_at = ? WHERE email = ?', [
    nowIso(),
    nowIso(),
    user.email
  ]);
  persist();
  return {
    email: user.email,
    role: user.role,
    active: user.active,
    source: user.source
  };
}

function createApiSession(input = {}) {
  const sessionId = String(input.sessionId || input.session_id || input.jti || '').trim();
  const jwtId = String(input.jti || input.jwtId || input.jwt_id || sessionId).trim();
  const email = String(input.email || '').trim().toLowerCase();
  const role = String(input.role || 'api').trim() || 'api';
  const issuedAt = String(input.issuedAt || input.issued_at || nowIso()).trim();
  const expiresAt = String(input.expiresAt || input.expires_at || '').trim();
  if (!sessionId) throw new Error('sessionId es requerido');
  if (!jwtId) throw new Error('jti es requerido');
  if (!email) throw new Error('email es requerido');
  if (!expiresAt) throw new Error('expiresAt es requerido');

  run(`
    INSERT OR REPLACE INTO api_sessions (
      session_id, jwt_id, email, role, status, issued_at, expires_at, created_at, updated_at,
      last_seen_at, last_seen_ip, user_agent, revoked_at, revoke_reason
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `, [
    sessionId,
    jwtId,
    email,
    role,
    issuedAt,
    expiresAt,
    nowIso(),
    nowIso(),
    issuedAt,
    input.ipAddress || input.ip_address || null,
    input.userAgent || input.user_agent || null
  ]);
  addAuditEntry(`api-session:${sessionId}`, '', `created:${email}`, {
    userName: email,
    ipAddress: input.ipAddress || input.ip_address || null
  });
  persist();
  return getApiSessionByJti(jwtId);
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    jti: row.jwt_id,
    email: row.email,
    role: row.role || 'api',
    status: row.status || 'active',
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at || null,
    lastSeenIp: row.last_seen_ip || null,
    userAgent: row.user_agent || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || null,
    active: row.status === 'active' && !row.revoked_at && Date.parse(row.expires_at) > Date.now()
  };
}

function getApiSessionByJti(jti) {
  if (!jti) return null;
  return mapSessionRow(get('SELECT * FROM api_sessions WHERE jwt_id = ?', [String(jti).trim()]));
}

function getApiSessionById(sessionId) {
  if (!sessionId) return null;
  return mapSessionRow(get('SELECT * FROM api_sessions WHERE session_id = ?', [String(sessionId).trim()]));
}

function touchApiSession(jti, actor = {}) {
  const existing = getApiSessionByJti(jti);
  if (!existing) return null;
  run('UPDATE api_sessions SET updated_at = ?, last_seen_at = ?, last_seen_ip = ?, user_agent = ? WHERE jwt_id = ?', [
    nowIso(),
    nowIso(),
    actor.ipAddress || existing.lastSeenIp || null,
    actor.userAgent || existing.userAgent || null,
    existing.jti
  ]);
  persist();
  return getApiSessionByJti(jti);
}

function revokeApiSession(sessionIdOrJti, reason = 'manual', actor = {}) {
  const needle = String(sessionIdOrJti || '').trim();
  if (!needle) throw new Error('sessionId o jti es requerido');
  const existing = get('SELECT * FROM api_sessions WHERE session_id = ? OR jwt_id = ? LIMIT 1', [needle, needle]);
  if (!existing) throw new Error('Sesion no encontrada');
  if (existing.revoked_at || existing.status === 'revoked') return mapSessionRow(existing);
  run('UPDATE api_sessions SET status = ?, revoked_at = ?, revoke_reason = ?, updated_at = ?, last_seen_ip = ? WHERE session_id = ?', [
    'revoked',
    nowIso(),
    String(reason || 'manual'),
    nowIso(),
    actor.ipAddress || existing.last_seen_ip || null,
    existing.session_id
  ]);
  addAuditEntry(`api-session:${existing.session_id}`, 'active', `revoked:${reason}`, actor);
  persist();
  return getApiSessionById(existing.session_id);
}

function revokeApiSessionsByEmail(email, reason = 'manual', actor = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return [];
  const rows = all('SELECT session_id FROM api_sessions WHERE lower(email) = ? AND revoked_at IS NULL AND status = ?', [
    normalizedEmail,
    'active'
  ]);
  return rows.map(row => revokeApiSession(row.session_id, reason, actor));
}

function listApiSessions(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
  const includeRevoked = options.includeRevoked === true || String(options.includeRevoked).toLowerCase() === 'true';
  const email = String(options.email || '').trim().toLowerCase();
  let rows = all('SELECT * FROM api_sessions ORDER BY created_at DESC');
  if (!includeRevoked) rows = rows.filter(row => !row.revoked_at && row.status === 'active');
  if (email) rows = rows.filter(row => String(row.email || '').toLowerCase() === email);
  return rows.slice(0, limit).map(mapSessionRow);
}

async function initialize(options = {}) {
  if (ready) return { ready, dbPath };
  try {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs({
      locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
    });

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();

    ensureSchema();
    seedSystemInfo(options.packageJsonPath || path.join(__dirname, 'package.json'));
    seedSettings(options.serviceConfigPath || path.join(__dirname, 'service-config.api.json'), options.envValues || process.env);
    seedFeatures();
    seedConnections(options.connectionsPath || path.join(__dirname, 'api-query-connections.json'));
    seedApiUsers(options.authUsersPath || path.join(__dirname, 'api-auth-users.json'));
    persist();
    ready = true;
    lastError = null;
    return { ready, dbPath };
  } catch (error) {
    ready = false;
    lastError = error;
    return { ready, dbPath, error };
  }
}

function isReady() {
  return ready;
}

function getStatus() {
  return {
    ready,
    dbPath,
    error: lastError ? lastError.message : null,
    connections: all('SELECT COUNT(*) AS c FROM query_connections')[0]?.c || 0,
    settings: all('SELECT COUNT(*) AS c FROM service_settings')[0]?.c || 0,
    sessions: all('SELECT COUNT(*) AS c FROM api_sessions')[0]?.c || 0
  };
}

function getSystemInfo() {
  const row = get('SELECT * FROM system_info LIMIT 1');
  if (!row) return null;
  return {
    installationId: row.installation_id,
    serviceName: row.service_name,
    serviceRole: row.service_role,
    version: row.version,
    installedAt: row.installed_at,
    upgradedAt: row.upgraded_at
  };
}

function listSettings() {
  return all('SELECT * FROM service_settings ORDER BY key COLLATE NOCASE').map(row => ({
    key: row.key,
    category: row.category,
    value: safeJsonParse(row.value_json, null),
    description: row.description || '',
    editable: Boolean(row.editable),
    requiresRestart: Boolean(row.requires_restart),
    updatedAt: row.updated_at
  }));
}

function updateSetting(key, value, actor = {}) {
  const existing = get('SELECT * FROM service_settings WHERE key = ?', [key]);
  if (!existing) throw new Error(`Configuracion no encontrada: ${key}`);
  const previous = safeJsonParse(existing.value_json, null);
  run('UPDATE service_settings SET value_json = ?, updated_at = ? WHERE key = ?', [
    JSON.stringify(value),
    nowIso(),
    key
  ]);
  addAuditEntry(key, previous, value, actor);
  persist();
  return listSettings().find(item => item.key === key);
}

function listFeatures() {
  return all('SELECT * FROM feature_settings ORDER BY feature_key COLLATE NOCASE').map(row => ({
    key: row.feature_key,
    name: row.feature_name,
    enabled: Boolean(row.enabled),
    restartRequired: Boolean(row.restart_required),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function updateFeature(key, enabled, actor = {}) {
  const existing = get('SELECT * FROM feature_settings WHERE feature_key = ?', [key]);
  if (!existing) throw new Error(`Modulo no encontrado: ${key}`);
  const nextEnabled = enabled === true || enabled === 1 || String(enabled).toLowerCase() === 'true';
  run('UPDATE feature_settings SET enabled = ?, updated_at = ? WHERE feature_key = ?', [
    nextEnabled ? 1 : 0,
    nowIso(),
    key
  ]);
  addAuditEntry(`module:${key}`, Boolean(existing.enabled), nextEnabled, actor);
  persist();
  return listFeatures().find(item => item.key === key);
}

function getConnectionsSnapshot() {
  return all('SELECT * FROM query_connections ORDER BY name COLLATE NOCASE').map(row => ({
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    isActive: Boolean(row.active),
    engine: row.engine,
    host: row.host || null,
    port: row.port ?? null,
    database: row.database_name || null,
    dbPath: row.db_path || null,
    user: row.username || null,
    password: row.password || null,
    timeoutMs: row.timeout_ms ?? null,
    allowedOperations: safeJsonParse(row.allowed_operations_json, ['SELECT']),
    options: safeJsonParse(row.options_json, {}),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function getConnection(id) {
  return getConnectionsSnapshot().find(item => item.id === String(id || '').trim()) || null;
}

function upsertConnection(input, source = 'sqlite', actor = {}, audit = true) {
  const item = normalizeConnection(input);
  const existing = get('SELECT * FROM query_connections WHERE id = ?', [item.id]);
  const createdAt = existing?.created_at || nowIso();
  const password = input.password === undefined ? existing?.password || null : item.password;
  run(`
    INSERT OR REPLACE INTO query_connections (
      id, name, active, engine, host, port, database_name, db_path, username, password,
      timeout_ms, allowed_operations_json, options_json, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    item.id,
    item.name,
    item.active ? 1 : 0,
    item.engine,
    item.host,
    Number.isFinite(item.port) ? item.port : null,
    item.database || null,
    item.dbPath || null,
    item.user || null,
    password,
    Number.isFinite(Number(item.timeoutMs)) ? Number(item.timeoutMs) : null,
    JSON.stringify(item.allowedOperations),
    JSON.stringify(item.options || {}),
    existing?.source || source,
    createdAt,
    nowIso()
  ]);
  if (audit) addAuditEntry(`connection:${item.id}`, existing ? 'updated' : '', 'saved', actor);
  persist();
  return getConnection(item.id);
}

function deleteConnection(id, actor = {}) {
  const existing = getConnection(id);
  if (!existing) throw new Error(`Conexion no encontrada: ${id}`);
  run('DELETE FROM query_connections WHERE id = ?', [id]);
  addAuditEntry(`connection:${id}`, 'existing', 'deleted', actor);
  persist();
}

function recordQueryLog(entry = {}) {
  run(`
    INSERT INTO api_query_logs (ts, status, query_type, connection_id, connection_name, engine, sql_text, row_count, duration_ms, error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    entry.ts || nowIso(),
    entry.status || 'ok',
    entry.type || null,
    entry.connectionId || null,
    entry.connectionName || null,
    entry.engine || null,
    entry.sql || null,
    entry.rows ?? null,
    entry.durationMs ?? null,
    entry.error || null
  ]);
  persist();
}

function listQueryLogs({ limit = 100, offset = 0, status = '', type = '', search = '', minDurationMs = null } = {}) {
  let entries = all('SELECT * FROM api_query_logs ORDER BY id DESC');
  if (status) entries = entries.filter(item => String(item.status || '').toLowerCase() === String(status).toLowerCase());
  if (type) entries = entries.filter(item => String(item.query_type || '').toLowerCase() === String(type).toLowerCase());
  if (search) {
    const needle = String(search).toLowerCase();
    entries = entries.filter(item =>
      String(item.sql_text || '').toLowerCase().includes(needle)
      || String(item.connection_name || '').toLowerCase().includes(needle)
      || String(item.error_text || '').toLowerCase().includes(needle)
    );
  }
  if (minDurationMs !== null && minDurationMs !== undefined && minDurationMs !== '') {
    const threshold = Number(minDurationMs);
    if (Number.isFinite(threshold)) {
      entries = entries.filter(item => Number(item.duration_ms || 0) >= threshold);
    }
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return {
    total: all('SELECT COUNT(*) AS c FROM api_query_logs')[0]?.c || 0,
    filteredTotal: entries.length,
    entries: entries.slice(safeOffset, safeOffset + safeLimit).map(item => ({
      id: item.id,
      ts: item.ts,
      status: item.status,
      type: item.query_type,
      connectionId: item.connection_id,
      connectionName: item.connection_name,
      engine: item.engine,
      sql: item.sql_text,
      rows: item.row_count,
      durationMs: item.duration_ms,
      error: item.error_text
    }))
  };
}

function listAuditLog(limit = 100, offset = 0) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return all('SELECT * FROM config_audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [safeLimit, safeOffset]).map(row => ({
    id: row.id,
    settingKey: row.setting_key,
    oldValue: row.old_value,
    newValue: row.new_value,
    userName: row.user_name,
    ipAddress: row.ip_address,
    createdAt: row.created_at
  }));
}

module.exports = {
  initialize,
  isReady,
  getStatus,
  getSystemInfo,
  listSettings,
  updateSetting,
  listFeatures,
  updateFeature,
  getConnectionsSnapshot,
  getConnection,
  upsertConnection,
  listApiUsers,
  getApiUserByEmail,
  saveApiUser,
  authenticateApiUser,
  deleteApiUser,
  createApiSession,
  getApiSessionByJti,
  getApiSessionById,
  touchApiSession,
  revokeApiSession,
  revokeApiSessionsByEmail,
  listApiSessions,
  deleteConnection,
  recordQueryLog,
  listQueryLogs,
  listAuditLog,
  addAuditEntry
};
