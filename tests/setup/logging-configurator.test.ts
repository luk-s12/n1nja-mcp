import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setupLogging, undoLogging } from '../../src/core/setup/logging-configurator';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeProjectFile(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(tmpDir, relativePath), 'utf8');
}

const RES = 'src/main/resources';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-setup-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Logback branch ──────────────────────────────────────────────────────────

describe('setupLogging — logback branch', () => {
  const LOGBACK = `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger : %msg%n</pattern>
        </encoder>
    </appender>
    <root level="info">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`;

  it('detects logback and injects file appender, loggers and root ref', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);

    const result = setupLogging(tmpDir);
    const xml = read(`${RES}/logback-spring.xml`);

    expect(result.scenario).toBe('logback');
    expect(xml).toContain('name="n1njaFileAppender"');
    expect(xml).toContain('<file>logs/application.log</file>');
    expect(xml).toContain('<logger name="org.hibernate.SQL" level="DEBUG"/>');
    expect(xml).toContain('<logger name="org.hibernate.orm.jdbc.bind" level="TRACE"/>');
    expect(xml).toContain('<logger name="org.hibernate.stat" level="DEBUG"/>');
    expect(xml).toContain('<appender-ref ref="n1njaFileAppender"/>');
    // The new ref lands inside <root>, aligned with the existing one.
    expect(xml).toMatch(/<root[^>]*>[\s\S]*?<appender-ref ref="n1njaFileAppender"\/>[\s\S]*?<\/root>/);
  });

  it('does NOT touch application.properties when logback is present', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);
    writeProjectFile(`${RES}/application.properties`, 'spring.application.name=demo\n');

    const result = setupLogging(tmpDir);

    expect(result.scenario).toBe('logback');
    expect(read(`${RES}/application.properties`)).toBe('spring.application.name=demo\n');
  });

  it('is idempotent — a second run makes no changes', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);

    setupLogging(tmpDir);
    const afterFirst = read(`${RES}/logback-spring.xml`);
    const second = setupLogging(tmpDir);
    const afterSecond = read(`${RES}/logback-spring.xml`);

    expect(afterSecond).toBe(afterFirst);
    expect(second.changes[0].action).toBe('unchanged');
  });

  it('reuses a custom encoder layout (does not leak PII to the file)', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <layout class="com.acme.MaskingPatternLayout">
                <pattern>%d %msg%n</pattern>
            </layout>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    // The file appender must carry the masking layout, not the generic pattern.
    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    expect(fileAppender).toContain('com.acme.MaskingPatternLayout');
    // A <layout> inside a class-less <encoder> would resolve to the default
    // PatternLayoutEncoder, which rejects setLayout and breaks app startup.
    expect(fileAppender).toContain('<encoder class="ch.qos.logback.core.encoder.LayoutWrappingEncoder">');
  });

  it('copies the original encoder class when reusing a wrapped custom layout', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="ch.qos.logback.core.encoder.LayoutWrappingEncoder">
            <layout class="com.acme.MaskingPatternLayout">
                <pattern>\${CONSOLE_LOG_PATTERN}</pattern>
            </layout>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    expect(fileAppender).toContain('<encoder class="ch.qos.logback.core.encoder.LayoutWrappingEncoder">');
    expect(fileAppender).toContain('com.acme.MaskingPatternLayout');
  });

  it('strips %clr converters and resolves the property ref for the file appender', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <property name="CONSOLE_LOG_PATTERN"
              value="%clr(%5p) [\${app-name},%X{X-Amzn-Request-Id}] [dd.trace_id=%X{dd.trace_id:-0}] %clr(---){faint} %clr(%logger{35}){cyan} %clr(:){faint} %m%n%wEx"/>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="ch.qos.logback.core.encoder.LayoutWrappingEncoder">
            <layout class="com.acme.MaskingPatternLayout">
                <pattern>\${CONSOLE_LOG_PATTERN}</pattern>
            </layout>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    // Layout + encoder class preserved, but the pattern is inlined without colors.
    expect(fileAppender).toContain('com.acme.MaskingPatternLayout');
    expect(fileAppender).toContain('<encoder class="ch.qos.logback.core.encoder.LayoutWrappingEncoder">');
    expect(fileAppender).toContain(
      '<pattern>%5p [${app-name},%X{X-Amzn-Request-Id}] [dd.trace_id=%X{dd.trace_id:-0}] --- %logger{35} : %m%n%wEx</pattern>',
    );
    expect(fileAppender).not.toContain('%clr');
    // The console appender keeps its original colored pattern.
    const consoleAppender = xml.match(/<appender name="consoleAppender"[\s\S]*?<\/appender>/)![0];
    expect(consoleAppender).toContain('${CONSOLE_LOG_PATTERN}');
  });

  it('strips Logback native color converters from an inline pattern', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss} %highlight(%-5level) %cyan(%logger{15}) %boldRed(%X{err}) %msg%n</pattern>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    expect(fileAppender).toContain(
      '<pattern>%d{HH:mm:ss} %-5level %logger{15} %X{err} %msg%n</pattern>',
    );
  });

  it('keeps a ${property} pattern reference untouched when it has no colors', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <property name="FILE_LOG_PATTERN" value="%d{yyyy-MM-dd} %-5level %logger : %msg%n"/>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>\${FILE_LOG_PATTERN}</pattern>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    // No colors → the indirection is preserved, not inlined.
    expect(fileAppender).toContain('<pattern>${FILE_LOG_PATTERN}</pattern>');
  });

  it('does not add an encoder class when reusing a plain custom pattern', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss} %msg%n</pattern>
        </encoder>
    </appender>
    <root level="INFO">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback.xml`);

    const fileAppender = xml.match(/<appender name="n1njaFileAppender"[\s\S]*?<\/appender>/)![0];
    expect(fileAppender).toContain('<pattern>%d{HH:mm:ss} %msg%n</pattern>');
    expect(fileAppender).toContain('<encoder>');
    expect(fileAppender).not.toContain('<encoder class=');
  });

  it('expands a self-closing <root/> and wires the ref', () => {
    writeProjectFile(
      `${RES}/logback-spring.xml`,
      `<configuration>
    <appender name="c" class="ch.qos.logback.core.ConsoleAppender">
        <encoder><pattern>%msg%n</pattern></encoder>
    </appender>
    <root level="INFO"/>
