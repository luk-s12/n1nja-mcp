import * as fs from 'fs';
import * as path from 'path';
import { Severity } from '../../domain/models/issue.model';
import { severityIcon } from '../../shared/severity';
import { scanEntities } from '../code-analysis/entity-scanner';
import { getJavaSources, clearJavaSourceCache } from '../code-analysis/source-cache';

/**
 * Static (no-logs) audit of a Spring Boot / JPA project. Unlike the log-based
 * pipeline, this needs nothing from the running application: it scans the Java
 * sources and config files for the anti-patterns that cause N+1 queries, slow
 * bulk writes and oversized transactions.
 *
 * Fleet mode: when the given root is not itself a Java project but contains
 * subdirectories that are (a folder full of microservices), every project is
 * scanned and ranked by a severity-weighted score.
 */

// ── Result types ────────────────────────────────────────────────────────────

export type StaticFindingType =
  | 'EAGER_COLLECTION'
  | 'EAGER_TO_ONE'
  | 'MANY_TO_MANY'
  | 'MULTIPLE_JOIN_FETCH'
  | 'UNBOUNDED_FIND_ALL'
  | 'SAVE_ALL_WITHOUT_BATCH_SIZE'
  | 'TRANSACTIONAL_NOT_READ_ONLY';

export interface StaticFinding {
  type: StaticFindingType;
  severity: Severity;
  /** Path relative to the project root, forward slashes. */
  file: string;
  /** 1-based line number of the offending code. */
  line: number;
  /** The offending line, trimmed. */
  codeLine: string;
  /** What is wrong, with the concrete symbol involved. */
  detail: string;
  /** How to fix it. */
  recommendation: string;
}

export interface ProjectStaticScan {
  projectRoot: string;
  projectName: string;
  javaFilesScanned: number;
  entitiesScanned: number;
  findings: StaticFinding[];
  /** Severity-weighted score used for fleet ranking (HIGH=5, MEDIUM=2, LOW=1). */
  score: number;
  countsByType: Partial<Record<StaticFindingType, number>>;
}

export interface StaticScanResult {
  mode: 'single' | 'fleet';
  scannedRoot: string;
  projects: ProjectStaticScan[];
  markdownReport: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<Severity, number> = { HIGH: 5, MEDIUM: 2, LOW: 1 };

const RECOMMENDATIONS: Record<StaticFindingType, string> = {
  EAGER_COLLECTION:
    'Use fetch = FetchType.LAZY and load the collection explicitly where needed (JOIN FETCH, @EntityGraph or @BatchSize).',
  EAGER_TO_ONE:
    'Prefer fetch = FetchType.LAZY on @ManyToOne/@OneToOne; to-one associations are EAGER by default and every load drags the parent along.',
  MANY_TO_MANY:
    'Keep @ManyToMany LAZY and access it via a dedicated query (JOIN FETCH / @EntityGraph); consider modeling the join table as an entity if it carries data.',
  MULTIPLE_JOIN_FETCH:
    'Fetching two or more collections in one query multiplies rows (cartesian product) and, with List, throws MultipleBagFetchException. Split into separate queries or use Set + @BatchSize.',
  UNBOUNDED_FIND_ALL:
    'findAll() loads the entire table. Use pagination (findAll(Pageable)), a filtered query, or streaming for batch jobs.',
  SAVE_ALL_WITHOUT_BATCH_SIZE:
    'Without hibernate.jdbc.batch_size, saveAll() executes one INSERT per row. Set spring.jpa.properties.hibernate.jdbc.batch_size (e.g. 30) and order_inserts=true.',
  TRANSACTIONAL_NOT_READ_ONLY:
    'Read-only paths should use @Transactional(readOnly = true): it skips dirty checking and lets the driver/replica optimize.',
};

/** Names that never contain a scannable project. */
const SKIP_PROJECT_DIRS = new Set(['node_modules', '.git', 'target', 'build', '.idea', 'dist']);

// ── Public entry point ──────────────────────────────────────────────────────

export interface StaticScanOptions {
  /** Cap of findings kept per project (most severe first). Default 50. */
  maxFindingsPerProject?: number;
}

export function runStaticScan(root: string, options: StaticScanOptions = {}): StaticScanResult {
  clearJavaSourceCache();
  const scannedRoot = path.resolve(root);
  if (!fs.existsSync(scannedRoot)) {
    throw new Error(`Path not found: ${scannedRoot}`);
  }

  const max = options.maxFindingsPerProject ?? 50;

  let mode: StaticScanResult['mode'];
  let projectRoots: string[];

  if (isJavaProject(scannedRoot)) {
    mode = 'single';
    projectRoots = [scannedRoot];
  } else {
    mode = 'fleet';
    projectRoots = findFleetProjects(scannedRoot);
    if (projectRoots.length === 0) {
      throw new Error(
        `${scannedRoot} is not a Java project (no src/main/java) and none of its subdirectories are. ` +
          'Point projectRoot at a Spring Boot project or at a folder containing several.',
      );
    }
  }

  const projects = projectRoots
    .map((p) => {
      const scan = scanProject(p, max);
      // A fleet holds dozens of projects × ~1000 cached sources — release each
      // project's sources as soon as its scan is done.
      clearJavaSourceCache();
      return scan;
    })
    .sort((a, b) => b.score - a.score || a.projectName.localeCompare(b.projectName));

  const result: Omit<StaticScanResult, 'markdownReport'> = { mode, scannedRoot, projects };
  return { ...result, markdownReport: buildMarkdown(result) };
}

// ── Project discovery ───────────────────────────────────────────────────────

/** A scannable project is any directory with Java production sources. */
function isJavaProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'src', 'main', 'java'));
}

