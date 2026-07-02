import * as fs from 'fs';
import { getJavaSources, JavaSource } from './source-cache';
import { Layer, detectLayer, findEnclosingMethod, capitalize } from './java-utils';

export interface AssociationUsage {
  filePath: string;
  relativeFilePath: string;
  className: string;
  methodName: string;
  lineNumber: number;
  codeLine: string;
  /** Surrounding source fragment for report rendering */
  codeSnippet: string[];
  snippetStartLine: number;
  snippetEndLine: number;
  isInsideLoop: boolean;
  layer: Layer;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Expands tabs and returns lines[startIndex..endIndex] (0-based, inclusive). */
function makeSnippet(lines: string[], startIndex: number, endIndex: number): string[] {
  return lines.slice(startIndex, endIndex + 1).map((l) => l.replace(/\t/g, '  '));
}

interface UsageOverrides {
  methodName?: string;
  isInsideLoop?: boolean;
}

/**
 * Builds an AssociationUsage from a cached source file. Snippet bounds are
 * 0-based inclusive. Method name and loop detection default to scanning the
 * lines around `lineIndex` unless overridden.
 */
function buildUsage(
  src: JavaSource,
  layer: AssociationUsage['layer'],
  lineIndex: number,
  snippetStart: number,
  snippetEnd: number,
  overrides: UsageOverrides = {},
): AssociationUsage {
  return {
    filePath: src.filePath,
    relativeFilePath: src.relativeFilePath,
    className: src.className,
    methodName: overrides.methodName ?? findEnclosingMethod(src.lines, lineIndex),
    lineNumber: lineIndex + 1,
    codeLine: src.lines[lineIndex]?.trim() ?? '',
    codeSnippet: makeSnippet(src.lines, snippetStart, snippetEnd),
    snippetStartLine: snippetStart + 1,
    snippetEndLine: snippetEnd + 1,
    isInsideLoop: overrides.isInsideLoop ?? isInsideLoopContext(src.lines, lineIndex),
    layer,
  };
}

/**
 * Snippet bounds covering the enclosing method (capped at `cap` lines), or a
 * small window around the line when no enclosing method is found.
 */
function methodSnippetBounds(
  lines: string[],
  lineIndex: number,
  cap: number,
  radiusBefore: number,
  radiusAfter: number,
): { start: number; end: number } {
  const range = findEnclosingMethodRange(lines, lineIndex);
  if (range) {
    return { start: range.startLine, end: Math.min(range.endLine, range.startLine + cap) };
  }
  return {
    start: Math.max(0, lineIndex - radiusBefore),
    end: Math.min(lines.length - 1, lineIndex + radiusAfter),
  };
}

function isInsideLoopContext(lines: string[], lineIndex: number): boolean {
  // Check within the past 20 lines for a loop construct
  const contextStart = Math.max(0, lineIndex - 20);
  const context = lines.slice(contextStart, lineIndex).join('\n');
  return /\b(for|while|forEach|stream\s*\(|\.map\s*\(|\.filter\s*\(|\.forEach\s*\()\b/.test(context);
}

// ---------------------------------------------------------------------------
// Java method-range extraction (memoized per file)
// ---------------------------------------------------------------------------

interface MethodRange {
  name: string;
  startLine: number; // 0-based index into lines array
  endLine: number;
}

// Cached sources share their `lines` array across scanners, so ranges are
// computed once per file per analysis run instead of once per usage.
const methodRangesCache = new WeakMap<string[], MethodRange[]>();

function getMethodRanges(lines: string[]): MethodRange[] {
  let ranges = methodRangesCache.get(lines);
  if (!ranges) {
    ranges = extractJavaMethodRanges(lines);
    methodRangesCache.set(lines, ranges);
  }
  return ranges;
}

/**
 * Extracts method body ranges from a Java source file using brace tracking.
 * Handles generic return types like `Map<String, Object>`.
 */
function extractJavaMethodRanges(lines: string[]): MethodRange[] {
  const methods: MethodRange[] = [];
  // Matches method declarations with any return type (including generics with spaces/commas)
  const METHOD_SIG = /\b(?:public|private|protected)\b[^(]*\b(\w+)\s*\([^)]*\)\s*(?:throws[^{]*)?\s*\{/;
  const SKIP_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'try', 'catch', 'else', 'synchronized', 'finally']);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(METHOD_SIG);
    if (!m) continue;
    const methodName = m[1];
    if (SKIP_KEYWORDS.has(methodName)) continue;

    // Track braces to find the closing } of this method
    let depth = 0;
    let endLine = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endLine = j; break; }
        }
      }
      if (depth === 0) break;
    }

    methods.push({ name: methodName, startLine: i, endLine });
  }

