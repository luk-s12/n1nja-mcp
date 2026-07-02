import { loadDbConfig } from '../../../infrastructure/db/db-config';
import { getDbClient } from '../../../infrastructure/db/db-connector';
import { runExplain } from '../../../infrastructure/db/explain-runner';
import { analyzeExplainPlan, ExplainAnalysisResult } from '../../../infrastructure/db/explain-analyzer';
import { getLastReport } from './analyze-log.tool';

export interface ExplainQueryInput {
  /**
   * Raw SQL to explain. If omitted, the tool will take the top N+1 queries
   * from the last analysis report and explain them automatically.
   */
  sql?: string;
  /**
   * When sql is omitted, how many top queries from the report to explain.
   * Default: 3
   */
  maxQueriesToExplain?: number;
  /** Explicit .env file path with DB_* credentials (overrides ambient env vars). */
  envFile?: string;
  /**
   * Spring Boot project root — when credentials are not in the environment,
   * they are read from its application.properties/yml (spring.datasource.*).
   */
  projectRoot?: string;
}

export interface ExplainQueryOutput {
  results: ExplainAnalysisResult[];
  markdownReport: string;
}

/**
 * Tool handler: explain_query
 *
 * Two modes:
 *  1. Manual: user provides a SQL string → run EXPLAIN on it
 *  2. Automatic: no SQL provided → take top N+1/slow queries from the last
 *     report and run EXPLAIN on all of them
 */
export async function explainQuery(input: ExplainQueryInput): Promise<ExplainQueryOutput> {
  process.stderr.write(`🥷 Connecting to database...\n`);
  const config = loadDbConfig({ envFile: input.envFile, projectRoot: input.projectRoot });
  const client = await getDbClient(config);
  process.stderr.write(`✴️  Connected to ${config.type} @ ${config.host} [credentials: ${config.source}]\n`);

  const queriesToExplain: string[] = [];

  if (input.sql) {
    queriesToExplain.push(input.sql);
  } else {
    // Pull top queries from the last analysis report
    const report = getLastReport();
    if (!report) {
      throw new Error(
        'No analysis report found. Run analyze_hibernate_log first, or provide a sql parameter.',
      );
    }

    const topN = input.maxQueriesToExplain ?? 3;

    // Prioritize N+1 and slow query issues — those are most actionable
    const priorityIssues = report.issues
      .filter((i) => i.type === 'N_PLUS_1' || i.type === 'SLOW_QUERY' || i.type === 'MISSING_PAGINATION')
      .slice(0, topN);

    // Fall back to top queries by execution count
    if (priorityIssues.length === 0) {
      report.topQueries
        .slice(0, topN)
        .forEach((q) => queriesToExplain.push(q.executions[0]?.rawSql ?? q.normalizedSql));
    } else {
      priorityIssues.forEach((issue) => {
        // Use first evidence line (raw SQL) — it has actual parameter values for ANALYZE
        const rawSql = issue.evidence?.[0] ?? issue.query;
        queriesToExplain.push(rawSql);
      });
    }
  }

  if (queriesToExplain.length === 0) {
    throw new Error('No queries to explain. Provide a sql parameter or run analyze_hibernate_log first.');
  }

  const results: ExplainAnalysisResult[] = [];

  for (let i = 0; i < queriesToExplain.length; i++) {
    const sql = queriesToExplain[i];
    process.stderr.write(`✴️  EXPLAIN query ${i + 1}/${queriesToExplain.length}...\n`);
    const plan = await runExplain(client, sql);
    const analysis = analyzeExplainPlan(sql, plan);
    results.push(analysis);
  }
  process.stderr.write(`✅ EXPLAIN analysis complete — ${results.reduce((s, r) => s + r.issues.length, 0)} plan issue(s) found\n`);

  const markdownReport = buildCombinedMarkdown(results);

  return { results, markdownReport };
}

function buildCombinedMarkdown(results: ExplainAnalysisResult[]): string {
  const lines: string[] = [];

  lines.push('# Query Execution Plan Analysis');
  lines.push('');

  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const highIssues = results.reduce(
    (sum, r) => sum + r.issues.filter((i) => i.severity === 'HIGH').length,
    0,
  );

  lines.push(`**Queries analyzed:** ${results.length}`);
  lines.push(`**Total issues found:** ${totalIssues} (${highIssues} HIGH)`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    lines.push(`---`);
    lines.push('');
    lines.push(`### Query ${i + 1} of ${results.length}`);
    lines.push('');
    lines.push(results[i].markdownReport);
    lines.push('');
  }

  return lines.join('\n');
}
