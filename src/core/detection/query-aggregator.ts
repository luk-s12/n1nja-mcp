import { ParsedQuery, QueryGroup } from '../../domain/models/query.model';

/**
 * Aggregates a flat list of ParsedQuery objects into QueryGroups
 * keyed by their normalized SQL.
 */
export function aggregateQueries(queries: ParsedQuery[]): Map<string, QueryGroup> {
  const groups = new Map<string, QueryGroup>();

  for (const query of queries) {
    const key = query.normalizedSql;
    let group = groups.get(key);

    if (!group) {
      group = {
        normalizedSql: key,
        executions: [],
        totalExecutionTimeMs: 0,
        maxExecutionTimeMs: 0,
        avgExecutionTimeMs: 0,
        totalRows: 0,
      };
      groups.set(key, group);
    }

    group.executions.push(query);

    if (query.executionTimeMs !== undefined) {
      group.totalExecutionTimeMs += query.executionTimeMs;
      if (query.executionTimeMs > group.maxExecutionTimeMs) {
        group.maxExecutionTimeMs = query.executionTimeMs;
      }
    }

    if (query.rowCount !== undefined) {
      group.totalRows += query.rowCount;
    }
  }

  // Compute averages
  for (const group of groups.values()) {
    const withTime = group.executions.filter((q) => q.executionTimeMs !== undefined);
    group.avgExecutionTimeMs = withTime.length > 0
      ? group.totalExecutionTimeMs / withTime.length
      : 0;
  }

  return groups;
}

/**
 * Groups queries by (thread name + normalized SQL). Queries without a thread
 * name are skipped. Used by the per-request passes of the N+1 and duplicate
 * detectors to reason about executions within a single HTTP request.
 */
export function groupByThreadAndSql(queries: ParsedQuery[]): Map<string, ParsedQuery[]> {
  const groups = new Map<string, ParsedQuery[]>();
  for (const q of queries) {
    if (!q.threadName) continue;
    const key = `${q.threadName}::${q.normalizedSql}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(q);
  }
  return groups;
}

/**
 * True when every execution carries non-empty bind parameters and they are all
 * distinct — the signature of lazy-loading in a loop with different IDs (true
 * N+1), as opposed to the same query repeated with identical params (a duplicate).
 */
export function hasDistinctNonEmptyParams(executions: ParsedQuery[]): boolean {
  const paramSets = executions.map((q) => q.parameters.join(','));
  const allHaveParams = paramSets.every(Boolean);
  const allDistinct = new Set(paramSets).size === paramSets.length;
  return allHaveParams && allDistinct;
}

/**
 * Returns QueryGroups sorted by execution count descending (hottest queries first).
 */
export function topQueryGroups(groups: Map<string, QueryGroup>, limit = 10): QueryGroup[] {
  return [...groups.values()]
    .sort((a, b) => b.executions.length - a.executions.length)
    .slice(0, limit);
}
