const path = require('node:path');
const firebird = require('node-firebird');

function getNodeTextEncoding(charset) {
  const normalized = String(charset || '').trim().toUpperCase();
  if (!normalized) return 'utf8';
  if (normalized === 'UTF8' || normalized === 'UTF-8') return 'utf8';
  return 'latin1';
}

function decodeFirebirdBuffer(value, charset) {
  return value.toString(getNodeTextEncoding(charset)).replaceAll('\0', '');
}

function isRemoteDbPath(dbPath) {
  return typeof dbPath === 'string' && /^[^\\/:]+:(?:[A-Za-z]:\\|\\\\|\/)/.test(dbPath.trim());
}

function assertSafeQueryInput(dbPath, sql) {
  if (!dbPath || typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('dbPath es requerido');
  }

  if (!path.isAbsolute(dbPath) && !isRemoteDbPath(dbPath)) {
    throw new Error('dbPath debe ser una ruta absoluta');
  }

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    throw new Error('sql es requerido');
  }
}

function createOptions(dbPath, overrides = {}) {
  const charset = String(overrides.charset || process.env.FIREBIRD_CHARSET || '').trim();

  const sqlDialect = overrides.sqlDialect != null ? Number(overrides.sqlDialect) : undefined;

  return {
    host: String(overrides.host || process.env.FIREBIRD_HOST || '127.0.0.1').trim(),
    port: Number(overrides.port || process.env.FIREBIRD_PORT || 3050),
    database: dbPath,
    user: String(overrides.user || process.env.FIREBIRD_USER || 'SYSDBA').trim(),
    password: String(overrides.password || process.env.FIREBIRD_PASSWORD || 'masterkey'),
    charset: charset || undefined,
    lowercase_keys: false,
    role: null,
    pageSize: 4096,
    ...(sqlDialect != null ? { dialect: sqlDialect } : {})
  };
}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message || 'Operacion Firebird expiro por timeout')), timeoutMs);
    })
  ]);
}

function inferFieldType(value) {
  if (Number.isInteger(value)) {
    if (value >= -9223372036854775808 && value <= 9223372036854775807) {
      return value <= 32767 && value >= -32768 ? 'SMALLINT' : 'BIGINT';
    }
    return 'BIGINT';
  }

  if (typeof value === 'number') return 'DOUBLE';
  if (value instanceof Date) return 'TIMESTAMP';
  if (Buffer.isBuffer(value)) {
    const decoded = decodeFirebirdBuffer(value, process.env.FIREBIRD_CHARSET);
    const printableChars = decoded.replace(/[\r\n\t]/g, '').match(/[\x20-\x7E\u00A0-\u024F]/g)?.length || 0;
    const ratio = decoded.length ? printableChars / decoded.length : 0;

    if (decoded.length > 0 && ratio >= 0.8) {
      const len = Math.min(Math.max(decoded.length, 1), 255);
      return `VARCHAR(${len})`;
    }

    return 'BLOB';
  }
  if (typeof value === 'boolean') return 'BOOLEAN';

  return 'VARCHAR(255)';
}

