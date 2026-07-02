export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export type IssueType =
  | 'N_PLUS_1'
  | 'DUPLICATE_QUERY'
  | 'MISSING_PAGINATION'
  | 'LARGE_RESULT_SET'
  | 'SLOW_QUERY'
  | 'POSSIBLE_CARTESIAN_PRODUCT'
  | 'OVER_FETCHING'
  | 'DEADLOCK';

/**
 * Base interface for all detected issues
 */
export interface BaseIssue {
  type: IssueType;
  severity: Severity;
  /** Normalized SQL query involved */
  query: string;
  description: string;
  /** Recommended fix */
  recommendation: string;
  /** Example raw SQL lines from the log (evidence) */
  evidence: string[];
  /** Line numbers in the log file where issue was observed */
  lineNumbers?: number[];
  /** INFO/WARN/ERROR log lines from the same thread that preceded the triggering query */
  threadContextLines?: string[];
}

export interface NPlusOneIssue extends BaseIssue {
  type: 'N_PLUS_1';
  severity: 'HIGH';
  executions: number;
  estimatedExtraQueries: number;
  /** The parent query that triggered the N+1 */
  parentQuery?: string;
}

export interface DuplicateQueryIssue extends BaseIssue {
  type: 'DUPLICATE_QUERY';
  severity: 'HIGH' | 'MEDIUM';
  executions: number;
  /** How many times the query fired within a single HTTP request (same thread) */
  maxPerRequest?: number;
}

export interface MissingPaginationIssue extends BaseIssue {
  type: 'MISSING_PAGINATION';
  severity: 'HIGH' | 'MEDIUM';
}

export interface LargeResultSetIssue extends BaseIssue {
  type: 'LARGE_RESULT_SET';
  severity: 'HIGH' | 'MEDIUM';
  rows: number;
}

export interface SlowQueryIssue extends BaseIssue {
  type: 'SLOW_QUERY';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  executionTimeMs: number;
  /** true when detected via SQL anti-pattern analysis (no measured timing in the log) */
  isPatternBased?: boolean;
}

export interface PossibleCartesianProductIssue extends BaseIssue {
  type: 'POSSIBLE_CARTESIAN_PRODUCT';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  joinCount: number;
  /** Tables involved in the fan-out join (if detected) */
  fanOutTables?: string[];
}

export interface OverFetchingIssue extends BaseIssue {
  type: 'OVER_FETCHING';
  severity: 'MEDIUM' | 'LOW';
   /** Number of unique queries that use SELECT * */
  executions: number;
  /** Columns fetched by the query but never read in the triggering method */
  unusedColumns?: string[];
  /** Columns the triggering method actually reads (for DTO projection suggestion) */
  usedColumns?: string[];
  /** Entity whose columns are over-fetched */
  entityName?: string;
}

export interface DeadlockIssue extends BaseIssue {
  type: 'DEADLOCK';
  severity: 'HIGH';
  /** Number of times the lock error appeared in the log */
  occurrences: number;
  /** Raw error log lines as evidence */
  errorMessages: string[];
  /** SQL statements involved in the lock contention, if they could be recovered from the log */
  queries?: string[];
}

export type Issue =
  | NPlusOneIssue
  | DuplicateQueryIssue
  | MissingPaginationIssue
  | LargeResultSetIssue
  | SlowQueryIssue
  | PossibleCartesianProductIssue
  | OverFetchingIssue
  | DeadlockIssue;
