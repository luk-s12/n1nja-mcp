import * as fs from 'fs';
import * as path from 'path';

/**
 * Auto-configures the logging that N1nja needs to capture Hibernate/JPA SQL.
 *
 * N1nja reads a log file (default logs/application.log) that must contain the
 * SQL, bind parameters and statistics Hibernate emits at these levels:
 *   org.hibernate.SQL            = DEBUG
 *   org.hibernate.orm.jdbc.bind  = TRACE
 *   org.hibernate.stat           = DEBUG
 *
 * How that is enabled depends on the project:
 *   • If the project ships a Logback config (logback-spring.xml / logback.xml),
 *     Spring Boot hands logging control to Logback and IGNORES the
 *     logging.file.name / logging.level.* properties. So the XML must be edited.
 *   • Otherwise the standard application.properties / application.yml
 *     properties are used (base file + every application-{profile} variant).
 *
 * This module detects the scenario and applies the right change in-place.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** Path (relative to the project working dir) N1nja tails by default. */
export const DEFAULT_LOG_FILE = 'logs/application.log';

/** The Hibernate loggers N1nja depends on, and the level each needs. */
export const HIBERNATE_LOGGERS: ReadonlyArray<{ name: string; level: 'DEBUG' | 'TRACE' }> = [
  { name: 'org.hibernate.SQL', level: 'DEBUG' },
  { name: 'org.hibernate.orm.jdbc.bind', level: 'TRACE' },
  { name: 'org.hibernate.stat', level: 'DEBUG' },
];

/** Generic Logback/Spring pattern with the thread right after the timestamp. */
const GENERIC_PATTERN = '%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger : %msg%n';

/** Directories searched for config files, relative to the project root. */
const CONFIG_DIRS = ['src/main/resources', '.'];

/** Logback config file names, in Spring Boot's own precedence order. */
const LOGBACK_FILE_NAMES = ['logback-spring.xml', 'logback.xml'];

/** Matches application.properties/yml and profile variants (application-ci.yml). */
const APP_CONFIG_FILE = /^application(?:-([\w.-]+))?\.(properties|ya?ml)$/i;

// ── Result types ────────────────────────────────────────────────────────────

export type Scenario = 'logback' | 'properties' | 'created-properties';

export interface FileChange {
  /** Absolute path of the file written. */
  file: string;
  /** What happened to it. */
  action: 'updated' | 'created' | 'unchanged';
  /** Human-readable notes about what was added (or why nothing was). */
  notes: string[];
}

