import * as fs from 'fs';
import * as path from 'path';
import { findJavaFiles } from './java-file-walker';

/**
 * A Java source file loaded once per analysis run and shared by every
 * code-analysis scanner. Holding `lines` here lets scanners (and the
 * method-range memoization in usage-scanner) key off the same array instance.
 */
export interface JavaSource {
  filePath: string;
  /** Path relative to the project root, with forward slashes */
  relativeFilePath: string;
  /** File name without the .java extension */
  className: string;
  content: string;
  lines: string[];
}

const cacheByRoot = new Map<string, JavaSource[]>();

/**
 * Returns every `.java` source under `projectRoot`, reading each file from
 * disk at most once per analysis run. Unreadable files are skipped.
 */
export function getJavaSources(projectRoot: string): JavaSource[] {
  const key = path.resolve(projectRoot);
  const cached = cacheByRoot.get(key);
  if (cached) return cached;

  const sources: JavaSource[] = [];
  for (const filePath of findJavaFiles(projectRoot)) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    sources.push({
      filePath,
      relativeFilePath: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      className: path.basename(filePath, '.java'),
      content,
      lines: content.split('\n'),
    });
  }

  cacheByRoot.set(key, sources);
  return sources;
}

/**
 * Drops all cached sources. Called at the start of each analysis entry point
 * so edits made to the project between runs are always picked up.
 */
export function clearJavaSourceCache(): void {
  cacheByRoot.clear();
}
