import { Issue } from './issue.model';
import { HibernateStatistics, QueryGroup } from './query.model';

/**
 * Summary statistics for the analysis report
 */
export interface ReportSummary {
  totalQueries: number;
  uniqueNormalizedQueries: number;
  detectedIssues: number;
  issuesByType: Record<string, number>;
  issuesBySeverity: Record<string, number>;
  totalExecutionTimeMs: number;
  analysisStartedAt: string;
  analysisCompletedAt: string;
  logFile: string;
  linesProcessed: number;
}

/**
 * Full structured report
 */
export interface AnalysisReport {
  summary: ReportSummary;
  issues: Issue[];
  hibernateStatistics?: HibernateStatistics;
  topQueries: QueryGroup[];
}

/**
 * Lightweight status returned by watch_hibernate_log
 */
export interface WatchStatus {
  status: 'watching' | 'stopped' | 'error';
  logFile: string;
  startedAt: string;
  linesProcessed: number;
  queriesFound: number;
  message?: string;
}