export interface SetupLoggingResult {
  projectRoot: string;
  scenario: Scenario;
  logFile: string;
  changes: FileChange[];
  markdownReport: string;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Detects the project's logging setup and configures it in-place so N1nja can
 * capture Hibernate SQL. Writes files directly (no backup / no dry-run).
 */
export function setupLogging(projectRoot: string): SetupLoggingResult {
  const logbackFiles = findLogbackFiles(projectRoot);

  let scenario: Scenario;
  let changes: FileChange[];

  if (logbackFiles.length > 0) {
    // Logback present → Spring ignores the logging.* properties, so the XML wins.
    scenario = 'logback';
    changes = logbackFiles.map(configureLogbackFile);
  } else {
    const appFiles = findAppConfigFiles(projectRoot);
    if (appFiles.length > 0) {
      scenario = 'properties';
      changes = appFiles.map(configureAppConfigFile);
    } else {
      // Nothing to configure — create a fresh application.properties.
      scenario = 'created-properties';
      changes = [createApplicationProperties(projectRoot)];
    }
  }

  const result: Omit<SetupLoggingResult, 'markdownReport'> = {
    projectRoot,
    scenario,
    logFile: DEFAULT_LOG_FILE,
    changes,
  };
  return { ...result, markdownReport: buildMarkdown(result) };
}

// ── Detection ─────────────────────────────────────────────────────────────────

/** Absolute paths of every Logback config file found under the project. */
export function findLogbackFiles(projectRoot: string): string[] {
  const found: string[] = [];
  for (const dir of CONFIG_DIRS) {
    for (const name of LOGBACK_FILE_NAMES) {
      const candidate = path.join(projectRoot, dir, name);
      if (fileExists(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Absolute paths of every application.properties/yml (base + profile variants). */
export function findAppConfigFiles(projectRoot: string): string[] {
  const found: string[] = [];
  for (const dir of CONFIG_DIRS) {
    const abs = path.join(projectRoot, dir);
    let names: string[];
    try {
      names = fs.readdirSync(abs).filter((f) => APP_CONFIG_FILE.test(f));
    } catch {
      continue;
    }
    for (const name of names) found.push(path.join(abs, name));
  }
  return found;
}

// ── Logback branch ──────────────────────────────────────────────────────────

/**
 * Injects, if missing, a file appender writing DEFAULT_LOG_FILE, the Hibernate
 * loggers, and the appender-ref inside <root>. Idempotent: re-running makes no
 * further changes. Reuses a custom encoder/layout when one is present, so a
 * project-wide PII-masking layout is not bypassed for the file.
 */
export function configureLogbackFile(file: string): FileChange {
  const original = fs.readFileSync(file, 'utf8');
  let xml = original;
  const notes: string[] = [];

  const appenderName = 'n1njaFileAppender';
  const hasN1njaAppender = new RegExp(`<appender[^>]*name=["']${appenderName}["']`).test(xml);

  // 1. File appender ----------------------------------------------------------
  if (!hasN1njaAppender) {
    const customEncoder = detectCustomEncoderInner(xml);
    if (customEncoder) {
      notes.push('Reused the existing custom encoder/layout for the file appender (avoids leaking masked data).');
      if (customEncoder.colorStripped) {
        notes.push('Stripped color converters (%clr/%highlight/…) from the reused pattern so the log file stays free of ANSI escapes.');
      }
    }
    const appenderXml = buildFileAppenderXml(appenderName, customEncoder);
    xml = insertBeforeClosingConfiguration(xml, appenderXml);
    notes.push(`Added file appender "${appenderName}" → ${DEFAULT_LOG_FILE}.`);
  } else {
    notes.push(`File appender "${appenderName}" already present — left as is.`);
  }

  // 2. Hibernate loggers ------------------------------------------------------
  const loggerLines: string[] = [];
  for (const { name, level } of HIBERNATE_LOGGERS) {
    if (hasLogger(xml, name)) continue;
    loggerLines.push(`    <logger name="${name}" level="${level}"/>`);
  }
  if (loggerLines.length > 0) {
    xml = insertBeforeClosingConfiguration(xml, loggerLines.join('\n') + '\n');
    notes.push(`Added Hibernate logger(s): ${loggerLines.length} of ${HIBERNATE_LOGGERS.length}.`);
  } else {
    notes.push('All Hibernate loggers already present — left as is.');
  }

  // 3. Wire the appender into <root> -----------------------------------------
  const rootRef = `<appender-ref ref="${appenderName}"/>`;
  if (!xml.includes(rootRef)) {
    const wired = addAppenderRefToRoot(xml, appenderName);
    if (wired) {
      xml = wired;
      notes.push(`Wired "${appenderName}" into <root>.`);
    } else {
      notes.push(`⚠ Could not find a <root> element — add <appender-ref ref="${appenderName}"/> manually.`);
    }
  }

  if (xml === original) {
    return { file, action: 'unchanged', notes };
  }
  fs.writeFileSync(file, xml, 'utf8');
  return { file, action: 'updated', notes };
}

/** True if the XML already declares a <logger name="..."> for `loggerName`. */
function hasLogger(xml: string, loggerName: string): boolean {
  const escaped = loggerName.replace(/\./g, '\\.');
  return new RegExp(`<logger[^>]*name=["']${escaped}["']`).test(xml);
}

/** Encoder Logback needs when the encoder content is a <layout> element. */
const LAYOUT_WRAPPING_ENCODER = 'ch.qos.logback.core.encoder.LayoutWrappingEncoder';

interface CustomEncoder {
  /** Inner XML of the encoder: the whole <layout> block, or a <pattern>. */
  inner: string;
  /** class for the generated <encoder>; null → Logback's default encoder. */
  encoderClass: string | null;
  /** True when color converters were stripped from the reused pattern. */
  colorStripped: boolean;
}

/**
 * Returns the reusable encoder content of the FIRST encoder found (its
 * <pattern> or the whole <layout .../> block). Returns null when no custom
 * encoder exists, in which case the generic pattern is used. Patterns are
 * de-colorized: console patterns often use %clr/%highlight converters whose
 * ANSI escapes would pollute the log file and break parsing.
 */
function detectCustomEncoderInner(xml: string): CustomEncoder | null {
  const layout = xml.match(/<layout\b[\s\S]*?<\/layout>/i);
  if (layout && /class\s*=/.test(layout[0])) {
    let colorStripped = false;
    const inner = layout[0].trim().replace(/<pattern>([\s\S]*?)<\/pattern>/gi, (whole, p) => {
      const cleaned = cleanPatternForFile(p.trim(), xml);
      if (cleaned === null) return whole;
      colorStripped = true;
      return `<pattern>${cleaned}</pattern>`;
    });
    // The default PatternLayoutEncoder rejects a nested <layout>, so the
    // generated encoder must carry the original encoder's class (or an
    // explicit LayoutWrappingEncoder when none is declared).
    return { inner, encoderClass: enclosingEncoderClass(xml, layout[0]), colorStripped };
  }
  const pattern = xml.match(/<pattern>([\s\S]*?)<\/pattern>/i);
  if (pattern && pattern[1].trim() && pattern[1].trim() !== GENERIC_PATTERN) {
    const raw = pattern[1].trim();
    const cleaned = cleanPatternForFile(raw, xml);
    return {
      inner: `<pattern>${cleaned ?? raw}</pattern>`,
      encoderClass: null,
      colorStripped: cleaned !== null,
    };
  }
  return null;
}

/**
 * Resolves ${property} references against the XML's <property> declarations
 * and strips color converters. Returns the cleaned pattern, or null when the
 * pattern carries no colors — in that case the original text (including any
 * ${property} indirection) should be kept as is.
 */
function cleanPatternForFile(pattern: string, xml: string): string | null {
  const resolved = resolvePropertyRefs(pattern, xml);
  const cleaned = stripColorConverters(resolved);
  return cleaned === resolved ? null : cleaned;
}

/** Substitutes ${name} refs declared as <property name value> in the XML. */
function resolvePropertyRefs(pattern: string, xml: string): string {
  const props: Record<string, string> = {};
  for (const tag of xml.matchAll(/<property\b[^>]*>/gi)) {
    const name = tag[0].match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
    const value = tag[0].match(/value\s*=\s*["']([^"']+)["']/i)?.[1];
    if (name && value !== undefined) props[name] = value;
  }

  let resolved = pattern;
  for (let depth = 0; depth < 10; depth++) {
    const next = resolved.replace(/\$\{([\w.-]+)(?::-[^}]*)?\}/g, (whole, name) =>
      props[name] !== undefined ? props[name] : whole,
    );
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
}

/** Logback/Spring Boot converters that only add ANSI color to their content. */
const COLOR_CONVERTERS = new Set([
  'clr', 'highlight', 'black', 'red', 'green', 'yellow', 'blue', 'magenta',
  'cyan', 'white', 'gray', 'boldRed', 'boldGreen', 'boldYellow', 'boldBlue',
  'boldMagenta', 'boldCyan', 'boldWhite',
]);

/** Replaces %clr(X){color} / %highlight(X) / %red(X) … with X, recursively. */
function stripColorConverters(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '%') {
      const name = pattern.slice(i + 1).match(/^([A-Za-z]+)\(/)?.[1];
      if (name && COLOR_CONVERTERS.has(name)) {
        const open = i + 1 + name.length;
        const close = matchingParen(pattern, open);
        if (close !== -1) {
          out += stripColorConverters(pattern.slice(open + 1, close));
          i = close + 1;
          // Drop the optional {color} modifier that follows the group.
          if (pattern[i] === '{') {
            const brace = pattern.indexOf('}', i);
            if (brace !== -1) i = brace + 1;
          }
          continue;
        }
      }
    }
    out += pattern[i];
    i++;
  }
  return out;
}

/** Index of the ')' matching the '(' at `open`, honoring \-escapes; -1 if none. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** class attribute of the <encoder> that contains `layoutBlock`. */
function enclosingEncoderClass(xml: string, layoutBlock: string): string {
  for (const encoder of xml.matchAll(/<encoder\b([^>]*)>([\s\S]*?)<\/encoder>/gi)) {
    if (!encoder[2].includes(layoutBlock)) continue;
    const cls = encoder[1].match(/class\s*=\s*["']([^"']+)["']/i);
    return cls ? cls[1] : LAYOUT_WRAPPING_ENCODER;
  }
  return LAYOUT_WRAPPING_ENCODER;
}

/** Builds the <appender> block, reusing the custom encoder when provided. */
function buildFileAppenderXml(name: string, custom: CustomEncoder | null): string {
  const inner = custom?.inner ?? `<pattern>${GENERIC_PATTERN}</pattern>`;
  const encoderOpen = custom?.encoderClass ? `<encoder class="${custom.encoderClass}">` : '<encoder>';
  return [
    '',
    '    <!-- Added by N1nja: writes the file the MCP reads -->',
    `    <appender name="${name}" class="ch.qos.logback.core.FileAppender">`,
    `        <file>${DEFAULT_LOG_FILE}</file>`,
    `        ${encoderOpen}`,
    `            ${inner}`,
    '        </encoder>',
    '    </appender>',
    '',
  ].join('\n');
}

/** Inserts `block` right before the closing </configuration> tag. */
function insertBeforeClosingConfiguration(xml: string, block: string): string {
  const close = /<\/configuration>/i;
  if (close.test(xml)) {
    return xml.replace(close, `${block}\n</configuration>`);
  }
  // No closing tag (malformed or fragment) — append at the end.
  return `${xml.trimEnd()}\n${block}\n`;
}

/**
 * Adds an <appender-ref> to the first <root> element. Handles both a
 * self-closing <root .../> and a <root>...</root> block. Returns null when
 * there is no <root> to wire into.
 */
function addAppenderRefToRoot(xml: string, appenderName: string): string | null {
  const openClose = xml.match(/<root\b[^>]*>([\s\S]*?)<\/root>/i);
  if (openClose) {
    // Align the new ref with the existing refs (fall back to the </root> indent).
    const existingRef = openClose[1].match(/^([ \t]*)<appender-ref\b/m);
    const closeIndent = openClose[0].match(/\n([ \t]*)<\/root>/i)?.[1] ?? '    ';
    const refIndent = existingRef?.[1] ?? closeIndent + '    ';
    const ref = `${refIndent}<appender-ref ref="${appenderName}"/>`;
    // Replace the whitespace-before-</root> too, so the new ref isn't double-indented.
    const replaced = openClose[0].replace(/\n[ \t]*<\/root>/i, `\n${ref}\n${closeIndent}</root>`);
    return xml.replace(openClose[0], replaced);
  }

  const selfClosing = xml.match(/<root\b([^>]*)\/>/i);
  if (selfClosing) {
    const attrs = selfClosing[1].trimEnd();
    const expanded = `<root${attrs}>\n        <appender-ref ref="${appenderName}"/>\n    </root>`;
    return xml.replace(selfClosing[0], expanded);
  }

  return null;
}

// ── Properties / YAML branch ────────────────────────────────────────────────

/** Dispatches to the .properties or .yml writer based on the file extension. */
export function configureAppConfigFile(file: string): FileChange {
  return file.endsWith('.properties') ? configurePropertiesFile(file) : configureYamlFile(file);
}

/** Adds the logging.file.name + logging.level.* keys to a .properties file. */
function configurePropertiesFile(file: string): FileChange {
  const original = fs.readFileSync(file, 'utf8');
  const notes: string[] = [];
  const additions: string[] = [];

  if (!new RegExp(`^\\s*logging\\.file\\.name\\s*[=:]`, 'm').test(original)) {
    additions.push(`logging.file.name=${DEFAULT_LOG_FILE}`);
  } else {
    notes.push('logging.file.name already set — left as is.');
  }

  for (const { name, level } of HIBERNATE_LOGGERS) {
    const key = `logging.level.${name}`;
    const escaped = key.replace(/\./g, '\\.');
    if (!new RegExp(`^\\s*${escaped}\\s*[=:]`, 'm').test(original)) {
      additions.push(`${key}=${level}`);
    }
  }

  if (additions.length === 0) {
    notes.push('All required logging properties already present.');
    return { file, action: 'unchanged', notes };
  }

  const block = ['', '# Added by N1nja — Hibernate SQL logging', ...additions, ''].join('\n');
  fs.writeFileSync(file, ensureTrailingNewline(original) + block + '\n', 'utf8');
  notes.push(`Added ${additions.length} logging propert${additions.length === 1 ? 'y' : 'ies'}.`);
  return { file, action: 'updated', notes };
}

/**
 * Adds the logging config to a YAML file as a flat `logging.*`-style block.
 * Spring accepts flat dotted keys in YAML, which lets us append safely without
 * having to merge into an existing nested `logging:` tree.
 */
function configureYamlFile(file: string): FileChange {
  const original = fs.readFileSync(file, 'utf8');
  const notes: string[] = [];

  // Detect what's already there via flattened dotted keys.
  const flat = flattenYaml(original);
  const additions: string[] = [];

  if (flat['logging.file.name'] === undefined) {
    additions.push(`"logging.file.name": ${DEFAULT_LOG_FILE}`);
  } else {
    notes.push('logging.file.name already set — left as is.');
  }
  for (const { name, level } of HIBERNATE_LOGGERS) {
    const key = `logging.level.${name}`;
    if (flat[key] === undefined) {
      additions.push(`"${key}": ${level}`);
    }
  }

  if (additions.length === 0) {
    notes.push('All required logging config already present.');
    return { file, action: 'unchanged', notes };
  }

  const block = ['', '# Added by N1nja — Hibernate SQL logging', ...additions, ''].join('\n');
  fs.writeFileSync(file, ensureTrailingNewline(original) + block + '\n', 'utf8');
  notes.push(`Added ${additions.length} logging key(s) as flat dotted keys.`);
  return { file, action: 'updated', notes };
}

/** Creates src/main/resources/application.properties with the logging config. */
function createApplicationProperties(projectRoot: string): FileChange {
  const dir = path.join(projectRoot, 'src', 'main', 'resources');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'application.properties');

  const lines = [
    '# Created by N1nja — Hibernate SQL logging',
    `logging.file.name=${DEFAULT_LOG_FILE}`,
    ...HIBERNATE_LOGGERS.map(({ name, level }) => `logging.level.${name}=${level}`),
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return {
    file,
    action: 'created',
    notes: ['No logback or application config found — created a fresh application.properties.'],
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureTrailingNewline(s: string): string {
  if (s === '' || s.endsWith('\n')) return s;
  return s + '\n';
}

/**
 * Flattens a Spring-style YAML file into dotted keys. Mirrors the reader in
 * spring-datasource.ts: nested `key:` lines build the path, and both nested
 * and pre-flattened dotted keys (`logging.level.x: DEBUG`) are recognized.
 */
function flattenYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    const m = line.match(/^["']?([\w.-]+)["']?\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (rawValue === '') {
      stack.push({ indent, key });
      continue;
    }

    const fullKey = [...stack.map((p) => p.key), key].join('.');
    result[fullKey] = rawValue.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }

  return result;
}

// ── Markdown report ────────────────────────────────────────────────────────────

function buildMarkdown(r: Omit<SetupLoggingResult, 'markdownReport'>): string {
  const lines: string[] = [];
  lines.push('# 🥷 N1nja — Logging Setup');
  lines.push('');

  const scenarioLabel: Record<Scenario, string> = {
    logback: 'Custom Logback config detected — configured the XML (Spring ignores the logging.* properties when Logback is present).',
    properties: 'No Logback config — configured application.properties/yml (base + every profile variant).',
    'created-properties': 'No config found — created a fresh application.properties.',
  };

  lines.push(`> **Project:** \`${r.projectRoot}\``);
  lines.push(`> **Scenario:** ${scenarioLabel[r.scenario]}`);
  lines.push(`> **Log file:** \`${r.logFile}\``);
  lines.push('');

  const changed = r.changes.filter((c) => c.action !== 'unchanged');
  lines.push(`## Files (${changed.length} changed, ${r.changes.length} inspected)`);
  lines.push('');
  for (const c of r.changes) {
    const icon = c.action === 'created' ? '🆕' : c.action === 'updated' ? '✏️' : '✅';
    lines.push(`### ${icon} \`${c.file}\` — ${c.action}`);
    for (const n of c.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push('## Next steps');
  lines.push('');
  lines.push('1. Restart your Spring Boot app so the new logging config takes effect.');
  lines.push('2. Exercise the endpoints/flows that trigger the queries (the log must contain real queries).');
  lines.push('3. Run `full_scan` to analyze the captured log.');

  return lines.join('\n');
}
