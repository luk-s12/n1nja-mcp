/**
 * Shared helpers for the Java static-analysis scanners.
 *
 * These existed as near-duplicate copies in usage-scanner and call-chain-tracer
 * with slightly different regexes; this module is the single deliberate version.
 */

/** Spring architectural layer a source file belongs to. */
export type Layer = 'controller' | 'service' | 'repository' | 'other';

/**
 * Classifies a Java file by Spring layer, using annotations first and the
 * file path as a fallback. Union of the criteria previously used by
 * usage-scanner (path substrings) and call-chain-tracer (@Component,
 * explicit Spring Data base interfaces).
 */
export function detectLayer(content: string, filePath: string): Layer {
  if (/@RestController\b|@Controller\b/.test(content) || filePath.includes('Controller')) return 'controller';
  if (/@Service\b|@Component\b/.test(content) || filePath.includes('Service')) return 'service';
  if (/@Repository\b|extends\s+.*Repository/.test(content) || filePath.includes('Repository')) return 'repository';
  return 'other';
}

/**
 * Scans backwards from `lineIndex` for the nearest Java method signature and
 * returns its name, or `fallback` when none is found above the line.
 */
export function findEnclosingMethod(lines: string[], lineIndex: number, fallback = 'unknown'): string {
  for (let i = lineIndex; i >= 0; i--) {
    const match = lines[i].match(
      /(?:public|private|protected|default)\s+[\w<>?,\s[\]]+\s+(\w+)\s*\(/,
    );
    if (match) return match[1];
  }
  return fallback;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
