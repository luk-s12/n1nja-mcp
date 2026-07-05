import * as fs from 'fs';
import * as path from 'path';

import { findJavaFiles } from './java-file-walker';

/**
 * Classifies a project directory before running the Hibernate/JPA tools.
 *
 * full_scan and autoconfig only make sense on a Java project that actually
 * uses JPA/Hibernate. Pointing them at a reactive WebFlux + MongoDB service
 * or at a Python/Node lambda used to "work" (scan nothing, or inject logging
 * config that no Hibernate will ever write to). This module detects those
 * cases so the tools can answer "not applicable" instead.
 *
 * Detection is evidence-based and cheap:
 *   1. Build file (pom.xml / build.gradle): JPA starters vs reactive/Mongo
 *      starters, and the parent artifactId (corporate parents often hide the
 *      real dependencies, but their name encodes the stack: *-mysql-* vs *-rx-*).
 *   2. Source scan (bounded): javax/jakarta.persistence imports, @Entity,
 *      JpaRepository, EntityManager — any hit proves JPA even when the build
 *      file shows nothing.
 *   3. Non-Java markers (package.json, requirements.txt, *.py, …) for lambdas
 *      and frontends.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type ProjectKind = 'jpa' | 'non-jpa-java' | 'non-java' | 'unknown';

export interface ProjectDetection {
  projectRoot: string;
  kind: ProjectKind;
  /** True when Hibernate/JPA log analysis and logging setup make sense here. */
  applicable: boolean;
  /** Human-readable evidence lines behind the verdict. */
  signals: string[];
}

// ── Evidence tables ─────────────────────────────────────────────────────────

/** Build-file substrings that prove JPA/Hibernate is on the classpath. */
const JPA_BUILD_MARKERS = [
  'spring-boot-starter-data-jpa',
  'spring-data-jpa',
  'hibernate-core',
  'hibernate-entitymanager',
];

/** Build-file substrings for persistence stacks Hibernate plays no part in. */
const NON_JPA_BUILD_MARKERS = [
  'spring-boot-starter-data-mongodb',
  'spring-boot-starter-data-r2dbc',
  'spring-boot-starter-webflux',
  'mongodb-driver',
];

/** Parent artifactIds encode the stack when the parent hides the dependencies. */
const JPA_PARENT_HINT = /-(mysql|jpa|postgres(?:ql)?)-/i;
const REACTIVE_PARENT_HINT = /-(rx|reactive|webflux)-/i;

/** Source markers that prove JPA even when the build file shows nothing. */
const JPA_SOURCE_MARKERS = [
  'javax.persistence',
  'jakarta.persistence',
  '@Entity',
  'JpaRepository',
  'EntityManager',
];

/** Root-level files identifying a non-Java project (lambdas, frontends). */
const NON_JAVA_MARKERS: ReadonlyArray<{ file: string; label: string }> = [
  { file: 'package.json', label: 'Node.js project (package.json)' },
  { file: 'requirements.txt', label: 'Python project (requirements.txt)' },
  { file: 'pyproject.toml', label: 'Python project (pyproject.toml)' },
  { file: 'Pipfile', label: 'Python project (Pipfile)' },
  { file: 'serverless.yml', label: 'Serverless Framework config (serverless.yml)' },
  { file: 'template.yaml', label: 'AWS SAM template (template.yaml)' },
  { file: 'template.yml', label: 'AWS SAM template (template.yml)' },
];

/** Upper bound of .java files whose content is scanned for JPA markers. */
const MAX_SOURCE_FILES_SCANNED = 500;

// ── Public entry point ──────────────────────────────────────────────────────

/** Classifies `projectRoot`. Never throws: unreadable input degrades to 'unknown'. */
export function detectProject(projectRoot: string): ProjectDetection {
  const signals: string[] = [];

  const buildEvidence = inspectBuildFiles(projectRoot, signals);
  const sourceEvidence = inspectJavaSources(projectRoot, signals);

  if (buildEvidence.jpa || sourceEvidence.jpa) {
    return { projectRoot, kind: 'jpa', applicable: true, signals };
  }

  const isJavaProject = buildEvidence.hasBuildFile || sourceEvidence.hasJavaSources;
  if (isJavaProject) {
    signals.push(
      'No JPA/Hibernate evidence found (no JPA starters in the build file, ' +
        'no javax/jakarta.persistence, @Entity, JpaRepository or EntityManager in the sources).',
    );
    return { projectRoot, kind: 'non-jpa-java', applicable: false, signals };
  }

  const nonJava = detectNonJavaMarkers(projectRoot);
  if (nonJava.length > 0) {
    signals.push(...nonJava);
    signals.push('No pom.xml, build.gradle or src/main/java found.');
    return { projectRoot, kind: 'non-java', applicable: false, signals };
  }

  signals.push('No recognizable project markers found — proceeding anyway.');
  return { projectRoot, kind: 'unknown', applicable: true, signals };
}