/** Immediate subdirectories of `root` that are Java projects. */
export function findFleetProjects(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_PROJECT_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter(isJavaProject);
}

// ── Per-project scan ────────────────────────────────────────────────────────

export function scanProject(projectRoot: string, maxFindings = 50): ProjectStaticScan {
  const findings: StaticFinding[] = [];
  const sources = getJavaSources(projectRoot);
  const entities = scanEntities(projectRoot);

  findings.push(...detectEagerAssociations(entities, projectRoot));
  findings.push(...detectMultipleJoinFetch(projectRoot));
  findings.push(...detectUnboundedFindAll(projectRoot));
  findings.push(...detectSaveAllWithoutBatchSize(projectRoot));
  findings.push(...detectTransactionalNotReadOnly(projectRoot));

  findings.sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const countsByType: ProjectStaticScan['countsByType'] = {};
  let score = 0;
  for (const f of findings) {
    countsByType[f.type] = (countsByType[f.type] ?? 0) + 1;
    score += SEVERITY_WEIGHT[f.severity];
  }

  return {
    projectRoot,
    projectName: path.basename(projectRoot),
    javaFilesScanned: sources.length,
    entitiesScanned: entities.length,
    findings: findings.slice(0, maxFindings),
    score,
    countsByType,
  };
}

// ── Detections ──────────────────────────────────────────────────────────────

function detectEagerAssociations(
  entities: ReturnType<typeof scanEntities>,
  projectRoot: string,
): StaticFinding[] {
  const findings: StaticFinding[] = [];
  for (const entity of entities) {
    const file = relative(projectRoot, entity.filePath);
    for (const assoc of entity.associations) {
      const isCollection = assoc.annotationType === 'OneToMany' || assoc.annotationType === 'ManyToMany';
      const label = `${entity.className}.${assoc.fieldName} (@${assoc.annotationType})`;

      if (isCollection && assoc.fetchType === 'EAGER') {
        findings.push({
          type: 'EAGER_COLLECTION',
          severity: 'HIGH',
          file,
          line: assoc.lineNumber,
          codeLine: `@${assoc.annotationType}(fetch = FetchType.EAGER) ${assoc.fieldName}`,
          detail: `${label} loads the whole collection on EVERY load of ${entity.className} — N+1 or cartesian join on any list query.`,
          recommendation: RECOMMENDATIONS.EAGER_COLLECTION,
        });
      } else if (assoc.annotationType === 'ManyToMany') {
        findings.push({
          type: 'MANY_TO_MANY',
          severity: 'MEDIUM',
          file,
          line: assoc.lineNumber,
          codeLine: `@ManyToMany ${assoc.fieldName}`,
          detail: `${label} goes through a join table — a classic N+1 / cartesian-product candidate when iterated.`,
          recommendation: RECOMMENDATIONS.MANY_TO_MANY,
        });
      } else if (!isCollection && assoc.fetchType === 'EAGER') {
        findings.push({
          type: 'EAGER_TO_ONE',
          severity: 'LOW',
          file,
          line: assoc.lineNumber,
          codeLine: `@${assoc.annotationType}(fetch = FetchType.EAGER) ${assoc.fieldName}`,
          detail: `${label} is explicitly EAGER — the parent row is joined or selected on every load of ${entity.className}.`,
          recommendation: RECOMMENDATIONS.EAGER_TO_ONE,
        });
      }
    }
  }
  return findings;
}

