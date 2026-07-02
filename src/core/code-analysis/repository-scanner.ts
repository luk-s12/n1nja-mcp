import { getJavaSources } from './source-cache';

export interface RepositoryUsage {
  filePath: string;
  relativeFilePath: string;
  repositoryName: string;
  methodName: string;
  lineNumber: number;
  codeLine: string;
  codeSnippet: string[];
  snippetStartLine: number;
  snippetEndLine: number;
  queryText?: string;
  isJoinFetch: boolean;
  kind: 'query_annotation' | 'derived_method';
}

const REPOSITORY_ANNOTATION = /@Repository\b/;
const QUERY_ANNOTATION = /@Query\s*\(/i;
const REPOSITORY_FILE = /Repository\.java$/;

export function scanRepositoryUsages(projectRoot: string): RepositoryUsage[] {
  const usages: RepositoryUsage[] = [];

  for (const src of getJavaSources(projectRoot)) {
    const { filePath, lines } = src;
    if (!REPOSITORY_ANNOTATION.test(src.content) && !REPOSITORY_FILE.test(filePath)) continue;

    const repositoryName = src.className;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (QUERY_ANNOTATION.test(line)) {
        const methodLineIndex = findMethodSignature(lines, i + 1);
        if (methodLineIndex >= 0) {
          const snippet = buildSnippet(lines, i);
          const queryText = extractQueryText(lines.slice(i, Math.min(lines.length, i + 4)).join(' '));
          usages.push({
            filePath,
            relativeFilePath: src.relativeFilePath,
            repositoryName,
            methodName: extractMethodName(lines[methodLineIndex]) ?? 'unknown',
            lineNumber: methodLineIndex + 1,
            codeLine: lines[methodLineIndex].trim(),
            codeSnippet: snippet.snippet,
            snippetStartLine: snippet.startLine,
            snippetEndLine: snippet.endLine,
            queryText,
            isJoinFetch: /join\s+fetch/i.test(queryText ?? line),
            kind: 'query_annotation',
          });
        }
        continue;
      }

      const methodMatch = line.match(/\b(?:List|Set|Collection|Page|Slice|Optional|Iterable)<[^>]+>\s+(find|read|get|query|count|exists|delete|remove)\w*\s*\(/i);
      if (!methodMatch) continue;

      const methodName = extractMethodName(line);
      if (!methodName) continue;

      const snippet = buildSnippet(lines, i);
      usages.push({
        filePath,
        relativeFilePath: src.relativeFilePath,
        repositoryName,
        methodName,
        lineNumber: i + 1,
        codeLine: line.trim(),
        codeSnippet: snippet.snippet,
        snippetStartLine: snippet.startLine,
        snippetEndLine: snippet.endLine,
        isJoinFetch: /join\s+fetch/i.test(line),
        kind: 'derived_method',
      });
    }
  }

  usages.sort((a, b) => {
    if (a.isJoinFetch !== b.isJoinFetch) return a.isJoinFetch ? 1 : -1;
    if (a.relativeFilePath !== b.relativeFilePath) return a.relativeFilePath.localeCompare(b.relativeFilePath);
    return a.lineNumber - b.lineNumber;
  });

  return usages;
}

function buildSnippet(lines: string[], lineIndex: number): { snippet: string[]; startLine: number; endLine: number } {
  const radius = 2;
  const startIndex = Math.max(0, lineIndex - radius);
  const endIndex = Math.min(lines.length, lineIndex + radius + 1);
  return {
    snippet: lines.slice(startIndex, endIndex).map((snippetLine) => snippetLine.replace(/\t/g, '  ')),
    startLine: startIndex + 1,
    endLine: endIndex,
  };
}

function extractMethodName(line: string): string | undefined {
  const match = line.match(/\b(\w+)\s*\(/);
  return match ? match[1] : undefined;
}

function extractQueryText(text: string): string | undefined {
  const match = text.match(/@Query\s*\(\s*(["'])([\s\S]*?)\1/);
  return match ? match[2].replace(/\s+/g, ' ').trim() : undefined;
}

function findMethodSignature(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 8); i++) {
    if (/\b(?:List|Set|Collection|Page|Slice|Optional|Iterable)<[^>]+>\s+\w+\s*\(/i.test(lines[i])) {
      return i;
    }
  }
  return -1;
}
