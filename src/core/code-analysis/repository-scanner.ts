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
  /** True when the @Query declares nativeQuery = true (raw SQL, not JPQL). */
  isNative: boolean;
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
        const annotation = collectAnnotationText(lines, i);

        // The method signature is either inline after the closing paren
        // (`@Query("...") List<X> foo();`) or on one of the following lines.
        const inlineRest = lines[annotation.endLineIndex].slice(annotation.endOffset + 1);
        let methodLineIndex: number;
        let signatureText: string;
        if (isMethodSignature(inlineRest)) {
          methodLineIndex = annotation.endLineIndex;
          signatureText = inlineRest;
        } else {
          methodLineIndex = findMethodSignature(lines, annotation.endLineIndex + 1);
          signatureText = methodLineIndex >= 0 ? lines[methodLineIndex] : '';
        }

        if (methodLineIndex >= 0) {
          const snippet = buildSnippet(lines, i);
          const queryText = extractQueryValue(annotation.text);
          usages.push({
            filePath,
            relativeFilePath: src.relativeFilePath,
            repositoryName,
            methodName: extractMethodName(signatureText) ?? 'unknown',
            lineNumber: methodLineIndex + 1,
            codeLine: signatureText.trim(),
            codeSnippet: snippet.snippet,
            snippetStartLine: snippet.startLine,
            snippetEndLine: snippet.endLine,
            queryText,
            isNative: /nativeQuery\s*=\s*true/.test(annotation.text),
            isJoinFetch: /join\s+fetch/i.test(queryText ?? line),
            kind: 'query_annotation',
          });
        }
        // Skip past the annotation so a multi-line query body is not re-scanned.
        i = Math.max(i, annotation.endLineIndex);
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
        isNative: false,
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

// ── @Query annotation parsing ────────────────────────────────────────────────

interface AnnotationText {
  /** Full annotation text, from `@Query` through its closing paren. */
  text: string;
  /** Line index (0-based) where the annotation's closing paren sits. */
  endLineIndex: number;
  /** Offset of the closing paren within that line. */
  endOffset: number;
}

/** Max lines an annotation may span before extraction gives up (degrades safely). */
const MAX_ANNOTATION_LINES = 40;

/**
 * Collects the complete `@Query(...)` text starting at `startLineIndex`,
 * tracking paren balance while skipping string literals (including `"""`
 * text blocks), so multi-line and concatenated queries are captured whole.
 */
function collectAnnotationText(lines: string[], startLineIndex: number): AnnotationText {
  const windowEnd = Math.min(lines.length, startLineIndex + MAX_ANNOTATION_LINES);
  const joined = lines.slice(startLineIndex, windowEnd).join('\n');
  const at = Math.max(0, joined.search(/@Query\b/));

  let i = at;
  let depth = 0;
  let started = false;
  let end = joined.length - 1;
  while (i < joined.length) {
    const ch = joined[i];
    if (ch === '"') {
      i = skipStringLiteral(joined, i);
      continue;
    }
    if (ch === '(') {
      depth++;
      started = true;
    } else if (ch === ')') {
      depth--;
      if (started && depth === 0) {
        end = i;
        break;
      }
    }
    i++;
  }

  const consumed = joined.slice(0, end + 1).split('\n');
  return {
    text: joined.slice(at, end + 1),
    endLineIndex: startLineIndex + consumed.length - 1,
    endOffset: consumed[consumed.length - 1].length - 1,
  };
}

/** Index right after the string literal starting at `start` (a `"` or `"""`). */
function skipStringLiteral(s: string, start: number): number {
  if (s.startsWith('"""', start)) {
    const close = s.indexOf('"""', start + 3);
    return close === -1 ? s.length : close + 3;
  }
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '"') return i + 1;
    else i++;
  }
  return s.length;
}

/**
 * Extracts the query string from the annotation text: the `value =` attribute
 * when present, otherwise the first positional string. Handles `+`
 * concatenation of literals and `"""` text blocks. Queries built from
 * identifiers/constants cannot be resolved statically and yield undefined
 * (or a partial text that simply won't fingerprint-match).
 */
function extractQueryValue(annotation: string): string | undefined {
  const valueAttr = annotation.match(/\bvalue\s*=/);
  let pos: number;
  if (valueAttr && valueAttr.index !== undefined) {
    pos = valueAttr.index + valueAttr[0].length;
  } else {
    const open = annotation.indexOf('(');
    if (open === -1) return undefined;
    pos = open + 1;
  }

  const parts: string[] = [];
  for (;;) {
    while (pos < annotation.length && /\s/.test(annotation[pos])) pos++;
    if (!annotation.startsWith('"', pos)) break;
    const literal = readStringLiteral(annotation, pos);
    parts.push(literal.value);
    pos = literal.end;
    while (pos < annotation.length && /\s/.test(annotation[pos])) pos++;
    if (annotation[pos] === '+') pos++;
    else break;
  }

  if (parts.length === 0) return undefined;
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Reads the literal starting at `start` and returns its unescaped content. */
function readStringLiteral(s: string, start: number): { value: string; end: number } {
  if (s.startsWith('"""', start)) {
    const close = s.indexOf('"""', start + 3);
    return {
      value: close === -1 ? s.slice(start + 3) : s.slice(start + 3, close),
      end: close === -1 ? s.length : close + 3,
    };
  }
  let i = start + 1;
  let out = '';
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return { value: out, end: i + 1 };
}

// ── Method signature detection ───────────────────────────────────────────────

const COLLECTION_SIGNATURE = /\b(?:List|Set|Collection|Page|Slice|Optional|Iterable)<[^>]+>\s+\w+\s*\(/i;

/** Declaration-looking line: modifiers? + return type + name + `(`. */
const GENERIC_SIGNATURE = /^(?:(?:public|protected|private|default|static|final|abstract|synchronized)\s+)*[\w$][\w$.<>,[\]\s?]*\s+\w+\s*\(/;

function isMethodSignature(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('//') || trimmed.startsWith('*')) {
    return false;
  }
  return COLLECTION_SIGNATURE.test(trimmed) || GENERIC_SIGNATURE.test(trimmed);
}

function findMethodSignature(lines: string[], startIndex: number): number {
  const windowEnd = Math.min(lines.length, startIndex + 8);
  // Collection-typed signatures first (the historical behavior), then any
  // declaration-looking line — native queries often return scalars or Object[].
  for (let i = startIndex; i < windowEnd; i++) {
    if (COLLECTION_SIGNATURE.test(lines[i])) return i;
  }
  for (let i = startIndex; i < windowEnd; i++) {
    if (isMethodSignature(lines[i])) return i;
  }
  return -1;
}
