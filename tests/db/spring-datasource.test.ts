import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadSpringDatasource, parseJdbcUrl } from '../../src/infrastructure/db/spring-datasource';
import { loadDbConfig } from '../../src/infrastructure/db/db-config';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeProjectFile(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const DB_ENV_KEYS = ['DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SCHEMA', 'DB_SSL', 'SPRING_PROFILES_ACTIVE'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1nja-spring-test-'));
  savedEnv = {};
  for (const key of DB_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of DB_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ── parseJdbcUrl ──────────────────────────────────────────────────────────────

describe('parseJdbcUrl', () => {
  it('parses a PostgreSQL URL with port', () => {
    expect(parseJdbcUrl('jdbc:postgresql://localhost:5432/mydb')).toEqual({
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      database: 'mydb',
    });
  });

  it('parses a MySQL URL without port and with query params', () => {
    expect(parseJdbcUrl('jdbc:mysql://db.example.com/shop?useSSL=false&serverTimezone=UTC')).toEqual({
      type: 'mysql',
      host: 'db.example.com',
      port: undefined,
      database: 'shop',
    });
  });

  it('treats MariaDB as MySQL', () => {
    expect(parseJdbcUrl('jdbc:mariadb://localhost:3306/mydb')?.type).toBe('mysql');
  });

  it('returns null for non-JDBC or unsupported URLs', () => {
    expect(parseJdbcUrl('postgresql://localhost/mydb')).toBeNull();
    expect(parseJdbcUrl('jdbc:h2:mem:testdb')).toBeNull();
  });
});

// ── loadSpringDatasource ──────────────────────────────────────────────────────

describe('loadSpringDatasource', () => {
  it('reads application.properties', () => {
    writeProjectFile('src/main/resources/application.properties', [
      '# datasource',
      'spring.datasource.url=jdbc:postgresql://localhost:5432/demo',
      'spring.datasource.username=demo_user',
      'spring.datasource.password=secret',
    ].join('\n'));

    const result = loadSpringDatasource(tmpDir);
    expect(result).toMatchObject({
      type: 'postgresql',
      host: 'localhost',
      port: 5432,
      database: 'demo',
      user: 'demo_user',
      password: 'secret',
    });
  });

  it('reads application.yml with nested keys', () => {
    writeProjectFile('src/main/resources/application.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:mysql://127.0.0.1:3306/shop',
      '    username: root',
      '    password: ""',
      'server:',
      '  port: 8080',
    ].join('\n'));

    const result = loadSpringDatasource(tmpDir);
    expect(result).toMatchObject({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'shop',
      user: 'root',
      password: '',
    });
  });

  it('resolves ${VAR:default} placeholders and leaves unresolvable values undefined', () => {
    process.env.TEST_N1NJA_DB_USER = 'env_user';
    try {
      writeProjectFile('src/main/resources/application.properties', [
        'spring.datasource.url=jdbc:postgresql://localhost:5432/demo',
        'spring.datasource.username=${TEST_N1NJA_DB_USER}',
        'spring.datasource.password=${TEST_N1NJA_MISSING_SECRET}',
      ].join('\n'));

      const result = loadSpringDatasource(tmpDir);
      expect(result?.user).toBe('env_user');
      expect(result?.password).toBeUndefined();
    } finally {
      delete process.env.TEST_N1NJA_DB_USER;
    }
  });

  it('returns null when no config file defines a datasource URL', () => {
    writeProjectFile('src/main/resources/application.properties', 'server.port=8080\n');
    expect(loadSpringDatasource(tmpDir)).toBeNull();
    expect(loadSpringDatasource(path.join(tmpDir, 'nope'))).toBeNull();
  });

  it('falls back to application-{profile}.yml when the base has no datasource', () => {
    writeProjectFile('src/main/resources/application.yml', 'server:\n  port: 8080\n');
    writeProjectFile('src/main/resources/application-ci.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://ci-db:5432/ci_db',
      '    username: ci_user',
      '    password: ci_pass',
    ].join('\n'));

    const result = loadSpringDatasource(tmpDir);
    expect(result).toMatchObject({ host: 'ci-db', database: 'ci_db', user: 'ci_user' });
    expect(result?.sourceFile).toContain('application-ci.yml');
  });

  it('merges profile values over the base (profile url + base credentials)', () => {
    writeProjectFile('src/main/resources/application.properties', [
      'spring.datasource.username=base_user',
      'spring.datasource.password=base_pass',
    ].join('\n'));
    writeProjectFile('src/main/resources/application-dev.properties',
      'spring.datasource.url=jdbc:mysql://dev-db:3306/dev_db\n');

    const result = loadSpringDatasource(tmpDir);
    expect(result).toMatchObject({
      host: 'dev-db',
      database: 'dev_db',
      user: 'base_user',
      password: 'base_pass',
    });
  });

  it("prefers the profile named in the base's spring.profiles.active", () => {
    writeProjectFile('src/main/resources/application.yml', [
      'spring:',
      '  profiles:',
      '    active: prod',
    ].join('\n'));
    writeProjectFile('src/main/resources/application-dev.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://dev-db:5432/dev_db',
    ].join('\n'));
    writeProjectFile('src/main/resources/application-prod.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://prod-db:5432/prod_db',
    ].join('\n'));

    expect(loadSpringDatasource(tmpDir)?.host).toBe('prod-db');
  });

  it('prefers the profile from SPRING_PROFILES_ACTIVE over the base config', () => {
    process.env.SPRING_PROFILES_ACTIVE = 'ci';
    writeProjectFile('src/main/resources/application.yml', [
      'spring:',
      '  profiles:',
      '    active: prod',
    ].join('\n'));
    writeProjectFile('src/main/resources/application-ci.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://ci-db:5432/ci_db',
    ].join('\n'));
    writeProjectFile('src/main/resources/application-prod.yml', [
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://prod-db:5432/prod_db',
    ].join('\n'));

    expect(loadSpringDatasource(tmpDir)?.host).toBe('ci-db');
  });

  it('still prefers the base file when it defines a datasource URL', () => {
    writeProjectFile('src/main/resources/application.properties',
      'spring.datasource.url=jdbc:postgresql://base-db:5432/base_db\n' +
      'spring.datasource.username=u\nspring.datasource.password=p\n');
    writeProjectFile('src/main/resources/application-ci.properties',
      'spring.datasource.url=jdbc:postgresql://ci-db:5432/ci_db\n');

    expect(loadSpringDatasource(tmpDir)?.host).toBe('base-db');
  });
});

