import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDeadlocks } from '../../src/core/detection/deadlock.detector';

/** Writes lines to a unique temp log file and returns its path. */
function writeTempLog(lines: string[]): string {
  const file = path.join(os.tmpdir(), `n1nja-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  tempFiles.push(file);
  return file;
}

const tempFiles: string[] = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

const APP = 'c.e.demo.service.ProblemService';

describe('detectDeadlocks', () => {
  it('returns no issues when there is no lock error', async () => {
    const log = writeTempLog([
      `2026-06-23 21:00:00.000 [main] INFO  ${APP} - app started`,
      `2026-06-23 21:00:01.000 [http-1] DEBUG org.hibernate.SQL - select * from orders`,
    ]);
    expect(await detectDeadlocks(log)).toEqual([]);
  });

  it('detects a deadlock and recovers the SQL from the "Offending SQL:" line', async () => {
    const log = writeTempLog([
      `2026-06-23 21:16:15.587 [http-1] WARN  ${APP} - [Deadlock] Starting simulation`,
      `2026-06-23 21:16:15.588 [deadlock-t2] INFO  ${APP} - [Deadlock] Thread-2 executing: UPDATE orders SET status = status WHERE id = 1`,
      `2026-06-23 21:16:15.589 [deadlock-t2] ERROR ${APP} - [Deadlock] Thread-2 rolled back as deadlock victim. Offending SQL: UPDATE orders SET status = status WHERE id = 1 — cause: rollback`,
      `Deadlock detected. The current transaction was rolled back. Details: "ORDERS"; SQL statement:`,
      `UPDATE orders SET status = status WHERE id = 1 [40001-240]`,
    ]);

    const issues = await detectDeadlocks(log);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.type).toBe('DEADLOCK');
    expect(issue.severity).toBe('HIGH');
    expect(issue.occurrences).toBeGreaterThanOrEqual(1);
    expect(issue.query).toBe('UPDATE orders SET status = status WHERE id = 1');
    expect(issue.queries).toContain('UPDATE orders SET status = status WHERE id = 1');
  });

  it('captures thread context lines so the source method can be traced', async () => {
    const errorLine = `2026-06-23 21:16:15.589 [deadlock-t2] ERROR ${APP} - [Deadlock] Thread-2 rolled back as deadlock victim. Offending SQL: UPDATE orders SET status = status WHERE id = 1 — cause: x`;
    const log = writeTempLog([
      `2026-06-23 21:16:15.587 [http-1] WARN  ${APP} - [Deadlock] Starting simulation`,
      errorLine,
      `Deadlock detected. The current transaction was rolled back.`,
    ]);

    const issues = await detectDeadlocks(log);
    expect(issues[0].threadContextLines).toBeDefined();
    expect(issues[0].threadContextLines!.some((l) => l.includes('ProblemService'))).toBe(true);
  });

  it('falls back to the most recent SQL when the error line has no embedded SQL', async () => {
    const log = writeTempLog([
      `2026-06-23 21:16:15.588 [deadlock-t2] INFO  ${APP} - [Deadlock] Thread-2 executing: UPDATE orders SET status = status WHERE id = 5`,
      `Deadlock detected. The current transaction was rolled back.`,
    ]);

    const issues = await detectDeadlocks(log);
    expect(issues[0].query).toBe('UPDATE orders SET status = status WHERE id = 5');
  });

  it('still reports the deadlock with empty query when no SQL is recoverable', async () => {
    const log = writeTempLog([
      `2026-06-23 21:16:15.589 [http-1] ERROR ${APP} - org.postgresql.util.PSQLException: deadlock detected`,
    ]);

    const issues = await detectDeadlocks(log);
    expect(issues).toHaveLength(1);
    expect(issues[0].query).toBe('');
    expect(issues[0].queries).toEqual([]);
    expect(issues[0].occurrences).toBe(1);
  });
});
