import * as fs from 'fs';
import * as path from 'path';
import { analyzeHibernateLog } from './analyze-log.tool';
import { analyzeProjectForNPlusOne } from '../../../core/code-analysis/project-analyzer';
import { buildCombinedReport } from '../../../core/reporting/combined-report';
import { DetectorConfig } from '../../../domain/models/config.model';

export interface GenerateReportInput {
  /** Path to the Hibernate log file. Defaults to logs/application.log */
  logFile?: string;
  /** Root of the Spring Boot project. Defaults to process.cwd() */
  projectRoot?: string;
  /** Where to write the .md file. Defaults to ./doc/n1nja-report_{timestamp}.md */
  outputFile?: string;
  config?: Partial<DetectorConfig>;
}

export interface GenerateReportOutput {
  reportPath: string;
  totalQueries: number;
  issuesFound: number;
  findingsWithCode: number;
  markdownReport: string;
}

// ---------------------------------------------------------------------------

const DEFAULT_LOG_FILE = 'logs/application.log';

function buildTimestampedOutputPath(outputFile?: string): string {
  if (outputFile) return path.resolve(outputFile);
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19); // e.g. 2026-06-20_14-35-00
  const dir = path.resolve('report');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `n1nja-report_${ts}.md`);
}

export async function generateN1Report(input: GenerateReportInput): Promise<GenerateReportOutput> {
  const {
    logFile = DEFAULT_LOG_FILE,
    projectRoot = process.cwd(),
    outputFile,
    config,
  } = input;

  // ── Step 1: parse the log ────────────────────────────────────────────────
  process.stderr.write(`🥷 [full_scan] Parsing log: ${path.basename(logFile)}\n`);
  const logResult = await analyzeHibernateLog({ logFile, config, projectRoot });

  // ── Step 2: scan source code ─────────────────────────────────────────────
  process.stderr.write(`🥷 [full_scan] Scanning project: ${path.basename(projectRoot)}\n`);
  let projectResult = null;
  try {
    projectResult = analyzeProjectForNPlusOne(projectRoot, logResult.jsonReport);
  } catch (err) {
    process.stderr.write(`⚠️  Project scan failed: ${err}\n`);
  }

  // ── Step 3: render combined markdown (presentation lives in core) ─────────
  const markdown = buildCombinedReport(logFile, logResult.jsonReport, projectResult);

  // ── Step 4: write to disk ────────────────────────────────────────────────
  const outputPath = buildTimestampedOutputPath(outputFile);
  fs.writeFileSync(outputPath, markdown, 'utf8');
  process.stderr.write(`✅ Report saved to: ${outputPath}\n`);

  return {
    reportPath: outputPath,
    totalQueries: logResult.summary.totalQueries,
    issuesFound: logResult.summary.detectedIssues,
    findingsWithCode: projectResult?.findings.filter((f) => f.usages.length > 0).length ?? 0,
    markdownReport: markdown,
  };
}