// ── loadDbConfig resolution precedence ────────────────────────────────────────

describe('loadDbConfig', () => {
  it('loads credentials from an explicit envFile', () => {
    const envPath = path.join(tmpDir, 'db.env');
    fs.writeFileSync(envPath, [
      'DB_TYPE=mysql',
      'DB_HOST=envfile-host',
      'DB_NAME=envfile_db',
      'DB_USER=envfile_user',
      'DB_PASSWORD=envfile_pass',
    ].join('\n'), 'utf8');

    const config = loadDbConfig({ envFile: envPath });
    expect(config).toMatchObject({
      type: 'mysql',
      host: 'envfile-host',
      port: 3306, // MySQL default applied
      database: 'envfile_db',
      user: 'envfile_user',
      password: 'envfile_pass',
    });
    expect(config.source).toContain('db.env');
  });

  it('throws a clear error when the explicit envFile does not exist', () => {
    expect(() => loadDbConfig({ envFile: path.join(tmpDir, 'missing.env') }))
      .toThrow(/\.env file not found/);
  });

  it('falls back to Spring application.properties under projectRoot', () => {
    writeProjectFile('src/main/resources/application.properties', [
      'spring.datasource.url=jdbc:postgresql://spring-host:5433/spring_db',
      'spring.datasource.username=spring_user',
      'spring.datasource.password=spring_pass',
    ].join('\n'));

    const config = loadDbConfig({ projectRoot: tmpDir });
    expect(config).toMatchObject({
      type: 'postgresql',
      host: 'spring-host',
      port: 5433,
      database: 'spring_db',
      user: 'spring_user',
      password: 'spring_pass',
    });
    expect(config.source).toContain('application.properties');
  });

  it('prefers envFile values over the Spring fallback', () => {
    writeProjectFile('src/main/resources/application.properties', [
      'spring.datasource.url=jdbc:postgresql://spring-host:5433/spring_db',
      'spring.datasource.username=spring_user',
      'spring.datasource.password=spring_pass',
    ].join('\n'));
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, [
      'DB_TYPE=postgresql',
      'DB_HOST=env-host',
      'DB_NAME=env_db',
      'DB_USER=env_user',
      'DB_PASSWORD=env_pass',
    ].join('\n'), 'utf8');

    const config = loadDbConfig({ envFile: envPath, projectRoot: tmpDir });
    expect(config.host).toBe('env-host');
  });

  it('lists all three mechanisms when credentials are missing everywhere', () => {
    expect(() => loadDbConfig({ projectRoot: tmpDir })).toThrow(/envFile[\s\S]*DB_\*[\s\S]*projectRoot/);
  });
});
