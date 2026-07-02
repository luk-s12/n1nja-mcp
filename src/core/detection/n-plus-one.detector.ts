import { ParsedQuery, QueryGroup } from '../../domain/models/query.model';
import { NPlusOneIssue } from '../../domain/models/issue.model';
import { DetectorConfig } from '../../domain/models/config.model';
import { groupByThreadAndSql, hasDistinctNonEmptyParams } from './query-aggregator';
import { t } from '../../shared/i18n';

/**
 * Detects N+1 query patterns in two passes:
 *
 * Pass 1 — per-request: same normalized SELECT with WHERE fired N times in
 * the same HTTP thread, each with distinct bind parameters. This is the
 * classic lazy-loading-in-a-loop pattern. Uses a lower threshold
 * (nPlusOnePerRequestThreshold, default 3) so small result sets are caught.
 *
 * Pass 2 — global: same query fired across requests above nPlusOneThreshold.
 */
export function detectNPlusOne(
  groups: Map<string, QueryGroup>,
  orderedQueries: Array<{ normalizedSql: string; rawSql: string; lineNumber: number }>,
  config: DetectorConfig,
  allQueries: ParsedQuery[] = [],
): NPlusOneIssue[] {
  const issues: NPlusOneIssue[] = [];
  const alreadyFlagged = new Set<string>();

  // ── Pass 1: per-request N+1 ─────────────────────────────────────────────────
  // Group by thread + normalizedSql, then check that params are all distinct.
  // Different params per execution = lazy-loading in a loop (true N+1).
  const threadGroups = groupByThreadAndSql(allQueries);

  for (const [, executions] of threadGroups) {
    if (executions.length < config.nPlusOnePerRequestThreshold) continue;
    const { normalizedSql, threadName } = executions[0];

    if (!/^\s*select\b/i.test(normalizedSql)) continue;
    if (!/\bwhere\b/i.test(normalizedSql)) continue;

    // Only flag as N+1 when every execution has non-empty, distinct params.
    // If params are missing or repeat, the duplicate detector handles it.
    if (!hasDistinctNonEmptyParams(executions)) continue;

    const evidence = executions.slice(0, 5).map((q) => q.rawSql.trim());
    const firstIndex = orderedQueries.findIndex((q) => q.normalizedSql === normalizedSql);
    let parentQuery: string | undefined;
    if (firstIndex > 0) {
      const prev = orderedQueries[firstIndex - 1].normalizedSql;
      if (prev !== normalizedSql) parentQuery = prev;
    }

    issues.push({
      type: 'N_PLUS_1',
      severity: 'HIGH',
      query: normalizedSql,
      executions: executions.length,
      estimatedExtraQueries: executions.length - 1,
      parentQuery,
      description: t().detectors.nPlusOne.description(executions.length),
      recommendation: t().detectors.nPlusOne.recommendation,
      evidence,
      lineNumbers: executions.map((q) => q.lineNumber),
    });

    alreadyFlagged.add(`${threadName}::${normalizedSql}`);
  }

  // ── Pass 2: global N+1 ──────────────────────────────────────────────────────
  for (const [normalizedSql, group] of groups) {
    const count = group.executions.length;
    if (count < config.nPlusOneThreshold) continue;

    if (!/^\s*select\b/i.test(normalizedSql)) continue;
    if (!/\bwhere\b/i.test(normalizedSql)) continue;

    // Skip if every occurrence was already captured by a per-request flag
    const allCoveredByPerRequest = group.executions.every((q) =>
      q.threadName && alreadyFlagged.has(`${q.threadName}::${normalizedSql}`),
    );
    if (allCoveredByPerRequest) continue;

    const evidence = group.executions.slice(0, 5).map((q) => q.rawSql.trim());

    const firstOccurrenceIndex = orderedQueries.findIndex(
      (q) => q.normalizedSql === normalizedSql,
    );
    let parentQuery: string | undefined;
    if (firstOccurrenceIndex > 0) {
      const parentNormalized = orderedQueries[firstOccurrenceIndex - 1].normalizedSql;
      if (parentNormalized !== normalizedSql) {
        parentQuery = parentNormalized;
      }
    }

    issues.push({
      type: 'N_PLUS_1',
      severity: 'HIGH',
      query: normalizedSql,
      executions: count,
      estimatedExtraQueries: count - 1,
      parentQuery,
      description: t().detectors.nPlusOne.description(count),
      recommendation: t().detectors.nPlusOne.recommendation,
      evidence,
      lineNumbers: group.executions.map((q) => q.lineNumber),
    });
  }

  return issues.sort((a, b) => b.executions - a.executions);
}
