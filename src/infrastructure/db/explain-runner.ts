import { DbClient } from './db-connector';

export interface ExplainPlan {
  /** Raw plan as returned by the DB */
  raw: unknown;
  /** Formatted text plan for human reading */
  textPlan: string;
  /** Database type */
  dbType: 'postgresql' | 'mysql';
}

/**
 * Runs EXPLAIN ANALYZE on a query and returns the raw plan.
 *
 * Safety: we only run EXPLAIN, never the query itself.
 * For PostgreSQL: EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
 * For MySQL:      EXPLAIN FORMAT=JSON
 *
 * Note: EXPLAIN ANALYZE actually executes the query in PostgreSQL.
 * For SELECT queries this is safe (read-only). For INSERT/UPDATE/DELETE
 * we fall back to EXPLAIN without ANALYZE.
 */
export async function runExplain(
  client: DbClient,
  sql: string,
): Promise<ExplainPlan> {
  const isSelect = /^\s*select\b/i.test(sql.trim());

  if (client.type === 'postgresql') {
    return runPostgresExplain(client, sql, isSelect);
  } else {
    return runMysqlExplain(client, sql);
  }
}

async function runPostgresExplain(
  client: DbClient,
  sql: string,
  analyze: boolean,
): Promise<ExplainPlan> {
  const options = analyze
    ? 'ANALYZE, BUFFERS, FORMAT JSON'
    : 'FORMAT JSON';

  const explainSql = `EXPLAIN (${options}) ${sql}`;
  const rows = await client.query(explainSql);

  const raw = (rows[0] as Record<string, unknown>)['QUERY PLAN'];
  const textRows = await client.query(`EXPLAIN ${sql}`);
  const textPlan = (textRows as Array<Record<string, string>>)
    .map((r) => r['QUERY PLAN'])
    .join('\n');

  return { raw, textPlan, dbType: 'postgresql' };
}

async function runMysqlExplain(
  client: DbClient,
  sql: string,
): Promise<ExplainPlan> {
  const rows = await client.query(`EXPLAIN FORMAT=JSON ${sql}`);
  const raw = (rows[0] as Record<string, unknown>)['QUERY PLAN'];

  // MySQL text plan
  const textRows = await client.query(`EXPLAIN ${sql}`);
  const textPlan = JSON.stringify(textRows, null, 2);

  return { raw, textPlan, dbType: 'mysql' };
}
