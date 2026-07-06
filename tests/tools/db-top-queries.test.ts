import {
  deriveFlags,
  mapMysqlDigestRow,
  mapPgStatRow,
  buildTopQueriesMarkdown,
} from '../../src/interfaces/mcp/tools/db-top-queries.tool';

// ── deriveFlags ───────────────────────────────────────────────────────────────

describe('deriveFlags', () => {
  const base = { sql: 'SELECT * FROM t', calls: 10, totalTimeMs: 100, avgTimeMs: 10, rowsSent: 100 };

  it('flags full scans when noIndexUsedCount > 0', () => {
    const flags = deriveFlags({ ...base, noIndexUsedCount: 7 });
    expect(flags.some((f) => f.includes('full scan in 7 of 10'))).toBe(true);
  });

  it('flags a high examine ratio only above the row floor', () => {
    const heavy = deriveFlags({ ...base, rowsExamined: 500_000, examineRatio: 5000 });
    expect(heavy.some((f) => f.includes('rows per row returned'))).toBe(true);

    // Tiny table: ratio is high but absolute rows are negligible — no flag.
    const tiny = deriveFlags({ ...base, rowsExamined: 500, examineRatio: 500 });
    expect(tiny).toHaveLength(0);
  });

  it('flags slow average time', () => {
    const flags = deriveFlags({ ...base, avgTimeMs: 900 });
    expect(flags.some((f) => f.includes('slow: avg 900 ms'))).toBe(true);
  });

  it('returns no flags for a healthy query', () => {
    expect(deriveFlags({ ...base, rowsExamined: 100, examineRatio: 1, noIndexUsedCount: 0 })).toHaveLength(0);
  });
});

// ── mapMysqlDigestRow ─────────────────────────────────────────────────────────

describe('mapMysqlDigestRow', () => {
  const row = {
    DIGEST_TEXT: 'SELECT * FROM `transactions` WHERE `customer_id` = ?',
    COUNT_STAR: '150',
    SUM_TIMER_WAIT: String(3_000_000_000_000), // 3000 ms in picoseconds
    AVG_TIMER_WAIT: String(20_000_000_000), // 20 ms
    MAX_TIMER_WAIT: String(500_000_000_000), // 500 ms
    SUM_ROWS_EXAMINED: '450000',
    SUM_ROWS_SENT: '150',
    SUM_NO_INDEX_USED: '150',
    FIRST_SEEN: '2026-07-01 10:00:00',
    LAST_SEEN: '2026-07-04 18:00:00',
  };

  it('converts picoseconds to ms and derives ratios and flags', () => {
    const q = mapMysqlDigestRow(row)!;

    expect(q.totalTimeMs).toBeCloseTo(3000);
    expect(q.avgTimeMs).toBeCloseTo(20);
    expect(q.maxTimeMs).toBeCloseTo(500);
    expect(q.calls).toBe(150);
    expect(q.examineRatio).toBeCloseTo(3000);
    expect(q.flags.some((f) => f.includes('full scan'))).toBe(true);
    expect(q.flags.some((f) => f.includes('rows per row returned'))).toBe(true);
    expect(q.lastSeen).toBe('2026-07-04 18:00:00');
  });

  it('drops NULL digests and noise statements', () => {
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: null })).toBeNull();
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'SET NAMES utf8mb4' })).toBeNull();
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'SHOW WARNINGS' })).toBeNull();
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'COMMIT' })).toBeNull();
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'SELECT @@session.transaction_isolation' })).toBeNull();
  });

  it('keeps real SELECT/INSERT/UPDATE statements', () => {
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'INSERT INTO `t` VALUES (?)' })).not.toBeNull();
    expect(mapMysqlDigestRow({ ...row, DIGEST_TEXT: 'UPDATE `t` SET `a` = ?' })).not.toBeNull();
  });
});

// ── mapPgStatRow ──────────────────────────────────────────────────────────────

describe('mapPgStatRow', () => {
  const row = {
    query: 'SELECT * FROM transactions WHERE customer_id = $1',
    calls: '80',
    total_exec_time: '4000.5',
    mean_exec_time: '50.0',
    max_exec_time: '900.1',
    rows: '80',
  };

  it('maps times directly (already ms) and derives flags', () => {
    const q = mapPgStatRow(row)!;
    expect(q.totalTimeMs).toBeCloseTo(4000.5);
    expect(q.avgTimeMs).toBeCloseTo(50);
    expect(q.calls).toBe(80);
    expect(q.flags).toHaveLength(0); // healthy
  });

  it('flags slow pg queries', () => {
    const q = mapPgStatRow({ ...row, mean_exec_time: '750' })!;
    expect(q.flags.some((f) => f.includes('slow'))).toBe(true);
  });

  it('drops noise statements', () => {
    expect(mapPgStatRow({ ...row, query: 'BEGIN' })).toBeNull();
    expect(mapPgStatRow({ ...row, query: 'SET search_path TO public' })).toBeNull();
    expect(mapPgStatRow({ ...row, query: null })).toBeNull();
  });
});

// ── buildTopQueriesMarkdown ───────────────────────────────────────────────────

describe('buildTopQueriesMarkdown', () => {
  const base = {
    dbType: 'mysql',
    dbHost: 'localhost',
    dbName: 'shop',
    orderBy: 'total_time' as const,
  };

  it('renders the ranking table and per-query sections', () => {
    const md = buildTopQueriesMarkdown({
      ...base,
      queries: [
        {
          sql: 'SELECT * FROM t WHERE a = ?',
          calls: 10,
          totalTimeMs: 1234.6,
          avgTimeMs: 123.4,
          rowsSent: 10,
          rowsExamined: 100000,
          examineRatio: 10000,
          flags: ['examines 10000 rows per row returned'],
        },
      ],
    });

    expect(md).toContain('| 1 | 10 | 1235 | 123 | 10 | 100000 |');
    expect(md).toContain('SELECT * FROM t WHERE a = ?');
    expect(md).toContain('⚠ examines 10000 rows per row returned');
  });

  it('renders the reset confirmation', () => {
    const md = buildTopQueriesMarkdown({ ...base, queries: [], statsReset: true });
    expect(md).toContain('statistics were reset');
  });

  it('renders the empty state', () => {
    const md = buildTopQueriesMarkdown({ ...base, queries: [] });
    expect(md).toContain('No statements recorded yet');
  });
});
