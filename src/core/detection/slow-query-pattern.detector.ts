import { ParsedQuery } from '../../domain/models/query.model';
import { SlowQueryIssue } from '../../domain/models/issue.model';
import { t } from '../../shared/i18n';

/**
 * SQL anti-patterns that always produce slow queries, regardless of measured timing.
 * Each entry has a regex tested against the raw SQL and a human-readable reason.
 */
const SLOW_PATTERNS: { regex: RegExp; reason: string }[] = [
  {
    regex: /\bLOWER\s*\([^)]+\)\s+LIKE\b/i,
    reason: 'LOWER(col) LIKE — function on column prevents index use, forces per-row evaluation',
  },
  {
    regex: /\bUPPER\s*\([^)]+\)\s+LIKE\b/i,
    reason: 'UPPER(col) LIKE — function on column prevents index use, forces per-row evaluation',
  },
  {
    regex: /\bTO_CHAR\s*\([^)]+\)\s*(=|LIKE|<|>)\b/i,
    reason: 'TO_CHAR(col) in WHERE — function on column prevents index use',
  },
  {
    regex: /\bDATE\s*\([^)]+\)\s*(=|<|>|<=|>=|BETWEEN)\b/i,
    reason: 'DATE(col) in WHERE — function on column prevents index use',
  },
  {
    regex: /LIKE\s+['"][%]/i,
    reason: "Leading wildcard LIKE '%...' — cannot use B-tree index, always full table scan",
  },
  {
    regex: /\bCAST\s*\([^)]+\s+AS\s+[^)]+\)\s*(=|<|>|LIKE)\b/i,
    reason: 'CAST(col AS ...) in WHERE — implicit type conversion prevents index use',
  },
];

/**
 * Detects SQL anti-patterns that are structurally slow.
 *
 * When the log contains a measured execution time for the query (e.g. an application
 * `Query completed in 50ms` line), the issue is reported as timing-confirmed
 * (`isPatternBased: false`, carrying the measured `executionTimeMs`) so the report can
 * confirm the timing log was found instead of asking the user to add timing logs.
 * When no timing data is present, the issue falls back to pure static analysis
 * (`isPatternBased: true`) and the report suggests adding timing logs.
 *
 * Queries whose measured time already exceeds the slow-query threshold are handled by
 * the timing-based slow-query.detector.ts and de-duplicated in the issue orchestrator.
 */
export function detectSlowQueryPatterns(queries: ParsedQuery[]): SlowQueryIssue[] {
  // Highest measured execution time per normalized SQL (if any execution logged timing).
  const measuredByNorm = new Map<string, number>();
  for (const query of queries) {
    if (query.executionTimeMs !== undefined) {
      const prev = measuredByNorm.get(query.normalizedSql) ?? 0;
      if (query.executionTimeMs > prev) measuredByNorm.set(query.normalizedSql, query.executionTimeMs);
    }
  }

  const seen = new Set<string>();
  const issues: SlowQueryIssue[] = [];

  for (const query of queries) {
    if (seen.has(query.normalizedSql)) continue;

    for (const { regex, reason } of SLOW_PATTERNS) {
      if (regex.test(query.rawSql)) {
        seen.add(query.normalizedSql);
        const measuredMs = measuredByNorm.get(query.normalizedSql);
        const timingConfirmed = measuredMs !== undefined;
        issues.push({
          type: 'SLOW_QUERY',
          severity: 'MEDIUM',
          isPatternBased: !timingConfirmed,
          executionTimeMs: measuredMs ?? 0,
          query: query.normalizedSql,
          description: t().detectors.slowQueryPattern.description(reason),
          recommendation: t().detectors.slowQueryPattern.recommendation,
          evidence: [query.rawSql.trim()],
          lineNumbers: [query.lineNumber],
          threadContextLines: query.threadContextLines,
        });
        break;
      }
    }
  }

  return issues;
}
