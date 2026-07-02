/**
 * Configuration model for the Hibernate N+1 Detector
 */
export interface DetectorConfig {
  /** Minimum executions of the same normalized query to flag as N+1 globally (default: 10) */
  nPlusOneThreshold: number;
  /** Minimum per-request executions with distinct params to flag as N+1 in-request (default: 3) */
  nPlusOnePerRequestThreshold: number;
  /** Minimum executions of the same query to flag as DUPLICATE_QUERY (default: 2) */
  duplicateQueryThreshold: number;
  /** Row count threshold for LARGE_RESULT_SET (default: 1000) */
  largeResultThreshold: number;
  /** Execution time threshold in ms for SLOW_QUERY (default: 500) */
  slowQueryMs: number;
  /** Minimum joins to consider POSSIBLE_CARTESIAN_PRODUCT (default: 2) */
  cartesianJoinThreshold: number;
}

export const DEFAULT_CONFIG: DetectorConfig = {
  nPlusOneThreshold: 10,
  nPlusOnePerRequestThreshold: 3,
  duplicateQueryThreshold: 2,
  largeResultThreshold: 1000,
  slowQueryMs: 500,
  cartesianJoinThreshold: 2,
};