</configuration>
`,
    );

    setupLogging(tmpDir);
    const xml = read(`${RES}/logback-spring.xml`);

    expect(xml).toMatch(/<root[^>]*>\s*<appender-ref ref="n1njaFileAppender"\/>\s*<\/root>/);
  });
});

// ── Properties / YAML branch ─────────────────────────────────────────────────

describe('setupLogging — properties branch', () => {
  it('adds logging keys to base .properties and every profile variant', () => {
    writeProjectFile(`${RES}/application.properties`, 'spring.application.name=demo\n');
    writeProjectFile(`${RES}/application-prod.properties`, 'server.port=9090\n');

    const result = setupLogging(tmpDir);

    expect(result.scenario).toBe('properties');
    for (const file of ['application.properties', 'application-prod.properties']) {
      const content = read(`${RES}/${file}`);
      expect(content).toContain('logging.file.name=logs/application.log');
      expect(content).toContain('logging.level.org.hibernate.SQL=DEBUG');
      expect(content).toContain('logging.level.org.hibernate.orm.jdbc.bind=TRACE');
      expect(content).toContain('logging.level.org.hibernate.stat=DEBUG');
    }
  });

  it('adds flat dotted keys to a .yml file', () => {
    writeProjectFile(`${RES}/application.yml`, 'spring:\n  jpa:\n    show-sql: false\n');

    setupLogging(tmpDir);
    const yml = read(`${RES}/application.yml`);

    expect(yml).toContain('"logging.file.name": logs/application.log');
    expect(yml).toContain('"logging.level.org.hibernate.SQL": DEBUG');
    // Original content preserved.
    expect(yml).toContain('show-sql: false');
  });

  it('does not duplicate keys already present (.properties)', () => {
    writeProjectFile(
      `${RES}/application.properties`,
      'logging.file.name=custom/path.log\nlogging.level.org.hibernate.SQL=DEBUG\n',
    );

    const result = setupLogging(tmpDir);
    const content = read(`${RES}/application.properties`);

    // Existing file.name kept, not overwritten.
    expect(content).toContain('logging.file.name=custom/path.log');
    expect((content.match(/logging\.file\.name/g) || []).length).toBe(1);
    expect((content.match(/logging\.level\.org\.hibernate\.SQL/g) || []).length).toBe(1);
    // Only the two missing hibernate loggers were added.
    expect(content).toContain('logging.level.org.hibernate.orm.jdbc.bind=TRACE');
    expect(result.changes[0].action).toBe('updated');
  });

  it('recognizes pre-flattened dotted keys in YAML and skips them', () => {
    writeProjectFile(
      `${RES}/application.yml`,
      'logging.file.name: existing.log\nlogging.level.org.hibernate.SQL: DEBUG\n',
    );

    setupLogging(tmpDir);
    const yml = read(`${RES}/application.yml`);

    expect((yml.match(/logging\.file\.name/g) || []).length).toBe(1);
    expect(yml).toContain('existing.log');
  });
});

// ── No config at all ──────────────────────────────────────────────────────────

describe('setupLogging — no config', () => {
  it('creates application.properties when nothing exists', () => {
    fs.mkdirSync(path.join(tmpDir, 'src/main/java'), { recursive: true });

    const result = setupLogging(tmpDir);
    const content = read(`${RES}/application.properties`);

    expect(result.scenario).toBe('created-properties');
    expect(result.changes[0].action).toBe('created');
    expect(content).toContain('logging.file.name=logs/application.log');
    expect(content).toContain('logging.level.org.hibernate.SQL=DEBUG');
  });
});

// ── Undo ──────────────────────────────────────────────────────────────────────

describe('undoLogging', () => {
  const LOGBACK = `<configuration>
    <appender name="consoleAppender" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger : %msg%n</pattern>
        </encoder>
    </appender>
    <root level="info">
        <appender-ref ref="consoleAppender"/>
    </root>
