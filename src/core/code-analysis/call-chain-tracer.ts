import { getJavaSources, JavaSource } from './source-cache';
import { Layer, detectLayer, findEnclosingMethod } from './java-utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export type { Layer };

export interface CallChainStep {
  className: string;
  methodName: string;
  relativeFilePath: string;
  lineNumber: number;
  layer: Layer;
  /** HTTP verb (GET, POST, ...) if this is a controller endpoint */
  httpVerb?: string;
  /** HTTP path if this is a controller endpoint */
  httpPath?: string;
  /** The code line that makes the call */
  codeLine: string;
}

/** Ordered from outermost caller (controller/entry-point) down to the trigger method. */
export interface CallChain {
  steps: CallChainStep[];
}

// ── Internal file cache ───────────────────────────────────────────────────────

interface JavaFile {
  filePath: string;
  relPath: string;
  className: string;
  content: string;
  lines: string[];
  layer: Layer;
  /** Class-level @RequestMapping path prefix */
  classHttpPath: string;
}

// ── HTTP annotation helpers ───────────────────────────────────────────────────

const HTTP_MAPPINGS: Array<{ regex: RegExp; verb: string }> = [
  { regex: /@GetMapping\b/, verb: 'GET' },
  { regex: /@PostMapping\b/, verb: 'POST' },
  { regex: /@PutMapping\b/, verb: 'PUT' },
  { regex: /@DeleteMapping\b/, verb: 'DELETE' },
  { regex: /@PatchMapping\b/, verb: 'PATCH' },
  { regex: /@RequestMapping\b/, verb: '' },
];

// ── File loading ──────────────────────────────────────────────────────────────

// traceCallChain runs once per usage per finding — memoize the derived
// JavaFile list on the shared source cache so files are read and annotated once.
const javaFileCache = new WeakMap<JavaSource[], JavaFile[]>();

function loadJavaFiles(projectRoot: string): JavaFile[] {
  const sources = getJavaSources(projectRoot);
  let files = javaFileCache.get(sources);
  if (!files) {
    files = sources.map((src) => ({
      filePath: src.filePath,
      relPath: src.relativeFilePath,
      className: src.className,
      content: src.content,
      lines: src.lines,
      layer: detectLayer(src.content, src.filePath),
      classHttpPath: extractClassHttpPath(src.content),
    }));
    javaFileCache.set(sources, files);
  }
  return files;
}

function extractClassHttpPath(content: string): string {
  const m = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)['"]/);
  return m ? m[1] : '';
}

// ── Core tracer ───────────────────────────────────────────────────────────────

/**
 * Given the class+method that triggers the issue (e.g. OrderService.getDetails),
 * walks upward through the call graph to find the HTTP entry point.
 *
 * Returns up to 3 chains, each ordered from controller → ... → trigger.
 */
export function traceCallChain(
  triggerClassName: string,
  triggerMethodName: string,
  projectRoot: string,
): CallChain[] {
  const javaFiles = loadJavaFiles(projectRoot);
  const visited = new Set<string>();
  const chains = traceUp(triggerClassName, triggerMethodName, javaFiles, 3, visited);
  return chains.slice(0, 3);
}

function traceUp(
  targetClass: string,
  targetMethod: string,
  javaFiles: JavaFile[],
  depth: number,
  visited: Set<string>,
): CallChain[] {
  const key = `${targetClass}.${targetMethod}`;
  if (depth === 0 || visited.has(key)) return [];
  visited.add(key);

  const callers = findCallers(targetClass, targetMethod, javaFiles);
  if (callers.length === 0) return [];

  const chains: CallChain[] = [];

  for (const caller of callers.slice(0, 3)) {
    const callerKey = `${caller.className}.${caller.methodName}`;
    if (visited.has(callerKey)) continue;

    if (caller.layer === 'controller') {
      // Found the top of the chain
      chains.push({ steps: [caller] });
    } else {
      const upper = traceUp(caller.className, caller.methodName, javaFiles, depth - 1, new Set(visited));
      if (upper.length > 0) {
        for (const u of upper) {
          chains.push({ steps: [...u.steps, caller] });
        }
      } else {
        chains.push({ steps: [caller] });
      }
    }
  }

  return chains;
}

// ── Caller finder ─────────────────────────────────────────────────────────────

function findCallers(targetClass: string, targetMethod: string, javaFiles: JavaFile[]): CallChainStep[] {
  const callers: CallChainStep[] = [];

  // Match: someRef.targetMethod( or just targetMethod(
  const byRef = new RegExp(`\\.\\s*${targetMethod}\\s*\\(`, 'g');
  const direct = new RegExp(`\\b${targetMethod}\\s*\\(`, 'g');

  for (const jf of javaFiles) {
    if (jf.className === targetClass) continue;

    // Quick content check before per-line scan
    byRef.lastIndex = 0;
    direct.lastIndex = 0;
    const hasRef = byRef.test(jf.content) || direct.test(jf.content);
    byRef.lastIndex = 0;
    direct.lastIndex = 0;
    if (!hasRef) continue;

    // Filter: file should reference the target class OR a typical injection variable
    const mentionsClass = jf.content.includes(targetClass);
    const varName = decapitalize(targetClass);
    const mentionsVar = jf.content.includes(varName);
    if (!mentionsClass && !mentionsVar) continue;

    for (let i = 0; i < jf.lines.length; i++) {
      const line = jf.lines[i];
      byRef.lastIndex = 0;
      direct.lastIndex = 0;
      if (!byRef.test(line) && !direct.test(line)) continue;
      byRef.lastIndex = 0;
      direct.lastIndex = 0;

      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      const methodName = findEnclosingMethod(jf.lines, i, '');
      if (!methodName || methodName === targetMethod) continue;

      const { httpVerb, httpPath } = findHttpAnnotation(jf.lines, i, jf.classHttpPath);

      callers.push({
        className: jf.className,
        methodName,
        relativeFilePath: jf.relPath,
        lineNumber: i + 1,
        layer: jf.layer,
        httpVerb,
        httpPath,
        codeLine: trimmed,
      });
    }
  }

  // Prefer controllers and services over generic
  callers.sort((a, b) => layerPriority(a.layer) - layerPriority(b.layer));
  return dedup(callers);
}

function layerPriority(layer: Layer): number {
  return { controller: 0, service: 1, repository: 2, other: 3 }[layer];
}

function dedup(steps: CallChainStep[]): CallChainStep[] {
  const seen = new Set<string>();
  return steps.filter((s) => {
    const k = `${s.className}.${s.methodName}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── AST helpers ───────────────────────────────────────────────────────────────

function findHttpAnnotation(
  lines: string[],
  idx: number,
  classPath: string,
): { httpVerb?: string; httpPath?: string } {
  const lookback = Math.max(0, idx - 8);
  for (let i = idx; i >= lookback; i--) {
    const line = lines[i];
    for (const { regex, verb } of HTTP_MAPPINGS) {
      if (regex.test(line)) {
        const pathMatch = line.match(/["']([^"']+)['"]/);
        const methodMatch = line.match(/method\s*=\s*RequestMethod\.(\w+)/);
        const httpVerb = verb || methodMatch?.[1] || 'ANY';
        const methodPath = pathMatch ? pathMatch[1] : '';
        const full = classPath ? `${classPath}${methodPath}` : methodPath;
        return { httpVerb, httpPath: full || '/' };
      }
    }
  }
  return {};
}

function decapitalize(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