function extractSingleTableName(sql) {
  if (!sql || typeof sql !== 'string') return null;

  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (!/^select\s+/i.test(normalized)) return null;
  if (/\bjoin\b|\bunion\b|\bwith\b/i.test(normalized)) return null;

  const match = normalized.match(/\bfrom\s+([A-Za-z0-9_"$]+)/i);
  return match ? match[1].replaceAll('"', '').trim().toUpperCase() : null;
}

function mapFirebirdFieldDescriptor(fieldRow) {
  const fieldType = Number(fieldRow.FIELD_TYPE);
  const subType = Number(fieldRow.FIELD_SUB_TYPE || 0);
  const precision = Number(fieldRow.FIELD_PRECISION || 0);
  const scaleRaw = Number(fieldRow.FIELD_SCALE || 0);
  const scale = Math.abs(scaleRaw);
  const charLength = Number(fieldRow.CHAR_LENGTH || fieldRow.FIELD_LENGTH || 0);

  switch (fieldType) {
    case 7:
      return subType > 0 && precision > 0 ? `NUMERIC(${precision},${scale})` : 'SMALLINT';
    case 8:
      return subType > 0 && precision > 0 ? `NUMERIC(${precision},${scale})` : 'INTEGER';
    case 10:
      return 'FLOAT';
    case 12:
      return 'DATE';
    case 13:
      return 'TIME';
    case 14:
      return `CHAR(${Math.max(charLength, 1)})`;
    case 16:
      if (subType === 1 || subType === 2) {
        const p = precision > 0 ? precision : 18;
        return subType === 2 ? `DECIMAL(${p},${scale})` : `NUMERIC(${p},${scale})`;
      }
      return 'BIGINT';
    case 23:
      return 'BOOLEAN';
    case 27:
      return 'DOUBLE';
    case 35:
      return 'TIMESTAMP';
    case 37:
      return `VARCHAR(${Math.max(charLength, 1)})`;
    case 261:
      return subType === 1 ? 'VARCHAR(255)' : 'BLOB';
    default:
      return 'VARCHAR(255)';
  }
}

async function getTableColumnsMetadata(dbPath, relationName, connectionOverrides = {}) {
  const safeRelation = String(relationName || '').replaceAll("'", "''").toUpperCase();
  if (!safeRelation) return [];

  const sql = `
    SELECT
      TRIM(rf.RDB$FIELD_NAME) AS FIELD_NAME,
      f.RDB$FIELD_TYPE AS FIELD_TYPE,
      f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
      f.RDB$FIELD_LENGTH AS FIELD_LENGTH,
      f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
      f.RDB$FIELD_SCALE AS FIELD_SCALE
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
    WHERE rf.RDB$RELATION_NAME = '${safeRelation}'
    ORDER BY rf.RDB$FIELD_POSITION
  `;

  const rows = await query(dbPath, sql, connectionOverrides);

  return rows.map(row => ({
    name: String(row.FIELD_NAME || '').trim(),
    type: mapFirebirdFieldDescriptor(row)
  }));
}

function query(dbPath, sql, connectionOverrides = {}) {
  assertSafeQueryInput(dbPath, sql);

  const timeoutMs = Number(connectionOverrides.timeoutMs) || (Number(process.env.FIREBIRD_TIMEOUT_MIN || 1) * 60000);

  const promise = new Promise((resolve, reject) => {
    const options = createOptions(dbPath, connectionOverrides);
    console.log(`[FIREBIRD_SERVICE] Connecting to: host=${options.host}, port=${options.port}, database=${options.database}, user=${options.user}`);
    firebird.attach(options, (attachError, db) => {
      if (attachError) return reject(attachError);

      db.query(sql, (queryError, result) => {
        db.detach();

        if (queryError) return reject(queryError);
        resolve(Array.isArray(result) ? result : []);
      });
    });
  });

  promise.catch(() => {});
  return withTimeout(promise, timeoutMs, 'Consulta Firebird excedio el timeout configurado');
}

async function queryWithMetadata(dbPath, sql, connectionOverrides = {}) {
  const sampleRows = await queryBatch(dbPath, sql, 1, 0, connectionOverrides);
  const relationName = extractSingleTableName(sql);

  let relationMetadata = [];
  if (relationName) {
    relationMetadata = await getTableColumnsMetadata(dbPath, relationName, connectionOverrides);
  }

  if (!sampleRows.length) {
    return {
      rows: [],
      columns: relationMetadata
    };
  }

  const firstRow = sampleRows[0];
  const metadataByName = new Map(relationMetadata.map(col => [col.name.toUpperCase(), col.type]));

  const columns = Object.keys(firstRow).map(name => ({
    name,
    type: metadataByName.get(name.toUpperCase()) || inferFieldType(firstRow[name])
  }));

  return {
    rows: sampleRows,
    columns
  };
}

async function testConnection(dbPath, sql = 'SELECT 1 FROM RDB$DATABASE', connectionOverrides = {}) {
  await query(dbPath, sql, connectionOverrides);
}

async function executeScript(dbPath, sql, connectionOverrides = {}) {
  await query(dbPath, sql, connectionOverrides);
}

function buildBatchSql(baseSql, limit, offset) {
  const normalizedSql = String(baseSql || '').trim().replace(/;\s*$/, '');
  if (/^select\s+/i.test(normalizedSql)) {
    return normalizedSql.replace(/^select\s+/i, `SELECT FIRST ${Number(limit)} SKIP ${Number(offset)} `);
  }

  return `SELECT FIRST ${Number(limit)} SKIP ${Number(offset)} * FROM (${normalizedSql}) SRC_BATCH`;
}

async function queryBatch(dbPath, baseSql, limit, offset, connectionOverrides = {}) {
  const batchedSql = buildBatchSql(baseSql, limit, offset);
  return query(dbPath, batchedSql, connectionOverrides);
}

async function countRows(dbPath, baseSql, connectionOverrides = {}) {
  const normalized = String(baseSql || '').replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
  const fromPart = normalized.match(/^SELECT \*\s+(FROM\s+[\s\S]+)$/i);
  const fromWithoutOrder = fromPart?.[1]?.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '') || null;

  const countSql = fromWithoutOrder
    ? `SELECT COUNT(*) ${fromWithoutOrder}`
    : `SELECT COUNT(*) AS CNT FROM (${baseSql}) Q1`;

  try {
    const rows = await query(dbPath, countSql, connectionOverrides);
    const row = rows[0] || {};
    return Number(Object.values(row)[0] ?? 0);
  } catch {
    return 0;
  }
}

function quoteFirebirdIdentifier(name) {
  const safe = String(name || '').replaceAll('"', '""').trim();
  return `"${safe}"`;
}

function quoteFirebirdTable(tableName) {
  const parts = String(tableName || '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return quoteFirebirdIdentifier('');
  }

  return parts.map(quoteFirebirdIdentifier).join('.');
}

function isFirebirdNumericOrTruncationError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('sql error code = -303')
    || message.includes('numeric overflow')
    || message.includes('string truncation')
    || message.includes('string right truncation')
    || message.includes('arithmetic exception');
}

function isFirebirdDuplicateKeyError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('attempt to store duplicate value')
    || message.includes('violation of primary or unique key constraint')
    || message.includes('335544349')
    || message.includes('unique index');
}