  return methods;
}

/**
 * Returns the MethodRange that contains `lineIndex`, or null if not found.
 */
function findEnclosingMethodRange(lines: string[], lineIndex: number): MethodRange | null {
  for (const m of getMethodRanges(lines)) {
    if (lineIndex >= m.startLine && lineIndex <= m.endLine) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Association usage scanner
// ---------------------------------------------------------------------------

/**
 * Scans Java source files for accesses to a specific entity's association field,
 * which are potential sources of N+1 queries.
 */
export function scanAssociationUsages(
  projectRoot: string,
  entityName: string,
  fieldName: string,
): AssociationUsage[] {
  const usages: AssociationUsage[] = [];

  // Pattern: entity.getFieldName() or variable.getFieldName()
  const accessPattern = new RegExp(`\\.get${capitalize(fieldName)}\\s*\\(`);
  const directPattern = new RegExp(`\\.${fieldName}\\b`);

  for (const src of getJavaSources(projectRoot)) {
    // Skip if the entity is not mentioned in this file
    if (!src.content.includes(entityName) && !src.content.includes(fieldName)) continue;

    const layer = detectLayer(src.content, src.filePath);
    if (layer === 'repository') continue;

    for (let i = 0; i < src.lines.length; i++) {
      const line = src.lines[i];
      if (!accessPattern.test(line) && !directPattern.test(line)) continue;

      // Skip constructor/setter assignments: `this.field = ...` — not a lazy-load trigger
      if (/\bthis\.\w+\s*=\s*/.test(line) && !accessPattern.test(line)) continue;

      const snippetRadius = 2;
      const snippetStart = Math.max(0, i - snippetRadius);
      const snippetEnd = Math.min(src.lines.length - 1, i + snippetRadius);
      usages.push(buildUsage(src, layer, i, snippetStart, snippetEnd));
    }
  }

  usages.sort((a, b) => {
    if (a.isInsideLoop !== b.isInsideLoop) return a.isInsideLoop ? -1 : 1;
    const layerOrder: Record<AssociationUsage['layer'], number> = {
      controller: 0,
      service: 1,
      repository: 2,
      other: 3,
    };
    if (layerOrder[a.layer] !== layerOrder[b.layer]) {
      return layerOrder[a.layer] - layerOrder[b.layer];
    }
    return a.relativeFilePath.localeCompare(b.relativeFilePath) || a.lineNumber - b.lineNumber;
  });

  return usages;
}

// ---------------------------------------------------------------------------
// Duplicate repository call scanner
// ---------------------------------------------------------------------------

/**
 * Scans service/controller files for methods that call the same repository
 * method multiple times for the same entity — the root cause of DUPLICATE_QUERY.
 *
 * Example: customerRepository.findById(id) called 3× in getDuplicateQueries()
 */
// Repository methods that are NOT entity reads — repeated calls are fine (write batches, guard checks, logging)
const NON_FETCH_METHOD = /^(?:save|saveAll|delete|deleteAll|deleteById|deleteAllById|flush|count|exists|existsById|getFlushMode|clear|evict)\w*/i;

export function scanDuplicateRepositoryCalls(
  projectRoot: string,
  entityName: string,
): AssociationUsage[] {
  const results: AssociationUsage[] = [];
  const entityLower = entityName.toLowerCase();

  for (const src of getJavaSources(projectRoot)) {
    const layer = detectLayer(src.content, src.filePath);
    if (layer === 'repository') continue;

    const repoFields = extractRepoFieldsForEntity(src.content, entityLower);
    if (repoFields.length === 0) continue;

    const callPatterns = repoFields.map((f) => new RegExp(`\\b${f}\\.(\\w+)\\s*\\(`, 'g'));

    for (const method of getMethodRanges(src.lines)) {
      const callTally = new Map<string, number[]>(); // key → absolute 1-based line numbers

      for (let i = method.startLine; i <= method.endLine && i < src.lines.length; i++) {
        const line = src.lines[i];
        for (let f = 0; f < repoFields.length; f++) {
          const callRe = callPatterns[f];
          callRe.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = callRe.exec(line)) !== null) {
            const repoMethodName = m[1];
            // Skip write operations and aggregates — these are not "duplicate query" problems
            if (NON_FETCH_METHOD.test(repoMethodName)) continue;
            const key = `${repoFields[f]}.${repoMethodName}`;
            if (!callTally.has(key)) callTally.set(key, []);
            callTally.get(key)!.push(i + 1);
          }
        }
      }

      for (const [, lineNums] of callTally) {
        if (lineNums.length < 2) continue;

        // Show the whole method body (capped at 60 lines for readability)
        const snippetStart = method.startLine;
        const snippetEnd = Math.min(method.endLine, method.startLine + 60);
        results.push(
          buildUsage(src, layer, lineNums[0] - 1, snippetStart, snippetEnd, {
            methodName: method.name,
            isInsideLoop: false,
          }),
        );
      }
    }
  }

  return results;
}

