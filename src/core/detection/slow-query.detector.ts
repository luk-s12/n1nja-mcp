import { QueryGroup } from '../../domain/models/query.model';
import { SlowQueryIssue } from '../../domain/models/issue.model';
import { DetectorConfig } from '../../domain/models/config.model';
import { t } from '../../shared/i18n';

/**
 * Detects queries whose maximum execution time exceeds the threshold.
 *
 * Execution time is sourced from Hibernate statistics when available.
 * If no timing data is present in the log, no SLOW_QUERY issues are emitted.
 */
export function detectSlowQueries(
  groups: Map<string, QueryGroup>,
  config: DetectorConfig,
): SlowQueryIssue[] {
  const issues: SlowQueryIssue[] = [];

  for (const [normalizedSql, group] of groups) {
    if (group.maxExecutionTimeMs < config.slowQueryMs) continue;

    const evidence = group.executions
      .filter((q) => (q.executionTimeMs ?? 0) >= config.slowQueryMs)
      .slice(0, 3)
      .map((q) => `${q.rawSql.trim()}  [${q.executionTimeMs}ms]`);

    issues.push({
      type: 'SLOW_QUERY',
      severity: group.maxExecutionTimeMs >= config.slowQueryMs * 4 ? 'HIGH' : 'MEDIUM',
      query: normalizedSql,
      executionTimeMs: group.maxExecutionTimeMs,
      description: t().detectors.slowQuery.description(config.slowQueryMs, group.maxExecutionTimeMs, Math.round(group.avgExecutionTimeMs)),
      recommendation: t().detectors.slowQuery.recommendation,
      evidence,
      lineNumbers: group.executions.map((q) => q.lineNumber),
    });
  }

  return issues.sort((a, b) => b.executionTimeMs - a.executionTimeMs);
}