function withAttachedDb(dbPath, handler, connectionOverrides = {}) {
  assertSafeQueryInput(dbPath, 'SELECT 1 FROM RDB$DATABASE');

  const timeoutMs = Number(connectionOverrides.timeoutMs)
    || (Number(process.env.FIREBIRD_TIMEOUT_MIN || 1) * 60000);

  const promise = new Promise((resolve, reject) => {
    const options = createOptions(dbPath, connectionOverrides);

    firebird.attach(options, async (attachError, db) => {
      if (attachError) return reject(attachError);

      const queryDb = (sql, params = []) => new Promise((resolveQuery, rejectQuery) => {
        db.query(sql, params, (queryError, result) => {
          if (queryError) return rejectQuery(queryError);
          resolveQuery(Array.isArray(result) ? result : []);
        });
      });

      try {
        const result = await handler({ db, queryDb });
        db.detach();
        resolve(result);
      } catch (error) {
        db.detach();
        reject(error);
      }
    });
  });

  promise.catch(() => {});

  return withTimeout(promise, timeoutMs, 'Operacion Firebird excedio el timeout configurado');
}

async function upsertRows(dbPath, tableName, uniqueKey, rows, connectionOverrides = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  const safeTable = String(tableName || '').trim();
  const safeUniqueKey = String(uniqueKey || '').trim();

  if (!safeTable) {
    throw new Error('tableName es requerido para upsertRows');
  }

  if (!safeUniqueKey) {
    throw new Error('uniqueKey es requerido para upsertRows');
  }

  const qTable = quoteFirebirdTable(safeTable);
  const qUnique = quoteFirebirdIdentifier(safeUniqueKey);

  return withAttachedDb(dbPath, async ({ queryDb }) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const immutableColumns = new Set();
    try {
      const constraintRows = await queryDb(
        `SELECT sg.RDB$FIELD_NAME AS FIELD_NAME
           FROM RDB$RELATION_CONSTRAINTS rc
           JOIN RDB$INDEX_SEGMENTS sg ON sg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
          WHERE rc.RDB$RELATION_NAME = ?
            AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')`,
        [safeTable.toUpperCase()]
      );

      const uniqueIndexRows = await queryDb(
        `SELECT sg.RDB$FIELD_NAME AS FIELD_NAME
           FROM RDB$INDICES i
           JOIN RDB$INDEX_SEGMENTS sg ON sg.RDB$INDEX_NAME = i.RDB$INDEX_NAME
          WHERE i.RDB$RELATION_NAME = ?
            AND COALESCE(i.RDB$UNIQUE_FLAG, 0) = 1`,
        [safeTable.toUpperCase()]
      );

      const immutableRows = [...constraintRows, ...uniqueIndexRows];
      for (const row of immutableRows) {
        const col = String(
          row?.FIELD_NAME ??
          row?.field_name ??
          row?.['RDB$FIELD_NAME'] ??
          ''
        ).trim().toUpperCase();
        if (col && col !== safeUniqueKey.toUpperCase()) {
          immutableColumns.add(col);
        }
      }
    } catch (_) {
      // Si falla metadata, mantenemos el comportamiento previo.
    }

    for (const row of list) {
      const record = row && typeof row === 'object' ? row : null;
      if (!record) {
        skipped += 1;
        continue;
      }

      const uniqueValue = record[safeUniqueKey]
        ?? record[safeUniqueKey.toUpperCase()]
        ?? record[safeUniqueKey.toLowerCase()];

      const normalizedUniqueValue = typeof uniqueValue === 'string'
        ? uniqueValue.trim()
        : uniqueValue;

      if (normalizedUniqueValue === null || normalizedUniqueValue === undefined || normalizedUniqueValue === '') {
        skipped += 1;
        continue;
      }

      const allKeys = Object.keys(record);
      const updateKeys = allKeys.filter(key => {
        const normalized = String(key || '').toUpperCase();
        if (normalized === safeUniqueKey.toUpperCase()) return false;
        if (immutableColumns.has(normalized)) return false;
        return true;
      });
      const quotedUpdateKeys = updateKeys.map(quoteFirebirdIdentifier);

      let existing;
      try {
        existing = await queryDb(
          `SELECT FIRST 1 ${qUnique} FROM ${qTable} WHERE ${qUnique} = ?`,
          [normalizedUniqueValue]
        );
      } catch (error) {
        throw new Error(
          `Firebird SELECT previo fallo en ${safeTable} por ${safeUniqueKey}=${JSON.stringify(normalizedUniqueValue)}: ${error.message}`
        );
      }

      if (existing.length) {
        if (!updateKeys.length) {
          skipped += 1;
          continue;
        }

        const setClause = quotedUpdateKeys.map(column => `${column} = ?`).join(', ');
        const params = updateKeys.map(key => record[key]);
        params.push(normalizedUniqueValue);

        try {
          await queryDb(
            `UPDATE ${qTable} SET ${setClause} WHERE ${qUnique} = ?`,
            params
          );
        } catch (error) {
          if (isFirebirdNumericOrTruncationError(error)) {
            const getSchemaValue = (row, exactKey) => {
              if (!row || typeof row !== 'object') return undefined;
              if (Object.prototype.hasOwnProperty.call(row, exactKey)) {
                return row[exactKey];
              }
              const target = String(exactKey).toUpperCase();
              for (const key of Object.keys(row)) {
                if (String(key).toUpperCase() === target) {
                  return row[key];
                }
              }
              return undefined;
            };
            try {
              const schemaRows = await queryDb(
                `SELECT rf.RDB$FIELD_NAME AS FIELD_NAME,` +
                ` f.RDB$CHARACTER_LENGTH AS CHARACTER_LENGTH,` +
                ` f.RDB$FIELD_LENGTH AS FIELD_LENGTH,` +
                ` f.RDB$FIELD_TYPE AS FIELD_TYPE` +
                ` FROM RDB$RELATION_FIELDS rf` +
                ` JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME` +
                ` WHERE rf.RDB$RELATION_NAME = ?`,
                [safeTable.toUpperCase()]
              );
              for (const schemaRow of schemaRows) {
                if (!Object.prototype.hasOwnProperty.call(schemaRow, 'FIELD_NAME')) continue;
                const fieldName = String(getSchemaValue(schemaRow, 'FIELD_NAME') || '').trim();
                if (fieldName) {
                  immutableColumns.add(fieldName.toUpperCase());
                }
              }
            } catch (_) {
              // Ignorar falla en metadata.
            }
          }
          throw error;
        }
        updated += 1;
      } else {
        const columns = allKeys.map(quoteFirebirdIdentifier).join(', ');
        const placeholders = allKeys.map(() => '?').join(', ');
        const values = allKeys.map(key => record[key]);

        await queryDb(
          `INSERT INTO ${qTable} (${columns}) VALUES (${placeholders})`,
          values
        );
        inserted += 1;
      }
    }

    return { inserted, updated, skipped };
  });
}

module.exports = {
  query,
  queryWithMetadata,
  testConnection,
  executeScript,
  queryBatch,
  countRows,
  upsertRows,
  withAttachedDb,
  isFirebirdDuplicateKeyError,
  isFirebirdNumericOrTruncationError
};
