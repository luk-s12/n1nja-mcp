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
      'db_top_queries',
      'explain_sql',
      'find_missing_indexes',
      'find_n1_in_code',
      'full_scan',
      'monitor_log',
      'show_report',
      'static_scan',
    ]);
  });

  it('static_scan allows empty input and validates maxFindingsPerProject', () => {
    const tool = tools.find((t) => t.name === 'static_scan')!;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ projectRoot: 'C:/x', maxFindingsPerProject: 10 }).success).toBe(true);
    expect(tool.schema.safeParse({ maxFindingsPerProject: 'many' }).success).toBe(false);
    expect(tool.schema.safeParse({ outputFile: 'report/static.md' }).success).toBe(true);
    expect(tool.schema.safeParse({ outputFile: 42 }).success).toBe(false);
  });

  it('db_top_queries validates the orderBy enum and allows empty input', () => {
    const tool = tools.find((t) => t.name === 'db_top_queries')!;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ orderBy: 'total_time', limit: 5, reset: false }).success).toBe(true);
    expect(tool.schema.safeParse({ orderBy: 'slowest' }).success).toBe(false);
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
});

// ── static_scan report file ──────────────────────────────────────────────────

describe('static_scan — .md report on disk', () => {
  let tmpDir: string;

  function write(relativePath: string, content: string): void {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-staticscan-report-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the markdown report to the given outputFile and returns its path', async () => {
    write(
      'src/main/java/com/demo/Order.java',
      `package com.demo;

import javax.persistence.Entity;
import javax.persistence.OneToMany;
import javax.persistence.FetchType;
import java.util.List;

@Entity
public class Order {
    @OneToMany(fetch = FetchType.EAGER)
    private List<Item> items;
}
`,
    );
    const outputFile = path.join(tmpDir, 'out', 'static-report.md');
    const tool = tools.find((t) => t.name === 'static_scan')!;

    const result = await tool.run({ projectRoot: tmpDir, outputFile });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.reportPath).toBe(outputFile);
    expect(fs.existsSync(outputFile)).toBe(true);
    const md = fs.readFileSync(outputFile, 'utf8');
    expect(md).toContain('EAGER');
    expect(result.content[1].text).toContain(`Report saved to: ${outputFile}`);
  });
});
