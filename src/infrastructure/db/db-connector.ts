import { DbConfig } from './db-config';

/**
 * Generic DB client interface — abstracts pg and mysql2 behind a common API.
 */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
  /** DB type for feature detection (e.g. EXPLAIN syntax differences). */
  readonly type: 'postgresql' | 'mysql';
}

// ---------------------------------------------------------------------------
// PostgreSQL adapter
// ---------------------------------------------------------------------------
async function createPostgresClient(config: DbConfig): Promise<DbClient> {
  // Dynamic import so mysql2 users don't need pg installed
  const { Pool } = await import('pg');

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === false ? false : { rejectUnauthorized: false },
    min: config.poolMin,
    max: config.poolMax,
    connectionTimeoutMillis: config.queryTimeout,
    statement_timeout: config.queryTimeout,
  });

  // Verify connectivity immediately
  const client = await pool.connect();
  if (config.schema && config.schema !== 'public') {
    await client.query(`SET search_path TO "${config.schema}"`);
  }
  client.release();

  return {
    type: 'postgresql',
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL adapter
// ---------------------------------------------------------------------------
async function createMysqlClient(config: DbConfig): Promise<DbClient> {
  const mysql = await import('mysql2/promise');

  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === false ? undefined : { rejectUnauthorized: false },
    connectionLimit: config.poolMax,
    connectTimeout: config.queryTimeout,
  });

  // Verify connectivity immediately
  const conn = await pool.getConnection();
  conn.release();

  return {
    type: 'mysql',
    async query(sql: string, params?: unknown[]): Promise<unknown[]> {
      const [rows] = await pool.query(sql, params);
      return rows as unknown[];
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a connected DB client based on config.
 * Throws with a clear message if the connection fails.
 */
export async function createDbClient(config: DbConfig): Promise<DbClient> {
  try {
    if (config.type === 'postgresql') {
      return await createPostgresClient(config);
    } else {
      return await createMysqlClient(config);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to ${config.type} at ${config.host}:${config.port}/${config.database}.\n` +
      `Reason: ${msg}\n` +
      `Check your .env credentials.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton pool — reused across tool calls in the same MCP session.
// Keyed by connection identity so switching credentials (e.g. a different
// envFile or projectRoot) reconnects instead of reusing a stale pool.
// ---------------------------------------------------------------------------
let _client: DbClient | null = null;
let _clientKey: string | null = null;

function connectionKey(config: DbConfig): string {
  return `${config.type}|${config.host}|${config.port}|${config.database}|${config.user}|${config.schema}`;
}

export async function getDbClient(config: DbConfig): Promise<DbClient> {
  const key = connectionKey(config);
  if (_client && _clientKey === key) {
    return _client;
  }
  if (_client) {
    await _client.close().catch(() => { /* stale pool — ignore close errors */ });
    _client = null;
    _clientKey = null;
  }
  _client = await createDbClient(config);
  _clientKey = key;
  return _client;
}

export async function closeDbClient(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _clientKey = null;
  }
}
