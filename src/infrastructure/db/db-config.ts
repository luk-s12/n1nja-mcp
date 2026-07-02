import * as path from 'path';
import * as fs from 'fs';
import { loadSpringDatasource } from './spring-datasource';

/**
 * Parses a .env file into a key → value map. Returns {} when the file
 * does not exist and `mustExist` is false.
 */
function parseEnvFile(envPath: string, mustExist: boolean): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    if (mustExist) {
      throw new Error(`.env file not found: ${envPath}`);
    }
    return {};
  }

  const values: Record<string, string> = {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key) values[key] = value;
  }
  return values;
}

/**
 * Loads the .env from the working directory into process.env at startup
 * (without requiring dotenv). Kept for backwards compatibility; the preferred
 * ways to provide credentials are the `envFile` tool parameter or the Spring
 * project's application.properties.
 */
function loadCwdEnvIntoProcess(): void {
  const values = parseEnvFile(path.resolve(process.cwd(), '.env'), false);
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadCwdEnvIntoProcess();

export type DbType = 'postgresql' | 'mysql';

export interface DbConfig {
  type: DbType;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | string;
  poolMin: number;
  poolMax: number;
  queryTimeout: number;
  schema: string;
  /** Human-readable description of where the credentials came from */
  source: string;
}

/**
 * Full guide shown whenever credentials are missing or a connection fails,
 * so every DB tool (explain_sql, find_missing_indexes) gives the same help —
 * including the expected .env structure.
 */
export const DB_CREDENTIALS_HELP = `
Database credentials can be provided in any of these ways (checked in order):

1. Pass the envFile parameter with the path to a .env file. Expected structure:

     DB_TYPE=postgresql        # or "mysql"
     DB_HOST=localhost
     DB_PORT=5432              # 5432 for PostgreSQL, 3306 for MySQL
     DB_NAME=your_database
     DB_USER=your_user
     DB_PASSWORD=your_password
     DB_SCHEMA=public          # optional, defaults to "public"
     DB_SSL=false              # set to "true" if your DB requires SSL

2. Set the same DB_* variables as environment variables
   (or put a .env with that structure in the working directory).

3. Pass the projectRoot parameter pointing at your Spring Boot project —
   credentials are read from src/main/resources/application.properties|yml:

     spring.datasource.url=jdbc:postgresql://localhost:5432/your_database
     spring.datasource.username=your_user
     spring.datasource.password=your_password

Then re-run this command.
`.trim();

export interface DbConfigOptions {
  /** Explicit .env file path — takes precedence over ambient environment variables. */
  envFile?: string;
  /**
   * Spring Boot project root. When required credentials are not found in the
   * environment, spring.datasource.* is read from application.properties/yml.
   * Defaults to the current working directory.
   */
  projectRoot?: string;
}

/**
 * Resolves DB configuration with the following precedence:
 *   1. `envFile` option — an explicit .env path (DB_* keys).
 *   2. Environment variables (including the cwd .env loaded at startup).
 *   3. The Spring project's application.properties / application.yml
 *      (spring.datasource.url / username / password).
 * Throws a descriptive error listing all three mechanisms when incomplete.
 */
export function loadDbConfig(options: DbConfigOptions = {}): DbConfig {
  const fileVars = options.envFile
    ? parseEnvFile(path.resolve(options.envFile), true)
    : {};

  const get = (key: string): string | undefined => fileVars[key] ?? process.env[key];

  let type = get('DB_TYPE');
  let host = get('DB_HOST');
  let database = get('DB_NAME');
  let user = get('DB_USER');
  let password = get('DB_PASSWORD');
  let port = get('DB_PORT');

  let source = options.envFile
    ? `.env file: ${path.resolve(options.envFile)}`
    : 'environment variables / .env in working directory';

  // ── Fallback: Spring Boot application.properties / application.yml ─────────
  const requiredMissing = !type || !host || !database || !user || password === undefined;
  if (requiredMissing) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const spring = loadSpringDatasource(projectRoot);
    if (spring) {
      type = type || spring.type;
      host = host || spring.host;
      database = database || spring.database;
      user = user || spring.user;
      // Empty-string passwords are valid (common for local dev DBs)
      password = password ?? spring.password;
      port = port || (spring.port !== undefined ? String(spring.port) : undefined);
      source = `spring.datasource.* in ${spring.sourceFile}`;
    }
  }

  const missing: string[] = [];
  if (!type) missing.push('DB_TYPE');
  if (!host) missing.push('DB_HOST');
  if (!database) missing.push('DB_NAME');
  if (!user) missing.push('DB_USER');
  if (password === undefined) missing.push('DB_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Missing database credentials: ${missing.join(', ')}\n\n${DB_CREDENTIALS_HELP}`,
    );
  }

  if (type !== 'postgresql' && type !== 'mysql') {
    throw new Error(`DB_TYPE must be "postgresql" or "mysql". Got: "${type}"`);
  }

  const optional = (key: string, fallback: string): string => get(key) ?? fallback;

  const portDefault = type === 'postgresql' ? '5432' : '3306';
  const sslRaw = optional('DB_SSL', 'false');
  const ssl: boolean | string =
    sslRaw === 'true' ? true :
    sslRaw === 'false' ? false :
    sslRaw; // "require" | "prefer" passed through

  return {
    type,
    host: host as string,
    port: parseInt(port ?? portDefault, 10),
    database: database as string,
    user: user as string,
    password: password as string,
    ssl,
    poolMin: parseInt(optional('DB_POOL_MIN', '1'), 10),
    poolMax: parseInt(optional('DB_POOL_MAX', '3'), 10),
    queryTimeout: parseInt(optional('DB_QUERY_TIMEOUT', '10000'), 10),
    schema: optional('DB_SCHEMA', 'public'),
    source,
  };
}
