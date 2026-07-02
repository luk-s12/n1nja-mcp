import * as path from 'path';
import * as fs from 'fs';
import { getOrCreateWatcher, stopWatcher } from '../../../infrastructure/watcher/file-watcher';
import { ParsedQuery } from '../../../domain/models/query.model';
import { WatchStatus } from '../../../domain/models/report.model';

// Accumulate queries seen during watching for on-demand analysis
const watchedQueries = new Map<string, ParsedQuery[]>();

/** Default log path from the recommended Spring Boot logging config. */
const DEFAULT_LOG_FILE = 'logs/application.log';

export interface WatchLogInput {
  /** Path to the log file. Defaults to logs/application.log (Spring Boot default). */
  logFile?: string;
  action?: 'start' | 'stop' | 'status';
}

export interface WatchLogOutput {
  status: WatchStatus;
  message: string;
}

/**
 * Tool handler: watch_hibernate_log
 *
 * Starts (or stops) real-time monitoring of a log file.
 * Accumulated queries are stored in memory for later analysis via get_last_report.
 */
export function watchHibernateLog(input: WatchLogInput): WatchLogOutput {
  const { logFile = DEFAULT_LOG_FILE, action = 'start' } = input;
  const resolvedPath = path.resolve(logFile);

  if (action === 'stop') {
    process.stderr.write(`🥷 Stopping watcher: ${path.basename(resolvedPath)}\n`);
    stopWatcher(resolvedPath);
    watchedQueries.delete(resolvedPath);
    process.stderr.write(`✅ Watcher stopped\n`);
    return {
      status: {
        status: 'stopped',
        logFile: resolvedPath,
        startedAt: new Date().toISOString(),
        linesProcessed: 0,
        queriesFound: 0,
      },
      message: `Stopped watching ${resolvedPath}`,
    };
  }

  if (action === 'status') {
    const watcher = getOrCreateWatcher(resolvedPath);
    return { status: watcher.getStatus(), message: 'Status retrieved.' };
  }

  // action === 'start'
  if (!fs.existsSync(resolvedPath)) {
    process.stderr.write(
      `⏳ ${path.basename(resolvedPath)} does not exist yet — waiting for it to appear\n`,
    );
  }

  if (!watchedQueries.has(resolvedPath)) {
    watchedQueries.set(resolvedPath, []);
  }

  process.stderr.write(`🥷 Watching: ${path.basename(resolvedPath)}\n`);
  const watcher = getOrCreateWatcher(resolvedPath);

  watcher.on('query', (q: ParsedQuery) => {
    const list = watchedQueries.get(resolvedPath);
    if (list) list.push(q);
  });

  watcher.on('error', (err: Error) => {
    console.error(`[FileWatcher] Error on ${resolvedPath}:`, err.message);
  });

  watcher.start();
  process.stderr.write(`✅ Watcher active — tailing for Hibernate SQL\n`);

  return {
    status: watcher.getStatus(),
    message: `Now watching ${resolvedPath} for Hibernate SQL activity. Call show_report or analyze_hibernate_log to view accumulated results.`,
  };
}
