import { QueryGroup } from '../../domain/models/query.model';
import { LargeResultSetIssue } from '../../domain/models/issue.model';
import { DetectorConfig } from '../../domain/models/config.model';
import { t } from '../../shared/i18n';

/**
 * Detects queries where the total returned rows exceed the threshold.
 *
 * Row count can come from:
 * 1. Hibernate statistics (entity load count per query)
 * 2. Heuristic: a query with no pagination executed many times × estimated rows
 */
export function detectLargeResultSets(
  groups: Map<string, QueryGroup>,
  config: DetectorConfig,
): LargeResultSetIssue[] {
  const issues: LargeResultSetIssue[] = [];

  for (const [normalizedSql, group] of groups) {
    const totalRows = group.totalRows;
    if (totalRows < config.largeResultThreshold) continue;

    const evidence = group.executions.slice(0, 3).map((q) => q.rawSql.trim());

    issues.push({
      type: 'LARGE_RESULT_SET',
      severity: totalRows >= config.largeResultThreshold * 5 ? 'HIGH' : 'MEDIUM',
      query: normalizedSql,
      rows: totalRows,
      description: t().detectors.largeResultSet.description(totalRows, group.executions.length, config.largeResultThreshold),
      recommendation: t().detectors.largeResultSet.recommendation,
      evidence,
      lineNumbers: group.executions.map((q) => q.lineNumber),
    });
  }

  return issues.sort((a, b) => b.rows - a.rows);
}