</configuration>
`;

  it('restores a logback.xml byte-for-byte after apply', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);

    setupLogging(tmpDir);
    expect(read(`${RES}/logback-spring.xml`)).not.toBe(LOGBACK); // sanity: apply changed it

    const result = undoLogging(tmpDir);

    expect(read(`${RES}/logback-spring.xml`)).toBe(LOGBACK);
    expect(result.changes[0].action).toBe('reverted');
  });

  it('restores a self-closing <root/> logback exactly', () => {
    const xml = `<configuration>
    <appender name="c" class="ch.qos.logback.core.ConsoleAppender">
        <encoder><pattern>%msg%n</pattern></encoder>
    </appender>
    <root level="INFO"/>
</configuration>
`;
    writeProjectFile(`${RES}/logback-spring.xml`, xml);

    setupLogging(tmpDir);
    undoLogging(tmpDir);

    expect(read(`${RES}/logback-spring.xml`)).toBe(xml);
  });

  it('restores .properties and .yml files byte-for-byte after apply', () => {
    const props = 'spring.application.name=demo\n';
    const yml = 'spring:\n  jpa:\n    show-sql: false\n';
    writeProjectFile(`${RES}/application.properties`, props);
    writeProjectFile(`${RES}/application-prod.yml`, yml);

    setupLogging(tmpDir);
    undoLogging(tmpDir);

    expect(read(`${RES}/application.properties`)).toBe(props);
    expect(read(`${RES}/application-prod.yml`)).toBe(yml);
  });

  it('keeps user lines appended AFTER the N1nja block', () => {
    writeProjectFile(`${RES}/application.properties`, 'spring.application.name=demo\n');

    setupLogging(tmpDir);
    const withUserLine = read(`${RES}/application.properties`) + 'server.port=9090\n';
    writeProjectFile(`${RES}/application.properties`, withUserLine);

    undoLogging(tmpDir);
    const content = read(`${RES}/application.properties`);

    expect(content).toContain('server.port=9090');
    expect(content).not.toContain('Added by N1nja');
    expect(content).not.toContain('logging.level.org.hibernate.SQL');
  });

  it('deletes the application.properties N1nja created from scratch', () => {
    fs.mkdirSync(path.join(tmpDir, 'src/main/java'), { recursive: true });

    setupLogging(tmpDir); // created-properties scenario
    const file = path.join(tmpDir, RES, 'application.properties');
    expect(fs.existsSync(file)).toBe(true);

    const result = undoLogging(tmpDir);

    expect(fs.existsSync(file)).toBe(false);
    expect(result.changes.some((c) => c.action === 'deleted')).toBe(true);
  });

  it('keeps a N1nja-created file that gained foreign lines, removing only ours', () => {
    fs.mkdirSync(path.join(tmpDir, 'src/main/java'), { recursive: true });

    setupLogging(tmpDir);
    const rel = `${RES}/application.properties`;
    writeProjectFile(rel, read(rel) + 'spring.application.name=demo\n');

    undoLogging(tmpDir);
    const content = read(rel);

    expect(content).toContain('spring.application.name=demo');
    expect(content).not.toContain('Created by N1nja');
    expect(content).not.toContain('logging.level.org.hibernate');
  });

  it('is a no-op on a pristine project', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);
    writeProjectFile(`${RES}/application.properties`, 'spring.application.name=demo\n');

    const result = undoLogging(tmpDir);

    expect(result.changes.every((c) => c.action === 'unchanged')).toBe(true);
    expect(read(`${RES}/logback-spring.xml`)).toBe(LOGBACK);
  });

  it('apply after undo behaves like a first apply (idempotent cycle)', () => {
    writeProjectFile(`${RES}/logback-spring.xml`, LOGBACK);

    setupLogging(tmpDir);
    const firstApply = read(`${RES}/logback-spring.xml`);
    undoLogging(tmpDir);
    setupLogging(tmpDir);

    expect(read(`${RES}/logback-spring.xml`)).toBe(firstApply);
  });
});

// ── Spring Cloud Config awareness ─────────────────────────────────────────────

describe('setupLogging — config server detection', () => {
  it('warns and suggests env vars when configserver: is imported', () => {
    writeProjectFile(`${RES}/application.yml`, 'spring:\n  application:\n    name: ms-demo\n');
    writeProjectFile(
      `${RES}/application-prod.yml`,
      'spring:\n  config:\n    import: "optional:configserver:https://lb-config.example.com/config"\n',
    );

    const result = setupLogging(tmpDir);

    expect(result.configServerFiles).toHaveLength(1);
    expect(result.configServerFiles[0]).toContain('application-prod.yml');
    expect(result.markdownReport).toContain('Spring Cloud Config detected');
    expect(result.markdownReport).toContain('LOGGING_LEVEL_ORG_HIBERNATE_SQL=DEBUG');
    expect(result.markdownReport).toContain('LOGGING_LEVEL_ORG_HIBERNATE_ORM_JDBC_BIND=TRACE');
  });

  it('also warns in the logback scenario (config files are still scanned)', () => {
    writeProjectFile(
      `${RES}/logback.xml`,
      '<configuration><root level="INFO"/></configuration>\n',
    );
    writeProjectFile(
      `${RES}/application.yml`,
      'spring.config.import: "configserver:https://cfg.internal"\n',
    );

    const result = setupLogging(tmpDir);

    expect(result.scenario).toBe('logback');
    expect(result.configServerFiles).toHaveLength(1);
    expect(result.markdownReport).toContain('Spring Cloud Config detected');
  });

  it('does not warn without a config server import', () => {
    writeProjectFile(`${RES}/application.yml`, 'spring:\n  application:\n    name: ms-demo\n');

    const result = setupLogging(tmpDir);

    expect(result.configServerFiles).toHaveLength(0);
    expect(result.markdownReport).not.toContain('Spring Cloud Config detected');
  });
});
