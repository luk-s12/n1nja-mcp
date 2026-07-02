import * as path from 'path';
import { AnalysisReport } from '../../domain/models/report.model';
import {
  ProjectAnalysisResult,
  ProjectFinding,
} from '../code-analysis/project-analyzer';
import { strategyLabel } from '../code-analysis/fix-suggester';
import { t, getLanguage } from '../../shared/i18n';
import { severityIcon } from '../../shared/severity';
import { Severity } from '../../domain/models/issue.model';

/**
 * Renders the combined full-scan report (log analysis + source-code findings)
 * as a Markdown string. Pure presentation: no I/O, no orchestration.
 */
export function buildCombinedReport(
  logFile: string,
  report: AnalysisReport,
  projectResult: ProjectAnalysisResult | null,
): string {
  const s = t().generateReport;
  const locale = getLanguage() === 'es' ? 'es-AR' : 'en-US';
  const now = new Date().toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short' });
  const { summary, issues } = report;

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(s.title);
  lines.push(``);
  lines.push(`> ${s.labelGenerated} ${now}  `);
  lines.push(`> ${s.labelLogFile} \`${path.basename(logFile)}\`  `);
  lines.push(`> ${s.labelLinesProcessed} ${summary.linesProcessed.toLocaleString()}  `);
  lines.push(`> ${s.labelAnalysisTime} ${summary.totalExecutionTimeMs} ms`);
  lines.push(``);
  lines.push(`---`);

  // ── Summary table ─────────────────────────────────────────────────────────
  lines.push(s.sectionSummary);
  lines.push(``);
  lines.push(`| ${s.colMetric} | ${s.colValue} |`);
  lines.push(`|--------|-------|`);
  lines.push(`| ${s.metricTotalQueries} | **${summary.totalQueries}** |`);
  lines.push(`| ${s.metricUniquePatterns} | ${summary.uniqueNormalizedQueries} |`);
  lines.push(`| ${s.metricIssuesFound} | **${summary.detectedIssues}** |`);

  const bySeverity = summary.issuesBySeverity ?? {};
  for (const sev of ['HIGH', 'MEDIUM', 'LOW'] as Severity[]) {
    if (bySeverity[sev]) {
      lines.push(`| ${severityIcon(sev)} ${sev} | ${bySeverity[sev]} |`);
    }
  }

  const byType = summary.issuesByType ?? {};
  lines.push(``);
  lines.push(s.issueTypes);
  for (const [type, count] of Object.entries(byType)) {
    lines.push(`- \`${type}\` — ${count}`);
  }

  lines.push(``);
  lines.push(`---`);

  // ── Per-issue sections ────────────────────────────────────────────────────
  lines.push(s.sectionIssues);
  lines.push(``);

  if (issues.length === 0) {
    lines.push(s.noIssues);
  }

  for (let idx = 0; idx < issues.length; idx++) {
    const issue = issues[idx];
    const emoji = severityIcon(issue.severity);

    // Find the matching project finding (if code scan ran)
    const finding: ProjectFinding | undefined = projectResult?.findings.find(
      (f) => f.issue.type === issue.type && f.issue.query === issue.query,
    );

    lines.push(`### ${emoji} Issue ${idx + 1}: \`${issue.type}\``);
    lines.push(``);
    lines.push(`${s.labelSeverity} ${issue.severity}  `);
    lines.push(`**${issue.description}**`);
    lines.push(``);

    // SQL pattern
    if (issue.query) {
      lines.push(s.labelSqlPattern);
      lines.push(` \`\`\`sql`);
      lines.push(` ${issue.query}`);
      lines.push(` \`\`\``);
      lines.push(``);
    }

    // Occurrences (executions field for N+1, DUPLICATE_QUERY and OVER_FETCHING)
    const executions = 'executions' in issue ? issue.executions : undefined;
    if (executions !== undefined) {
      lines.push(`${s.labelOccurrences} ${executions}×`);
      lines.push(``);
    }

    // Evidence: raw SQL samples from the log
    if (issue.evidence?.length) {
      lines.push(`<details><summary>${s.labelEvidence(issue.evidence.length)}</summary>`);
      lines.push(``);
      lines.push(`\`\`\`sql`);
      for (const e of issue.evidence.slice(0, 5)) {
        lines.push(e);
      }
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }

    // ── Code location (from project scan) ───────────────────────────────────
    if (finding) {
      if (finding.suspectedEntity) {
        lines.push(`${s.labelEntity} \`${finding.suspectedEntity.className}\``);
        if (finding.suspectedField) {
          lines.push(` ${s.labelField} \`${finding.suspectedField}\``);
        }
        lines.push(``);
      }

      if (finding.usages.length > 0) {
        // Collapse usages that resolve to the same code snippet (e.g. several
        // log lines from the same method) so we don't print the block twice.
        const dedupeBySnippet = (list: typeof finding.usages) => {
          const seen = new Set<string>();
          return list.filter((u) => {
            const key = `${u.filePath}:${u.snippetStartLine}-${u.snippetEndLine}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };
        // Collapse usages that point to the same method (keeps one row per method).
        const dedupeByMethod = (list: typeof finding.usages) => {
          const seen = new Set<string>();
          return list.filter((u) => {
            const key = `${u.filePath}:${u.methodName}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };

        const originLabel = finding.originConfidence === 'confirmed'
          ? s.labelOriginCode
          : s.labelSuggestedOriginCode;
        lines.push(originLabel);
        lines.push(``);
        lines.push(`| ${s.colFile} | ${s.colLine} | ${s.colMethod} | ${s.colInLoop} |`);
        lines.push(`|------|------|--------|---------|`);
        for (const u of dedupeByMethod(finding.usages).slice(0, 6)) {
          const loopFlag = u.isInsideLoop ? '⚠️ Si' : 'No';
          const fileName = path.basename(u.filePath);
          lines.push(`| \`${fileName}\` | ${u.lineNumber} | \`${u.methodName}()\` | ${loopFlag} |`);
        }
        lines.push(``);

        // Show the actual problematic code lines
        const loopUsages = dedupeBySnippet(finding.usages.filter((u) => u.isInsideLoop));
        if (loopUsages.length > 0) {
          lines.push(`> ${s.loopWarning(loopUsages.length)}`);
          lines.push(``);
          lines.push(`\`\`\`java`);
          for (const u of loopUsages.slice(0, 3)) {
            lines.push(`// ${path.basename(u.filePath)}:${u.snippetStartLine}-${u.snippetEndLine} - ${u.methodName}()`);
            for (const snippetLine of u.codeSnippet) {
              lines.push(snippetLine);
            }
            lines.push('');
          }
          lines.push(`\`\`\``);
          lines.push(``);
        } else if (finding.usages.length > 0) {
          const label = s.codeLabel[issue.type] ?? s.codeLabelDefault;
          lines.push(`> ${label}`);
          lines.push(``);
          lines.push(`\`\`\`java`);
          for (const u of dedupeBySnippet(finding.usages).slice(0, 2)) {
            lines.push(`// ${path.basename(u.filePath)}:${u.snippetStartLine}-${u.snippetEndLine} — ${u.methodName}()`);
            for (const snippetLine of u.codeSnippet) {
              lines.push(snippetLine);
            }
            lines.push('');
          }
          lines.push(`\`\`\``);
          lines.push(``);
        }
      } else {
        lines.push(s.noCodeLocation);
        lines.push(``);
      }

      // ── Call chain (request flow) ────────────────────────────────────────
      if (finding.callChains && finding.callChains.length > 0) {
        lines.push(s.flowSection);
        lines.push(``);

        for (const chain of finding.callChains.slice(0, 4)) {
          if (chain.steps.length === 0) continue;

          lines.push(`\`\`\``);

          // Entry point line
          const entry = chain.steps[0];
          if (entry.httpVerb && entry.httpPath) {
            lines.push(`${entry.httpVerb} ${entry.httpPath}`);
          }

          // Each step in the chain
          for (let si = 0; si < chain.steps.length; si++) {
            const step = chain.steps[si];
            const indent = '  '.repeat(si + 1);
            const layerTag = step.layer !== 'other' ? ` [${step.layer}]` : '';
            lines.push(`${indent}-> ${step.className}.${step.methodName}()${layerTag}  (${step.relativeFilePath}:${step.lineNumber})`);
          }

          // Trigger (the usage that fires the query)
          if (finding.usages.length > 0) {
            const u = finding.usages[0];
            const indent = '  '.repeat(chain.steps.length + 1);
            const triggerLabel = s.triggerLabel[issue.type] ?? s.triggerLabelDefault;
            lines.push(`${indent}-> ${u.codeLine.trim()}  <-- ${triggerLabel}`);
          }

          lines.push(`\`\`\``);
          lines.push(``);
        }
      }

      // ── Fix suggestions ──────────────────────────────────────────────────
      if (finding.fixes.length > 0) {
        lines.push(s.labelFixOptions);
        lines.push(``);
        for (let fi = 0; fi < finding.fixes.length; fi++) {
          const fix = finding.fixes[fi];
          const label = fi === 0 ? ` ${s.labelRecommended}` : '';
          lines.push(`#### Fix ${fi + 1}: ${strategyLabel(fix.strategy)}${label}`);
          lines.push(``);
          lines.push(fix.description);
          lines.push(``);
          lines.push(`\`\`\`java`);
          lines.push(fix.codeExample);
          lines.push(`\`\`\``);
          lines.push(``);
        }
      }

      // ── Timing hint for pattern-based slow queries ───────────────────────
      if (issue.type === 'SLOW_QUERY' && issue.isPatternBased) {
        const TIMING_IN_LOG = /(?:completed in\s+|elapsed[:\s]+|took\s+|duration[:\s]+|Time[:\s]+)\d+\s*ms/i;
        const timingAlreadyLogged = issue.threadContextLines?.some((l) => TIMING_IN_LOG.test(l));
        if (!timingAlreadyLogged) {
          const td = t().detectors.slowQueryPattern;
          lines.push(`> ${td.timingHint}`);
          lines.push(``);
          if (finding.usages.length > 0) {
            const u = finding.usages[0];
            lines.push(`> ${td.timingHintMethod(path.basename(u.filePath), u.methodName)}`);
            lines.push(``);
          }
          lines.push(`\`\`\`java`);
          lines.push(`long start = System.currentTimeMillis();`);
          lines.push(``);
          lines.push(`// ... tu llamada al repositorio aqui ...`);
          lines.push(``);
          lines.push(`long elapsed = System.currentTimeMillis() - start;`);
          lines.push(`log.warn("Query completed in {}ms", elapsed);`);
          lines.push(`\`\`\``);
          lines.push(``);
        }
      } else if (issue.type === 'SLOW_QUERY' && issue.executionTimeMs > 0) {
        const td = t().detectors.slowQuery;
        lines.push(`> ${td.timingDetected(issue.executionTimeMs)}`);
        lines.push(``);
      }
    } else if (issue.recommendation) {
      lines.push(s.labelSuggestedFix);
      lines.push(``);
      lines.push(`> ${issue.recommendation}`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  // ── Project scan summary ─────────────────────────────────────────────────
  if (projectResult) {
    lines.push(s.sectionProjectScan);
    lines.push(``);
    lines.push(`| ${s.colMetric} | ${s.colValue} |`);
    lines.push(`|--------|-------|`);
    lines.push(`| ${s.metricEntitiesScanned} | ${projectResult.entitiesScanned} |`);
    lines.push(`| ${s.metricFindingsWithCode} | ${projectResult.findings.filter((f) => f.usages.length > 0).length} |`);
    lines.push(``);
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(``);
  lines.push(s.footer);
  lines.push(``);

  return lines.join('\n');
}

