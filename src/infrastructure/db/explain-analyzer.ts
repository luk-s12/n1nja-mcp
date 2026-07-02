import { ExplainPlan } from './explain-runner';
import { severityIcon } from '../../shared/severity';

// ── Issue types specific to EXPLAIN analysis ────────────────────────────────

export type ExplainIssueSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type ExplainIssueType =
  | 'SEQ_SCAN'
  | 'MISSING_INDEX'
  | 'HIGH_COST'
  | 'HIGH_ROWS_REMOVED'
  | 'HASH_JOIN_ON_LARGE_TABLE'
  | 'NESTED_LOOP_ON_LARGE_TABLE'
  | 'SORT_WITHOUT_INDEX'
  | 'BITMAP_HEAP_SCAN'
  | 'MYSQL_FULL_TABLE_SCAN'
  | 'MYSQL_NO_INDEX_USED'
  | 'MYSQL_FILESORT';

export interface ExplainIssue {
  type: ExplainIssueType;
  severity: ExplainIssueSeverity;
  description: string;
  recommendation: string;
  nodeType?: string;
  tableName?: string;
  estimatedCost?: number;
  actualRows?: number;
  rowsRemoved?: number;
}

export interface ExplainAnalysisResult {
  query: string;
  dbType: 'postgresql' | 'mysql';
  issues: ExplainIssue[];
  summary: string;
  textPlan: string;
  totalCost?: number;
  actualTotalTime?: number;
  indexesUsed: string[];
  tablesScanned: string[];
  markdownReport: string;
}

// ── PostgreSQL plan node types ───────────────────────────────────────────────

interface PgNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PgNode[];
  [key: string]: unknown;
}

// ── Main analyzer ────────────────────────────────────────────────────────────

