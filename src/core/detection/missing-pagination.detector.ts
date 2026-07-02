import { ParsedQuery } from '../../domain/models/query.model';
import { MissingPaginationIssue } from '../../domain/models/issue.model';
import { isSelectQuery, lacksPagination } from '../parsing/sql-normalizer';
import { t } from '../../shared/i18n';

/**
 * Detects SELECT queries that fetch potentially unbounded result sets
 * because they lack LIMIT / OFFSET / FETCH FIRST / TOP clauses.
 *
 * Only flags queries that look like "broad" fetches:
 * - No WHERE clause, OR
 * - WHERE clause but querying a "list" entity (table names ending in s, es, ies)
 */
export function detectMissingPagination(
  queries: ParsedQuery[],
): MissingPaginationIssue[] {
  const seen = new Set<string>();
  const issues: MissingPaginationIssue[] = [];

  for (const query of queries) {
    const { normalizedSql, rawSql, lineNumber } = query;

    if (!isSelectQuery(normalizedSql)) continue;
    if (!lacksPagination(normalizedSql)) continue;
    if (seen.has(normalizedSql)) continue;

    // Broad fetch heuristic: no WHERE clause or only ORDER BY (no filtering)
    const hasNoWhere = !/\bwhere\b/i.test(normalizedSql);
    const hasOrderByOnly = /\border\s+by\b/i.test(normalizedSql) && hasNoWhere;

    if (!hasNoWhere && !hasOrderByOnly) continue;

    seen.add(normalizedSql);

    issues.push({
      type: 'MISSING_PAGINATION',
      severity: 'HIGH',
      query: normalizedSql,
      description: t().detectors.missingPagination.description,
      recommendation: t().detectors.missingPagination.recommendation,
      evidence: [rawSql.trim()],
      lineNumbers: [lineNumber],
    });
  }

  return issues;
}
