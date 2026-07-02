import { AnalysisReport } from '../../domain/models/report.model';
import { Issue, NPlusOneIssue, DuplicateQueryIssue, LargeResultSetIssue, SlowQueryIssue, PossibleCartesianProductIssue, OverFetchingIssue, DeadlockIssue } from '../../domain/models/issue.model';
import { t } from '../../shared/i18n';
import { severityIcon } from '../../shared/severity';

/**
 * Renders an AnalysisReport as a Markdown string (language-aware).
 */
export function toMarkdown(report: AnalysisReport): string {
  const s = t().report;
  const lines: string[] = [];
  const { summary, issues, hibernateStatistics, topQueries } = report;

  lines.push(s.title);
  lines.push('');
  lines.push(`${s.labelLogFile} \`${summary.logFile}\``);
  lines.push(`${s.labelAnalyzedAt} ${summary.analysisCompletedAt}`);
  lines.push(`${s.labelLinesProcessed} ${summary.linesProcessed.toLocaleString()}`);
  lines.push('');

  // Summary table
  lines.push(s.sectionSummary);
  lines.push('');
  lines.push(`| ${s.colMetric} | ${s.colValue} |`);
  lines.push(`|--------|-------|`);
  lines.push(`| ${s.metricTotalQueries} | ${summary.totalQueries} |`);
  lines.push(`| ${s.metricUniqueQueries} | ${summary.uniqueNormalizedQueries} |`);
  lines.push(`| ${s.metricDetectedIssues} | **${summary.detectedIssues}** |`);
  lines.push(`| ${s.metricExecutionTime} | ${summary.totalExecutionTimeMs}ms |`);
  if (summary.issuesBySeverity['HIGH']) lines.push(`| ${s.metricHighSeverity} | ${summary.issuesBySeverity['HIGH']} |`);
  if (summary.issuesBySeverity['MEDIUM']) lines.push(`| ${s.metricMediumSeverity} | ${summary.issuesBySeverity['MEDIUM']} |`);
  if (summary.issuesBySeverity['LOW']) lines.push(`| ${s.metricLowSeverity} | ${summary.issuesBySeverity['LOW']} |`);
  lines.push('');

  if (issues.length === 0) {
    lines.push(s.noIssues);
    return lines.join('\n');
  }

  // Issues
  lines.push(s.sectionIssues);
  lines.push('');

  for (let i = 0; i < issues.length; i++) {
    lines.push(...renderIssue(issues[i], i + 1));
    lines.push('');
  }

  // Hibernate statistics
  if (hibernateStatistics && hibernateStatistics.rawLines.length > 0) {
    lines.push(s.sectionStatistics);
    lines.push('');
    lines.push('```');
    lines.push(...hibernateStatistics.rawLines);
    lines.push('```');
    lines.push('');
  }

  // Top queries
  if (topQueries.length > 0) {
    lines.push(s.sectionTopQueries);
    lines.push('');
    lines.push(`| # | ${s.colExecutions} | ${s.colAvgTime} | ${s.colQuery} |`);
    lines.push('|---|-----------|---------------|-------|');
    for (let i = 0; i < Math.min(topQueries.length, 10); i++) {
      const q = topQueries[i];
      const shortSql = q.normalizedSql.length > 80
        ? q.normalizedSql.slice(0, 77) + '...'
        : q.normalizedSql;
      lines.push(`| ${i + 1} | ${q.executions.length} | ${Math.round(q.avgExecutionTimeMs)} | \`${shortSql}\` |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderIssue(issue: Issue, index: number): string[] {
  const s = t().report;
  const lines: string[] = [];
  lines.push(`### ${index}. ${severityIcon(issue.severity)} ${issue.type.replace(/_/g, ' ')} — ${issue.severity}`);
  lines.push('');
  lines.push(`${s.labelDescription} ${issue.description}`);
  lines.push('');

  // Type-specific fields: one renderer per issue type (returns the extra bullet lines).
  const typeFieldRenderers: Partial<Record<Issue['type'], (issue: Issue) => string[]>> = {
    N_PLUS_1: (i) => {
      const n1 = i as NPlusOneIssue;
      const out = [
        `- ${s.labelExecutions} ${n1.executions}`,
        `- ${s.labelExtraQueries} ${n1.estimatedExtraQueries}`,
      ];
      if (n1.parentQuery) out.push(`- ${s.labelTriggeredAfter} \`${n1.parentQuery}\``);
      return out;
    },
    DUPLICATE_QUERY: (i) => [`- ${s.labelExecutions} ${(i as DuplicateQueryIssue).executions}`],
    LARGE_RESULT_SET: (i) => [`- ${s.labelTotalRows} ${(i as LargeResultSetIssue).rows.toLocaleString()}`],
    SLOW_QUERY: (i) => {
      const sq = i as SlowQueryIssue;
      const out = [`- ${s.labelMaxExecTime} ${sq.executionTimeMs}ms`];
      if (!sq.isPatternBased && sq.executionTimeMs > 0) {
        out.push(`- ${t().detectors.slowQuery.timingDetected(sq.executionTimeMs)}`);
      }
      return out;
    },
    POSSIBLE_CARTESIAN_PRODUCT: (i) => [`- ${s.labelJoinCount} ${(i as PossibleCartesianProductIssue).joinCount}`],
    OVER_FETCHING: (i) => [`- ${s.labelExecutions} ${(i as OverFetchingIssue).executions}`],
    DEADLOCK: (i) => {
      const dl = i as DeadlockIssue;
      const out = [`- **Occurrences:** ${dl.occurrences}`];
      if (dl.queries && dl.queries.length > 0) {
        out.push(`- ${t().detectors.deadlock.queriesLabel}`);
        for (const q of dl.queries) out.push(`  - \`${q}\``);
      } else {
        out.push(`- ${t().detectors.deadlock.queryNotFound}`);
      }
      return out;
    },
  };

  lines.push(...(typeFieldRenderers[issue.type]?.(issue) ?? []));

  lines.push('');

  if (issue.query) {
    lines.push(s.labelNormalizedQuery);
    lines.push('```sql');
    lines.push(issue.query);
    lines.push('```');
    lines.push('');
  }

  if (issue.evidence.length > 0) {
    lines.push(s.labelEvidence);
    lines.push('```sql');
    for (const e of issue.evidence) lines.push(e);
    lines.push('```');
    lines.push('');
  }

  lines.push(s.labelRecommendation);
  lines.push(`> ${issue.recommendation}`);

  return lines;
}
