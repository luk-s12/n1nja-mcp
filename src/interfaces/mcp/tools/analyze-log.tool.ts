import * as path from 'path';
import * as fs from 'fs';
import { parseLogFile } from '../../../core/parsing/log-parser';
import { detectAllIssues } from '../../../core/detection/issue-detector';
import { buildReport } from '../../../core/reporting/report-generator';
import { toMarkdown } from '../../../core/reporting/markdown-reporter';
import { AnalysisReport } from '../../../domain/models/report.model';
import { DetectorConfig, DEFAULT_CONFIG } from '../../../domain/models/config.model';
import { detectDeadlocks } from '../../../core/detection/deadlock.detector';
import { clearJavaSourceCache } from '../../../core/code-analysis/source-cache';

// In-memory store for the last generated report
let lastReport: AnalysisReport | null = null;

export function getLastReport(): AnalysisReport | null {
  return lastReport;
}

export interface AnalyzeLogInput {
  logFile: string;
  config?: Partial<DetectorConfig>;
  /** Spring Boot project root — enables source-aware detectors (e.g. column-level over-fetching) */
  projectRoot?: string;
}

export interface AnalyzeLogOutput {
  summary: {
    totalQueries: number;
    uniqueNormalizedQueries: number;
    detectedIssues: number;
    issuesByType: Record<string, number>;
    issuesBySeverity: Record<string, number>;
    linesProcessed: number;
    totalExecutionTimeMs: number;
  };
  issues: AnalysisReport['issues'];
  markdownReport: string;
  jsonReport: AnalysisReport;
}

/**
 * Tool handler: analyze_hibernate_log
 *
 * Reads the log file line-by-line (memory-efficient), detects issues,
 * and returns both a structured JSON report and a human-readable Markdown report.
 */
export async function analyzeHibernateLog(input: AnalyzeLogInput): Promise<AnalyzeLogOutput> {
  const { logFile, config: configOverride, projectRoot } = input;
  const config: DetectorConfig = { ...DEFAULT_CONFIG, ...configOverride };

  const resolvedPath = path.resolve(logFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Log file not found: ${resolvedPath}`);
  }

  const startedAt = new Date().toISOString();

  // Source-aware detectors read project files — start each run with a fresh cache.
  clearJavaSourceCache();

  process.stderr.write(`🥷 Parsing log file: ${path.basename(resolvedPath)}\n`);
  const { queries, statistics, linesProcessed } = await parseLogFile(resolvedPath);
  process.stderr.write(`✴️  ${linesProcessed} lines processed — ${queries.length} queries found\n`);

  process.stderr.write(`✴️  Running detectors...\n`);
  const detection = detectAllIssues(queries, statistics, config, projectRoot);

  // Deadlock detection requires scanning raw log lines for error patterns
  process.stderr.write(`✴️  Scanning for deadlocks / lock timeouts...\n`);
  const deadlockIssues = await detectDeadlocks(resolvedPath);
  if (deadlockIssues.length > 0) {
    detection.issues.push(...deadlockIssues);
  }

  process.stderr.write(`✅ ${detection.issues.length} issue(s) detected\n`);

  const report = buildReport({
    logFile: resolvedPath,
    linesProcessed,
    totalQueries: queries.length,
    startedAt,
    detection,
    statistics,
  });

  // Cache for show_report
  lastReport = report;

  const markdownReport = toMarkdown(report);

  return {
    summary: {
      totalQueries: report.summary.totalQueries,
      uniqueNormalizedQueries: report.summary.uniqueNormalizedQueries,
      detectedIssues: report.summary.detectedIssues,
      issuesByType: report.summary.issuesByType,
      issuesBySeverity: report.summary.issuesBySeverity,
      linesProcessed: report.summary.linesProcessed,
      totalExecutionTimeMs: report.summary.totalExecutionTimeMs,
    },
    issues: report.issues,
    markdownReport,
    jsonReport: report,
  };
}
