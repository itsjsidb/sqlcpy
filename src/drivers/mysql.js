'use strict';
const mysql = require('mysql2/promise');
const SqlString = require('sqlstring');

/**
 * Database driver: everything engine-specific lives here, so the copy / compare logic stays generic.
 * A driver exports:
 *   name, defaultPort
 *   kinds                              object kinds this engine supports (subset of tables|views|procedures|functions|triggers)
 *   createPool(cfg, concurrency)       -> { query(sql, params) -> [rows, fields], getConnection(), end() }
 *   quote(identifier), escape(value)   identifier quoting / literal escaping
 *   listObjects(pool, db)              -> { tables: [], views: [], ... }
 *   getCreateSql(pool, kind, name)     raw CREATE statement
 *   normalizeSql(sql, db)              make definitions from two databases comparable
 *   primaryKey(pool, db, table)        -> [column, ...]
 *   count(pool, table), checksum(pool, table)
 *   sessionSetup(conn), sessionTeardown(conn)   relax / restore constraint checks on a slave connection
 *   dumpPreamble                       statements written at the top of a table dump
 *   dropSql(kind, name)
 */

const KINDS = ['tables', 'views', 'procedures', 'functions', 'triggers'];
const quote = (id) => SqlString.escapeId(id);

function createPool(c, concurrency = 1) {
  return mysql.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    connectionLimit: Math.max(3, concurrency + 1), // one per chunk worker, plus a spare for lookups
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    typeCast(field, next) {
      if (field.type === 'JSON') return field.string();
      return next();
    },
  });
}

async function listObjects(pool, db) {
  const out = { tables: [], views: [], procedures: [], functions: [], triggers: [] };

  const [t] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS approxRows, DATA_LENGTH AS dataLength,
            INDEX_LENGTH AS indexLength, AVG_ROW_LENGTH AS avgRowLength
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
  for (const r of t) {
    const o = {
      name: r.name,
      approxRows: Number(r.approxRows || 0),
      bytes: Number(r.dataLength || 0) + Number(r.indexLength || 0),
      dataBytes: Number(r.dataLength || 0),
      avgRowLength: Number(r.avgRowLength || 0),
    };
    (r.type === 'VIEW' ? out.views : out.tables).push(o);
  }

  const [r] = await pool.query(
    `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [db]);
  for (const x of r) (x.type === 'PROCEDURE' ? out.procedures : out.functions).push({ name: x.name });

  const [g] = await pool.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [db]);
  for (const x of g) out.triggers.push({ name: x.name, table: x.tbl });

  return out;
}

async function getCreateSql(pool, kind, name) {
  const spec = {
    tables: ['TABLE', 'Create Table'],
    views: ['TABLE', 'Create View'],
    procedures: ['PROCEDURE', 'Create Procedure'],
    functions: ['FUNCTION', 'Create Function'],
    triggers: ['TRIGGER', 'SQL Original Statement'],
  }[kind];
  const [rows] = await pool.query(`SHOW CREATE ${spec[0]} ${quote(name)}`);
  const sql = rows[0] && rows[0][spec[1]];
  if (!sql) throw new Error(`No definition returned for ${kind} ${name} (insufficient privileges?)`);
  return sql;
}

const DEFINER_RE = /\s*DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^@\s]+)@(`[^`]*`|'[^']*'|[^\s]+)/i;

/** Strip DEFINER, db qualifiers and AUTO_INCREMENT so definitions from two DBs are comparable / portable. */
function normalizeSql(sql, db) {
  let s = sql.replace(DEFINER_RE, '');
  s = s.split('`' + db + '`.').join('');
  s = s.replace(/\sAUTO_INCREMENT=\d+/i, '');
  return s.replace(/\r\n/g, '\n').trim();
}

async function primaryKey(pool, db, table) {
  const [r] = await pool.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
    [db, table]);
  return r.map((x) => x.c);
}

async function count(pool, table) {
  const [r] = await pool.query(`SELECT COUNT(*) AS c FROM ${quote(table)}`);
  return Number(r[0].c);
}

async function checksum(pool, table) {
  const [r] = await pool.query(`CHECKSUM TABLE ${quote(table)}`);
  return String(r[0].Checksum);
}

const DROP = { tables: 'TABLE', views: 'VIEW', procedures: 'PROCEDURE', functions: 'FUNCTION', triggers: 'TRIGGER' };

module.exports = {
  name: 'mysql',
  defaultPort: 3306,
  kinds: KINDS,
  createPool,
  quote,
  escape: (v) => SqlString.escape(v),
  listObjects,
  getCreateSql,
  normalizeSql,
  primaryKey,
  count,
  checksum,
  async sessionSetup(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0, SQL_MODE=CONCAT(@@sql_mode, \',NO_AUTO_VALUE_ON_ZERO\')');
  },
  async sessionTeardown(conn) {
    await conn.query('SET FOREIGN_KEY_CHECKS=1, UNIQUE_CHECKS=1');
  },
  dumpPreamble: 'SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n',
  dropSql: (kind, name) => `DROP ${DROP[kind]} IF EXISTS ${quote(name)}`,
};
