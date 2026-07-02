import * as fs from 'fs';
import * as readline from 'readline';
import { normalizeSql } from './sql-normalizer';
import { ParsedQuery, HibernateStatistics } from '../../domain/models/query.model';

/**
 * State machine modes while scanning a log file
 */
type ParserMode = 'idle' | 'collecting-sql' | 'collecting-params';

/**
 * Result of a complete log parse pass
 */
export interface ParseResult {
  queries: ParsedQuery[];
  statistics: HibernateStatistics;
  linesProcessed: number;
}

/**
 * Callback invoked for each parsed query during streaming
 */
export type QueryCallback = (query: ParsedQuery) => void;

// --- Pattern constants -------------------------------------------------------

/**
 * Hibernate SQL log line:
 *   2024-01-15 10:30:00.000 DEBUG ... Hibernate: select ...
 *   DEBUG o.h.SQL - select ...
 *   Hibernate:
 *     select ...
 */
const HIBERNATE_SQL_PREFIX = /(?:Hibernate:|(?:DEBUG|TRACE)\s+[\w.]+\s*[-:]\s*)/i;

/**
 * Spring Boot / Logback timestamp prefix (optional)
 * e.g.: 2024-01-15T10:30:00.123Z  or  2024-01-15 10:30:00.123
 */
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+/;

/**
 * Spring Boot thread name in brackets. Supports two layouts:
 *   - Custom pattern (thread right after the time):
 *       2026-06-20 18:25:46.718 [http-nio-8080-exec-7] INFO ...
 *       2024-01-15 10:30:00.123 [restartedMain] DEBUG ...
 *   - Spring Boot default (level → PID → `---` → thread):
 *       2026-06-26T00:03:01.123Z  INFO 12345 --- [           main] c.e.demo.Service : ...
 * The thread bracket is captured whether it follows the time or the `---` marker.
 */
const LOG_THREAD = /(?:\d{2}:\d{2}:\d{2}[.\d]*\s+|---\s+)\[([^\]]+)\]/;

/**
 * Hibernate bind parameter line — supports both Hibernate 5 and 6 formats:
 *   Hibernate 5:  TRACE ... - binding parameter [1] as [VARCHAR] - [hello]
 *   Hibernate 6:  TRACE ... - binding parameter (1:BIGINT) <- [1]
 */
const BIND_PARAM_LINE = /binding parameter .*\[([^\]]*)\]\s*$/i;

/**
 * Hibernate statistics block markers
 */
const STATS_JDBC = /(\d+)\s+JDBC\s+statements?\s+executed/i;
const STATS_ENTITY_LOAD = /(\d+)\s+entities?\s+loaded/i;
const STATS_COLLECTION_LOAD = /(\d+)\s+collections?\s+loaded/i;
const STATS_QUERY_COUNT = /(\d+)\s+queries?\s+executed/i;
const STATS_QUERY_MAX_TIME = /max query time:\s*(\d+)\s*ms/i;
const STATS_SESSION_OPEN = /(\d+)\s+sessions?\s+opened/i;
const STATS_TRANSACTION = /(\d+)\s+transactions?\s+completed/i;
const STATS_FLUSH = /(\d+)\s+flushes?/i;
const STATS_CONNECTIONS = /(\d+)\s+connections?\s+obtained/i;

/** Numeric fields of HibernateStatistics (everything except the rawLines buffer). */
type NumericStatKey = Exclude<keyof HibernateStatistics, 'rawLines'>;

/**
 * Maps each Hibernate statistics marker to the field it populates. Driven as a
 * table so adding a new counter is a single entry rather than another match/if block.
 */
const STATS_PATTERNS: ReadonlyArray<{ regex: RegExp; key: NumericStatKey }> = [
  { regex: STATS_JDBC, key: 'jdbcStatementsExecuted' },
  { regex: STATS_ENTITY_LOAD, key: 'entityLoadsCount' },
  { regex: STATS_COLLECTION_LOAD, key: 'collectionLoadsCount' },
  { regex: STATS_QUERY_COUNT, key: 'queryExecutionCount' },
  { regex: STATS_QUERY_MAX_TIME, key: 'queryExecutionMaxTime' },
  { regex: STATS_SESSION_OPEN, key: 'sessionOpenCount' },
  { regex: STATS_TRANSACTION, key: 'transactionCount' },
  { regex: STATS_FLUSH, key: 'flushCount' },
  { regex: STATS_CONNECTIONS, key: 'connectionsObtained' },
];

// Lines that are purely Hibernate formatting (whitespace / comma-only continuations)
const BLANK_OR_FORMAT = /^\s*(?:,\s*)?$/;

