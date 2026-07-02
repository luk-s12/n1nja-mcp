import { ParsedQuery, HibernateStatistics, QueryGroup } from '../../domain/models/query.model';
import { Issue } from '../../domain/models/issue.model';
import { DetectorConfig, DEFAULT_CONFIG } from '../../domain/models/config.model';
import { aggregateQueries, topQueryGroups } from './query-aggregator';
import { detectNPlusOne } from './n-plus-one.detector';
import { detectDuplicateQueries } from './duplicate-query.detector';
import { detectMissingPagination } from './missing-pagination.detector';
import { detectLargeResultSets } from './large-result-set.detector';
import { detectSlowQueries } from './slow-query.detector';
import { detectCartesianProducts } from './cartesian-product.detector';
import { detectOverFetching } from './select-star.detector';
import { detectSlowQueryPatterns } from './slow-query-pattern.detector';

export interface DetectionResult {
  issues: Issue[];
  queryGroups: Map<string, QueryGroup>;
  topQueries: QueryGroup[];
}

/**
 * Everything a detector may need, computed once per analysis run.
 */
export interface DetectionContext {
  queries: ParsedQuery[];
  queryGroups: Map<string, QueryGroup>;
  /** Chronological query summary, used for N+1 parent inference */
  orderedSummary: Array<{ normalizedSql: string; rawSql: string; lineNumber: number }>;
  config: DetectorConfig;
  /** Enables source-aware detectors (e.g. column-level over-fetching) */
  projectRoot?: string;
  /**
   * Issues emitted by detectors that ran earlier in the pipeline. Lets a
   * detector defer to a more specific one (e.g. DUPLICATE_QUERY skips queries
   * already flagged as N_PLUS_1) without hard-wiring detector-to-detector calls.
   */
  previousIssues: readonly Issue[];
}

export interface Detector {
  name: string;
  detect(ctx: DetectionContext): Issue[];
}

/**
 * The detection pipeline, run in order. Adding a detector means appending an
 * entry here — order matters only when a detector reads `previousIssues`.
 */
const DETECTORS: Detector[] = [
  {
    name: 'n-plus-one',
    detect: (ctx) => detectNPlusOne(ctx.queryGroups, ctx.orderedSummary, ctx.config, ctx.queries),
  },
  {
    name: 'duplicate-query',
    detect: (ctx) => {
      // Queries already explained as N+1 must not be double-reported as duplicates
      const nPlusOneKeys = new Set(
        ctx.previousIssues.filter((i) => i.type === 'N_PLUS_1').map((i) => i.query),
      );
      return detectDuplicateQueries(ctx.queryGroups, nPlusOneKeys, ctx.config, ctx.queries);
    },
  },
  {
    name: 'missing-pagination',
    detect: (ctx) => detectMissingPagination(ctx.queries),
  },
  {
    name: 'large-result-set',
    detect: (ctx) => detectLargeResultSets(ctx.queryGroups, ctx.config),
  },
  {
    name: 'slow-query',
    detect: (ctx) => detectSlowQueries(ctx.queryGroups, ctx.config),
  },
  {
    name: 'slow-query-pattern',
    detect: (ctx) => {
      // Timing-confirmed SLOW_QUERY findings win over pattern-based suspicions
      const timedSlowKeys = new Set(
        ctx.previousIssues.filter((i) => i.type === 'SLOW_QUERY').map((i) => i.query),
      );
      return detectSlowQueryPatterns(ctx.queries).filter((i) => !timedSlowKeys.has(i.query));
    },
  },
  {
    name: 'cartesian-product',
    detect: (ctx) => detectCartesianProducts(ctx.queries, ctx.config),
  },
  {
    name: 'over-fetching',
    detect: (ctx) => detectOverFetching(ctx.queries, ctx.projectRoot),
  },
];

/**
 * Runs the detector pipeline and returns the combined list of issues.
 */
export function detectAllIssues(
  queries: ParsedQuery[],
  _statistics: HibernateStatistics,
  config: DetectorConfig = DEFAULT_CONFIG,
  projectRoot?: string,
): DetectionResult {
  const queryGroups = aggregateQueries(queries);

  const orderedSummary = queries.map((q) => ({
    normalizedSql: q.normalizedSql,
    rawSql: q.rawSql,
    lineNumber: q.lineNumber,
  }));

  const issues: Issue[] = [];
  for (const detector of DETECTORS) {
    issues.push(
      ...detector.detect({
        queries,
        queryGroups,
        orderedSummary,
        config,
        projectRoot,
        previousIssues: issues,
      }),
    );
  }

  attachThreadContext(issues, queries);

  const topQueries = topQueryGroups(queryGroups, 10);

  return { issues, queryGroups, topQueries };
}

/**
 * Attaches thread context from the first query that matches each issue's
 * normalized SQL. This lets the project analyzer trace the exact service
 * method that triggered the query.
 */
function attachThreadContext(issues: Issue[], queries: ParsedQuery[]): void {
  const queryByNorm = new Map<string, string[]>();
  for (const q of queries) {
    if (q.threadContextLines?.length && !queryByNorm.has(q.normalizedSql)) {
      queryByNorm.set(q.normalizedSql, q.threadContextLines);
    }
  }
  for (const issue of issues) {
    if (!issue.threadContextLines) {
      const ctx = queryByNorm.get(issue.query);
      if (ctx) issue.threadContextLines = ctx;
    }
  }
}
