import { ParsedQuery } from '../../domain/models/query.model';
import { PossibleCartesianProductIssue } from '../../domain/models/issue.model';
import { DetectorConfig } from '../../domain/models/config.model';
import { countJoins, isSelectQuery } from '../parsing/sql-normalizer';
import { t } from '../../shared/i18n';

interface FanOutResult {
  isFanOut: boolean;
  drivingColumn: string | null;
  joinedTables: string[];
}

/**
 * Detects "fan-out" JOINs: the same parent column appears on the driving side
 * of two or more ON clauses joining different child tables.
 *
 * Example from Hibernate-generated SQL:
 *   join orders o1_0 on c1_0.id=o1_0.customer_id     ← c1_0.id seen once
 *   join customer_tag t1_0 on c1_0.id=t1_0.customer_id ← c1_0.id seen twice → fan-out!
 *
 * This causes rows = |orders| × |customer_tag| — a Cartesian product.
 * Hibernate deduplicates in memory via first-level cache, but the DB already
 * transferred all the extra rows across the wire.
 *
 * Note: Hibernate SQL logs show plain `join`, not JPQL `join fetch`.
 * Detecting `join fetch` in SQL logs always yields 0 — don't use it.
 */
function detectFanOut(sql: string): FanOutResult {
  const joinOnRe = /\bjoin\s+(\w+)\s+\w+\s+on\s+(\w+\.\w+)\s*=\s*(\w+\.\w+)/gi;
  const colToTables = new Map<string, string[]>();
  let m: RegExpExecArray | null;

  while ((m = joinOnRe.exec(sql)) !== null) {
    const table = m[1];
    const left  = m[2].toLowerCase();
    const right = m[3].toLowerCase();
    for (const col of [left, right]) {
      if (!colToTables.has(col)) colToTables.set(col, []);
      colToTables.get(col)!.push(table);
    }
  }

  for (const [col, tables] of colToTables) {
    if (tables.length >= 2) {
      return { isFanOut: true, drivingColumn: col, joinedTables: tables };
    }
  }

  return { isFanOut: false, drivingColumn: null, joinedTables: [] };
}

export function detectCartesianProducts(
  queries: ParsedQuery[],
  config: DetectorConfig,
): PossibleCartesianProductIssue[] {
  const seen = new Set<string>();
  const issues: PossibleCartesianProductIssue[] = [];

  for (const query of queries) {
    const { normalizedSql, rawSql, lineNumber } = query;

    if (!isSelectQuery(normalizedSql)) continue;
    if (seen.has(normalizedSql)) continue;

    const joinCount = countJoins(rawSql);
    if (joinCount < config.cartesianJoinThreshold) continue;

    const hasDistinct = /\bselect\s+distinct\b/i.test(rawSql);
    const fanOut = detectFanOut(rawSql);

    // Fan-out is the definitive signal for Cartesian explosion.
    // Without a fan-out, only flag if many JOINs AND no DISTINCT mitigation.
    if (!fanOut.isFanOut && hasDistinct) continue;

    seen.add(normalizedSql);

    const severity: 'HIGH' | 'MEDIUM' = fanOut.isFanOut && !hasDistinct ? 'HIGH' : 'MEDIUM';

    issues.push({
      type: 'POSSIBLE_CARTESIAN_PRODUCT',
      severity,
      query: normalizedSql,
      joinCount,
      fanOutTables: fanOut.isFanOut ? fanOut.joinedTables : undefined,
      description: t().detectors.cartesianProduct.description(
        joinCount,
        fanOut.isFanOut ? fanOut.joinedTables : undefined,
      ),
      recommendation: t().detectors.cartesianProduct.recommendation,
      evidence: [rawSql.trim()],
      lineNumbers: [lineNumber],
    });
  }

  return issues;
}
