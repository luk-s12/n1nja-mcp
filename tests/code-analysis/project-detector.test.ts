import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectProject, buildNotApplicableMarkdown } from '../../src/core/code-analysis/project-detector';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeProjectFile(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function pom(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<project>\n${body}\n</project>\n`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-detector-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── JPA projects (applicable) ───────────────────────────────────────────────

describe('detectProject — JPA projects', () => {
  it('detects JPA from a spring-boot-starter-data-jpa dependency', () => {
    writeProjectFile(
      'pom.xml',
      pom(`  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
  </dependencies>`),
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('jpa');
    expect(result.applicable).toBe(true);
    expect(result.signals.join('\n')).toContain('spring-boot-starter-data-jpa');
  });

  it('detects JPA from a corporate parent artifactId (*-mysql-*) when the pom hides the deps', () => {
    writeProjectFile(
      'pom.xml',
      pom(`  <parent>
    <groupId>com.global</groupId>
    <artifactId>global66-mysql-starter-parent</artifactId>
    <version>1.2.0</version>
  </parent>`),
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('jpa');
    expect(result.applicable).toBe(true);
    expect(result.signals.join('\n')).toContain('global66-mysql-starter-parent');
  });

  it('detects JPA from javax.persistence imports even with an uninformative pom', () => {
    writeProjectFile('pom.xml', pom('  <artifactId>ms-demo</artifactId>'));
    writeProjectFile(
      'src/main/java/com/demo/Customer.java',
      'package com.demo;\n\nimport javax.persistence.Entity;\n\n@Entity\npublic class Customer {}\n',
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('jpa');
    expect(result.applicable).toBe(true);
  });

  it('detects JPA from jakarta.persistence sources without any build file', () => {
    writeProjectFile(
      'src/main/java/com/demo/Order.java',
      'package com.demo;\n\nimport jakarta.persistence.Entity;\n\n@Entity\npublic class Order {}\n',
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('jpa');
    expect(result.applicable).toBe(true);
  });
});

// ── Non-JPA Java projects (skipped) ─────────────────────────────────────────

describe('detectProject — non-JPA Java projects', () => {
  it('skips a reactive WebFlux + MongoDB service (parent *-rx-*)', () => {
    writeProjectFile(
      'pom.xml',
      pom(`  <parent>
    <groupId>com.global</groupId>
    <artifactId>global66-rx-starter-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
  </dependencies>`),
    );
    writeProjectFile(
      'src/main/java/com/demo/NotificationHandler.java',
      'package com.demo;\n\nimport reactor.core.publisher.Mono;\n\npublic class NotificationHandler {}\n',
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('non-jpa-java');
    expect(result.applicable).toBe(false);
    expect(result.signals.join('\n')).toContain('global66-rx-starter-parent');
    expect(result.signals.join('\n')).toContain('spring-boot-starter-webflux');
  });

  it('skips a plain Java project with no persistence at all', () => {
    writeProjectFile('pom.xml', pom('  <artifactId>plain-lib</artifactId>'));
    writeProjectFile(
      'src/main/java/com/demo/Util.java',
      'package com.demo;\n\npublic class Util {}\n',
    );

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('non-jpa-java');
    expect(result.applicable).toBe(false);
    expect(result.signals.join('\n')).toContain('No JPA/Hibernate evidence');
  });
});

// ── Non-Java projects (skipped) ─────────────────────────────────────────────

describe('detectProject — non-Java projects', () => {
  it('skips a Node.js lambda (package.json, no pom)', () => {
    writeProjectFile('package.json', '{ "name": "lambda-mailer" }\n');
    writeProjectFile('index.js', 'exports.handler = async () => {};\n');

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('non-java');
    expect(result.applicable).toBe(false);
    expect(result.signals.join('\n')).toContain('Node.js');
  });

  it('skips a Python lambda (only .py files at the root)', () => {
    writeProjectFile('handler.py', 'def handler(event, context):\n    return {}\n');

    const result = detectProject(tmpDir);

    expect(result.kind).toBe('non-java');
    expect(result.applicable).toBe(false);
    expect(result.signals.join('\n')).toContain('Python');
  });
});

// ── Unknown layouts (benefit of the doubt) ──────────────────────────────────

describe('detectProject — unknown layouts', () => {
  it('lets an empty directory through (previous behavior preserved)', () => {
    const result = detectProject(tmpDir);

    expect(result.kind).toBe('unknown');
    expect(result.applicable).toBe(true);
  });
});

// ── Markdown ────────────────────────────────────────────────────────────────

describe('buildNotApplicableMarkdown', () => {
  it('names the tool, the evidence and the force escape hatch', () => {
    writeProjectFile('package.json', '{}\n');
    const detection = detectProject(tmpDir);

    const md = buildNotApplicableMarkdown(detection, 'autoconfig');

    expect(md).toContain('`autoconfig`');
    expect(md).toContain('## Evidence');
    expect(md).toContain('force: true');
  });
});
