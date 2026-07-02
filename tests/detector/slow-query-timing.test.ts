import { HibernateLogParser } from '../../src/core/parsing/log-parser';
import { ParsedQuery } from '../../src/domain/models/query.model';
import { detectSlowQueryPatterns } from '../../src/core/detection/slow-query-pattern.detector';

/**
 * Regression tests for timing-based slow-query detection.
 *
 * Bug history: the elapsed-time regex had `completed in` glued directly to `(\d+)`,
 * so an application log line like `Query completed in 50ms` (with a space after "in")
 * never matched. The query was then treated as having no timing and reported via pure
 * static analysis, even though the timing log was present.
 */

/** Feeds raw log lines to a fresh parser and returns the emitted queries. */
function parseLines(lines: string[]): ParsedQuery[] {
  const queries: ParsedQuery[] = [];
  const parser = new HibernateLogParser((query) => queries.push(query));
  for (const line of lines) parser.processLine(line);
  parser.flush();
  return queries;
}

const SQL_BLOCK = [
  '2026-06-21 15:06:34.880 [http-nio-8080-exec-1] DEBUG org.hibernate.SQL - ',
  '    SELECT',
  '        * ',
  '    FROM',
  '        customer ',
  '    WHERE',
  '        LOWER(name) LIKE LOWER(?) ',
  '        OR LOWER(email) LIKE LOWER(?)',
  '2026-06-21 15:06:34.882 [http-nio-8080-exec-1] TRACE org.hibernate.orm.jdbc.bind - binding parameter (1:VARCHAR) <- [%john%]',
  '2026-06-21 15:06:34.882 [http-nio-8080-exec-1] TRACE org.hibernate.orm.jdbc.bind - binding parameter (2:VARCHAR) <- [%john%]',
];

const TIMING_LINE =
  '2026-06-21 15:06:34.890 [http-nio-8080-exec-1] WARN  c.e.demo.service.ProblemService - Query completed in 50ms';

describe('parser: elapsed-time extraction', () => {
  it('captures timing from "Query completed in 50ms" (space after "in")', () => {
    const queries = parseLines([...SQL_BLOCK, TIMING_LINE]);
    expect(queries).toHaveLength(1);
    expect(queries[0].executionTimeMs).toBe(50);
  });

  it('leaves executionTimeMs undefined when no timing line is present', () => {
    const queries = parseLines([...SQL_BLOCK]);
    expect(queries).toHaveLength(1);
    expect(queries[0].executionTimeMs).toBeUndefined();
  });

  it.each([
    ['Query completed in 50ms', 50],
    ['Query completed in   120ms', 120],
    ['elapsed: 33ms', 33],
    ['took 80 ms', 80],
    ['duration: 12ms', 12],
  ])('captures timing from "%s"', (msg, expected) => {
    const line = `2026-06-21 15:06:34.890 [http-nio-8080-exec-1] WARN  c.e.demo.Svc - ${msg}`;
    const queries = parseLines([...SQL_BLOCK, line]);
    expect(queries[0].executionTimeMs).toBe(expected);
  });
});

describe('detectSlowQueryPatterns: timing confirmation', () => {
  it('confirms via timing when a measured time is present (not pattern-based)', () => {
    const queries = parseLines([...SQL_BLOCK, TIMING_LINE]);
    const issues = detectSlowQueryPatterns(queries);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('SLOW_QUERY');
    expect(issues[0].isPatternBased).toBe(false);
    expect(issues[0].executionTimeMs).toBe(50);
  });

  it('falls back to static analysis when no timing is present', () => {
    const queries = parseLines([...SQL_BLOCK]);
    const issues = detectSlowQueryPatterns(queries);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('SLOW_QUERY');
    expect(issues[0].isPatternBased).toBe(true);
    expect(issues[0].executionTimeMs).toBe(0);
  });
});