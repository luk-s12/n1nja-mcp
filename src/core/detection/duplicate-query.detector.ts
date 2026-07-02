import { ParsedQuery, QueryGroup } from '../../domain/models/query.model';
import { DuplicateQueryIssue } from '../../domain/models/issue.model';
import { DetectorConfig } from '../../domain/models/config.model';
import { groupByThreadAndSql, hasDistinctNonEmptyParams } from './query-aggregator';
import { t } from '../../shared/i18n';

/**
 * Detects queries executed more than `duplicateQueryThreshold` times
 * that are NOT already flagged as N+1.
 *
 * Also detects per-request duplicates: the same normalized SQL fired 2+
 * times within a single HTTP request (same thread name). This catches the
 * classic pattern of calling findById() multiple times in the same service
 * method for the same ID, even when Hibernate L1 cache prevents extra SQL
 * from being emitted across calls with different parameters.
 *
 * Common causes:
 * - Loading the same entity multiple times in nested service calls
 * - Missing @Cacheable on repository methods
 * - Calling findById() inside a loop instead of findAllById()
 */
export function detectDuplicateQueries(
  groups: Map<string, QueryGroup>,
  nPlusOneKeys: Set<string>,
  config: DetectorConfig,
  allQueries: ParsedQuery[] = [],
): DuplicateQueryIssue[] {
  const issues: DuplicateQueryIssue[] = [];
  const alreadyFlagged = new Set<string>();

  // ── Pass 1: per-request (per-thread) detection ──────────────────────────────
  // When the same normalized SQL fires 2+ times in the same HTTP request
  // (identified by thread name), flag it as HIGH severity immediately.
  // This catches findById-style duplicates that Hibernate L1 cache may
  // deduplicate at SQL level, but that still represent wasteful code.
  const threadGroups = groupByThreadAndSql(allQueries);

  for (const [, executions] of threadGroups) {
    if (executions.length < 2) continue;
    const { normalizedSql, threadName } = executions[0];
    if (nPlusOneKeys.has(normalizedSql)) continue;
    if (!/^\s*select\b/i.test(normalizedSql)) continue;

    // If every execution has distinct non-empty params, it's N+1 (lazy-loading
    // in a loop with different IDs), not a duplicate. The N+1 detector handles it.
    if (/\bwhere\b/i.test(normalizedSql) && hasDistinctNonEmptyParams(executions)) continue;

    issues.push({
      type: 'DUPLICATE_QUERY',
      severity: 'HIGH',
      query: normalizedSql,
      executions: executions.length,
      maxPerRequest: executions.length,
      description: t().detectors.duplicateQuery.descriptionPerRequest(executions.length, threadName),
      recommendation: t().detectors.duplicateQuery.recommendation,
      evidence: executions.slice(0, 5).map((q) => q.rawSql.trim()),
      lineNumbers: executions.map((q) => q.lineNumber),
    });
    alreadyFlagged.add(normalizedSql);
  }

  // ── Pass 2: global duplicate detection ─────────────────────────────────────
  // Flag queries that repeat across requests above the configured threshold.
  for (const [normalizedSql, group] of groups) {
    const count = group.executions.length;
    if (count < config.duplicateQueryThreshold) continue;
    if (nPlusOneKeys.has(normalizedSql)) continue;
    if (alreadyFlagged.has(normalizedSql)) continue;
    if (!/^\s*select\b/i.test(normalizedSql)) continue;

    const evidence = group.executions.slice(0, 5).map((q) => q.rawSql.trim());

    issues.push({
      type: 'DUPLICATE_QUERY',
      severity: count >= 20 ? 'HIGH' : 'MEDIUM',
      query: normalizedSql,
      executions: count,
      description: t().detectors.duplicateQuery.description(count),
      recommendation: t().detectors.duplicateQuery.recommendation,
      evidence,
      lineNumbers: group.executions.map((q) => q.lineNumber),
    });
  }

  return issues.sort((a, b) => b.executions - a.executions);
}
