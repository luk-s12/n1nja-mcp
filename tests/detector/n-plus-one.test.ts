import { detectNPlusOne } from '../../src/core/detection/n-plus-one.detector';
import { aggregateQueries } from '../../src/core/detection/query-aggregator';
import { ParsedQuery } from '../../src/domain/models/query.model';
import { DEFAULT_CONFIG } from '../../src/domain/models/config.model';
import { normalizeSql } from '../../src/core/parsing/sql-normalizer';

function makeQuery(rawSql: string, lineNumber: number): ParsedQuery {
  return {
    rawSql,
    normalizedSql: normalizeSql(rawSql),
    parameters: [],
    lineNumber,
  };
}

describe('detectNPlusOne', () => {
  it('detects N+1 when same normalized query is executed above threshold', () => {
    const queries: ParsedQuery[] = [
      makeQuery('select * from groups', 1),
      ...Array.from({ length: 15 }, (_, i) =>
        makeQuery(`select * from member where group_id=${i + 1}`, i + 2),
      ),
    ];

    const groups = aggregateQueries(queries);
    const orderedSummary = queries.map((q) => ({
      normalizedSql: q.normalizedSql,
      rawSql: q.rawSql,
      lineNumber: q.lineNumber,
    }));

    const issues = detectNPlusOne(groups, orderedSummary, DEFAULT_CONFIG);

    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].type).toBe('N_PLUS_1');
    expect(issues[0].severity).toBe('HIGH');
    expect(issues[0].executions).toBe(15);
    expect(issues[0].estimatedExtraQueries).toBe(14);
  });

  it('does not flag queries below threshold', () => {
    const queries: ParsedQuery[] = Array.from({ length: 5 }, (_, i) =>
      makeQuery(`select * from member where group_id=${i + 1}`, i),
    );

    const groups = aggregateQueries(queries);
    const orderedSummary = queries.map((q) => ({
      normalizedSql: q.normalizedSql,
      rawSql: q.rawSql,
      lineNumber: q.lineNumber,
    }));

    const issues = detectNPlusOne(groups, orderedSummary, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });

  it('infers parent query correctly', () => {
    const queries: ParsedQuery[] = [
      makeQuery('select * from groups', 1),
      ...Array.from({ length: 12 }, (_, i) =>
        makeQuery(`select * from member where group_id=${i + 1}`, i + 2),
      ),
    ];

    const groups = aggregateQueries(queries);
    const orderedSummary = queries.map((q) => ({
      normalizedSql: q.normalizedSql,
      rawSql: q.rawSql,
      lineNumber: q.lineNumber,
    }));

    const issues = detectNPlusOne(groups, orderedSummary, DEFAULT_CONFIG);
    expect(issues[0].parentQuery).toContain('groups');
  });

  it('does not flag queries without WHERE clause (non-N+1 pattern)', () => {
    const queries: ParsedQuery[] = Array.from({ length: 20 }, (_, i) =>
      makeQuery('select * from member', i),
    );

    const groups = aggregateQueries(queries);
    const orderedSummary = queries.map((q) => ({
      normalizedSql: q.normalizedSql,
      rawSql: q.rawSql,
      lineNumber: q.lineNumber,
    }));

    // Queries without WHERE are not N+1 pattern
    const issues = detectNPlusOne(groups, orderedSummary, DEFAULT_CONFIG);
    expect(issues).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    const config = { ...DEFAULT_CONFIG, nPlusOneThreshold: 3 };
    const queries: ParsedQuery[] = Array.from({ length: 5 }, (_, i) =>
      makeQuery(`select * from member where group_id=${i + 1}`, i),
    );

    const groups = aggregateQueries(queries);
    const orderedSummary = queries.map((q) => ({
      normalizedSql: q.normalizedSql,
      rawSql: q.rawSql,
      lineNumber: q.lineNumber,
    }));

    const issues = detectNPlusOne(groups, orderedSummary, config);
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});