/**
 * Finds repository field names injected into a class that correspond to the given entity.
 * Matches: `private final CustomerRepository customerRepository;`
 */
function extractRepoFieldsForEntity(content: string, entityNameLower: string): string[] {
  const fields: string[] = [];
  const pattern = /(?:private|protected|public)\s+(?:final\s+)?(\w+(?:Repository|Repo|DAO|Dao))\s+(\w+)\s*[;=]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (m[1].toLowerCase().includes(entityNameLower)) {
      fields.push(m[2]);
    }
  }
  return [...new Set(fields)];
}

// ---------------------------------------------------------------------------
// Missing pagination scanner
// ---------------------------------------------------------------------------

/**
 * Scans service/controller files for calls to repository methods that return
 * a full collection of the entity without a Pageable/PageRequest argument.
 *
 * Detects patterns like:
 *   List<Order> all = orderRepository.findAll();
 *   List<Order> all = orderRepository.findAllOrders();
 *
 * Excludes calls that pass a Pageable / PageRequest (already paginated).
 */
export function scanUnpaginatedRepositoryCalls(
  projectRoot: string,
  entityName: string,
): AssociationUsage[] {
  const results: AssociationUsage[] = [];
  const entityLower = entityName.toLowerCase();

  for (const src of getJavaSources(projectRoot)) {
    const layer = detectLayer(src.content, src.filePath);
    if (layer === 'repository') continue;

    const repoFields = extractRepoFieldsForEntity(src.content, entityLower);
    if (repoFields.length === 0) continue;

    for (let i = 0; i < src.lines.length; i++) {
      const line = src.lines[i];

      for (const repoField of repoFields) {
        // Match: repoField.findAll() or repoField.findAllXxx()
        const callRe = new RegExp(`\\b${repoField}\\.(findAll\\w*)\\s*\\(([^)]*)\\)`, 'g');
        let m: RegExpExecArray | null;

        while ((m = callRe.exec(line)) !== null) {
          const args = m[2].trim();

          // Skip if Pageable/PageRequest is passed — already paginated
          if (/\bPageable\b|\bPageRequest\b|\bpage\b|\bpageable\b/i.test(args)) continue;

          // Skip if result is assigned to Page<> or Slice<> — already paginated
          const prevLines = src.lines.slice(Math.max(0, i - 1), i + 1).join('\n');
          if (/\bPage<|\bSlice</.test(prevLines)) continue;

          const bounds = methodSnippetBounds(src.lines, i, 40, 3, 3);
          results.push(buildUsage(src, layer, i, bounds.start, bounds.end));
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cartesian JPQL scanner
// ---------------------------------------------------------------------------

export interface CartesianJpqlUsage {
  filePath: string;
  relativeFilePath: string;
  className: string;
  methodName: string;
  lineNumber: number;
  jpqlQuery: string;
  joinFetchCount: number;
  codeSnippet: string[];
  snippetStartLine: number;
  snippetEndLine: number;
}

/**
 * Scans repository interfaces for @Query methods with 2+ JOIN FETCH on sibling
 * collections — the JPQL-level root cause of Cartesian product SQL.
 *
 * Example problematic JPQL:
 *   SELECT c FROM Customer c JOIN FETCH c.orders JOIN FETCH c.tags WHERE c.id = :id
 */
export function scanCartesianJpqlUsages(
  projectRoot: string,
  entityName?: string,
): CartesianJpqlUsage[] {
  const results: CartesianJpqlUsage[] = [];

  for (const src of getJavaSources(projectRoot)) {
    const layer = detectLayer(src.content, src.filePath);
    if (layer !== 'repository') continue;

    if (entityName && !src.content.toLowerCase().includes(entityName.toLowerCase())) continue;

    const lines = src.lines;

    for (let i = 0; i < lines.length; i++) {
      if (!/@Query\s*\(/i.test(lines[i])) continue;

      // Collect the full @Query block (may span multiple lines with triple-quotes)
      let queryBlock = '';
      let blockEnd = i;
      let depth = 0;
      for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        queryBlock += ' ' + lines[j];
        for (const ch of lines[j]) {
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) { blockEnd = j; break; }
          }
        }
        if (depth === 0) break;
      }

      // Extract the JPQL string value
      const jpqlMatch =
        queryBlock.match(/@Query\s*\(\s*(?:value\s*=\s*)?["']{1,3}(.+?)["']{1,3}\s*(?:,|\))/s)
        ?? queryBlock.match(/["'](.+?)["']/s);
      if (!jpqlMatch) continue;

      const jpql = jpqlMatch[1].replace(/\s+/g, ' ').trim();
      const joinFetchCount = (jpql.match(/\bjoin\s+fetch\b/gi) ?? []).length;
      if (joinFetchCount < 2) continue;

      // Find the method name from the signature that follows the annotation
      let methodName = 'unknown';
      for (let j = blockEnd + 1; j < Math.min(blockEnd + 6, lines.length); j++) {
        const mMatch =
          lines[j].match(/(?:Optional|List|Collection|Set|Page|Slice)\s*<[\w<>, ]+>\s+(\w+)\s*\(/)
          ?? lines[j].match(/\b(\w+)\s*\(@Param/);
        if (mMatch) { methodName = mMatch[1]; break; }
        const simple = lines[j].match(/\s+(\w+)\s*\(/);
        if (simple && !['if', 'for', 'while', 'switch', 'try', 'catch'].includes(simple[1])) {
          methodName = simple[1];
          break;
        }
      }

      const snippetStart = Math.max(0, i - 1);
      const snippetEnd = Math.min(lines.length - 1, blockEnd + 3);

      results.push({
        filePath: src.filePath,
        relativeFilePath: src.relativeFilePath,
        className: src.className,
        methodName,
        lineNumber: i + 1,
        jpqlQuery: jpql,
        joinFetchCount,
        codeSnippet: makeSnippet(lines, snippetStart, snippetEnd),
        snippetStartLine: snippetStart + 1,
        snippetEndLine: snippetEnd + 1,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Repository method caller scanner (for Cartesian product tracing)
// ---------------------------------------------------------------------------

/**
 * Finds service/controller methods that call a specific repository method by name.
 * Used to pinpoint exactly which code triggered a Cartesian product query,
 * rather than returning all callers of any repository method on the entity.
 */
export function scanRepositoryMethodCallers(
  projectRoot: string,
  repositoryMethodName: string,
  entityName?: string,
): AssociationUsage[] {
  const results: AssociationUsage[] = [];
  const entityLower = entityName?.toLowerCase() ?? '';
  const callPattern = new RegExp(`\\.${repositoryMethodName}\\s*\\(`);

  for (const src of getJavaSources(projectRoot)) {
    const layer = detectLayer(src.content, src.filePath);
    if (layer === 'repository') continue;

    // Quick scan: skip files that don't even mention the method name
    if (!src.content.includes(repositoryMethodName)) continue;
    if (entityLower && !src.content.toLowerCase().includes(entityLower)) continue;

    for (let i = 0; i < src.lines.length; i++) {
      if (!src.lines[i].includes(repositoryMethodName)) continue;
      if (!callPattern.test(src.lines[i])) continue;

      const bounds = methodSnippetBounds(src.lines, i, 40, 3, 3);
      results.push(buildUsage(src, layer, i, bounds.start, bounds.end));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Log-message origin scanner (primary — thread-context based)
// ---------------------------------------------------------------------------

/**
 * Matches INFO/WARN/ERROR log context lines (from the same HTTP thread as the SQL)
 * against log.info(...) / log.warn(...) / log.error(...) calls in Java source files.
 *
 * When Hibernate logs a query, the lines that appear BEFORE it on the same thread
 * (e.g. `INFO c.e.demo.service.ProblemService - [No Pagination] Loading ALL orders...`)
 * identify exactly which service method triggered the SQL. This scanner finds the
 * Java source for those log calls so the report can show the confirmed origin.
 *
 * Returns one AssociationUsage per matched log call, ordered by match quality.
 */
export function scanLogMessageOrigin(
  projectRoot: string,
  contextLines: string[],
): AssociationUsage[] {
  if (contextLines.length === 0) return [];

  // Extract message bodies from the INFO/WARN/ERROR lines.
  // Format: ... [thread] INFO  com.example.SomeService - message body here
  const messages: string[] = [];
  for (const line of contextLines) {
    const match = line.match(/\b(?:INFO|WARN|ERROR)\b\s+[\w.]+\s+-\s+(.+)$/i);
    if (match) {
      const msg = match[1].trim();
      if (msg.length >= 4) messages.push(msg);
    }
  }
  if (messages.length === 0) return [];

  const results: AssociationUsage[] = [];
  const LOG_CALL = /\blog\.(info|warn|error|debug)\s*\(\s*["'`]/i;

  for (const src of getJavaSources(projectRoot)) {
    if (!LOG_CALL.test(src.content)) continue;

    const layer = detectLayer(src.content, src.filePath);

    for (let i = 0; i < src.lines.length; i++) {
      const line = src.lines[i];
      if (!/\blog\.(info|warn|error)\s*\(/i.test(line)) continue;

      // Extract the string literal from the log call (handles multi-token args)
      const literalMatch = line.match(/log\.\w+\s*\(\s*["']([^"']+)/i);
      if (!literalMatch) continue;
      const literal = literalMatch[1];

      // Check if any captured message matches this literal (substring search both ways)
      const matched = messages.some(
        (msg) => literal.includes(msg) || msg.includes(literal) ||
          // Fuzzy: compare first 30 chars to handle truncation / SLF4J params
          (literal.length >= 10 && msg.startsWith(literal.slice(0, Math.min(30, literal.length)))),
      );
      if (!matched) continue;

      const bounds = methodSnippetBounds(src.lines, i, 40, 3, 5);
      results.push(buildUsage(src, layer, i, bounds.start, bounds.end));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entity field-usage scanner (for column-level over-fetching detection)
// ---------------------------------------------------------------------------

/**
 * Within the Java method that encloses `lineHint` (1-based) in `filePath`,
 * collects the set of entity fields read via getters (`getXxx()`), normalized
 * to lowercase with underscores removed so they can be compared against the
 * snake_case column names that appear in Hibernate SQL.
 *
 * Example: a method body containing `c.getName()` and `c.getEmail()` returns
 * the set { "name", "email" }.
 */
export function extractUsedEntityFields(filePath: string, lineHint: number): Set<string> {
  const used = new Set<string>();
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return used;
  }

  const lines = content.split('\n');
  const range = findEnclosingMethodRange(lines, Math.max(0, lineHint - 1));
  const start = range ? range.startLine : Math.max(0, lineHint - 1);
  const end = range ? range.endLine : Math.min(lines.length - 1, lineHint + 40);

  // Join the method body and strip comments so getters mentioned inside
  // `// c.getCity() never used` comments don't count as real usages.
  const body = stripJavaComments(lines.slice(start, end + 1).join('\n'));

  // `.getXxx()` with no arguments — a property read, not a service call
  const getterRe = /\.get([A-Z]\w*)\s*\(\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = getterRe.exec(body)) !== null) {
    used.add(normalizeColumnName(m[1]));
  }

  return used;
}

/** Normalizes a column or field name for comparison: lowercase, no underscores. */
export function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/_/g, '');
}

/** Removes // line comments and block comments from a Java source fragment. */
function stripJavaComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' '); // line comments
}

// ---------------------------------------------------------------------------
// Generic entity usage scanner (fallback for all issue types)
// ---------------------------------------------------------------------------

/**
 * Generic fallback: finds any service/controller method that calls any method
 * on the entity's repository. Used when issue-specific scanners find nothing.
 * Returns one entry per method (deduped), prioritizing loop contexts.
 */
export function scanGenericEntityUsages(
  projectRoot: string,
  entityName: string,
): AssociationUsage[] {
  const results: AssociationUsage[] = [];
  const entityLower = entityName.toLowerCase();

  for (const src of getJavaSources(projectRoot)) {
    const layer = detectLayer(src.content, src.filePath);
    if (layer === 'repository') continue;

    const repoFields = extractRepoFieldsForEntity(src.content, entityLower);
    if (repoFields.length === 0) continue;

    const callPatterns = repoFields.map((f) => new RegExp(`\\b${f}\\.\\w+\\s*\\(`));
    const seenMethods = new Set<string>();

    for (const method of getMethodRanges(src.lines)) {
      if (seenMethods.has(method.name)) continue;

      // Find the first line in the method that calls any repo method
      let firstCallLine = -1;
      outer: for (let i = method.startLine; i <= method.endLine && i < src.lines.length; i++) {
        for (const callPattern of callPatterns) {
          if (callPattern.test(src.lines[i])) {
            firstCallLine = i;
            break outer;
          }
        }
      }
      if (firstCallLine < 0) continue;
      seenMethods.add(method.name);

      const snippetStart = method.startLine;
      const snippetEnd = Math.min(method.endLine, method.startLine + 40);
      results.push(
        buildUsage(src, layer, firstCallLine, snippetStart, snippetEnd, {
          methodName: method.name,
        }),
      );
    }
  }

  return results;
}