// ── Build-file inspection ───────────────────────────────────────────────────

interface BuildEvidence {
  hasBuildFile: boolean;
  jpa: boolean;
}

function inspectBuildFiles(projectRoot: string, signals: string[]): BuildEvidence {
  const evidence: BuildEvidence = { hasBuildFile: false, jpa: false };

  for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const content = readIfExists(path.join(projectRoot, name));
    if (content === null) continue;
    evidence.hasBuildFile = true;

    for (const marker of JPA_BUILD_MARKERS) {
      if (content.includes(marker)) {
        evidence.jpa = true;
        signals.push(`${name} declares ${marker} (JPA/Hibernate).`);
      }
    }
    for (const marker of NON_JPA_BUILD_MARKERS) {
      if (content.includes(marker)) {
        signals.push(`${name} declares ${marker} (non-JPA stack).`);
      }
    }

    const parent = mavenParentArtifactId(content);
    if (parent) {
      if (JPA_PARENT_HINT.test(parent)) {
        evidence.jpa = true;
        signals.push(`Maven parent "${parent}" suggests a JPA stack.`);
      } else if (REACTIVE_PARENT_HINT.test(parent)) {
        signals.push(`Maven parent "${parent}" suggests a reactive (non-JPA) stack.`);
      }
    }
  }

  return evidence;
}

/** artifactId inside the <parent> block of a pom.xml; null when absent. */
function mavenParentArtifactId(pom: string): string | null {
  const parentBlock = pom.match(/<parent>([\s\S]*?)<\/parent>/i)?.[1];
  if (!parentBlock) return null;
  return parentBlock.match(/<artifactId>([^<]+)<\/artifactId>/i)?.[1]?.trim() ?? null;
}

// ── Source inspection ───────────────────────────────────────────────────────

interface SourceEvidence {
  hasJavaSources: boolean;
  jpa: boolean;
}

function inspectJavaSources(projectRoot: string, signals: string[]): SourceEvidence {
  const files = findJavaFiles(path.join(projectRoot, 'src', 'main', 'java'));
  const evidence: SourceEvidence = { hasJavaSources: files.length > 0, jpa: false };

  const toScan = files.slice(0, MAX_SOURCE_FILES_SCANNED);
  for (const file of toScan) {
    const content = readIfExists(file);
    if (content === null) continue;
    const marker = JPA_SOURCE_MARKERS.find((m) => content.includes(m));
    if (marker) {
      evidence.jpa = true;
      signals.push(`Found "${marker}" in ${path.relative(projectRoot, file)} (JPA/Hibernate).`);
      return evidence;
    }
  }

  if (evidence.hasJavaSources) {
    const scannedNote =
      files.length > toScan.length ? ` (scanned the first ${toScan.length})` : '';
    signals.push(`Scanned ${toScan.length} Java source file(s)${scannedNote} — no JPA markers.`);
  }
  return evidence;
}

// ── Non-Java markers ────────────────────────────────────────────────────────

function detectNonJavaMarkers(projectRoot: string): string[] {
  const found: string[] = [];
  for (const { file, label } of NON_JAVA_MARKERS) {
    if (fileExists(path.join(projectRoot, file))) found.push(`${label} found.`);
  }
  if (found.length === 0 && hasRootFilesWithExtension(projectRoot, ['.py'])) {
    found.push('Python source files found at the project root.');
  }
  return found;
}

function hasRootFilesWithExtension(dir: string, extensions: string[]): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isFile() && extensions.some((ext) => e.name.endsWith(ext)));
  } catch {
    return false;
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** File content, or null when it does not exist or cannot be read. */
function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── Markdown ────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<ProjectKind, string> = {
  jpa: 'Java project using JPA/Hibernate',
  'non-jpa-java': 'Java project WITHOUT JPA/Hibernate (e.g. reactive WebFlux/MongoDB)',
  'non-java': 'Not a Java project (e.g. a Python/Node lambda or frontend)',
  unknown: 'Unrecognized project layout',
};

/** Report returned by full_scan/autoconfig when the project is not applicable. */
export function buildNotApplicableMarkdown(detection: ProjectDetection, toolName: string): string {
  const lines: string[] = [];
  lines.push('# 🥷 N1nja — Not applicable');
  lines.push('');
  lines.push(`> **Project:** \`${detection.projectRoot}\``);
  lines.push(`> **Detected:** ${KIND_LABELS[detection.kind]}`);
  lines.push('');
  lines.push(
    `\`${toolName}\` works with Hibernate/JPA SQL logs, and this project shows no sign of using ` +
      'Hibernate — there is nothing to analyze or configure here, so no files were touched.',
  );
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const s of detection.signals) lines.push(`- ${s}`);
  lines.push('');
  lines.push('## Options');
  lines.push('');
  lines.push('- If this is the wrong directory, re-run with the correct `projectRoot`.');
  lines.push('- If the detection is wrong, re-run with `force: true` to skip this check.');
  return lines.join('\n');
}
