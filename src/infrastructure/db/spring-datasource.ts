import * as fs from 'fs';
import * as path from 'path';
import type { DbType } from './db-config';

/**
 * DB connection values extracted from a Spring Boot project's
 * application.properties / application.yml (spring.datasource.*).
 */
export interface SpringDatasourceValues {
  type?: DbType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** File the values were read from (for error/status messages) */
  sourceFile: string;
}

/** Directories searched for Spring config files, relative to the project root. */
const CONFIG_DIRS = ['src/main/resources', '.'];

/** Matches application.properties, application.yml and profile variants (application-ci.yml). */
const CONFIG_FILE = /^application(?:-([\w.-]+))?\.(properties|ya?ml)$/i;

/**
 * Searches `projectRoot` for Spring Boot config files and extracts the
 * spring.datasource.* connection values. Handles base files and
 * `application-{profile}` variants:
 *
 *  1. The base application.properties/yml is tried first.
 *  2. When it has no datasource URL, profile files are tried, each merged
 *     over the base (profile values win, as Spring does at runtime). Active
 *     profiles — from SPRING_PROFILES_ACTIVE or the base's
 *     spring.profiles.active — are tried before the rest (alphabetical).
 *
 * Returns null when no file yields a datasource URL.
 */
export function loadSpringDatasource(projectRoot: string): SpringDatasourceValues | null {
  for (const dir of CONFIG_DIRS) {
    const result = loadFromConfigDir(path.join(projectRoot, dir));
    if (result) return result;
  }
  return null;
}

function loadFromConfigDir(dir: string): SpringDatasourceValues | null {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dir).filter((f) => CONFIG_FILE.test(f));
  } catch {
    return null;
  }
  if (fileNames.length === 0) return null;

  const baseFiles = fileNames.filter((f) => !profileOf(f)).sort(byExtensionPriority);
  const profileFiles = fileNames.filter((f) => profileOf(f));

  // ── Base config (application.properties / application.yml) ────────────────
  const base: Record<string, string> = {};
  let baseSource: string | undefined;
  for (const fileName of baseFiles) {
    const flat = parseConfigFile(path.join(dir, fileName));
    if (!flat) continue;
    Object.assign(base, flat);
    if (flat['spring.datasource.url']) baseSource = path.join(dir, fileName);
  }

  const fromBase = extractDatasource(base, baseSource);
  if (fromBase) return fromBase;

  // ── Profile configs, merged over the base ─────────────────────────────────
  for (const fileName of orderByActiveProfile(profileFiles, base)) {
    const filePath = path.join(dir, fileName);
    const flat = parseConfigFile(filePath);
    if (!flat) continue;

    const merged = { ...base, ...flat };
    const result = extractDatasource(merged, filePath);
    if (result) return result;
  }

  return null;
}

/** Profile name of a config file, or undefined for base files: application-ci.yml → "ci" */
function profileOf(fileName: string): string | undefined {
  return fileName.match(CONFIG_FILE)?.[1];
}

/** .properties before .yml/.yaml, mirroring Spring's own load order. */
function byExtensionPriority(a: string, b: string): number {
  const rank = (f: string): number => (f.endsWith('.properties') ? 0 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Orders profile files so active profiles come first: SPRING_PROFILES_ACTIVE
 * takes precedence over the base config's spring.profiles.active; the
 * remaining profiles follow alphabetically for deterministic results.
 */
function orderByActiveProfile(profileFiles: string[], base: Record<string, string>): string[] {
  const activeRaw = process.env.SPRING_PROFILES_ACTIVE ?? base['spring.profiles.active'] ?? '';
  const active = activeRaw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);

  const rank = (fileName: string): number => {
    const idx = active.indexOf(profileOf(fileName)?.toLowerCase() ?? '');
    return idx === -1 ? active.length : idx;
  };

  return [...profileFiles].sort((a, b) => rank(a) - rank(b) || byExtensionPriority(a, b));
}

/** Parses a config file into a flat key → value map, or null if unreadable. */
function parseConfigFile(filePath: string): Record<string, string> | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return filePath.endsWith('.properties') ? parseProperties(content) : parseSimpleYaml(content);
}

/** Builds the datasource values from a flat config map, or null when there is no usable URL. */
function extractDatasource(
  flat: Record<string, string>,
  sourceFile: string | undefined,
): SpringDatasourceValues | null {
  const url = resolvePlaceholders(flat['spring.datasource.url']);
  if (!url || !sourceFile) return null;

  const parsed = parseJdbcUrl(url);
  if (!parsed) return null;

  return {
    ...parsed,
    user: resolvePlaceholders(flat['spring.datasource.username']),
    password: resolvePlaceholders(flat['spring.datasource.password']),
    sourceFile,
  };
}

/**
 * Parses a JDBC URL into connection parts. MariaDB URLs are treated as MySQL
 * (same wire protocol and driver behavior for our purposes).
 *   jdbc:postgresql://localhost:5432/mydb
 *   jdbc:mysql://db.example.com/shop?useSSL=false
 */
export function parseJdbcUrl(
  url: string,
): { type: DbType; host: string; port?: number; database: string } | null {
  const m = url.match(/^jdbc:(postgresql|mysql|mariadb):\/\/([^/:?]+)(?::(\d+))?\/([^?;]+)/i);
  if (!m) return null;
  return {
    type: m[1].toLowerCase() === 'postgresql' ? 'postgresql' : 'mysql',
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : undefined,
    database: m[4],
  };
}

/**
 * Resolves Spring `${VAR}` / `${VAR:default}` placeholders against the
 * process environment. Returns undefined when a placeholder has no value —
 * a literal "${DB_PASSWORD}" must not be used as an actual password.
 */
function resolvePlaceholders(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  let unresolved = false;
  const resolved = value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_all, name: string, fallback?: string) => {
    const envValue = process.env[name.trim()] ?? fallback;
    if (envValue === undefined) {
      unresolved = true;
      return '';
    }
    return envValue;
  });

  return unresolved ? undefined : resolved;
}

/** Parses .properties content into a flat key → value map (supports `=` and `:` separators). */
function parseProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const sepIndex = Math.min(
      ...['=', ':'].map((sep) => {
        const idx = line.indexOf(sep);
        return idx === -1 ? Number.POSITIVE_INFINITY : idx;
      }),
    );
    if (!Number.isFinite(sepIndex)) continue;

    const key = line.slice(0, sepIndex).trim();
    const value = line.slice(sepIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Minimal YAML reader for the flat `key: value` maps used by Spring config
 * files. Tracks the indentation path so nested keys flatten to dotted form
 * (spring.datasource.url). Lists, anchors, and multi-line scalars are ignored —
 * datasource credentials never need them.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pathStack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    const m = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;

    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      pathStack.pop();
    }

    if (rawValue === '') {
      pathStack.push({ indent, key });
      continue;
    }

    const fullKey = [...pathStack.map((p) => p.key), key].join('.');
    const value = rawValue.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    result[fullKey] = value;
  }

  return result;
}
