import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { tools } from '../../src/interfaces/mcp/registry';

describe('mcp tool registry', () => {
  it('exposes exactly the expected tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'analyze_hibernate_log',
      'autoconfig',
      'explain_sql',
      'find_missing_indexes',
      'find_n1_in_code',
      'full_scan',
      'monitor_log',
      'show_report',
    ]);
  });

  it('registers explain_sql (regression: it was missing from the old dispatcher)', () => {
    expect(tools.some((t) => t.name === 'explain_sql')).toBe(true);
  });

  it('every tool has a non-empty description and an object JSON Schema', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      const jsonSchema = z.toJSONSchema(t.schema) as { type?: string };
      expect(jsonSchema.type).toBe('object');
    }
  });

  it('analyze_hibernate_log allows empty input (logFile defaults) and accepts a path', () => {
    const tool = tools.find((t) => t.name === 'analyze_hibernate_log')!;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ logFile: 'app.log' }).success).toBe(true);
    expect(tool.schema.safeParse({ logFile: 123 }).success).toBe(false);
  });

  it('monitor_log validates the action enum and allows empty input', () => {
    const tool = tools.find((t) => t.name === 'monitor_log')!;
    expect(tool.schema.safeParse({ action: 'bogus' }).success).toBe(false);
    expect(tool.schema.safeParse({ action: 'start' }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(true);
  });

  it('full_scan accepts optional config thresholds', () => {
    const tool = tools.find((t) => t.name === 'full_scan')!;
    expect(tool.schema.safeParse({ config: { slowQueryMs: 200 } }).success).toBe(true);
    expect(tool.schema.safeParse({ config: { slowQueryMs: 'fast' } }).success).toBe(false);
  });

  it('full_scan and autoconfig accept the force flag', () => {
    for (const name of ['full_scan', 'autoconfig']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.schema.safeParse({ force: true }).success).toBe(true);
      expect(tool.schema.safeParse({ force: 'yes' }).success).toBe(false);
    }
  });
});

// ── Non-JPA project gate ─────────────────────────────────────────────────────

describe('non-JPA project gate (full_scan / autoconfig)', () => {
  let tmpDir: string;

  function writeProjectFile(relativePath: string, content: string): void {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  /** Minimal reactive (non-JPA) service: *-rx-* parent, no JPA anywhere. */
  function writeReactiveProject(): void {
    writeProjectFile(
      'pom.xml',
      `<project>
  <parent>
    <groupId>com.global</groupId>
    <artifactId>global66-rx-starter-parent</artifactId>
    <version>1.0.0</version>
  </parent>
</project>
`,
    );
    writeProjectFile(
      'src/main/java/com/demo/Handler.java',
      'package com.demo;\n\nimport reactor.core.publisher.Mono;\n\npublic class Handler {}\n',
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-gate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('autoconfig skips a reactive project and touches no files', async () => {
    writeReactiveProject();
    const tool = tools.find((t) => t.name === 'autoconfig')!;

    const result = await tool.run({ projectRoot: tmpDir });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.skipped).toBe(true);
    expect(payload.kind).toBe('non-jpa-java');
    expect(fs.existsSync(path.join(tmpDir, 'src/main/resources/application.properties'))).toBe(false);
  });

  it('autoconfig with force: true configures the project anyway', async () => {
    writeReactiveProject();
    const tool = tools.find((t) => t.name === 'autoconfig')!;

    const result = await tool.run({ projectRoot: tmpDir, force: true });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.skipped).toBeUndefined();
    expect(payload.scenario).toBe('created-properties');
  });

  it('autoconfig undo is never gated (reverts even on a non-JPA project)', async () => {
    writeReactiveProject();
    const tool = tools.find((t) => t.name === 'autoconfig')!;
    await tool.run({ projectRoot: tmpDir, force: true });

    const result = await tool.run({ projectRoot: tmpDir, action: 'undo' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.action).toBe('undo');
    expect(fs.existsSync(path.join(tmpDir, 'src/main/resources/application.properties'))).toBe(false);
  });

  it('full_scan skips a non-Java project (Node lambda) without needing a log file', async () => {
    writeProjectFile('package.json', '{ "name": "lambda-mailer" }\n');
    const tool = tools.find((t) => t.name === 'full_scan')!;

    const result = await tool.run({ projectRoot: tmpDir });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.skipped).toBe(true);
    expect(payload.kind).toBe('non-java');
  });
});
