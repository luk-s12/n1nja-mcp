import { HibernateLogParser } from '../../src/core/parsing/log-parser';
import { ParsedQuery } from '../../src/domain/models/query.model';

function parseLines(lines: string[]): ParsedQuery[] {
  const collected: ParsedQuery[] = [];
  const parser = new HibernateLogParser((q) => collected.push(q));
  for (const line of lines) parser.processLine(line);
  parser.flush();
  return collected;
}

describe('HibernateLogParser', () => {
  it('parses a simple Hibernate: prefixed query', () => {
    const lines = [
      'Hibernate: select g1_0.id,g1_0.name from groups g1_0',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(1);
    expect(queries[0].rawSql).toContain('select');
    expect(queries[0].normalizedSql).toContain('select');
  });

  it('parses a DEBUG-prefixed query', () => {
    const lines = [
      '2024-01-15 10:30:00.123 DEBUG org.hibernate.SQL - select * from member where group_id=1',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(1);
    expect(queries[0].normalizedSql).toBe('select * from member where group_id=?');
  });

  it('extracts bind parameters from TRACE lines', () => {
    const lines = [
      'Hibernate: select * from member where group_id=?',
      'TRACE o.h.o.j.bind - binding parameter [1] as [BIGINT] - [42]',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(1);
    expect(queries[0].parameters).toContain('42');
  });

  it('parses multiple sequential queries', () => {
    const lines = [
      'Hibernate: select * from groups',
      'Hibernate: select * from member where group_id=1',
      'Hibernate: select * from member where group_id=2',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(3);
  });

  it('normalizes queries with the same structure but different params', () => {
    const lines = [
      'Hibernate: select * from member where group_id=1',
      'Hibernate: select * from member where group_id=2',
      'Hibernate: select * from member where group_id=3',
    ];
    const queries = parseLines(lines);
    const normalized = queries.map((q) => q.normalizedSql);
    expect(new Set(normalized).size).toBe(1); // all same normalized form
  });

  it('parses Hibernate statistics lines', () => {
    const lines = [
      '2024-01-15 10:30:00 INFO  - 245 JDBC statements executed',
      '2024-01-15 10:30:00 INFO  - 50 entities loaded',
    ];
    const collected: ParsedQuery[] = [];
    const parser = new HibernateLogParser((q) => collected.push(q));
    for (const line of lines) parser.processLine(line);
    parser.flush();
    const stats = parser.getStatistics();
    expect(stats.jdbcStatementsExecuted).toBe(245);
    expect(stats.entityLoadsCount).toBe(50);
  });

  it('captures timestamp from log line', () => {
    const lines = [
      '2024-01-15 10:30:00.500 DEBUG org.hibernate.SQL - select * from user where id=1',
    ];
    const queries = parseLines(lines);
    expect(queries[0].timestamp).toBe('2024-01-15 10:30:00.500');
  });

  it('captures the thread name from the Spring Boot default pattern (level → PID → --- → thread)', () => {
    const lines = [
      '2026-06-26T00:03:01.123Z DEBUG 12345 --- [           main] org.hibernate.SQL : select * from member where group_id=1',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(1);
    // Padded thread name is trimmed for consistent grouping
    expect(queries[0].threadName).toBe('main');
  });

  it('captures the thread name from the custom pattern (thread right after the time)', () => {
    const lines = [
      '2026-06-20 18:25:46.718 [http-nio-8080-exec-7] DEBUG org.hibernate.SQL - select * from groups',
    ];
    const queries = parseLines(lines);
    expect(queries[0].threadName).toBe('http-nio-8080-exec-7');
  });

  it('traces origin + timing from Spring Boot default INFO lines (level before thread)', () => {
    const lines = [
      '2026-06-26T00:03:01.000Z  INFO 12345 --- [           main] c.e.demo.OrderService : getOrderSummaries() start',
      '2026-06-26T00:03:01.100Z DEBUG 12345 --- [           main] org.hibernate.SQL : select * from orders',
      '2026-06-26T00:03:01.150Z  WARN 12345 --- [           main] c.e.demo.OrderService : Query completed in 46ms',
    ];
    const queries = parseLines(lines);
    expect(queries).toHaveLength(1);
    expect(queries[0].threadName).toBe('main');
    expect(queries[0].threadContextLines?.some((l) => l.includes('getOrderSummaries'))).toBe(true);
    expect(queries[0].executionTimeMs).toBe(46);
  });
});
