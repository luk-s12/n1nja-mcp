import { normalizeSql } from '../parsing/sql-normalizer';
import { RepositoryUsage } from './repository-scanner';

/**
 * Fingerprint matching between native @Query SQL and the SQL captured in the
 * Hibernate log.
 *
 * Native queries (`@Query(nativeQuery = true)`) are executed almost verbatim:
 * Hibernate only replaces the named/positional parameters with `?`. So the
 * annotation text and the logged SQL converge to the SAME string once both go
 * through the shared normalizer — which gives a direct, deterministic
 * attribution "this log query IS RepositoryX.methodY".
 *
 * JPQL queries are out of scope: Hibernate translates them to SQL with
 * generated aliases (t1_0, ...), so the annotation text never matches the log.
 * Dynamically-built SQL (Criteria, EntityManager.createNativeQuery with
 * concatenated variables) has no static text to fingerprint either.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type MatchConfidence = 'exact' | 'no-pagination';

export interface QueryFingerprintMatch {
  usage: RepositoryUsage;
  /**
   * 'exact' — the normalized SQL strings are identical.
   * 'no-pagination' — identical after stripping the trailing LIMIT/OFFSET
   * Hibernate appends when the method takes a Pageable.
   */
  confidence: MatchConfidence;
}

export interface QueryFingerprintIndex {
  exact: Map<string, RepositoryUsage[]>;
  noPagination: Map<string, RepositoryUsage[]>;
  /** Number of native @Query methods indexed. */
  size: number;
}

// ── Fingerprinting ──────────────────────────────────────────────────────────

/**
 * Normalizes the SQL text of a @Query annotation to the same shape the log
 * side produces: JPA parameters (`:name`, `?1`, SpEL `?#{...}`/`:#{...}`)
 * become `?`, then the shared normalizeSql collapses literals and casing.
 */
export function fingerprintAnnotationSql(sql: string): string {
  let s = sql;
  s = s.replace(/[?:]#\{[^}]*\}/g, '?'); // SpEL expressions
  s = s.replace(/(?<!:):\w+/g, '?'); // named params (:id) — not '::' casts
  s = s.replace(/\?\d+/g, '?'); // positional params (?1)
  return canonicalizeSpacing(normalizeSql(s));
}

/**
 * Removes cosmetic spacing around operators and punctuation: the annotation
 * usually reads `desk_id = :deskId` while Hibernate logs `desk_id=?`. Applied
 * identically to both sides, so equality is spacing-insensitive.
 */
function canonicalizeSpacing(s: string): string {
  return s.replace(/\s*([=<>!,()])\s*/g, '$1');
}

/**
 * Removes a trailing pagination clause from a normalized query, so a Pageable
 * method (whose annotation has no LIMIT) can match its logged SQL (which does).
 */
export function stripPaginationSuffix(normalized: string): string {
  return normalized
    .replace(/\s+limit\s+\?(?:\s*,\s*\?)?(?:\s+offset\s+\?)?\s*$/i, '')
    .replace(/\s+offset\s+\?(?:\s+rows)?\s*$/i, '')
    .replace(/\s+fetch\s+(?:first|next)\s+\?\s+rows?\s+only\s*$/i, '')
    .trim();
}

// ── Index ───────────────────────────────────────────────────────────────────

/** Indexes every native @Query by its fingerprint (and pagination-stripped one). */
export function buildQueryFingerprintIndex(usages: RepositoryUsage[]): QueryFingerprintIndex {
  const exact = new Map<string, RepositoryUsage[]>();
  const noPagination = new Map<string, RepositoryUsage[]>();
  let size = 0;

  for (const usage of usages) {
    if (usage.kind !== 'query_annotation' || !usage.isNative || !usage.queryText) continue;
    const fingerprint = fingerprintAnnotationSql(usage.queryText);
    if (!fingerprint) continue;
    size++;
    push(exact, fingerprint, usage);
    push(noPagination, stripPaginationSuffix(fingerprint), usage);
  }

  return { exact, noPagination, size };
}

function push(map: Map<string, RepositoryUsage[]>, key: string, usage: RepositoryUsage): void {
  const list = map.get(key);
  if (list) list.push(usage);
  else map.set(key, [usage]);
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Matches a query from the log (raw or already normalized — normalization is
 * idempotent) against the index. Returns every method whose fingerprint
 * matches: more than one result means the same SQL is declared in several
 * places and the caller should present all candidates, not pick blindly.
 */
export function matchQueryFingerprint(
  logSql: string,
  index: QueryFingerprintIndex,
): QueryFingerprintMatch[] {
  if (index.size === 0) return [];

  const fingerprint = canonicalizeSpacing(normalizeSql(logSql));
  const exact = index.exact.get(fingerprint);
  if (exact?.length) {
    return exact.map((usage) => ({ usage, confidence: 'exact' as const }));
  }

  const stripped = stripPaginationSuffix(fingerprint);
  if (stripped !== fingerprint) {
    const paged = index.noPagination.get(stripped);
    if (paged?.length) {
      return paged.map((usage) => ({ usage, confidence: 'no-pagination' as const }));
    }
  }

  return [];
}
