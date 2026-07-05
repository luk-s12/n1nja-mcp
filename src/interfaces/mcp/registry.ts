import { z } from 'zod';

import { analyzeHibernateLog, getLastReport } from './tools/analyze-log.tool';
import { watchHibernateLog } from './tools/watch-log.tool';
import { explainQuery } from './tools/explain-query.tool';
import { generateN1Report } from './tools/generate-report.tool';
import { findMissingIndexes } from './tools/find-missing-indexes.tool';
import { dbTopQueries } from './tools/db-top-queries.tool';
import { writeMarkdownReport } from './tools/report-path';
import { analyzeProjectForNPlusOne } from '../../core/code-analysis/project-analyzer';
import { detectProject, buildNotApplicableMarkdown } from '../../core/code-analysis/project-detector';
import { setupLogging, undoLogging } from '../../core/setup/logging-configurator';
import { runStaticScan } from '../../core/static-analysis/static-scanner';
import { toMarkdown } from '../../core/reporting/markdown-reporter';
import { toPdf } from '../../core/reporting/pdf-reporter';

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** A single MCP tool: schema (Zod) validates input; run executes the use case. */
export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<ToolResult> | ToolResult;
}

/** Identity helper so each tool's `run` input is inferred from its Zod schema. */
function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const text = (s: string): { type: 'text'; text: string } => ({ type: 'text', text: s });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const configSchema = z
  .object({
    nPlusOneThreshold: z.number().optional().describe('Min executions across the whole log to flag N+1 (default: 10).'),
    nPlusOnePerRequestThreshold: z.number().optional().describe('Min executions with distinct params in the same request/thread to flag N+1 (default: 3).'),
    duplicateQueryThreshold: z.number().optional().describe('Min executions to flag DUPLICATE_QUERY (default: 2).'),
    largeResultThreshold: z.number().optional().describe('Row count threshold for LARGE_RESULT_SET (default: 1000).'),
    slowQueryMs: z.number().optional().describe('Execution time threshold in ms for SLOW_QUERY (default: 500).'),
    cartesianJoinThreshold: z.number().optional().describe('Min JOINs to warn about cartesian product (default: 2).'),
  })
  .optional()
  .describe('Optional detection thresholds override.');

const envFileSchema = z
  .string()
  .optional()
  .describe(
    'Path to a .env file containing the DB_* credentials. ' +
      'Use this when the .env lives in your Spring project instead of the MCP working directory.',
  );

const dbProjectRootSchema = z
  .string()
  .optional()
  .describe(
    'Spring Boot project root. When DB credentials are not found in the environment, ' +
      'they are read from its src/main/resources/application.properties|yml ' +
      '(spring.datasource.url/username/password). Defaults to the current working directory.',
  );

const forceSchema = z
  .boolean()
  .optional()
  .describe(
    'Skip the project-type check and run anyway. By default, projects with no JPA/Hibernate ' +
      '(reactive WebFlux/MongoDB services, Python/Node lambdas, …) are detected and skipped.',
  );