/**
 * Captures elapsed time in ms from application WARN/INFO lines logged after a query.
 * Matches common patterns like:
 *   "Query completed in 46ms"
 *   "elapsed: 120ms"
 *   "took 80ms"
 *   "duration: 55ms"
 *   "Time: 33ms"  (datasource-proxy format)
 */
const ELAPSED_MS_PATTERN = /(?:completed in\s+|elapsed[:\s]+|took\s+|duration[:\s]+|Time[:\s]+)(\d+)\s*ms/i;

/**
 * INFO/WARN/ERROR application log lines (not DEBUG/TRACE Hibernate lines).
 * Used to capture the business-layer context that preceded a SQL statement
 * so we can trace back to the exact service method that triggered it.
 *
 * Supports both layouts:
 *   - Custom pattern:  2026-06-20 23:15:24.119 [thread] INFO  com.example.Service - message
 *   - Spring Boot default:  2026-06-26T00:03:01.123Z  INFO 12345 --- [thread] c.e.Service : message
 */
const APP_LOG_LINE = /(?:\[[^\]]+\]\s+(?:INFO|WARN|ERROR)\b)|(?:\b(?:INFO|WARN|ERROR)\s+\d+\s+---)/i;

// ---------------------------------------------------------------------------

/**
 * Stateful log parser.
 *
 * Processes lines one-by-one (streaming-friendly) and emits ParsedQuery objects
 * as soon as each statement is fully assembled.
 */
export class HibernateLogParser {
  private mode: ParserMode = 'idle';
  private sqlBuffer: string[] = [];
  private currentParams: string[] = [];
  private currentLineNumber = 0;
  private currentTimestamp?: string;
  private currentThreadName?: string;
  private pendingQuery?: Omit<ParsedQuery, 'parameters'>;
  /** Per-thread buffer of INFO/WARN/ERROR lines (last 20 per thread) */
  private threadContextBuffer: Map<string, string[]> = new Map();

  private onQuery: QueryCallback;
  private statistics: HibernateStatistics = { rawLines: [] };

  constructor(onQuery: QueryCallback) {
    this.onQuery = onQuery;
  }

  /**
   * Feed one log line to the parser.
   */
  public processLine(line: string): void {
    this.currentLineNumber++;

    const tsMatch = line.match(LOG_TIMESTAMP);
    if (tsMatch) {
      this.currentTimestamp = tsMatch[1];
    }

    const threadMatch = line.match(LOG_THREAD);
    if (threadMatch) {
      // Spring Boot's default pattern pads the thread to a fixed width
      // (e.g. "[           main]"), so trim for consistent per-thread grouping.
      this.currentThreadName = threadMatch[1].trim();
    }

    // INFO/WARN/ERROR lines identify the service method that triggered the next SQL.
    if (APP_LOG_LINE.test(line) && this.currentThreadName) {
      const buf = this.threadContextBuffer.get(this.currentThreadName) ?? [];
      buf.push(line);
      if (buf.length > 20) buf.shift(); // rolling window — keep last 20
      this.threadContextBuffer.set(this.currentThreadName, buf);
    }

    if (this.tryParseStatistics(line)) return;

    if (this.isSqlStart(line)) {
      this.flushCurrentQuery();
      const rawSql = this.extractSql(line);
      this.mode = 'collecting-sql';
      this.sqlBuffer = [rawSql];
      return;
    }

    if (this.mode === 'collecting-sql') {
      if (this.isSqlContinuation(line)) {
        this.sqlBuffer.push(line.trim());
        return;
      } else {
        this.finalizeSql();
      }
    }

    if (this.mode === 'collecting-params' || this.mode === 'idle') {
      const paramMatch = line.match(BIND_PARAM_LINE);
      if (paramMatch) {
        this.mode = 'collecting-params';
        this.currentParams.push(paramMatch[1]);
        return;
      } else if (this.mode === 'collecting-params') {
        this.emitQuery();
        this.mode = 'idle';
      }
    }
  }

  /**
   * Flush any pending query at end-of-file.
   */
  public flush(): void {
    if (this.mode === 'collecting-sql') {
      this.finalizeSql();
    }
    if (this.pendingQuery) {
      this.emitQuery();
    }
  }

  public getStatistics(): HibernateStatistics {
    return this.statistics;
  }

  public getLinesProcessed(): number {
    return this.currentLineNumber;
  }

  // --- Private helpers -------------------------------------------------------

  private isSqlStart(line: string): boolean {
    // Old format: SQL keyword on the same line as the prefix
    // e.g. "Hibernate: select ..." or "DEBUG o.h.SQL - select ..."
    if (HIBERNATE_SQL_PREFIX.test(line) && /\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bwith\b/i.test(line)) {
      return true;
    }
    // Hibernate 6 format: "... DEBUG org.hibernate.SQL - " with SQL on subsequent indented lines
    if (/\borg\.hibernate\.SQL\b/i.test(line)) {
      return true;
    }
    // Legacy "Hibernate:" prefix with SQL on next line
    if (/Hibernate:\s*$/i.test(line)) {
      return true;
    }
    return false;
  }

