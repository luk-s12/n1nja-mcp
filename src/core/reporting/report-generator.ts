import { AnalysisReport, ReportSummary } from '../../domain/models/report.model';
import { HibernateStatistics } from '../../domain/models/query.model';
import { DetectionResult } from '../detection/issue-detector';

/**
 * Builds an AnalysisReport from detection results and metadata.
 */
export function buildReport(params: {
  logFile: string;
  linesProcessed: number;
  totalQueries: number;
  startedAt: string;
  detection: DetectionResult;
  statistics: HibernateStatistics;
}): AnalysisReport {
  const { logFile, linesProcessed, totalQueries, startedAt, detection, statistics } = params;

  const issuesByType: Record<string, number> = {};
  const issuesBySeverity: Record<string, number> = {};

  for (const issue of detection.issues) {
    issuesByType[issue.type] = (issuesByType[issue.type] ?? 0) + 1;
    issuesBySeverity[issue.severity] = (issuesBySeverity[issue.severity] ?? 0) + 1;
  }

  const totalExecutionTimeMs = [...detection.queryGroups.values()].reduce(
    (sum, g) => sum + g.totalExecutionTimeMs,
    0,
  );

  const summary: ReportSummary = {
    totalQueries,
    uniqueNormalizedQueries: detection.queryGroups.size,
    detectedIssues: detection.issues.length,
    issuesByType,
    issuesBySeverity,
    totalExecutionTimeMs,
    analysisStartedAt: startedAt,
    analysisCompletedAt: new Date().toISOString(),
    logFile,
    linesProcessed,
  };

  return {
    summary,
    issues: detection.issues,
    hibernateStatistics: statistics.rawLines.length > 0 ? statistics : undefined,
    topQueries: detection.topQueries,
  };
}
