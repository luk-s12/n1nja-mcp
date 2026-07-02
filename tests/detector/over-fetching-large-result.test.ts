import { detectOverFetching } from '../../src/core/detection/select-star.detector';
import { detectLargeResultSets } from '../../src/core/detection/large-result-set.detector';
import { detectDuplicateQueries } from '../../src/core/detection/duplicate-query.detector';
import { aggregateQueries } from '../../src/core/detection/query-aggregator';
import { ParsedQuery } from '../../src/domain/models/query.model';
import { DEFAULT_CONFIG } from '../../src/domain/models/config.model';
import { normalizeSql } from '../../src/core/parsing/sql-normalizer';

function q(rawSql: string, lineNumber = 1, extra: Partial<ParsedQuery> = {}): ParsedQuery {
  return { rawSql, normalizedSql: normalizeSql(rawSql), parameters: [], lineNumber, ...extra };
}

// ---------------------------------------------------------------------------
describe('detectOverFetching (literal SELECT *)', () => {
  it('flags a SELECT * query', () => {
    const issues = detectOverFetching([q('select * from expenses')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('OVER_FETCHING');
  });

  it('flags qualified star (alias.*)', () => {
    const issues = detectOverFetching([q('select e.* from expenses e')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('OVER_FETCHING');
  });

  it('does not flag an explicit column projection', () => {
    const issues = detectOverFetching([q('select id, name from expenses')]);
    expect(issues).toHaveLength(0);
  });

  it('deduplicates identical SELECT * but counts every execution', () => {
    const issues = detectOverFetching([
      q('select * from expenses', 1),
      q('select * from expenses', 2),
      q('select * from expenses', 3),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].executions).toBe(3);
  });

  it('escalates to MEDIUM severity at high execution counts', () => {
    const queries = Array.from({ length: 50 }, (_, i) => q('select * from expenses', i));
    const issues = detectOverFetching(queries);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('MEDIUM');
  });

  it('stays LOW severity for few executions', () => {
    const issues = detectOverFetching([q('select * from expenses')]);
    expect(issues[0].severity).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
describe('detectLargeResultSets', () => {
  it('flags a query whose total rows exceed the threshold', () => {
    const groups = aggregateQueries([q('select * from member', 1, { rowCount: 1500 })]);
    const issues = detectLargeResultSets(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('LARGE_RESULT_SET');
    expect(issues[0].rows).toBe(1500);
    expect(issues[0].severity).toBe('MEDIUM');
  });

  it('does not flag queries below the threshold', () => {
    const groups = aggregateQueries([q('select * from member', 1, { rowCount: 100 })]);
    const issues = detectLargeResultSets(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });

  it('aggregates rows across executions of the same query', () => {
    const groups = aggregateQueries([
      q('select * from member', 1, { rowCount: 600 }),
      q('select * from member', 2, { rowCount: 600 }),
    ]);
    const issues = detectLargeResultSets(groups, DEFAULT_CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].rows).toBe(1200);
  });

  it('marks HIGH severity when rows are 5x over the threshold', () => {
    const groups = aggregateQueries([q('select * from member', 1, { rowCount: 5000 })]);
    const issues = detectLargeResultSets(groups, DEFAULT_CONFIG);
    expect(issues[0].severity).toBe('HIGH');
  });

  it('sorts results by row count descending', () => {
    const groups = aggregateQueries([
      q('select * from a', 1, { rowCount: 1200 }),
      q('select * from b', 2, { rowCount: 6000 }),
    ]);
    const issues = detectLargeResultSets(groups, DEFAULT_CONFIG);
    expect(issues.map((i) => i.rows)).toEqual([6000, 1200]);
  });
});

// ---------------------------------------------------------------------------
describe('detectDuplicateQueries (per-request / per-thread)', () => {
  it('flags the same SQL fired twice in one thread as HIGH', () => {
    const sql = 'select * from user where id=1';
    const queries = [
      q(sql, 1, { threadName: 'http-nio-exec-1' }),
      q(sql, 2, { threadName: 'http-nio-exec-1' }),
    ];
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set(), DEFAULT_CONFIG, queries);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('HIGH');
    expect(issues[0].maxPerRequest).toBe(2);
  });

  it('does not flag distinct-param WHERE queries as a per-request (HIGH) duplicate', () => {
    // Distinct params on a WHERE query look like lazy-loading in a loop (N+1),
    // so the per-request pass skips them. The global pass may still flag them
    // as MEDIUM, but never as the HIGH per-request severity.
    const sql = 'select * from user where id=?';
    const queries = [
      q(sql, 1, { threadName: 't1', parameters: ['1'] }),
      q(sql, 2, { threadName: 't1', parameters: ['2'] }),
    ];
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set(), DEFAULT_CONFIG, queries);
    expect(issues.every((i) => i.maxPerRequest === undefined)).toBe(true);
    expect(issues.every((i) => i.severity !== 'HIGH')).toBe(true);
  });

  it('skips queries already classified as N+1 entirely', () => {
    const sql = 'select * from user where id=?';
    const normalized = normalizeSql(sql);
    const queries = [
      q(sql, 1, { threadName: 't1', parameters: ['1'] }),
      q(sql, 2, { threadName: 't1', parameters: ['2'] }),
    ];
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set([normalized]), DEFAULT_CONFIG, queries);
    expect(issues).toHaveLength(0);
  });

  it('does not double-flag a per-request duplicate in the global pass', () => {
    const sql = 'select * from user where id=1';
    const queries = [
      q(sql, 1, { threadName: 't1' }),
      q(sql, 2, { threadName: 't1' }),
    ];
    const groups = aggregateQueries(queries);
    const issues = detectDuplicateQueries(groups, new Set(), DEFAULT_CONFIG, queries);
    expect(issues).toHaveLength(1);
  });
});