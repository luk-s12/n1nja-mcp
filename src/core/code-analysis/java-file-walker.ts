import * as fs from 'fs';
import * as path from 'path';

/**
 * Directories that never contain production JPA/Spring source worth scanning.
 * Shared by every code-analysis scanner so the skip list stays consistent.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  '.idea',
  'test',
]);

/**
 * Recursively collects every `.java` file under `dir`, skipping {@link SKIP_DIRS}.
 * Returns an empty array if `dir` does not exist.
 */
export function findJavaFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...findJavaFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.java')) {
      results.push(fullPath);
    }
  }

  return results;
}
