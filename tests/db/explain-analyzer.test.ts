import { analyzeExplainPlan } from '../../src/infrastructure/db/explain-analyzer';
import { ExplainPlan } from '../../src/infrastructure/db/explain-runner';

// ── Helpers to build mock plans ───────────────────────────────────────────────

function makePgPlan(nodes: object[]): ExplainPlan {
  return {
    raw: nodes,
    textPlan: nodes.map((n) => JSON.stringify(n)).join('\n'),
    dbType: 'postgresql',
  };
}

function makeMysqlPlan(queryBlock: object): ExplainPlan {
  return {
    raw: { query_block: queryBlock },
    textPlan: JSON.stringify({ query_block: queryBlock }, null, 2),
    dbType: 'mysql',
  };
}

const BASE_QUERY = 'select * from member where group_id = 1';

// ── PostgreSQL tests ──────────────────────────────────────────────────────────

describe('analyzeExplainPlan — PostgreSQL', () => {
  it('detects Seq Scan and flags it as a missing index', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'member',
          'Total Cost': 5000,
          'Plan Rows': 10000,
          'Actual Rows': 9800,
          'Rows Removed by Filter': 200,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);

    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    const seqScan = result.issues.find((i) => i.type === 'SEQ_SCAN');
    expect(seqScan).toBeDefined();
    expect(seqScan?.tableName).toBe('member');
    expect(seqScan?.recommendation).toContain('CREATE INDEX');
  });

  it('assigns HIGH severity for expensive Seq Scan', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Total Cost': 50000,
          'Actual Rows': 500000,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const seqScan = result.issues.find((i) => i.type === 'SEQ_SCAN');
    expect(seqScan?.severity).toBe('HIGH');
  });

  it('assigns LOW severity for cheap Seq Scan', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'config',
          'Total Cost': 10,
          'Actual Rows': 5,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const seqScan = result.issues.find((i) => i.type === 'SEQ_SCAN');
    expect(seqScan?.severity).toBe('LOW');
  });

  it('collects index usage from Index Scan nodes', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'member',
          'Index Name': 'idx_member_group_id',
          'Total Cost': 8.41,
          'Actual Rows': 150,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    expect(result.indexesUsed).toContain('idx_member_group_id');
    expect(result.issues.filter((i) => i.type === 'SEQ_SCAN')).toHaveLength(0);
  });

  it('detects Sort node without index', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Sort',
          'Sort Key': ['member.created_at'],
          'Total Cost': 8000,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'member',
              'Total Cost': 100,
              'Actual Rows': 10000,
            },
          ],
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const sortIssue = result.issues.find((i) => i.type === 'SORT_WITHOUT_INDEX');
    expect(sortIssue).toBeDefined();
    expect(sortIssue?.description).toContain('created_at');
  });

  it('detects high rows removed by filter', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'event',
          'Total Cost': 2000,
          'Actual Rows': 50,
          'Rows Removed by Filter': 9950,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const rowsIssue = result.issues.find((i) => i.type === 'HIGH_ROWS_REMOVED');
    expect(rowsIssue).toBeDefined();
    expect(rowsIssue?.rowsRemoved).toBe(9950);
  });

  it('returns no issues for a clean Index Scan plan', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'member',
          'Index Name': 'idx_member_group_id',
          'Total Cost': 8.41,
          'Actual Rows': 10,
          'Actual Total Time': 0.5,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toContain('No issues');
  });

  it('generates a non-empty markdown report', () => {
    const plan = makePgPlan([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'member',
          'Total Cost': 5000,
          'Actual Rows': 10000,
        },
      },
    ]);

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    expect(result.markdownReport).toContain('## EXPLAIN Analysis Report');
    expect(result.markdownReport).toContain('SEQ SCAN');
  });
});

// ── MySQL tests ───────────────────────────────────────────────────────────────

describe('analyzeExplainPlan — MySQL', () => {
  it('detects full table scan', () => {
    const plan = makeMysqlPlan({
      table: {
        table_name: 'member',
        access_type: 'ALL',
        rows_examined_per_scan: 50000,
        filtered: 10,
      },
    });

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const issue = result.issues.find((i) => i.type === 'MYSQL_FULL_TABLE_SCAN');
    expect(issue).toBeDefined();
    expect(issue?.tableName).toBe('member');
    expect(issue?.recommendation).toContain('ADD INDEX');
  });

  it('detects filesort', () => {
    const plan = makeMysqlPlan({
      table: {
        table_name: 'member',
        access_type: 'ref',
        key: 'idx_group_id',
        rows_examined_per_scan: 150,
        filtered: 100,
        using_filesort: true,
      },
    });

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const issue = result.issues.find((i) => i.type === 'MYSQL_FILESORT');
    expect(issue).toBeDefined();
  });

  it('collects index from MySQL plan', () => {
    const plan = makeMysqlPlan({
      table: {
        table_name: 'member',
        access_type: 'ref',
        key: 'idx_member_group_id',
        rows_examined_per_scan: 10,
        filtered: 100,
      },
    });

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    expect(result.indexesUsed).toContain('idx_member_group_id');
  });

  it('flags HIGH severity for large full table scan', () => {
    const plan = makeMysqlPlan({
      table: {
        table_name: 'orders',
        access_type: 'ALL',
        rows_examined_per_scan: 500000,
        filtered: 1,
      },
    });

    const result = analyzeExplainPlan(BASE_QUERY, plan);
    const issue = result.issues.find((i) => i.type === 'MYSQL_FULL_TABLE_SCAN');
    expect(issue?.severity).toBe('HIGH');
  });
});
