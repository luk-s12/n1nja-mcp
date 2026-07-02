import { ParsedQuery } from '../../domain/models/query.model';
import { OverFetchingIssue } from '../../domain/models/issue.model';
import { scanLogMessageOrigin, extractUsedEntityFields, normalizeColumnName } from '../code-analysis/usage-scanner';
import { t } from '../../shared/i18n';

/**
 * Detects over-fetching: queries that load more columns than the triggering
 * code actually uses.
 *
 * Two strategies:
 *  1. Literal `SELECT *` (rare with Hibernate, but valid for native queries) —
 *     works from the log alone.
 *  2. Column-level over-fetching (requires `projectRoot`) — Hibernate always
 *     expands columns explicitly (`select c.id, c.city, c.email, c.name ...`),
 *     so we parse the fetched columns from the SQL and compare them against the
 *     entity getters used inside the method that triggered the query. Columns
 *     fetched but never read are reported as over-fetching.
 */
export function detectOverFetching(queries: ParsedQuery[], projectRoot?: string): OverFetchingIssue[] {
  const issues: OverFetchingIssue[] = [];
  const seen = new Set<string>();

  // ── Strategy 1: literal SELECT * (no source needed) ───────────────────────
  const starPattern = /\bselect\s+(?:\*|[\w]+\.\*|\*\s*from)/i;
  const starGroups: { normalizedSql: string; rawSql: string; lineNumber: number }[] = [];

  for (const query of queries) {
    if (!starPattern.test(query.rawSql)) continue;
    if (seen.has(query.normalizedSql)) continue;
    seen.add(query.normalizedSql);
    starGroups.push({
      normalizedSql: query.normalizedSql,
      rawSql: query.rawSql,
      lineNumber: query.lineNumber,
    });
  }

  if (starGroups.length > 0) {
    const totalExecutions = queries.filter((q) => starPattern.test(q.rawSql)).length;
    issues.push({
      type: 'OVER_FETCHING',
      severity: totalExecutions >= 50 ? 'MEDIUM' : 'LOW',
      query: starGroups[0].normalizedSql,
      description: t().detectors.overFetching.description(starGroups.length, totalExecutions),
      recommendation: t().detectors.overFetching.recommendation,
      evidence: starGroups.slice(0, 5).map((g) => g.rawSql.trim()),
      lineNumbers: starGroups.map((g) => g.lineNumber),
      executions: totalExecutions,
    });
  }

  // ── Strategy 2: column-level over-fetching (needs source code) ────────────
  if (!projectRoot) return issues;

  for (const query of queries) {
    if (seen.has(query.normalizedSql)) continue;

    const parsed = parseFullEntitySelect(query.normalizedSql);
    if (!parsed) continue;
    if (!query.threadContextLines?.length) continue;

    // Trace the exact method that triggered this query via the thread-context logs
    const origins = scanLogMessageOrigin(projectRoot, query.threadContextLines);
    if (origins.length === 0) continue;

    // Collect the entity fields the triggering method actually reads
    const used = new Set<string>();
    for (const origin of origins.slice(0, 3)) {
      for (const field of extractUsedEntityFields(origin.filePath, origin.lineNumber)) {
        used.add(field);
      }
    }

    // Confirm we matched the right entity/method: at least one selected column
    // must be read here. Otherwise the entity is likely handed off whole.
    const usedHere = parsed.columns.filter((c) => used.has(normalizeColumnName(c)));
    if (usedHere.length === 0) continue;

    // Unused = fetched columns the method never reads (the PK is excluded — it's
    // almost always needed and rarely worth projecting away).
    const unusedColumns = parsed.columns.filter((c) => {
      const norm = normalizeColumnName(c);
      return norm !== 'id' && !used.has(norm);
    });
    if (unusedColumns.length === 0) continue;

    seen.add(query.normalizedSql);

    const entity = toPascalCase(parsed.table);
    const totalExecutions = queries.filter((q) => q.normalizedSql === query.normalizedSql).length;

    issues.push({
      type: 'OVER_FETCHING',
      severity: 'MEDIUM',
      query: query.normalizedSql,
      description: t().detectors.overFetching.descriptionColumns(entity, unusedColumns, usedHere),
      recommendation: t().detectors.overFetching.recommendation,
      evidence: [query.rawSql.trim()],
      lineNumbers: [query.lineNumber],
      executions: totalExecutions,
      unusedColumns,
      usedColumns: usedHere,
      entityName: entity,
      threadContextLines: query.threadContextLines,
    });
  }

  return issues;
}

/**
 * Parses a Hibernate "full entity" SELECT (`select a.c1, a.c2, ... from table a`)
 * and returns the table plus the list of fetched columns. Returns null for
 * anything that isn't a plain single-table column list (aggregates, joins,
 * SELECT *, subqueries) — those are not column-level over-fetching candidates.
 */
function parseFullEntitySelect(sql: string): { table: string; columns: string[] } | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const m = s.match(/^select\s+(?:distinct\s+)?(.+?)\s+from\s+(\w+)\s+\w+\b(.*)$/i);
  if (!m) return null;

  const colPart = m[1];
  const table = m[2];
  const rest = m[3] ?? '';

  if (/\bjoin\b/i.test(rest)) return null; // single table only
  if (/[()*]/.test(colPart)) return null; // no aggregates / star

  const columns: string[] = [];
  for (const item of colPart.split(',')) {
    const cm = item.trim().match(/^\w+\.(\w+)$/); // alias.column
    if (!cm) return null;
    columns.push(cm[1]);
  }

  if (columns.length < 2) return null; // need ≥2 columns to over-fetch
  return { table, columns };
}

/** customer → Customer, order_item → OrderItem */
function toPascalCase(table: string): string {
  return table
    .split('_')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}
