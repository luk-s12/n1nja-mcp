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
});
