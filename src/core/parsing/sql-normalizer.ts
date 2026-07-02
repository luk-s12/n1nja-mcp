/**
 * SQL Normalization Engine
 *
 * Replaces concrete literal values (numbers, strings, UUIDs, dates, timestamps)
 * with placeholders so that structurally identical queries can be grouped together.
 */

/** UUID pattern: 8-4-4-4-12 hex characters */
const UUID_PATTERN = /['"]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]?/gi;

/** ISO date/timestamp: 2024-01-15 or 2024-01-15T10:30:00 or 2024-01-15 10:30:00 */
const TIMESTAMP_PATTERN = /['"]?\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?['"]?/g;

/** Quoted strings: 'anything' */
const QUOTED_STRING_PATTERN = /'(?:[^'\\]|\\.)*'/g;

/** Numeric literals (not part of identifiers) */
const NUMERIC_PATTERN = /(?<![.\w])\d+(?:\.\d+)?(?![.\w])/g;

/** IN clause list: (1, 2, 3) or ('a', 'b') → (?) */
const IN_LIST_PATTERN = /\(\s*\?(?:\s*,\s*\?)*\s*\)/g;

/**
 * Normalizes a SQL string so that structurally identical queries group together:
 * collapses whitespace, replaces literal values (UUIDs, dates, strings, numbers)
 * with `?`, collapses IN-lists, and lowercases.
 */
export function normalizeSql(sql: string): string {
  let normalized = sql.trim();

  normalized = normalized.replace(/\s+/g, ' ');

  // UUIDs before quoted strings to avoid partial matches
  normalized = normalized.replace(UUID_PATTERN, '?');

  normalized = normalized.replace(TIMESTAMP_PATTERN, (match) => {
    if (/\d{4}-\d{2}-\d{2}/.test(match)) return '?';
    return match;
  });

  normalized = normalized.replace(QUOTED_STRING_PATTERN, '?');
  normalized = normalized.replace(NUMERIC_PATTERN, '?');
  normalized = normalized.replace(IN_LIST_PATTERN, '(?)'); // ?, ?, ? → (?)

  normalized = normalized.toLowerCase().trim();

  return normalized;
}

/**
 * Extracts the table name(s) from a SELECT statement.
 * Returns the first FROM target — useful for quick entity correlation.
 */
export function extractTableName(sql: string): string | null {
  const match = sql.match(/\bfrom\s+["'`]?(\w+)["'`]?/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Counts the number of JOIN clauses in a SQL string.
 */
export function countJoins(sql: string): number {
  const matches = sql.match(/\b(?:inner|left|right|full|cross)?\s*(?:outer\s+)?join\b/gi);
  return matches ? matches.length : 0;
}

/**
 * Returns true if the query appears to have no pagination (LIMIT / OFFSET / FETCH FIRST).
 */
export function lacksPagination(sql: string): boolean {
  return !/\b(limit|offset|fetch\s+(?:first|next)|rownum|top\s+\d)\b/i.test(sql);
}

/**
 * Returns true if the query is a SELECT (not an INSERT/UPDATE/DELETE).
 */
export function isSelectQuery(sql: string): boolean {
  return /^\s*select\b/i.test(sql.trimStart());
}
