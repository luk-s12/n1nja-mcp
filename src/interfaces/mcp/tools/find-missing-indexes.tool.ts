import { loadDbConfig, DB_CREDENTIALS_HELP } from '../../../infrastructure/db/db-config';
import { getDbClient, DbClient } from '../../../infrastructure/db/db-connector';
import { getLastReport } from './analyze-log.tool';

// ─────────────────────────────────────────────────────────────────────────────

export interface MissingIndexResult {
  table: string;
  column: string;
  usageCount: number;
  exampleQuery: string;
  existingIndexes: string[];
}

export interface FindMissingIndexesOutput {
  connected: boolean;
  dbType: string;
  dbHost: string;
  dbName: string;
  queriesAnalyzed: number;
  missingIndexes: MissingIndexResult[];
  markdownReport: string;
}

// ── SQL column extraction ──────────────────────────────────────────────────────

/**
 * Extracts (table, column) pairs from WHERE / JOIN ON / ORDER BY clauses
 * in a normalized SQL string.
 */
function extractWhereColumns(sql: string): Array<{ table: string; column: string }> {
  const result: Array<{ table: string; column: string }> = [];

  // Extract table name from FROM clause (first table only, handles aliases)
  const fromMatch = sql.match(/\bfrom\s+([\w"]+)(?:\s+(?:as\s+)?[\w"]+)?/i);
  const mainTable = fromMatch?.[1]?.replace(/"/g, '') ?? '';
  if (!mainTable) return result;

  // Normalize: remove ? placeholders noise, lowercase
  const normalized = sql.toLowerCase();

  // Match patterns like: WHERE col = ?, AND col = ?, OR col = ?
  // Also: ORDER BY col, col2
  // Also: JOIN ... ON t.col = t2.col
  const whereColPattern = /(?:where|and|or)\s+(?:[\w]+\.)?(\w+)\s*(?:=|>|<|>=|<=|<>|!=|like|in|between|is)/gi;
  const orderColPattern = /order\s+by\s+([\w,\s.]+?)(?:asc|desc|limit|$)/gi;
  const joinOnPattern = /join\s+[\w"]+(?:\s+\w+)?\s+on\s+(?:[\w]+\.)?(\w+)\s*=\s*(?:[\w]+\.)?(\w+)/gi;

  let m: RegExpExecArray | null;

  while ((m = whereColPattern.exec(normalized)) !== null) {
    const col = m[1];
    if (col && col !== 'null' && col.length > 1) {
      result.push({ table: mainTable, column: col });
    }
  }

  while ((m = orderColPattern.exec(normalized)) !== null) {
    const cols = m[1].split(',').map((c) => c.trim().split('.').pop() ?? '');
    for (const col of cols) {
      if (col && col.length > 1) {
        result.push({ table: mainTable, column: col });
      }
    }
  }

  // For JOINs, capture both sides as potential filter columns
  while ((m = joinOnPattern.exec(normalized)) !== null) {
    if (m[1] && m[1].length > 1) result.push({ table: mainTable, column: m[1] });
    if (m[2] && m[2].length > 1) result.push({ table: mainTable, column: m[2] });
  }

  return result;
}

// ── Index queries per DB type ──────────────────────────────────────────────────

async function getExistingIndexes(
  client: DbClient,
  schema: string,
): Promise<Map<string, Set<string>>> {
  // Returns Map<"tablename.columnname", Set<index_name>>
  const indexMap = new Map<string, Set<string>>();

  if (client.type === 'postgresql') {
    const rows = await client.query(`
      SELECT
        t.relname   AS table_name,
        a.attname   AS column_name,
        i.relname   AS index_name
      FROM pg_index ix
      JOIN pg_class t  ON t.oid = ix.indrelid
      JOIN pg_class i  ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1
        AND t.relkind = 'r'
      ORDER BY t.relname, a.attname
    `, [schema]) as Array<{ table_name: string; column_name: string; index_name: string }>;

    for (const row of rows) {
      const key = `${row.table_name}.${row.column_name}`;
      if (!indexMap.has(key)) indexMap.set(key, new Set());
      indexMap.get(key)!.add(row.index_name);
    }
  } else {
    // MySQL
    const rows = await client.query(`
      SELECT
        TABLE_NAME   AS table_name,
        COLUMN_NAME  AS column_name,
        INDEX_NAME   AS index_name
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, COLUMN_NAME
    `) as Array<{ table_name: string; column_name: string; index_name: string }>;

    for (const row of rows) {
      const key = `${row.table_name}.${row.column_name}`;
      if (!indexMap.has(key)) indexMap.set(key, new Set());
      indexMap.get(key)!.add(row.index_name);
    }
  }

  return indexMap;
}

// ── Markdown report ────────────────────────────────────────────────────────────

function buildMarkdown(
  output: Omit<FindMissingIndexesOutput, 'markdownReport'>,
): string {
  const lines: string[] = [];

  lines.push(`# 🔍 Missing Index Report`);
  lines.push('');
  lines.push(`> **DB:** \`${output.dbType}\` @ \`${output.dbHost}/${output.dbName}\``);
  lines.push(`> **Queries analyzed:** ${output.queriesAnalyzed}`);
  lines.push(`> **Missing indexes found:** **${output.missingIndexes.length}**`);
  lines.push('');

  if (output.missingIndexes.length === 0) {
    lines.push('> ✅ All frequently-filtered columns appear to have indexes. No obvious missing indexes detected.');
    return lines.join('\n');
  }

  lines.push('## Recommended Indexes');
  lines.push('');
  lines.push('| Table | Column | Query Usage | Suggested SQL |');
  lines.push('|-------|--------|-------------|---------------|');

  for (const m of output.missingIndexes) {
    const sql = `CREATE INDEX idx_${m.table}_${m.column} ON ${m.table}(${m.column});`;
    lines.push(`| \`${m.table}\` | \`${m.column}\` | ${m.usageCount}× | \`${sql}\` |`);
  }

  lines.push('');
  lines.push('## Ready-to-run SQL');
  lines.push('');
  lines.push('```sql');
  for (const m of output.missingIndexes) {
    lines.push(`-- Used in ${m.usageCount} query execution(s)`);
    lines.push(`CREATE INDEX CONCURRENTLY idx_${m.table}_${m.column} ON ${m.table}(${m.column});`);
    lines.push('');
  }
  lines.push('```');

  lines.push('');
  lines.push('> ⚠️  `CREATE INDEX CONCURRENTLY` avoids table locks in production (PostgreSQL).');
  lines.push('> For MySQL, use `ALTER TABLE ... ADD INDEX` — indexes are online by default in InnoDB.');

  return lines.join('\n');
}

// ── Main tool ──────────────────────────────────────────────────────────────────

export interface FindMissingIndexesInput {
  /** Explicit .env file path with DB_* credentials (overrides ambient env vars). */
  envFile?: string;
  /**
   * Spring Boot project root — when credentials are not in the environment,
   * they are read from its application.properties/yml (spring.datasource.*).
   */
  projectRoot?: string;
}

export async function findMissingIndexes(
  input: FindMissingIndexesInput = {},
): Promise<FindMissingIndexesOutput> {
  // ── 1. Load config — fail fast with clear message ──────────────────────────
  // loadDbConfig errors already include DB_CREDENTIALS_HELP with the expected
  // .env structure, so they propagate as-is.
  const config = loadDbConfig({ envFile: input.envFile, projectRoot: input.projectRoot });

  // ── 2. Connect to DB — fail fast with clear message ────────────────────────
  let client: DbClient;
  try {
    process.stderr.write(`🥷 [find_missing_indexes] Connecting to ${config.type} @ ${config.host}:${config.port}/${config.database}...\n`);
    client = await getDbClient(config);
    process.stderr.write(`✴️  Connected\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not connect to ${config.type} at ${config.host}:${config.port}/${config.database}.\n\n` +
      `Reason: ${msg}\n\n` +
      `Credentials source: ${config.source}\n` +
      `Check the following values:\n` +
      `  DB_HOST     = ${config.host}\n` +
      `  DB_PORT     = ${config.port}\n` +
      `  DB_NAME     = ${config.database}\n` +
      `  DB_USER     = ${config.user}\n` +
      `  DB_PASSWORD = (hidden)\n` +
      `  DB_SSL      = ${config.ssl}\n\n` +
      DB_CREDENTIALS_HELP,
    );
  }

  // ── 3. Get queries from last report ────────────────────────────────────────
  const report = getLastReport();
  const queries: string[] = [];

  if (report) {
    // Use top queries + issue queries for broadest coverage
    for (const q of report.topQueries) {
      queries.push(q.normalizedSql);
    }
    for (const issue of report.issues) {
      if (issue.query && !queries.includes(issue.query)) {
        queries.push(issue.query);
      }
    }
  }

  if (queries.length === 0) {
    const out = {
      connected: true,
      dbType: config.type,
      dbHost: config.host,
      dbName: config.database,
      queriesAnalyzed: 0,
      missingIndexes: [],
    };
    return { ...out, markdownReport: buildMarkdown(out) };
  }

  // ── 4. Extract (table, column) usage from WHERE/JOIN/ORDER BY ──────────────
  const usageCount = new Map<string, { table: string; column: string; count: number; example: string }>();

  for (const sql of queries) {
    const cols = extractWhereColumns(sql);
    for (const { table, column } of cols) {
      const key = `${table}.${column}`;
      const existing = usageCount.get(key);
      if (existing) {
        existing.count++;
      } else {
        usageCount.set(key, { table, column, count: 1, example: sql });
      }
    }
  }

  // ── 5. Fetch existing indexes from DB ──────────────────────────────────────
  process.stderr.write(`✴️  Fetching existing indexes from ${config.type}...\n`);
  const indexMap = await getExistingIndexes(client, config.schema ?? 'public');

  // ── 6. Cross-reference: find columns without indexes ──────────────────────
  const missingIndexes: MissingIndexResult[] = [];

  for (const [key, usage] of usageCount) {
    // Skip if already indexed (primary key or explicit index)
    if (indexMap.has(key)) {
      const idxSet = indexMap.get(key)!;
      // Primary key counts — skip
      if (idxSet.has('PRIMARY') || [...idxSet].some((n) => n.toLowerCase().includes('pkey'))) continue;
      continue; // has any index — skip
    }

    // Skip common false positives: columns that are IDs (likely PKs not yet in catalog)
    if (/^(id|uuid|created_at|updated_at)$/.test(usage.column)) continue;

    missingIndexes.push({
      table: usage.table,
      column: usage.column,
      usageCount: usage.count,
      exampleQuery: usage.example,
      existingIndexes: [],
    });
  }

  // Sort by usage count descending (most impactful first)
  missingIndexes.sort((a, b) => b.usageCount - a.usageCount);

  process.stderr.write(`✅ ${missingIndexes.length} potential missing index(es) found\n`);

  const out = {
    connected: true,
    dbType: config.type,
    dbHost: config.host,
    dbName: config.database,
    queriesAnalyzed: queries.length,
    missingIndexes,
  };

  return { ...out, markdownReport: buildMarkdown(out) };
}
