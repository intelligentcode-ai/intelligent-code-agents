/**
 * sqlite3 CLI adapter
 * Fallback database adapter when better-sqlite3 is unavailable.
 */

const { execFileSync } = require('child_process');

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function toSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${escapeSqlString(value)}'`;
}

function interpolateSql(sql, args = []) {
  if (!args || args.length === 0) return sql;

  // Named parameters (single object)
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
    const named = args[0];
    return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key) => toSqlLiteral(named[key]));
  }

  // Positional parameters
  let idx = 0;
  return sql.replace(/\?/g, () => toSqlLiteral(args[idx++]));
}

function runSqlite(dbPath, sql, { json = false } = {}) {
  const cmdArgs = [];
  if (json) cmdArgs.push('-json');
  cmdArgs.push(dbPath, sql);

  const output = execFileSync('sqlite3', cmdArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (!json) return output;
  if (!output) return [];

  try {
    return JSON.parse(output);
  } catch (_) {
    return [];
  }
}

function createSqliteCliAdapter(dbPath) {
  return {
    __driver: 'sqlite3-cli',
    __dbPath: dbPath,

    pragma(value) {
      runSqlite(dbPath, `PRAGMA ${value};`);
    },

    exec(sql) {
      runSqlite(dbPath, sql);
    },

    prepare(sql) {
      return {
        run(...args) {
          const rendered = interpolateSql(sql, args);
          const rows = runSqlite(
            dbPath,
            `BEGIN IMMEDIATE; ${rendered}; SELECT changes() AS changes; COMMIT;`,
            { json: true }
          );
          const row = Array.isArray(rows) && rows.length > 0 ? rows[rows.length - 1] : { changes: 0 };
          return { changes: Number(row.changes || 0) };
        },

        get(...args) {
          const rendered = interpolateSql(sql, args);
          const rows = runSqlite(dbPath, rendered, { json: true });
          return Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
        },

        all(...args) {
          const rendered = interpolateSql(sql, args);
          const rows = runSqlite(dbPath, rendered, { json: true });
          return Array.isArray(rows) ? rows : [];
        },
      };
    },

    transaction(fn) {
      // sqlite3 CLI opens a new process per statement; transaction semantics are
      // handled by callers that need atomic scripts.
      return fn;
    },

    close() {
      // No persistent process/connection to close for CLI mode.
    },
  };
}

function isSqliteCliAvailable() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  createSqliteCliAdapter,
  isSqliteCliAvailable,
};
