import { detectMissingPagination } from '../../src/core/detection/missing-pagination.detector';
import { detectDuplicateQueries } from '../../src/core/detection/duplicate-query.detector';
import { detectSlowQueries } from '../../src/core/detection/slow-query.detector';
import { detectSlowQueryPatterns } from '../../src/core/detection/slow-query-pattern.detector';
import { detectCartesianProducts } from '../../src/core/detection/cartesian-product.detector';
import { aggregateQueries } from '../../src/core/detection/query-aggregator';
import { ParsedQuery } from '../../src/domain/models/query.model';
import { DEFAULT_CONFIG } from '../../src/domain/models/config.model';
import { normalizeSql } from '../../src/core/parsing/sql-normalizer';

function q(rawSql: string, lineNumber = 1, extra: Partial<ParsedQuery> = {}): ParsedQuery {
  return { rawSql, normalizedSql: normalizeSql(rawSql), parameters: [], lineNumber, ...extra };
}

// ---------------------------------------------------------------------------
describe('detectMissingPagination', () => {
  it('flags a full-table SELECT without WHERE or LIMIT', () => {
    const queries = [q('select * from expenses')];
    const issues = detectMissingPagination(queries);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('MISSING_PAGINATION');
    expect(issues[0].severity).toBe('HIGH');
  });

  it('does not flag when LIMIT is present', () => {
    const queries = [q('select * from expenses limit 20')];
    const issues = detectMissingPagination(queries);
    expect(issues).toHaveLength(0);
  });

  it('does not flag SELECT with WHERE clause', () => {
    const queries = [q('select * from expenses where user_id=1')];
    const issues = detectMissingPagination(queries);
    expect(issues).toHaveLength(0);
  });

  it('deduplicates: same query flagged only once', () => {
    const queries = [
      q('select * from expenses', 1),
      q('select * from expenses', 2),
      q('select * from expenses', 3),
    ];
    const issues = detectMissingPagination(queries);
    expect(issues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('detectDuplicateQueries', () => {
  it('flags a query executed above threshold', () => {
    const queries = Array.from({ length: 10 }, (_, i) =>
      q('select * from user where id=1', i),
    );
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set(), DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('DUPLICATE_QUERY');
    expect(issues[0].executions).toBe(10);
  });

  it('skips queries already flagged as N+1', () => {
    const sql = 'select * from user where id=1';
    const normalized = normalizeSql(sql);
    const queries = Array.from({ length: 10 }, (_, i) => q(sql, i));
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set([normalized]), DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('detectSlowQueries', () => {
  it('flags queries exceeding slow query threshold', () => {
    const queries = [q('select * from order', 1, { executionTimeMs: 1200 })];
    const groups = aggregateQueries(queries);
    const issues = detectSlowQueries(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('SLOW_QUERY');
    expect(issues[0].executionTimeMs).toBe(1200);
  });

  it('does not flag fast queries', () => {
    const queries = [q('select * from order', 1, { executionTimeMs: 50 })];
    const groups = aggregateQueries(queries);
    const issues = detectSlowQueries(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });

  it('does not flag queries without timing data', () => {
    const queries = [q('select * from order', 1)]; // no executionTimeMs
    const groups = aggregateQueries(queries);
    const issues = detectSlowQueries(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('detectSlowQueryPatterns', () => {
  it('confirms the anti-pattern with the measured timing when the query has timing', () => {
    const queries = [q('select * from member where lower(name) like ?', 1, { executionTimeMs: 50 })];

    const issues = detectSlowQueryPatterns(queries);
    expect(issues).toHaveLength(1);
    expect(issues[0].isPatternBased).toBe(false);
    expect(issues[0].executionTimeMs).toBe(50);
  });

  it('falls back to static (pattern-based) analysis when the query has no timing', () => {
    const queries = [q('select * from member where lower(name) like ?', 1)];

    const issues = detectSlowQueryPatterns(queries);
    expect(issues).toHaveLength(1);
    expect(issues[0].isPatternBased).toBe(true);
    expect(issues[0].executionTimeMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('detectCartesianProducts', () => {
  it('flags queries with multiple JOIN FETCH', () => {
    const sql =
      'select g from Group g left join fetch g.members left join fetch g.tags left join fetch g.roles';
    const queries = [q(sql, 1)];
    const issues = detectCartesianProducts(queries, DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('POSSIBLE_CARTESIAN_PRODUCT');
  });

  it('does not flag simple queries without joins', () => {
    const queries = [q('select * from member where id=1')];
    const issues = detectCartesianProducts(queries, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });

  it('deduplicates: same SQL pattern flagged once', () => {
    const sql = 'select g from Group g left join fetch g.members left join fetch g.tags left join fetch g.roles';
    const queries = [q(sql, 1), q(sql, 2), q(sql, 3)];
    const issues = detectCartesianProducts(queries, DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
  });
});