export function analyzeExplainPlan(
  query: string,
  plan: ExplainPlan,
): ExplainAnalysisResult {
  if (plan.dbType === 'postgresql') {
    return analyzePostgresPlan(query, plan);
  } else {
    return analyzeMysqlPlan(query, plan);
  }
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

function analyzePostgresPlan(query: string, plan: ExplainPlan): ExplainAnalysisResult {
  const issues: ExplainIssue[] = [];
  const indexesUsed: string[] = [];
  const tablesScanned: string[] = [];

  // The plan comes as [{ "Plan": {...} }]
  const planArray = plan.raw as Array<{ Plan: PgNode }>;
  const rootNode = planArray?.[0]?.Plan;

  let totalCost: number | undefined;
  let actualTotalTime: number | undefined;

  if (rootNode) {
    totalCost = rootNode['Total Cost'];
    actualTotalTime = rootNode['Actual Total Time'];
    walkPgNode(rootNode, issues, indexesUsed, tablesScanned);
  }

  const markdownReport = buildMarkdownReport({
    query,
    dbType: 'postgresql',
    issues,
    textPlan: plan.textPlan,
    totalCost,
    actualTotalTime,
    indexesUsed,
    tablesScanned,
  });

  return {
    query,
    dbType: 'postgresql',
    issues,
    summary: buildSummary(issues, totalCost, actualTotalTime),
    textPlan: plan.textPlan,
    totalCost,
    actualTotalTime,
    indexesUsed,
    tablesScanned,
    markdownReport,
  };
}

/** Flattened metrics for a single PostgreSQL plan node, fed to each detection rule. */
interface PgNodeMetrics {
  nodeType: string;
  tableName?: string;
  totalCost: number;
  actualRows: number;
  rowsRemoved: number;
  sortKey?: string[];
}

/** A detection rule: inspects one node's metrics and returns an issue, or null if it doesn't apply. */
type PgRule = (m: PgNodeMetrics) => ExplainIssue | null;

/**
 * PostgreSQL anti-pattern rules. Each is independent and self-contained, so adding
 * a new check means appending a rule here rather than editing the tree traversal.
 */
const PG_RULES: PgRule[] = [
  // Seq Scan detection
  ({ nodeType, tableName, totalCost, actualRows }) => {
    if (nodeType !== 'Seq Scan' || !tableName) return null;
    const severity: ExplainIssueSeverity =
      totalCost > 10000 ? 'HIGH' : totalCost > 1000 ? 'MEDIUM' : 'LOW';
    return {
      type: 'SEQ_SCAN',
      severity,
      tableName,
      estimatedCost: totalCost,
      actualRows,
      description:
        `Full sequential scan on table "${tableName}" (cost: ${totalCost.toFixed(2)}, rows: ${actualRows}). ` +
        `The database is reading every row instead of using an index.`,
      recommendation:
        `Add an index on the column(s) used in the WHERE / JOIN / ORDER BY clause.\n` +
        `Example: CREATE INDEX idx_${tableName}_column ON ${tableName} (column_name);\n` +
        `Or in JPA: @Index(name = "idx_${tableName}_column", columnList = "column_name") on @Table.`,
    };
  },

  // High rows removed by filter (missing selective index)
  ({ tableName, actualRows, rowsRemoved }) => {
    if (rowsRemoved <= 0 || actualRows <= 0) return null;
    const ratio = rowsRemoved / (rowsRemoved + actualRows);
    if (ratio <= 0.9 || rowsRemoved <= 1000) return null;
    return {
      type: 'HIGH_ROWS_REMOVED',
      severity: 'MEDIUM',
      tableName,
      rowsRemoved,
      actualRows,
      description:
        `${rowsRemoved.toLocaleString()} rows were read and discarded to return ${actualRows} rows ` +
        `(${(ratio * 100).toFixed(0)}% waste). The filter is not selective enough with the current index.`,
      recommendation:
        `Consider a composite index that includes the filter columns in the correct order, ` +
        `or a partial index: CREATE INDEX idx_partial ON ${tableName ?? 'table'} (col) WHERE condition;`,
    };
  },

  // Sort without index
  ({ nodeType, totalCost, sortKey }) => {
    if (nodeType !== 'Sort') return null;
    return {
      type: 'SORT_WITHOUT_INDEX',
      severity: totalCost > 5000 ? 'HIGH' : 'MEDIUM',
      estimatedCost: totalCost,
      description:
        `In-memory sort detected${sortKey ? ` on: ${sortKey.join(', ')}` : ''}. ` +
        `This indicates no index supports the ORDER BY clause.`,
      recommendation:
        `Add an index on the ORDER BY column(s)${sortKey ? `: (${sortKey.join(', ')})` : ''}.`,
    };
  },

  // Nested Loop on large tables
  ({ nodeType, totalCost }) => {
    if (nodeType !== 'Nested Loop' || totalCost <= 50000) return null;
    return {
      type: 'NESTED_LOOP_ON_LARGE_TABLE',
      severity: 'HIGH',
      estimatedCost: totalCost,
      description:
        `Nested Loop join with high cost (${totalCost.toFixed(2)}). ` +
        `This is O(n×m) and can be very slow on large tables.`,
      recommendation:
        `Ensure the inner loop join column has an index. ` +
        `Consider rewriting as a Hash Join by adjusting join order or using CTEs.`,
    };
  },

  // High total cost
  ({ nodeType, totalCost }) => {
    if (totalCost <= 100000 || nodeType === 'Nested Loop') return null;
    return {
      type: 'HIGH_COST',
      severity: 'HIGH',
      estimatedCost: totalCost,
      description: `Query plan has very high estimated cost: ${totalCost.toFixed(2)}.`,
      recommendation:
        `Run EXPLAIN ANALYZE to compare estimated vs actual rows. ` +
        `If estimates are off, run ANALYZE on the table to update statistics.`,
    };
  },
];

function walkPgNode(
  node: PgNode,
  issues: ExplainIssue[],
  indexesUsed: string[],
  tablesScanned: string[],
): void {
  const metrics: PgNodeMetrics = {
    nodeType: node['Node Type'],
    tableName: node['Relation Name'],
    totalCost: node['Total Cost'] ?? 0,
    actualRows: node['Actual Rows'] ?? 0,
    rowsRemoved: (node['Rows Removed by Filter'] ?? 0) +
                 (node['Rows Removed by Index Recheck'] ?? 0),
    sortKey: node['Sort Key'] as string[] | undefined,
  };

  if (metrics.tableName) tablesScanned.push(metrics.tableName);
  if (node['Index Name']) indexesUsed.push(node['Index Name'] as string);

  for (const rule of PG_RULES) {
    const issue = rule(metrics);
    if (issue) issues.push(issue);
  }

  // Recurse into child nodes
  if (node.Plans) {
    for (const child of node.Plans) {
      walkPgNode(child, issues, indexesUsed, tablesScanned);
    }
  }
}

// ── MySQL ────────────────────────────────────────────────────────────────────

interface MySqlQueryBlock {
  query_block?: {
    table?: MySqlTable;
    nested_loop?: Array<{ table: MySqlTable }>;
    ordering_operation?: { using_filesort?: boolean; table?: MySqlTable };
  };
}

interface MySqlTable {
  table_name?: string;
  access_type?: string;
  key?: string;
  rows_examined_per_scan?: number;
  filtered?: number;
  using_filesort?: boolean;
}

/** A per-table MySQL detection rule: returns an issue for the table, or null if it doesn't apply. */
type MysqlTableRule = (table: MySqlTable) => ExplainIssue | null;

/** MySQL anti-pattern rules evaluated against each table in the plan. */
const MYSQL_TABLE_RULES: MysqlTableRule[] = [
  // Full table scan
  (table) => {
    if (table.access_type !== 'ALL') return null;
    return {
      type: 'MYSQL_FULL_TABLE_SCAN',
      severity: (table.rows_examined_per_scan ?? 0) > 10000 ? 'HIGH' : 'MEDIUM',
      tableName: table.table_name,
      actualRows: table.rows_examined_per_scan,
      description:
        `Full table scan on "${table.table_name}" ` +
        `(${table.rows_examined_per_scan?.toLocaleString()} rows examined, ` +
        `filtered: ${table.filtered}%).`,
      recommendation:
        `Add an index on the column(s) in the WHERE / JOIN clause.\n` +
        `Example: ALTER TABLE ${table.table_name} ADD INDEX idx_col (column_name);`,
    };
  },

  // No index used
  (table) => {
    if (table.key || table.access_type === 'ALL') return null;
    return {
      type: 'MYSQL_NO_INDEX_USED',
      severity: 'MEDIUM',
      tableName: table.table_name,
      description: `No index used for table "${table.table_name}" (access type: ${table.access_type}).`,
      recommendation: `Review the join/filter columns and add an appropriate index.`,
    };
  },

  // Filesort
  (table) => {
    if (!table.using_filesort) return null;
    return {
      type: 'MYSQL_FILESORT',
      severity: 'MEDIUM',
      tableName: table.table_name,
      description: `Filesort detected on "${table.table_name}". MySQL is sorting in a temp file.`,
      recommendation: `Add an index on the ORDER BY column(s) to avoid filesort.`,
    };
  },
];

function analyzeMysqlPlan(query: string, plan: ExplainPlan): ExplainAnalysisResult {
  const issues: ExplainIssue[] = [];
  const indexesUsed: string[] = [];
  const tablesScanned: string[] = [];

  try {
    const planObj = typeof plan.raw === 'string'
      ? JSON.parse(plan.raw as string)
      : plan.raw as MySqlQueryBlock;

    const queryBlock = planObj?.query_block;
    if (queryBlock) {
      const tables: MySqlTable[] = [];

      if (queryBlock.table) tables.push(queryBlock.table);
      if (queryBlock.nested_loop) {
        for (const item of queryBlock.nested_loop) tables.push(item.table);
      }
      if (queryBlock.ordering_operation?.table) {
        tables.push(queryBlock.ordering_operation.table);
      }

      for (const table of tables) {
        if (table.table_name) tablesScanned.push(table.table_name);
        if (table.key) indexesUsed.push(table.key);

        for (const rule of MYSQL_TABLE_RULES) {
          const issue = rule(table);
          if (issue) issues.push(issue);
        }
      }

      if (queryBlock.ordering_operation?.using_filesort) {
        if (!issues.find((i) => i.type === 'MYSQL_FILESORT')) {
          issues.push({
            type: 'MYSQL_FILESORT',
            severity: 'MEDIUM',
            description: `Filesort detected. MySQL is sorting rows in a temporary file.`,
            recommendation: `Add a composite index that covers both the WHERE and ORDER BY columns.`,
          });
        }
      }
    }
  } catch {
    // Plan parsing failed — return empty analysis
  }

  const markdownReport = buildMarkdownReport({
    query,
    dbType: 'mysql',
    issues,
    textPlan: plan.textPlan,
    indexesUsed,
    tablesScanned,
  });

  return {
    query,
    dbType: 'mysql',
    issues,
    summary: buildSummary(issues),
    textPlan: plan.textPlan,
    indexesUsed,
    tablesScanned,
    markdownReport,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function buildSummary(
  issues: ExplainIssue[],
  totalCost?: number,
  actualTime?: number,
): string {
  if (issues.length === 0) {
    return `✅ No issues found in the query plan.${totalCost !== undefined ? ` Estimated cost: ${totalCost.toFixed(2)}.` : ''}`;
  }
  const high = issues.filter((i) => i.severity === 'HIGH').length;
  const medium = issues.filter((i) => i.severity === 'MEDIUM').length;
  return (
    `Found ${issues.length} issue(s): ${high} HIGH, ${medium} MEDIUM.` +
    (totalCost !== undefined ? ` Estimated cost: ${totalCost.toFixed(2)}.` : '') +
    (actualTime !== undefined ? ` Actual time: ${actualTime.toFixed(2)}ms.` : '')
  );
}

function buildMarkdownReport(params: {
  query: string;
  dbType: string;
  issues: ExplainIssue[];
  textPlan: string;
  totalCost?: number;
  actualTotalTime?: number;
  indexesUsed: string[];
  tablesScanned: string[];
}): string {
  const { query, dbType, issues, textPlan, totalCost, actualTotalTime, indexesUsed, tablesScanned } = params;
  const lines: string[] = [];

  lines.push('## EXPLAIN Analysis Report');
  lines.push('');
  lines.push(`**Database:** ${dbType}`);
  if (totalCost !== undefined) lines.push(`**Estimated total cost:** ${totalCost.toFixed(2)}`);
  if (actualTotalTime !== undefined) lines.push(`**Actual total time:** ${actualTotalTime.toFixed(2)} ms`);
  lines.push(`**Tables scanned:** ${tablesScanned.length > 0 ? tablesScanned.join(', ') : 'none'}`);
  lines.push(`**Indexes used:** ${indexesUsed.length > 0 ? indexesUsed.join(', ') : '⚠️ none'}`);
  lines.push('');

  lines.push('**Query:**');
  lines.push('```sql');
  lines.push(query.trim());
  lines.push('```');
  lines.push('');

  if (issues.length === 0) {
    lines.push('> ✅ No issues found in the execution plan.');
  } else {
    lines.push(`### Issues Found (${issues.length})`);
    lines.push('');
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      lines.push(`#### ${i + 1}. ${severityIcon(issue.severity)} ${issue.type.replace(/_/g, ' ')} — ${issue.severity}`);
      lines.push('');
      lines.push(issue.description);
      lines.push('');
      lines.push(`**Recommendation:** ${issue.recommendation}`);
      lines.push('');
    }
  }

  lines.push('### Raw Execution Plan');
  lines.push('```');
  lines.push(textPlan);
  lines.push('```');

  return lines.join('\n');
}
