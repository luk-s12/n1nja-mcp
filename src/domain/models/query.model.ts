/**
 * A single parsed SQL statement from the log
 */
export interface ParsedQuery {
  /** Raw SQL as it appeared in the log */
  rawSql: string;
  /** Normalized SQL with literal values replaced by ? */
  normalizedSql: string;
  /** Bound parameter values extracted from TRACE lines */
  parameters: string[];
  /** Line number in the log file */
  lineNumber: number;
  /** Timestamp from the log line (if present) */
  timestamp?: string;
  /** Thread name extracted from the log line (e.g. http-nio-8080-exec-7) */
  threadName?: string;
  /** INFO/WARN/ERROR log lines from the same thread that preceded this query */
  threadContextLines?: string[];
  /** Execution time in ms (from Hibernate statistics) */
  executionTimeMs?: number;
  /** Number of rows returned (from statistics) */
  rowCount?: number;
}

/**
 * Aggregated statistics for a normalized query
 */
export interface QueryGroup {
  normalizedSql: string;
  executions: ParsedQuery[];
  totalExecutionTimeMs: number;
  maxExecutionTimeMs: number;
  avgExecutionTimeMs: number;
  totalRows: number;
}

/**
 * Hibernate statistics parsed from log
 */
export interface HibernateStatistics {
  jdbcStatementsExecuted?: number;
  entityLoadsCount?: number;
  collectionLoadsCount?: number;
  secondLevelCacheHits?: number;
  secondLevelCacheMisses?: number;
  queryExecutionCount?: number;
  queryExecutionMaxTime?: number;
  sessionOpenCount?: number;
  sessionCloseCount?: number;
  transactionCount?: number;
  flushCount?: number;
  connectionsObtained?: number;
  rawLines: string[];
}