  private extractSql(line: string): string {
    // Remove the prefix (timestamp + level + logger + Hibernate:)
    let sql = line.replace(LOG_TIMESTAMP, '');
    // Strip Spring Boot thread name in brackets: [restartedMain], [http-nio-8080-exec-1], etc.
    sql = sql.replace(/^\s*\[[^\]]+\]\s*/, '');
    sql = sql.replace(HIBERNATE_SQL_PREFIX, '');
    return sql.trim();
  }

  /**
   * A SQL continuation line: any indented fragment that isn't a new log record.
   * Handles Hibernate 6's multi-line formatted SQL:
   *   DEBUG org.hibernate.SQL -
   *       select
   *           c1_0.id,
   *           c1_0.name
   *       from customer c1_0
   *       where c1_0.id=?
   */
  private isSqlContinuation(line: string): boolean {
    if (BLANK_OR_FORMAT.test(line)) return false;
    const trimmed = line.trimStart();
    // A new log record starts with a timestamp or a log level keyword
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
    if (/^(?:DEBUG|TRACE|INFO|WARN|ERROR)\b/i.test(trimmed)) return false;
    // Any indented line = SQL continuation (Hibernate 6 multi-line format)
    if (/^\s/.test(line)) return true;
    // Non-indented SQL continuation keywords (Hibernate 5 / single-line style)
    return /^(?:from|where|join|left|right|inner|outer|on|and|or|order|group|having|set|values|union|limit|offset|fetch)\b/i.test(trimmed)
      || /^[,)(]/.test(trimmed);
  }

  private finalizeSql(): void {
    // Filter out empty strings (from Hibernate 6 "DEBUG org.hibernate.SQL - \n" header)
    const rawSql = this.sqlBuffer.filter(s => s.length > 0).join(' ').replace(/\s+/g, ' ').trim();
    if (rawSql && /\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bwith\b/i.test(rawSql)) {
      this.pendingQuery = {
        rawSql,
        normalizedSql: normalizeSql(rawSql),
        lineNumber: this.currentLineNumber,
        timestamp: this.currentTimestamp,
        threadName: this.currentThreadName,
      };
    }
    this.sqlBuffer = [];
    this.mode = 'idle';
  }

  private flushCurrentQuery(): void {
    if (this.mode === 'collecting-sql') {
      this.finalizeSql();
    }
    if (this.pendingQuery) {
      this.emitQuery();
    }
  }

  private emitQuery(): void {
    if (this.pendingQuery) {
      const threadCtx = this.currentThreadName
        ? [...(this.threadContextBuffer.get(this.currentThreadName) ?? [])]
        : [];

      // Extract timing from context lines (scan from end to get the most recent ms value).
      // The WARN line with elapsed time comes after the SQL on the same thread, so by the time
      // emitQuery() is called it's already been pushed into threadContextBuffer.
      let executionTimeMs: number | undefined;
      for (let i = threadCtx.length - 1; i >= 0; i--) {
        const match = threadCtx[i].match(ELAPSED_MS_PATTERN);
        if (match) {
          executionTimeMs = parseInt(match[1], 10);
          break;
        }
      }

      const query: ParsedQuery = {
        ...this.pendingQuery,
        parameters: [...this.currentParams],
        threadContextLines: threadCtx.length > 0 ? threadCtx : undefined,
        executionTimeMs,
      };
      this.onQuery(query);
    }
    this.pendingQuery = undefined;
    this.currentParams = [];
    this.mode = 'idle';
  }

  private tryParseStatistics(line: string): boolean {
    let matched = false;

    for (const { regex, key } of STATS_PATTERNS) {
      const m = line.match(regex);
      if (m) {
        this.statistics[key] = parseInt(m[1], 10);
        matched = true;
      }
    }

    if (matched) this.statistics.rawLines.push(line.trim());

    return matched;
  }
}

// --- High-level file parsing API ---------------------------------------------

/**
 * Parse an entire log file, streaming line-by-line (memory-efficient).
 * Supports files with millions of lines.
 */
export async function parseLogFile(filePath: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const queries: ParsedQuery[] = [];
    const parser = new HibernateLogParser((q) => queries.push(q));

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream as unknown as NodeJS.ReadableStream, crlfDelay: Infinity });

    stream.on('error', reject);

    rl.on('line', (line) => parser.processLine(line));
    rl.on('close', () => {
      parser.flush();
      resolve({
        queries,
        statistics: parser.getStatistics(),
        linesProcessed: parser.getLinesProcessed(),
      });
    });
    rl.on('error', reject);
  });
}
