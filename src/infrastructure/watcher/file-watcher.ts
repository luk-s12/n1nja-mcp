import * as fs from 'fs';
import * as readline from 'readline';
import { EventEmitter } from 'events';
import { HibernateLogParser } from '../../core/parsing/log-parser';
import { ParsedQuery } from '../../domain/models/query.model';
import { WatchStatus } from '../../domain/models/report.model';

/**
 * Events emitted by FileWatcher:
 *  - 'query'  : ParsedQuery     — each time a new query is parsed
 *  - 'error'  : Error
 *  - 'close'  : void
 */
export class FileWatcher extends EventEmitter {
  private readonly logFile: string;
  private fileStream?: fs.ReadStream;
  private rl?: readline.Interface;
  private parser: HibernateLogParser;
  private watchTimer?: NodeJS.Timeout;
  private filePosition = 0;
  private isWatching = false;
  private startedAt: string;
  private linesProcessed = 0;
  private queriesFound = 0;

  constructor(logFile: string) {
    super();
    this.logFile = logFile;
    this.startedAt = new Date().toISOString();
    this.parser = new HibernateLogParser((query: ParsedQuery) => {
      this.queriesFound++;
      this.emit('query', query);
    });
  }

  /**
   * Start tailing the log file.
   * Reads from the current end of file and watches for new content.
   */
  public start(): void {
    if (this.isWatching) return;
    this.isWatching = true;

    // Get current file size to start from the tail
    try {
      const stat = fs.statSync(this.logFile);
      this.filePosition = stat.size;
    } catch {
      this.filePosition = 0;
    }

    // Poll every 500ms for new content (cross-platform: avoids fs.watch quirks on Windows)
    this.watchTimer = setInterval(() => this.poll(), 500);
  }

  /**
   * Stop watching.
   */
  public stop(): void {
    this.isWatching = false;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (this.rl) this.rl.close();
    if (this.fileStream) this.fileStream.destroy();
    this.parser.flush();
    this.emit('close');
  }

  public getStatus(): WatchStatus {
    return {
      status: this.isWatching ? 'watching' : 'stopped',
      logFile: this.logFile,
      startedAt: this.startedAt,
      linesProcessed: this.linesProcessed,
      queriesFound: this.queriesFound,
    };
  }

  public getStatistics() {
    return this.parser.getStatistics();
  }

  // ---------------------------------------------------------------------------

  private poll(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.logFile);
    } catch {
      return; // file not yet available
    }

    if (stat.size <= this.filePosition) return; // no new content

    const start = this.filePosition;
    const end = stat.size - 1;
    this.filePosition = stat.size;

    const stream = fs.createReadStream(this.logFile, { start, end, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream as unknown as NodeJS.ReadableStream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      this.linesProcessed++;
      this.parser.processLine(line);
    });
    rl.on('close', () => {
      this.parser.flush();
    });
    stream.on('error', (err) => this.emit('error', err));
  }
}

// Singleton registry: logFile → FileWatcher
const activeWatchers = new Map<string, FileWatcher>();

export function getOrCreateWatcher(logFile: string): FileWatcher {
  let watcher = activeWatchers.get(logFile);
  if (!watcher) {
    watcher = new FileWatcher(logFile);
    activeWatchers.set(logFile, watcher);
  }
  return watcher;
}

export function stopWatcher(logFile: string): void {
  const watcher = activeWatchers.get(logFile);
  if (watcher) {
    watcher.stop();
    activeWatchers.delete(logFile);
  }
}