/** "Not applicable" result shared by full_scan and autoconfig. */
function notApplicableResult(
  projectRoot: string,
  toolName: string,
): ToolResult | null {
  const detection = detectProject(projectRoot);
  if (detection.applicable) return null;
  return {
    content: [
      json({ skipped: true, reason: 'not-applicable', kind: detection.kind, signals: detection.signals }),
      text('\n\n---\n\n' + buildNotApplicableMarkdown(detection, toolName)),
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const analyzeHibernateLogTool = defineTool({
  name: 'analyze_hibernate_log',
  description:
    'Analyzes a Hibernate/JPA log file to detect N+1 queries, duplicate queries, ' +
    'missing pagination, large result sets, slow queries, and possible cartesian products. ' +
    'Returns a structured JSON report plus a human-readable Markdown report. ' +
    'If logFile is omitted, defaults to logs/application.log (the path set by the recommended ' +
    'Spring Boot config: logging.file.name=logs/application.log).',
  schema: z.object({
    logFile: z
      .string()
      .optional()
      .describe(
        'Absolute or relative path to the Spring Boot application log file. ' +
          'Defaults to logs/application.log.',
      ),
    config: configSchema,
  }),
  run: async ({ logFile = 'logs/application.log', config }) => {
    const result = await analyzeHibernateLog({ logFile, config });
    return {
      content: [
        json({ summary: result.summary, issues: result.issues }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

const monitorLogTool = defineTool({
  name: 'monitor_log',
  description:
    'Starts (or stops) real-time monitoring of a Hibernate/JPA log file by tailing it. ' +
    'While watching, queries are accumulated in memory and all detectors run live. ' +
    'Use show_report to view accumulated results after exercising the application. ' +
    'If no logFile is provided, defaults to logs/application.log — the path set by the recommended Spring Boot config ' +
    '(logging.file.name=logs/application.log). ' +
    'If no action is provided, defaults to start.',
  schema: z.object({
    logFile: z
      .string()
      .optional()
      .describe(
        'Absolute or relative path to the log file to watch. ' +
          'Defaults to logs/application.log (Spring Boot recommended config).',
      ),
    action: z
      .enum(['start', 'stop', 'status'])
      .optional()
      .describe("Action to perform. Defaults to 'start'."),
  }),
  run: ({ logFile, action }) => {
    const result = watchHibernateLog({ logFile, action });
    return { content: [json(result)] };
  },
});

const showReportTool = defineTool({
  name: 'show_report',
  description:
    'Returns the most recently generated analysis report. ' +
    'The report is created by analyze_hibernate_log or by the monitor_log accumulation. ' +
    "Use format 'pdf' to render the report to a .pdf file on disk (via the system Edge/Chrome) " +
    'and return its path.',
  schema: z.object({
    format: z
      .enum(['json', 'markdown', 'both', 'pdf'])
      .optional()
      .describe("Output format: 'json' (default), 'markdown', 'both', or 'pdf'."),
  }),
  run: async ({ format = 'both' }) => {
    const report = getLastReport();
    if (!report) {
      return { content: [text('No report available yet. Run analyze_hibernate_log first.')] };
    }
    if (format === 'pdf') {
      const pdfPath = await toPdf(report);
      return { content: [text(`✅ PDF report saved to: ${pdfPath}`)] };
    }
    const content: ToolResult['content'] = [];
    if (format === 'json' || format === 'both') content.push(json(report));
    if (format === 'markdown' || format === 'both') content.push(text(toMarkdown(report)));
    return { content };
  },
});

const findN1InCodeTool = defineTool({
  name: 'find_n1_in_code',
  description:
    'Given an existing analysis report, scans the Spring Boot project source code ' +
    '(JPA entities, repositories, services, controllers) to locate the exact source of each ' +
    'detected issue and proposes the most appropriate fix: JOIN FETCH, @EntityGraph, ' +
    'DTO Projection, or Batch Fetching. ' +
    'Must be called after analyze_hibernate_log has been run at least once. ' +
    'If projectRoot is omitted, defaults to the current working directory.',
  schema: z.object({
    projectRoot: z
      .string()
      .optional()
      .describe(
        'Absolute path to the root of the Spring Boot project (where src/main/java is). ' +
          'Defaults to the current working directory.',
      ),
  }),
  run: ({ projectRoot = process.cwd() }) => {
    const report = getLastReport();
    if (!report) {
      return {
        content: [
          text(
            'No analysis report found. Please run analyze_hibernate_log first to generate a report, ' +
              'then call find_n1_in_code.',
          ),
        ],
      };
    }
    const result = analyzeProjectForNPlusOne(projectRoot, report);
    return {
      content: [
        json({
          projectRoot: result.projectRoot,
          analyzedAt: result.analyzedAt,
          entitiesScanned: result.entitiesScanned,
          findingsCount: result.findingsCount,
          findings: result.findings.map((f) => ({
            issueType: f.issue.type,
            severity: f.issue.severity,
            suspectedEntity: f.suspectedEntity?.className,
            suspectedField: f.suspectedField,
            usageCount: f.usages.length,
            usagesInLoops: f.usages.filter((u) => u.isInsideLoop).length,
            topUsages: f.usages.slice(0, 3).map((u) => ({
              file: u.relativeFilePath,
              line: u.lineNumber,
              method: u.methodName,
              isInsideLoop: u.isInsideLoop,
            })),
            recommendedFix: f.fixes[0]?.strategy,
            allFixes: f.fixes.map((fx) => fx.strategy),
          })),
        }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

const fullScanTool = defineTool({
  name: 'full_scan',
  description:
    'All-in-one command: parses the Hibernate log, scans the Spring Boot project source code, ' +
    'cross-references SQL patterns with the exact Java files and methods that cause them, ' +
    'and writes a detailed .md report to disk with copy-paste ready fix code ' +
    '(JOIN FETCH, @EntityGraph, @BatchSize, @Cacheable, etc.). ' +
    'Use this as your first step — it replaces running analyze_hibernate_log and find_n1_in_code separately. ' +
    'If logFile is omitted, defaults to logs/application.log (Spring Boot recommended config: logging.file.name=logs/application.log). ' +
    'If projectRoot is omitted, defaults to the current working directory. ' +
    'Each run writes a new timestamped file: report/n1nja-report_{timestamp}.md. ' +
    'If the project does not use JPA/Hibernate (reactive WebFlux/MongoDB service, Python/Node lambda, …) ' +
    "the scan is skipped with a 'not applicable' report; pass force: true to run anyway.",
  schema: z.object({
    logFile: z.string().optional().describe('Path to the Hibernate log file. Defaults to logs/application.log.'),
    projectRoot: z
      .string()
      .optional()
      .describe('Root of the Spring Boot project (where src/main/java is). Defaults to current working directory.'),
    outputFile: z
      .string()
      .optional()
      .describe('Custom output path for the .md report. Defaults to report/n1nja-report_{timestamp}.md'),
    config: configSchema,
    force: forceSchema,
  }),
  run: async ({ logFile, projectRoot = process.cwd(), outputFile, config, force }) => {
    if (!force) {
      const skipped = notApplicableResult(projectRoot, 'full_scan');
      if (skipped) return skipped;
    }
    const result = await generateN1Report({ logFile, projectRoot, outputFile, config });
    return {
      content: [
        json({
          reportPath: result.reportPath,
          totalQueries: result.totalQueries,
          issuesFound: result.issuesFound,
          findingsWithCode: result.findingsWithCode,
        }),
        text(`\n\n✅ Report saved to: ${result.reportPath}\n\n---\n\n` + result.markdownReport),
      ],
    };
  },
});

const explainSqlTool = defineTool({
  name: 'explain_sql',
  description:
    'Runs EXPLAIN ANALYZE on one or more queries and analyzes the execution plan. ' +
    'Detects sequential scans, missing indexes, high-cost operations, filesorts, ' +
    'nested loops on large tables, and rows removed by filter. ' +
    'If no sql is provided, automatically explains the top N+1 and slow queries ' +
    'from the last analyze_hibernate_log report. ' +
    'DB credentials are resolved from: the envFile parameter, the DB_* environment variables ' +
    '(or a .env in the working directory), or the Spring project application.properties/yml ' +
    '(spring.datasource.*) under projectRoot.',
  schema: z.object({
    sql: z
      .string()
      .optional()
      .describe('Raw SQL query to explain. If omitted, the top queries from the last report are used.'),
    maxQueriesToExplain: z
      .number()
      .optional()
      .describe('When sql is omitted, how many top queries from the report to explain. Default: 3.'),
    envFile: envFileSchema,
    projectRoot: dbProjectRootSchema,
  }),
  run: async ({ sql, maxQueriesToExplain, envFile, projectRoot }) => {
    const result = await explainQuery({ sql, maxQueriesToExplain, envFile, projectRoot });
    return {
      content: [
        json({ queriesExplained: result.results.length }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

const findMissingIndexesTool = defineTool({
  name: 'find_missing_indexes',
  description:
    'Connects to the database and cross-references the WHERE / JOIN ON / ORDER BY columns ' +
    'found in recent queries against the existing index catalog. ' +
    'Reports columns that are queried frequently but have no index, ' +
    'and generates ready-to-run CREATE INDEX statements. ' +
    'If DB credentials are missing or the connection fails, shows exactly how to provide them. ' +
    'Run analyze_hibernate_log or full_scan first to populate the query list. ' +
    'DB credentials are resolved from: the envFile parameter, the DB_* environment variables ' +
    '(or a .env in the working directory), or the Spring project application.properties/yml ' +
    '(spring.datasource.*) under projectRoot.',
  schema: z.object({
    envFile: envFileSchema,
    projectRoot: dbProjectRootSchema,
  }),
  run: async ({ envFile, projectRoot }) => {
    const result = await findMissingIndexes({ envFile, projectRoot });
    return {
      content: [
        json({
          connected: result.connected,
          dbType: result.dbType,
          dbHost: result.dbHost,
          dbName: result.dbName,
          queriesAnalyzed: result.queriesAnalyzed,
          missingIndexesCount: result.missingIndexes.length,
          missingIndexes: result.missingIndexes.map((m) => ({
            table: m.table,
            column: m.column,
            usageCount: m.usageCount,
            suggestedSql: `CREATE INDEX idx_${m.table}_${m.column} ON ${m.table}(${m.column});`,
          })),
        }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

const setupLoggingTool = defineTool({
  name: 'autoconfig',
  description:
    'Auto-configures the logging N1nja needs to capture Hibernate/JPA SQL, adapting to the project. ' +
    'Detects whether the project ships a custom Logback config (logback-spring.xml / logback.xml): ' +
    'if so, it edits that XML (adding a file appender → logs/application.log, the Hibernate loggers, ' +
    'and the <root> appender-ref), because Spring Boot ignores the logging.* properties when Logback is present. ' +
    'Otherwise it adds the logging.file.name + logging.level.* properties to application.properties/yml — ' +
    'the base file and every application-{profile} variant. ' +
    'If no config exists at all, it creates src/main/resources/application.properties. ' +
    'It reuses a custom encoder/layout (e.g. a PII-masking layout) when one is found, and is idempotent. ' +
    'Files are written in place. Run this before full_scan. ' +
    "Use action 'undo' to revert every change autoconfig made (before committing your repo): " +
    'injected blocks are marker-delimited, so undo removes exactly what was added. ' +
    'If the project imports Spring Cloud Config (configserver:), the report warns that dev/prod ' +
    'levels may come from the central config repo and suggests LOGGING_LEVEL_* env vars as a ' +
    'non-invasive alternative. ' +
    'If the project does not use JPA/Hibernate (reactive WebFlux/MongoDB service, Python/Node lambda, …) ' +
    "nothing is configured and a 'not applicable' report is returned; pass force: true to configure anyway. " +
    'If projectRoot is omitted, defaults to the current working directory.',
  schema: z.object({
    projectRoot: z
      .string()
      .optional()
      .describe(
        'Absolute path to the root of the Spring Boot project (where src/main/resources is). ' +
          'Defaults to the current working directory.',
      ),
    action: z
      .enum(['apply', 'undo'])
      .optional()
      .describe("'apply' (default) configures the logging; 'undo' reverts every N1nja change."),
    force: forceSchema,
  }),
  run: ({ projectRoot = process.cwd(), action = 'apply', force }) => {
    if (action === 'undo') {
      const result = undoLogging(projectRoot);
      return {
        content: [
          json({
            action: 'undo',
            changes: result.changes.map((c) => ({ file: c.file, action: c.action, notes: c.notes })),
          }),
          text('\n\n---\n\n' + result.markdownReport),
        ],
      };
    }
    if (!force) {
      const skipped = notApplicableResult(projectRoot, 'autoconfig');
      if (skipped) return skipped;
    }
    const result = setupLogging(projectRoot);
    return {
      content: [
        json({
          scenario: result.scenario,
          logFile: result.logFile,
          configServerFiles: result.configServerFiles,
          changes: result.changes.map((c) => ({
            file: c.file,
            action: c.action,
            notes: c.notes,
          })),
        }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

const staticScanTool = defineTool({
  name: 'static_scan',
  description:
    'Audits a Spring Boot / JPA project WITHOUT needing logs or a running app: ' +
    'scans the Java sources and config for anti-patterns that cause N+1 queries and slow writes — ' +
    'EAGER collections, @ManyToMany, multiple JOIN FETCH in one query, unbounded findAll(), ' +
    'saveAll() without hibernate.jdbc.batch_size, and read methods missing @Transactional(readOnly = true). ' +
    'Fleet mode: if projectRoot is a folder of microservices (no src/main/java itself, but its ' +
    'subdirectories have one), every project is scanned and ranked worst-first. ' +
    'Use this as the zero-friction first step; then enable logging and run full_scan on the worst offenders. ' +
    'Each run also writes the markdown report to disk: report/n1nja-static-scan_{timestamp}.md ' +
    '(override the path with outputFile).',
  schema: z.object({
    projectRoot: z
      .string()
      .optional()
      .describe(
        'A Spring Boot project root (where src/main/java is), or a folder containing several ' +
          'such projects (fleet mode). Defaults to the current working directory.',
      ),
    maxFindingsPerProject: z
      .number()
      .optional()
      .describe('Cap of findings reported per project, most severe first. Default: 50.'),
    outputFile: z
      .string()
      .optional()
      .describe('Custom output path for the .md report. Defaults to report/n1nja-static-scan_{timestamp}.md'),
  }),
  run: ({ projectRoot = process.cwd(), maxFindingsPerProject, outputFile }) => {
    const result = runStaticScan(projectRoot, { maxFindingsPerProject });
    const reportPath = writeMarkdownReport('n1nja-static-scan', result.markdownReport, outputFile);
    return {
      content: [
        json({
          reportPath,
          mode: result.mode,
          scannedRoot: result.scannedRoot,
          projects: result.projects.map((p) => ({
            project: p.projectName,
            score: p.score,
            entitiesScanned: p.entitiesScanned,
            javaFilesScanned: p.javaFilesScanned,
            countsByType: p.countsByType,
            findings: p.findings.map((f) => ({
              type: f.type,
              severity: f.severity,
              location: `${f.file}:${f.line}`,
              detail: f.detail,
            })),
          })),
        }),
        text(`\n\n✅ Report saved to: ${reportPath}\n\n---\n\n` + result.markdownReport),
      ],
    };
  },
});

const dbTopQueriesTool = defineTool({
  name: 'db_top_queries',
  description:
    "Reads the database's own statement statistics (MySQL performance_schema digest summary, " +
    'or PostgreSQL pg_stat_statements) and returns the most expensive queries with REAL ' +
    'server-side timing: total/avg time, rows examined vs sent, and full-scan counts. ' +
    'Needs NO application logging — use it when Hibernate SQL logging is off or as ground truth ' +
    'to complement the log analysis. ' +
    "Use reset: true to zero the counters, exercise a specific flow, then call again to measure only that flow. " +
    'DB credentials are resolved from: the envFile parameter, the DB_* environment variables ' +
    '(or a .env in the working directory), or the Spring project application.properties/yml ' +
    '(spring.datasource.*) under projectRoot.',
  schema: z.object({
    envFile: envFileSchema,
    projectRoot: dbProjectRootSchema,
    limit: z.number().optional().describe('How many queries to return. Default: 20.'),
    orderBy: z
      .enum(['total_time', 'avg_time', 'calls', 'rows_examined'])
      .optional()
      .describe("Ranking metric. Default: 'total_time'."),
    minCalls: z.number().optional().describe('Ignore statements executed fewer times than this. Default: 1.'),
    reset: z
      .boolean()
      .optional()
      .describe('Reset the server-side statistics instead of reading them (measure a specific flow).'),
  }),
  run: async ({ envFile, projectRoot, limit, orderBy, minCalls, reset }) => {
    const result = await dbTopQueries({ envFile, projectRoot, limit, orderBy, minCalls, reset });
    return {
      content: [
        json({
          dbType: result.dbType,
          dbHost: result.dbHost,
          dbName: result.dbName,
          orderBy: result.orderBy,
          statsReset: result.statsReset ?? false,
          queriesReturned: result.queries.length,
          queries: result.queries,
        }),
        text('\n\n---\n\n' + result.markdownReport),
      ],
    };
  },
});

export const tools: ToolDef[] = [
  analyzeHibernateLogTool,
  monitorLogTool,
  showReportTool,
  findN1InCodeTool,
  fullScanTool,
  explainSqlTool,
  findMissingIndexesTool,
  setupLoggingTool,
  staticScanTool,
  dbTopQueriesTool,
];
