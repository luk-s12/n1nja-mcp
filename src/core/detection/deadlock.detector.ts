import * as fs from 'fs';
import * as readline from 'readline';
import { DeadlockIssue } from '../../domain/models/issue.model';
import { t } from '../../shared/i18n';

/**
 * Patterns that indicate a lock/deadlock problem in a Hibernate/Spring Boot log.
 *
 * Covers:
 *  - PostgreSQL: "deadlock detected", "could not obtain lock on row"
 *  - MySQL:      "Lock wait timeout exceeded", "Deadlock found when trying to get lock"
 *  - Hibernate:  "could not execute statement" wrapping lock errors
 *  - JPA:        "javax.persistence.PessimisticLockException" / "LockTimeoutException"
 */
const LOCK_PATTERNS: RegExp[] = [
  /deadlock detected/i,
  /deadlock found when trying to get lock/i,
  /could not obtain lock on row/i,
  /lock wait timeout exceeded/i,
  /pessimisticlockexception/i,
  /locktimeoutexception/i,
  /org\.postgresql\.util\.psqlexception.*lock/i,
  /com\.mysql\..*lock/i,
  /SQLState:\s*40P01/i,   // PostgreSQL deadlock
  /SQLState:\s*1213/i,    // MySQL deadlock
];

/** Matches "Offending SQL: <sql> — cause:" style lines emitted alongside the lock error. */
const OFFENDING_SQL_PATTERN = /offending sql:\s*(.+?)\s*[—–-]+\s*cause:/i;
/** Matches "... executing: <sql>" application log lines. */
const EXECUTING_SQL_PATTERN = /executing:\s*(.+)$/i;
/** Generic SQL statement, e.g. Hibernate `org.hibernate.SQL` / `Hibernate:` lines. */
const GENERIC_SQL_PATTERN = /\b(select|insert|update|delete)\b[\s\S]+?\b(from|into|set|where|values)\b/i;

/**
 * Tries to pull a SQL statement out of a single log line.
 * Returns the normalized SQL or null if the line carries no recoverable query.
 */
function extractSqlFromLine(line: string): string | null {
  const offending = line.match(OFFENDING_SQL_PATTERN);
  if (offending) return offending[1].trim();

  const executing = line.match(EXECUTING_SQL_PATTERN);
  if (executing) return executing[1].trim();

  const generic = line.match(GENERIC_SQL_PATTERN);
  if (generic) {
    // Keep the statement from the first SQL keyword onward
    const idx = line.toLowerCase().indexOf(generic[1].toLowerCase());
    return line.slice(idx).trim();
  }

  return null;
}

/**
 * Scans the log file for lock/deadlock error patterns.
 * Returns a DeadlockIssue if any are found.
 *
 * Besides counting the lock errors, it best-effort recovers the SQL statements
 * involved: from the error line itself ("Offending SQL: ..."), or failing that
 * from the most recent SQL statement seen earlier in the log.
 */
/** Standard app log line: "... [thread] INFO|WARN|ERROR com.example.Class - message". */
const APP_LOG_LINE = /\b(?:INFO|WARN|ERROR)\b\s+[\w.]+\s+-\s+.+$/i;
/** How many preceding app-log lines to keep as context around each lock error. */
const CONTEXT_WINDOW = 20;

export async function detectDeadlocks(logFilePath: string): Promise<DeadlockIssue[]> {
  const matchedLines: string[] = [];
  const capturedQueries: string[] = [];
  let lastSeenSql: string | null = null;

  // Rolling buffer of recent standard-format app log lines, used to attribute the
  // deadlock to the source method via its log.info()/warn()/error() calls.
  const recentAppLines: string[] = [];
  const contextLines = new Set<string>();

  const fileStream = fs.createReadStream(logFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();

    // Remember the latest SQL statement so we can attribute a lock error to it
    const sql = extractSqlFromLine(trimmed);
    if (sql) lastSeenSql = sql;

    // Keep a window of the most recent application log lines
    if (APP_LOG_LINE.test(trimmed)) {
      recentAppLines.push(trimmed);
      if (recentAppLines.length > CONTEXT_WINDOW) recentAppLines.shift();
    }

    if (LOCK_PATTERNS.some((p) => p.test(trimmed))) {
      matchedLines.push(trimmed);
      // Prefer SQL embedded in the error line, else the most recent SQL seen
      const attributed = extractSqlFromLine(trimmed) ?? lastSeenSql;
      if (attributed) capturedQueries.push(attributed);
      // Snapshot the surrounding app log lines so the source method can be traced
      for (const ctx of recentAppLines) contextLines.add(ctx);
      if (APP_LOG_LINE.test(trimmed)) contextLines.add(trimmed);
    }
  }

  if (matchedLines.length === 0) return [];

  // Deduplicate similar messages — keep unique patterns
  const unique = [...new Set(matchedLines)];
  const uniqueQueries = [...new Set(capturedQueries)];

  return [
    {
      type: 'DEADLOCK',
      severity: 'HIGH',
      // First recovered query (if any) — empty string when none could be found
      query: uniqueQueries[0] ?? '',
      description: t().detectors.deadlock.description(matchedLines.length),
      recommendation: t().detectors.deadlock.recommendation,
      evidence: unique.slice(0, 8),
      lineNumbers: [],
      occurrences: matchedLines.length,
      errorMessages: unique,
      queries: uniqueQueries,
      threadContextLines: [...contextLines],
    },
  ];
}
