import { loadDbConfig, DB_CREDENTIALS_HELP } from '../../../infrastructure/db/db-config';
import { getDbClient, DbClient } from '../../../infrastructure/db/db-connector';

/**
 * Reads the database's own statement statistics — MySQL's
 * performance_schema.events_statements_summary_by_digest, or PostgreSQL's
 * pg_stat_statements — and returns the most expensive queries with REAL
 * timing and row counts. Needs no application logging at all, which makes it
 * the fastest way to find slow/heavy queries on a project where Hibernate
 * SQL logging is off.
 */

// ── Result types ────────────────────────────────────────────────────────────

export interface TopQuery {
  /** Normalized statement (digest text / pg_stat_statements query). */
  sql: string;
  calls: number;
  totalTimeMs: number;
  avgTimeMs: number;
  maxTimeMs?: number;
  rowsExamined?: number;
  rowsSent: number;
  /** Executions that used no index at all (MySQL only). */
  noIndexUsedCount?: number;
  /** rowsExamined / max(rowsSent, 1) — high values mean scanning >> returning. */
  examineRatio?: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Human-readable red flags derived from the numbers. */
  flags: string[];
}

export type TopQueriesOrder = 'total_time' | 'avg_time' | 'calls' | 'rows_examined';

export interface DbTopQueriesOutput {
  dbType: string;
  dbHost: string;
  dbName: string;
  orderBy: TopQueriesOrder;
  queries: TopQuery[];
  /** Set when stats were reset instead of queried. */
  statsReset?: boolean;
  markdownReport: string;
}

// ── Flag derivation (pure — unit tested) ────────────────────────────────────

const EXAMINE_RATIO_FLAG = 100;
const EXAMINE_ROWS_FLOOR = 1_000;
const SLOW_AVG_MS = 500;

export function deriveFlags(q: Omit<TopQuery, 'flags'>): string[] {
  const flags: string[] = [];
  if (q.noIndexUsedCount && q.noIndexUsedCount > 0) {
    flags.push(`full scan in ${q.noIndexUsedCount} of ${q.calls} executions (no index used)`);
  }
  if (
    q.examineRatio !== undefined &&
    q.examineRatio >= EXAMINE_RATIO_FLAG &&
    (q.rowsExamined ?? 0) >= EXAMINE_ROWS_FLOOR
  ) {
    flags.push(`examines ${Math.round(q.examineRatio)} rows per row returned`);
  }
  if (q.avgTimeMs >= SLOW_AVG_MS) {
    flags.push(`slow: avg ${Math.round(q.avgTimeMs)} ms`);
  }
  return flags;
}

// ── MySQL: performance_schema ───────────────────────────────────────────────

