import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves where a tool's .md report goes: the explicit `outputFile` when
 * given, otherwise report/{prefix}_{timestamp}.md so each run writes a new
 * file. Shared by full_scan and static_scan.
 */
export function buildTimestampedReportPath(prefix: string, outputFile?: string): string {
  if (outputFile) return path.resolve(outputFile);
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19); // e.g. 2026-06-20_14-35-00
  return path.join(path.resolve('report'), `${prefix}_${ts}.md`);
}

/** Writes `markdown` to the resolved path (creating parent dirs) and returns it. */
export function writeMarkdownReport(prefix: string, markdown: string, outputFile?: string): string {
  const outputPath = buildTimestampedReportPath(prefix, outputFile);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, 'utf8');
  return outputPath;
}