const QUERY_ANNOTATION = /@Query\s*\(/;
const JOIN_FETCH = /\bjoin\s+fetch\b/gi;
const METHOD_SIGNATURE = /\b\w+(?:<[^;{]*>)?\s+(\w+)\s*\([^;{]*[;{)]?/;

function detectMultipleJoinFetch(projectRoot: string): StaticFinding[] {
  const findings: StaticFinding[] = [];
  for (const src of getJavaSources(projectRoot)) {
    if (!QUERY_ANNOTATION.test(src.content)) continue;
    const { lines } = src;

    for (let i = 0; i < lines.length; i++) {
      if (!QUERY_ANNOTATION.test(lines[i])) continue;

      // Annotation block: from @Query until the next annotation or the method
      // signature (query strings often span many concatenated lines).
      let end = i + 1;
      while (
        end < lines.length &&
        end - i < 40 &&
        !/^\s*@\w+/.test(lines[end]) &&
        !/\)\s*;\s*$/.test(lines[end - 1] ?? '')
      ) {
        end++;
      }
      const block = lines.slice(i, end + 1).join('\n');
      const fetchCount = (block.match(JOIN_FETCH) ?? []).length;
      if (fetchCount < 2) continue;

      const methodName = lines
        .slice(i + 1, Math.min(lines.length, end + 3))
        .map((l) => l.match(METHOD_SIGNATURE)?.[1])
        .find((name) => name !== undefined);

      findings.push({
        type: 'MULTIPLE_JOIN_FETCH',
        severity: 'MEDIUM',
        file: src.relativeFilePath,
        line: i + 1,
        codeLine: lines[i].trim(),
        detail: `${src.className}${methodName ? `.${methodName}` : ''} fetches ${fetchCount} associations in one query — row multiplication, and MultipleBagFetchException if two are List.`,
        recommendation: RECOMMENDATIONS.MULTIPLE_JOIN_FETCH,
      });
    }
  }
  return findings;
}

const UNBOUNDED_FIND_ALL = /\b(\w*[Rr]epository\w*)\s*\.\s*findAll\s*\(\s*\)/;

function detectUnboundedFindAll(projectRoot: string): StaticFinding[] {
  const findings: StaticFinding[] = [];
  for (const src of getJavaSources(projectRoot)) {
    // The repository interface itself legitimately declares findAll().
    if (/Repository\.java$/.test(src.filePath)) continue;

    for (let i = 0; i < src.lines.length; i++) {
      const m = src.lines[i].match(UNBOUNDED_FIND_ALL);
      if (!m) continue;
      findings.push({
        type: 'UNBOUNDED_FIND_ALL',
        severity: 'MEDIUM',
        file: src.relativeFilePath,
        line: i + 1,
        codeLine: src.lines[i].trim(),
        detail: `${src.className} calls ${m[1]}.findAll() with no bounds — loads the entire table into memory.`,
        recommendation: RECOMMENDATIONS.UNBOUNDED_FIND_ALL,
      });
    }
  }
  return findings;
}

const SAVE_ALL_CALL = /\b\w+\s*\.\s*saveAll\s*\(/;
const BATCH_SIZE_CONFIG = /hibernate[.\s]*[\w."'\s:]*jdbc[.\s"']*[\w."'\s:]*batch[_-]size/i;

function detectSaveAllWithoutBatchSize(projectRoot: string): StaticFinding[] {
  if (projectConfigContains(projectRoot, BATCH_SIZE_CONFIG)) return [];

  const findings: StaticFinding[] = [];
  for (const src of getJavaSources(projectRoot)) {
    for (let i = 0; i < src.lines.length; i++) {
      if (!SAVE_ALL_CALL.test(src.lines[i])) continue;
      findings.push({
        type: 'SAVE_ALL_WITHOUT_BATCH_SIZE',
        severity: 'MEDIUM',
        file: src.relativeFilePath,
        line: i + 1,
        codeLine: src.lines[i].trim(),
        detail: `${src.className} uses saveAll() but the project sets no hibernate.jdbc.batch_size — every row is a separate INSERT round-trip.`,
        recommendation: RECOMMENDATIONS.SAVE_ALL_WITHOUT_BATCH_SIZE,
      });
    }
  }
  return findings;
}

const TRANSACTIONAL = /@Transactional\b/;
const READ_ONLY = /readOnly\s*=\s*true/;
const READ_METHOD = /\b(?:public|protected)?\s*[\w<>[\],.?\s]+\s+((?:find|get|list|search|fetch|count|read|load)\w*)\s*\(/;

function detectTransactionalNotReadOnly(projectRoot: string): StaticFinding[] {
  const findings: StaticFinding[] = [];
  for (const src of getJavaSources(projectRoot)) {
    if (!TRANSACTIONAL.test(src.content)) continue;

    for (let i = 0; i < src.lines.length; i++) {
      if (!TRANSACTIONAL.test(src.lines[i]) || READ_ONLY.test(src.lines[i])) continue;

      // Method-level only: the annotated read method must follow within a few
      // lines (class-level @Transactional is a different, noisier discussion).
      for (let k = i + 1; k < Math.min(src.lines.length, i + 4); k++) {
        const line = src.lines[k];
        if (/^\s*@\w+/.test(line)) continue; // other annotations in between
        const m = line.match(READ_METHOD);
        if (m) {
          findings.push({
            type: 'TRANSACTIONAL_NOT_READ_ONLY',
            severity: 'LOW',
            file: src.relativeFilePath,
            line: i + 1,
            codeLine: src.lines[i].trim(),
            detail: `${src.className}.${m[1]}() looks read-only but its @Transactional does not set readOnly = true.`,
            recommendation: RECOMMENDATIONS.TRANSACTIONAL_NOT_READ_ONLY,
          });
        }
        break; // first non-annotation line decides
      }
    }
  }
  return findings;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True if any application*.properties/yml under src/main/resources matches `re`. */
function projectConfigContains(projectRoot: string, re: RegExp): boolean {
  const resources = path.join(projectRoot, 'src', 'main', 'resources');
  let names: string[];
  try {
    names = fs.readdirSync(resources).filter((f) => /^application[\w.-]*\.(properties|ya?ml)$/i.test(f));
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      if (re.test(fs.readFileSync(path.join(resources, name), 'utf8'))) return true;
    } catch {
      /* unreadable config — keep looking */
    }
  }
  return false;
}

function relative(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

// ── Markdown report ─────────────────────────────────────────────────────────

const TYPE_LABEL: Record<StaticFindingType, string> = {
  EAGER_COLLECTION: 'EAGER collection',
  EAGER_TO_ONE: 'Explicit EAGER to-one',
  MANY_TO_MANY: '@ManyToMany',
  MULTIPLE_JOIN_FETCH: 'Multiple JOIN FETCH',
  UNBOUNDED_FIND_ALL: 'Unbounded findAll()',
  SAVE_ALL_WITHOUT_BATCH_SIZE: 'saveAll() without batch_size',
  TRANSACTIONAL_NOT_READ_ONLY: '@Transactional not readOnly',
};

function buildMarkdown(r: Omit<StaticScanResult, 'markdownReport'>): string {
  const lines: string[] = [];
  lines.push('# 🥷 N1nja — Static Scan');
  lines.push('');
  lines.push(`> **Scanned:** \`${r.scannedRoot}\` (${r.mode === 'fleet' ? `fleet of ${r.projects.length} projects` : 'single project'})`);
  lines.push('> No logs needed — findings come from the Java sources and config files alone.');
  lines.push('');

  if (r.mode === 'fleet') {
    lines.push('## Ranking (worst first)');
    lines.push('');
    lines.push('| # | Project | Score | 🔴 High | 🟡 Medium | 🟢 Low | Entities |');
    lines.push('|---|---------|-------|---------|-----------|--------|----------|');
    r.projects.forEach((p, idx) => {
      const bySev = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const f of p.findings) bySev[f.severity]++;
      lines.push(
        `| ${idx + 1} | \`${p.projectName}\` | **${p.score}** | ${bySev.HIGH} | ${bySev.MEDIUM} | ${bySev.LOW} | ${p.entitiesScanned} |`,
      );
    });
    lines.push('');
  }

  for (const p of r.projects) {
    lines.push(`## ${r.mode === 'fleet' ? `\`${p.projectName}\`` : 'Findings'} — score ${p.score}`);
    lines.push('');
    lines.push(`> ${p.javaFilesScanned} Java files, ${p.entitiesScanned} entities scanned.`);
    lines.push('');

    if (p.findings.length === 0) {
      lines.push('✅ No static anti-patterns detected.');
      lines.push('');
      continue;
    }

    const byType = new Map<StaticFindingType, StaticFinding[]>();
    for (const f of p.findings) {
      if (!byType.has(f.type)) byType.set(f.type, []);
      byType.get(f.type)!.push(f);
    }

    for (const [type, fs_] of byType) {
      lines.push(`### ${severityIcon(fs_[0].severity)} ${TYPE_LABEL[type]} (${fs_.length})`);
      lines.push('');
      for (const f of fs_) {
        lines.push(`- \`${f.file}:${f.line}\` — ${f.detail}`);
      }
      lines.push('');
      lines.push(`> 💡 ${RECOMMENDATIONS[type]}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