/** Statements that are noise in a top-queries report. */
const MYSQL_NOISE = /^\s*(?:SET|SHOW|COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|USE|EXPLAIN|SELECT\s+@@|SELECT\s+DATABASE\s*\()/i;

interface MysqlDigestRow {
  DIGEST_TEXT: string | null;
  COUNT_STAR: number | string;
  SUM_TIMER_WAIT: number | string;
  AVG_TIMER_WAIT: number | string;
  MAX_TIMER_WAIT: number | string;
  SUM_ROWS_EXAMINED: number | string;
  SUM_ROWS_SENT: number | string;
  SUM_NO_INDEX_USED: number | string;
  FIRST_SEEN: unknown;
  LAST_SEEN: unknown;
}

const PICOS_PER_MS = 1e9;

/** Maps a performance_schema digest row to a TopQuery. Pure — unit tested. */
export function mapMysqlDigestRow(row: MysqlDigestRow): TopQuery | null {
  const sql = row.DIGEST_TEXT?.trim();
  if (!sql || MYSQL_NOISE.test(sql)) return null;

  const calls = Number(row.COUNT_STAR);
  const rowsExamined = Number(row.SUM_ROWS_EXAMINED);
  const rowsSent = Number(row.SUM_ROWS_SENT);
  const base = {
    sql,
    calls,
    totalTimeMs: Number(row.SUM_TIMER_WAIT) / PICOS_PER_MS,
    avgTimeMs: Number(row.AVG_TIMER_WAIT) / PICOS_PER_MS,
    maxTimeMs: Number(row.MAX_TIMER_WAIT) / PICOS_PER_MS,
    rowsExamined,
    rowsSent,
    noIndexUsedCount: Number(row.SUM_NO_INDEX_USED),
    examineRatio: rowsExamined / Math.max(rowsSent, 1),
    firstSeen: row.FIRST_SEEN ? String(row.FIRST_SEEN) : undefined,
    lastSeen: row.LAST_SEEN ? String(row.LAST_SEEN) : undefined,
  };
  return { ...base, flags: deriveFlags(base) };
}

const MYSQL_ORDER_COLUMN: Record<TopQueriesOrder, string> = {
  total_time: 'SUM_TIMER_WAIT',
  avg_time: 'AVG_TIMER_WAIT',
  calls: 'COUNT_STAR',
  rows_examined: 'SUM_ROWS_EXAMINED',
};

async function queryMysqlTop(
  client: DbClient,
  orderBy: TopQueriesOrder,
  limit: number,
  minCalls: number,
): Promise<TopQuery[]> {
  const rows = (await client.query(
    `SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, AVG_TIMER_WAIT, MAX_TIMER_WAIT,
            SUM_ROWS_EXAMINED, SUM_ROWS_SENT, SUM_NO_INDEX_USED, FIRST_SEEN, LAST_SEEN
       FROM performance_schema.events_statements_summary_by_digest
      WHERE SCHEMA_NAME = DATABASE()
        AND DIGEST_TEXT IS NOT NULL
        AND COUNT_STAR >= ?
      ORDER BY ${MYSQL_ORDER_COLUMN[orderBy]} DESC
      LIMIT ${Math.trunc(limit) * 2}`,
    [minCalls],
  )) as MysqlDigestRow[];

  return rows
    .map(mapMysqlDigestRow)
    .filter((q): q is TopQuery => q !== null)
    .slice(0, limit);
}

// ── PostgreSQL: pg_stat_statements ──────────────────────────────────────────

interface PgStatRow {
  query: string | null;
  calls: number | string;
  total_exec_time: number | string;
  mean_exec_time: number | string;
  max_exec_time: number | string;
  rows: number | string;
}

/** Maps a pg_stat_statements row to a TopQuery. Pure — unit tested. */
export function mapPgStatRow(row: PgStatRow): TopQuery | null {
  const sql = row.query?.trim();
  if (!sql || /^(?:SET|SHOW|COMMIT|ROLLBACK|BEGIN|DEALLOCATE)\b/i.test(sql)) return null;

  const base = {
    sql,
    calls: Number(row.calls),
    totalTimeMs: Number(row.total_exec_time),
    avgTimeMs: Number(row.mean_exec_time),
    maxTimeMs: Number(row.max_exec_time),
    rowsSent: Number(row.rows),
  };
  return { ...base, flags: deriveFlags(base) };
}

const PG_ORDER_COLUMN: Record<TopQueriesOrder, string> = {
  total_time: 'total_exec_time',
  avg_time: 'mean_exec_time',
  calls: 'calls',
  rows_examined: 'rows',
};

async function queryPgTop(
  client: DbClient,
  orderBy: TopQueriesOrder,
  limit: number,
  minCalls: number,
): Promise<TopQuery[]> {
  let rows: PgStatRow[];
  try {
    rows = (await client.query(
      `SELECT query, calls, total_exec_time, mean_exec_time, max_exec_time, rows
         FROM pg_stat_statements
        WHERE calls >= $1
        ORDER BY ${PG_ORDER_COLUMN[orderBy]} DESC
        LIMIT ${Math.trunc(limit) * 2}`,
      [minCalls],
    )) as PgStatRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/pg_stat_statements/.test(msg)) {
      throw new Error(
        'pg_stat_statements is not available on this PostgreSQL server.\n\n' +
          'Enable it with:\n' +
          "  1. shared_preload_libraries = 'pg_stat_statements' in postgresql.conf (requires restart)\n" +
          '  2. CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\n\n' +
          `Original error: ${msg}`,
      );
    }
    throw err;
  }

  return rows
    .map(mapPgStatRow)
    .filter((q): q is TopQuery => q !== null)
    .slice(0, limit);
}

// ── Markdown report (pure — unit tested) ────────────────────────────────────

export function buildTopQueriesMarkdown(out: Omit<DbTopQueriesOutput, 'markdownReport'>): string {
  const lines: string[] = [];
  lines.push('# 🥷 N1nja — Top Queries (from the database itself)');
  lines.push('');
  lines.push(`> **DB:** \`${out.dbType}\` @ \`${out.dbHost}/${out.dbName}\``);
  lines.push(`> **Ordered by:** ${out.orderBy} — real server-side statistics, no app logging required.`);
  lines.push('');

  if (out.statsReset) {
    lines.push('✅ Statement statistics were reset. Exercise the flows you want to measure, then run this tool again without `reset`.');
    return lines.join('\n');
  }

  if (out.queries.length === 0) {
    lines.push('No statements recorded yet for this schema. Exercise the application first (the statistics accumulate on the server).');
    return lines.join('\n');
  }

  lines.push('| # | Calls | Total (ms) | Avg (ms) | Rows sent | Rows examined | Flags |');
  lines.push('|---|-------|------------|----------|-----------|---------------|-------|');
  out.queries.forEach((q, i) => {
    lines.push(
      `| ${i + 1} | ${q.calls} | ${Math.round(q.totalTimeMs)} | ${Math.round(q.avgTimeMs)} | ${q.rowsSent} | ${q.rowsExamined ?? '—'} | ${q.flags.length ? '⚠ ' + q.flags.join('; ') : ''} |`,
    );
  });
  lines.push('');

  out.queries.forEach((q, i) => {
    lines.push(`## #${i + 1} — ${q.calls} calls, avg ${Math.round(q.avgTimeMs)} ms`);
    lines.push('');
    lines.push('```sql');
    lines.push(q.sql);
    lines.push('```');
    if (q.flags.length > 0) {
      for (const f of q.flags) lines.push(`- ⚠ ${f}`);
    }
    if (q.lastSeen) lines.push(`- Last seen: ${q.lastSeen}`);
    lines.push('');
  });

  lines.push('> 💡 Feed any of these to `explain_sql` for a plan analysis, or reset the counters');
  lines.push('> (`reset: true`) before exercising a specific flow to measure only that flow.');

  return lines.join('\n');
}

// ── Main tool ───────────────────────────────────────────────────────────────

export interface DbTopQueriesInput {
  envFile?: string;
  projectRoot?: string;
  /** How many queries to return. Default 20. */
  limit?: number;
  /** Ranking metric. Default total_time. */
  orderBy?: TopQueriesOrder;
  /** Ignore digests with fewer executions than this. Default 1. */
  minCalls?: number;
  /** Reset the server-side statistics instead of reading them. */
  reset?: boolean;
}

export async function dbTopQueries(input: DbTopQueriesInput = {}): Promise<DbTopQueriesOutput> {
  const config = loadDbConfig({ envFile: input.envFile, projectRoot: input.projectRoot });
  const orderBy = input.orderBy ?? 'total_time';
  const limit = input.limit ?? 20;
  const minCalls = input.minCalls ?? 1;

  let client: DbClient;
  try {
    process.stderr.write(
      `🥷 [db_top_queries] Connecting to ${config.type} @ ${config.host}:${config.port}/${config.database}...\n`,
    );
    client = await getDbClient(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not connect to ${config.type} at ${config.host}:${config.port}/${config.database}.\n\n` +
        `Reason: ${msg}\n\nCredentials source: ${config.source}\n\n` +
        DB_CREDENTIALS_HELP,
    );
  }

  const base = {
    dbType: config.type,
    dbHost: config.host,
    dbName: config.database,
    orderBy,
  };

  if (input.reset) {
    if (client.type === 'mysql') {
      await client.query('TRUNCATE TABLE performance_schema.events_statements_summary_by_digest');
    } else {
      await client.query('SELECT pg_stat_statements_reset()');
    }
    const out = { ...base, queries: [], statsReset: true };
    return { ...out, markdownReport: buildTopQueriesMarkdown(out) };
  }

  const queries =
    client.type === 'mysql'
      ? await queryMysqlTop(client, orderBy, limit, minCalls)
      : await queryPgTop(client, orderBy, limit, minCalls);

  process.stderr.write(`✅ ${queries.length} statement(s) retrieved\n`);

  const out = { ...base, queries };
  return { ...out, markdownReport: buildTopQueriesMarkdown(out) };
}
