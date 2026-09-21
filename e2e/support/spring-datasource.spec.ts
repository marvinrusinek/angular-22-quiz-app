const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inspect } = require('node:util');

const {
  deriveSpringDatasource,
  describeDatasource,
  buildSpringEnv,
  resolveLauncherDatasource,
  makeRedactor,
  SpringDatasourceError,
  E2E_RECEIPT_SECRET
} = require('./spring-datasource');
const backends = require('./e2e-backends');

/**
 * The Spring E2E datasource guard.
 *
 * Spring WRITES (every Interview session and answer an E2E run creates), so the
 * only database it may ever be given is this run's disposable `e2e_*` one. These
 * tests exercise the SAME functions the launcher calls; there is no copy.
 * Pure and offline: no database, no network, no Java, no Playwright.
 *
 * Every credential below is an obviously fake test value.
 */

const RUN_DB = 'e2e_mabc123_4242_x9y8z7';
const HOST = 'ep-test-host-pooler.us-west-2.aws.neon.tech';
const urlFor = (db: string, user = 'testuser', pass = 'testpass') =>
  `postgresql://${user}:${pass}@${HOST}/${db}?sslmode=require&channel_binding=require`;

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err: any) {
    expect(err).toBeInstanceOf(SpringDatasourceError);
    return String(err.message);
  }
  throw new Error('expected a SpringDatasourceError but nothing was thrown');
};

describe('deriveSpringDatasource ACCEPTS', () => {
  it('a valid e2e_* URL, and builds a credential-free JDBC URL', () => {
    const ds = deriveSpringDatasource(urlFor(RUN_DB), { expectedName: RUN_DB, devDatabaseName: 'neondb' });

    expect(ds.jdbcUrl).toBe(`jdbc:postgresql://${HOST}/${RUN_DB}?sslmode=require`);
    expect(ds.username).toBe('testuser');
    expect(ds.password).toBe('testpass');
    expect(ds.databaseName).toBe(RUN_DB);
    expect(ds.host).toBe(HOST);
    expect(ds.jdbcUrl).not.toContain('testpass');
    expect(ds.jdbcUrl).not.toContain('testuser');
  });

  it('always requires TLS, whatever the source URL said', () => {
    const noSsl = `postgres://u:p@${HOST}/${RUN_DB}`;
    expect(deriveSpringDatasource(noSsl).jdbcUrl).toMatch(/\?sslmode=require$/);
    // channel_binding and friends are NOT copied into the JDBC URL.
    expect(deriveSpringDatasource(urlFor(RUN_DB)).jdbcUrl).not.toContain('channel_binding');
  });

  it('keeps an explicit port', () => {
    const ds = deriveSpringDatasource(`postgres://u:p@localhost:5433/${RUN_DB}`);
    expect(ds.jdbcUrl).toBe(`jdbc:postgresql://localhost:5433/${RUN_DB}?sslmode=require`);
  });

  it('decodes percent-encoded special characters in credentials, and keeps them out of the JDBC URL', () => {
    const ds = deriveSpringDatasource(`postgres://us%40er%3Aname:p%40ss%3Aw%2Frd%23%25@${HOST}/${RUN_DB}`);

    expect(ds.username).toBe('us@er:name');
    expect(ds.password).toBe('p@ss:w/rd#%');
    expect(ds.jdbcUrl).toBe(`jdbc:postgresql://${HOST}/${RUN_DB}?sslmode=require`);
  });
});

describe('deriveSpringDatasource REFUSES', () => {
  it('the development database, outright', () => {
    expect(refusal(() => deriveSpringDatasource(urlFor('neondb'), { devDatabaseName: 'neondb' })))
      .toContain('development database');
  });

  it('the development database even if it were somehow named like a throwaway', () => {
    expect(refusal(() => deriveSpringDatasource(urlFor(RUN_DB), { devDatabaseName: RUN_DB })))
      .toContain('development database');
  });

  it.each([
    ['a plain database', 'neondb'],
    ['"e2e" with no underscore', 'e2e'],
    ['a name that only CONTAINS e2e_', 'my_e2e_db'],
    ['the wrong case', 'E2E_MABC_1_x'],
    ['an injection attempt', 'e2e_x;DROP DATABASE neondb'],
    ['an encoded second path segment', 'e2e_x%2Fneondb'],
    ['a name with a hyphen or space', 'e2e_a-b c']
  ])('%s (%s)', (_label: string, name: string) => {
    expect(refusal(() => deriveSpringDatasource(urlFor(name)))).toMatch(/is not an e2e_\* throwaway database|exactly one database/);
  });

  it('a DIFFERENT throwaway database from another concurrent run', () => {
    expect(refusal(() => deriveSpringDatasource(urlFor('e2e_other_1_abcdef'), { expectedName: RUN_DB })))
      .toContain('not this run');
  });

  it.each([undefined, null, '', '   ', 42, {}])('a missing URL (%p)', (value: unknown) => {
    expect(refusal(() => deriveSpringDatasource(value))).toContain('missing');
  });

  it.each([
    ['not a URL at all', 'this is not a url'],
    ['no host', `postgres://u:p@/${RUN_DB}`],
    ['no database', `postgres://u:p@${HOST}`],
    ['a trailing slash only', `postgres://u:p@${HOST}/`],
    ['two path segments', `postgres://u:p@${HOST}/${RUN_DB}/extra`],
    ['the wrong scheme', `mysql://u:p@${HOST}/${RUN_DB}`],
    ['a jdbc: URL, which is the OUTPUT format not the input', `jdbc:postgresql://${HOST}/${RUN_DB}`],
    ['a bad port', `postgres://u:p@${HOST}:99999/${RUN_DB}`],
    ['a broken percent-escape', `postgres://u:p%ZZ@${HOST}/${RUN_DB}`]
  ])('a malformed URL: %s', (_label: string, value: string) => {
    expect(refusal(() => deriveSpringDatasource(value))).toMatch(/malformed|not a postgres|host|exactly one|port|percent-encoding|missing/);
  });

  it.each([
    ['no user', `postgres://:p@${HOST}/${RUN_DB}`, 'no user name'],
    ['no password', `postgres://u@${HOST}/${RUN_DB}`, 'no password'],
    ['an empty password', `postgres://u:@${HOST}/${RUN_DB}`, 'no password'],
    ['no credentials at all', `postgres://${HOST}/${RUN_DB}`, 'no user name']
  ])('missing credentials: %s', (_label: string, value: string, expected: string) => {
    expect(refusal(() => deriveSpringDatasource(value))).toContain(expected);
  });
});

describe('the password never leaks', () => {
  const ds = deriveSpringDatasource(urlFor(RUN_DB, 'testuser', 'hunter2-secret'));

  it('is not enumerable, so logging or serialising the datasource cannot print it', () => {
    expect(Object.keys(ds)).not.toContain('password');
    expect(JSON.stringify(ds)).not.toContain('hunter2-secret');
    expect(inspect(ds)).not.toContain('hunter2-secret');
  });

  it('is not in the safe description', () => {
    expect(describeDatasource(ds)).toBe(`${RUN_DB} on ${HOST}`);
  });

  it('is not in any refusal message', () => {
    const message = refusal(() => deriveSpringDatasource(urlFor('neondb', 'testuser', 'hunter2-secret')));
    expect(message).not.toContain('hunter2-secret');
    expect(message).not.toContain('testuser');
  });

  it('is replaced by the log redactor, as are user:password@ pairs in URLs', () => {
    const redact = makeRedactor([ds.password]);

    expect(redact('connecting with hunter2-secret now')).toBe('connecting with [REDACTED] now');
    expect(redact('url=postgres://someone:hunter2-secret@host/db')).toContain('postgres://someone:[REDACTED]@host/db');
    expect(redact('no secret here')).toBe('no secret here');
  });
});

describe('buildSpringEnv', () => {
  const ds = deriveSpringDatasource(urlFor(RUN_DB, 'e2euser', 'e2e-secret-pw'));
  const options = { port: 8080, allowedOrigins: backends.ANGULAR_ORIGINS };

  // What a developer's shell might export for THEIR OWN Spring instance and Node backend.
  const developerShell = {
    PATH: '/usr/bin',
    JAVA_HOME: '/jdk',
    SPRING_DATASOURCE_URL: 'jdbc:postgresql://dev-host/neondb',
    SPRING_DATASOURCE_USERNAME: 'devuser',
    SPRING_DATASOURCE_PASSWORD: 'dev-password',
    SPRING_PROFILES_ACTIVE: 'test',
    SPRING_APPLICATION_JSON: '{"spring.datasource.url":"jdbc:postgresql://dev-host/neondb"}',
    SPRING_JPA_HIBERNATE_DDL_AUTO: 'update',
    SERVER_PORT: '9999',
    PORT: '9999',
    DATABASE_URL: 'postgres://devuser:dev-password@dev-host/neondb',
    ALLOWED_ORIGINS: 'https://dev.example',
    CORS_ALLOWED_ORIGINS: 'https://dev.example',
    TOPIC_QUIZ_RECEIPT_SECRET: 'dev-secret-dev-secret-dev-secret-1234',
    JAVA_TOOL_OPTIONS: '-Dspring.datasource.url=jdbc:postgresql://dev-host/neondb',
    JDK_JAVA_OPTIONS: '-Dspring.datasource.url=x'
  };

  it('OVERRIDES every critical setting, so nothing is inherited from the developer\'s shell', () => {
    const env = buildSpringEnv(developerShell, ds, options);

    expect(env.PORT).toBe('8080');
    expect(env.SPRING_DATASOURCE_URL).toBe(ds.jdbcUrl);
    expect(env.SPRING_DATASOURCE_USERNAME).toBe('e2euser');
    expect(env.SPRING_DATASOURCE_PASSWORD).toBe('e2e-secret-pw');
    expect(env.TOPIC_QUIZ_RECEIPT_SECRET).toBe(E2E_RECEIPT_SECRET);
    expect(env.ALLOWED_ORIGINS).toBe('http://localhost:4200,http://127.0.0.1:4200');
    expect(env.SPRING_JPA_HIBERNATE_DDL_AUTO).toBe('validate');
  });

  it('REMOVES every other channel that could carry a development datasource or JVM override', () => {
    const env = buildSpringEnv(developerShell, ds, options);

    for (const gone of [
      'SPRING_PROFILES_ACTIVE',
      'SPRING_APPLICATION_JSON',
      'SERVER_PORT',
      'DATABASE_URL',
      'CORS_ALLOWED_ORIGINS',
      'JAVA_TOOL_OPTIONS',
      'JDK_JAVA_OPTIONS'
    ]) {
      expect(env).not.toHaveProperty(gone);
    }
    expect(JSON.stringify(env)).not.toContain('dev-host');
    expect(JSON.stringify(env)).not.toContain('dev-password');
    expect(JSON.stringify(env)).not.toContain('dev-secret');
  });

  it('is case-insensitive about what it strips (Windows environment names are)', () => {
    const env = buildSpringEnv({ spring_datasource_url: 'jdbc:postgresql://dev-host/neondb', Database_Url: 'x' }, ds, options);

    expect(env).not.toHaveProperty('spring_datasource_url');
    expect(env).not.toHaveProperty('Database_Url');
  });

  it('keeps what Java needs to run', () => {
    const env = buildSpringEnv(developerShell, ds, options);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.JAVA_HOME).toBe('/jdk');
  });

  it('refuses a bad port or an empty origin list', () => {
    expect(refusal(() => buildSpringEnv({}, ds, { port: 0, allowedOrigins: ['http://x'] }))).toContain('port');
    expect(refusal(() => buildSpringEnv({}, ds, { port: 8080, allowedOrigins: [] }))).toContain('origins');
  });
});

describe('resolveLauncherDatasource — the launcher\'s whole decision', () => {
  const good = {
    E2E_DATABASE_URL: urlFor(RUN_DB),
    E2E_DATABASE_NAME: RUN_DB,
    E2E_DEV_DATABASE_NAME: 'neondb'
  };

  it('accepts the environment Playwright supplies', () => {
    expect(resolveLauncherDatasource(good).databaseName).toBe(RUN_DB);
  });

  it('refuses when the run\'s database name is not supplied', () => {
    expect(refusal(() => resolveLauncherDatasource({ ...good, E2E_DATABASE_NAME: '' }))).toContain('E2E_DATABASE_NAME');
  });

  it('refuses a URL for a different database than the run\'s', () => {
    expect(refusal(() => resolveLauncherDatasource({ ...good, E2E_DATABASE_URL: urlFor('e2e_other_1_abcdef') })))
      .toContain('not this run');
  });

  it('refuses the development database', () => {
    expect(refusal(() => resolveLauncherDatasource({
      E2E_DATABASE_URL: urlFor('neondb'),
      E2E_DATABASE_NAME: 'neondb',
      E2E_DEV_DATABASE_NAME: 'neondb'
    }))).toContain('development database');
  });

  it('NEVER falls back to DATABASE_URL, the development URL, or any default', () => {
    const onlyDevUrl = { DATABASE_URL: urlFor('neondb'), E2E_DATABASE_NAME: RUN_DB };
    expect(refusal(() => resolveLauncherDatasource(onlyDevUrl))).toContain('missing');

    const noName = { DATABASE_URL: urlFor(RUN_DB), E2E_DATABASE_URL: urlFor(RUN_DB) };
    expect(refusal(() => resolveLauncherDatasource(noName))).toContain('E2E_DATABASE_NAME');
  });
});

describe('launch-spring.js — the REAL launcher refuses unsafe targets before any Spring process exists', () => {
  const { spawnSync } = require('node:child_process');
  const { existsSync } = require('node:fs');
  const launcher = join(__dirname, 'launch-spring.js');
  const springBuildDir = join(__dirname, '..', '..', '.e2e-db', 'spring-build');

  /** Minimal environment: the test must not inherit the developer's real DATABASE_URL or SPRING_* variables. */
  const run = (extraEnv: Record<string, string>, args: string[] = []) => {
    const buildDirExisted = existsSync(springBuildDir);
    const result = spawnSync(process.execPath, [launcher, ...args], {
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000
    });
    return { ...result, output: `${result.stdout}${result.stderr}`, startedABuild: !buildDirExisted && existsSync(springBuildDir) };
  };

  const good = {
    E2E_DATABASE_URL: urlFor(RUN_DB, 'launcheruser', 'launcher-secret-pw'),
    E2E_DATABASE_NAME: RUN_DB,
    E2E_DEV_DATABASE_NAME: 'neondb'
  };

  it('accepts this run\'s e2e_* database and reports only its name and host', () => {
    const r = run(good, ['--check-only']);

    expect(r.status).toBe(0);
    expect(r.output).toContain(`datasource accepted: ${RUN_DB} on ${HOST}; port 8080; ddl-auto=validate`);
    expect(r.output).toContain('nothing was built or started');
    expect(r.output).not.toContain('launcher-secret-pw');
    expect(r.output).not.toContain('launcheruser');
  });

  it('REFUSES the development database, exits non-zero, and never reaches Maven or Java', () => {
    const r = run(
      { E2E_DATABASE_URL: urlFor('neondb', 'devuser', 'dev-secret-pw'), E2E_DATABASE_NAME: 'neondb', E2E_DEV_DATABASE_NAME: 'neondb' }
    );

    expect(r.status).toBe(1);
    expect(r.output).toContain('development database');
    expect(r.output).not.toMatch(/building the Spring jar|using the cached jar|Spring exited/);
    expect(r.startedABuild).toBe(false);
    expect(r.output).not.toContain('dev-secret-pw');
    expect(r.output).not.toContain('devuser');
  });

  it('REFUSES a non-e2e database even when it was not flagged as the development one', () => {
    const r = run({ E2E_DATABASE_URL: urlFor('production_like'), E2E_DATABASE_NAME: 'production_like' });

    expect(r.status).toBe(1);
    expect(r.output).toContain('not an e2e_* throwaway database');
    expect(r.output).not.toMatch(/building the Spring jar|using the cached jar/);
  });

  it('REFUSES when the run\'s database URL is missing — no fallback to DATABASE_URL or .env', () => {
    const r = run({ DATABASE_URL: urlFor(RUN_DB), E2E_DATABASE_NAME: RUN_DB });

    expect(r.status).toBe(1);
    expect(r.output).toContain('missing');
    expect(r.output).not.toMatch(/building the Spring jar|using the cached jar/);
  });

  it('REFUSES malformed configuration', () => {
    const r = run({ E2E_DATABASE_URL: 'not-a-url', E2E_DATABASE_NAME: RUN_DB });

    expect(r.status).toBe(1);
    expect(r.output).toContain('malformed');
  });

  it('REFUSES a URL for some OTHER e2e_* database', () => {
    const r = run({ E2E_DATABASE_URL: urlFor('e2e_someone_else_1_abcdef'), E2E_DATABASE_NAME: RUN_DB });

    expect(r.status).toBe(1);
    expect(r.output).toContain('not this run');
  });
});

describe('the harness cannot drift from the app\'s routing again', () => {
  const root = join(__dirname, '..', '..');
  const tokenSource: string = readFileSync(join(root, 'src/app/shared/tokens/api-base-url.token.ts'), 'utf8');
  const indexHtml: string = readFileSync(join(root, 'src/index.html'), 'utf8');

  const constant = (name: string): string => {
    const match = tokenSource.match(new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`));
    if (!match) throw new Error(`${name} not found in api-base-url.token.ts`);
    return match[1];
  };

  it('Topic Quiz + builder metadata: the app\'s local Node URL is the one the harness controls', () => {
    expect(constant('DEV_API_BASE_URL')).toBe(backends.NODE_API_BASE_URL);
  });

  it('Interview lifecycle: the app\'s local Spring URL is the one the harness controls', () => {
    expect(constant('INTERVIEW_DEV_API_BASE_URL')).toBe(backends.SPRING_API_BASE_URL);
  });

  it('the health URLs are the API base plus /health', () => {
    expect(backends.NODE_HEALTH_URL).toBe(`${backends.NODE_API_BASE_URL}/health`);
    expect(backends.SPRING_HEALTH_URL).toBe(`${backends.SPRING_API_BASE_URL}/health`);
  });

  it('the page\'s CSP allows exactly these loopback ports — which is why the ports are fixed', () => {
    // The DIRECTIVE, not the comments that discuss it: it is the one starting `connect-src 'self'`.
    const connectSrc: string = (indexHtml.match(/connect-src 'self'[^;]*;/) ?? [''])[0];
    expect(connectSrc).not.toBe('');
    for (const port of [backends.NODE_PORT, backends.SPRING_PORT]) {
      expect(connectSrc).toContain(`http://localhost:${port}`);
      expect(connectSrc).toContain(`http://127.0.0.1:${port}`);
    }
  });

  it('the Angular origins Spring allows are the ones Playwright serves the app from', () => {
    const config: string = readFileSync(join(root, 'playwright.config.ts'), 'utf8');
    expect(config).toContain("baseURL: 'http://localhost:4200'");
    expect(backends.ANGULAR_ORIGINS).toContain('http://localhost:4200');
  });
});

describe('playwright.config.ts — the controlled-backend wiring', () => {
  // The config module is data, but the guarantees live in it: order, no reuse, one shared database.
  //
  // It is loaded in a CHILD process (Playwright's own transpile-only loader) rather than imported here:
  // ts-jest would type-check it under this repo's strictest settings. The child returns only NON-SECRET
  // facts — booleans and names, never a URL — so a failing assertion cannot print a credential.
  const { spawnSync } = require('node:child_process');
  const root = join(__dirname, '..', '..');

  const facts = (() => {
    const script = `
      const c = require(${JSON.stringify(join(root, 'playwright.config.ts'))}).default;
      const [angular, node, spring] = c.webServer;
      console.log(JSON.stringify({
        count: c.webServer.length,
        urls: [angular.url, node.url, spring.url],
        angularReuse: !!angular.reuseExistingServer,
        nodeReuse: node.reuseExistingServer,
        springReuse: spring.reuseExistingServer,
        nodeCommand: node.command,
        springCommand: spring.command,
        sameDatabaseUrl: spring.env.E2E_DATABASE_URL === node.env.DATABASE_URL,
        sameDatabaseName: spring.env.E2E_DATABASE_NAME === node.env.E2E_DATABASE_NAME,
        databaseNameIsE2e: String(node.env.E2E_DATABASE_NAME).startsWith('e2e_'),
        springEnvKeys: Object.keys(spring.env).sort(),
        springTimeout: spring.timeout
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ['--require', join(root, 'backend', 'node_modules', 'ts-node', 'register', 'transpile-only'), '-e', script],
      { cwd: join(root, 'backend'), encoding: 'utf8', timeout: 60_000 }
    );
    if (result.status !== 0) throw new Error('could not load playwright.config.ts: ' + String(result.stderr).slice(-400));
    return JSON.parse(result.stdout.trim().split('\n').pop());
  })();

  it('starts exactly three servers, in dependency order: Angular, then Node, then Spring', () => {
    expect(facts.count).toBe(3);
    expect(facts.urls).toEqual(['http://localhost:4200', backends.NODE_HEALTH_URL, backends.SPRING_HEALTH_URL]);
  });

  it('NEVER reuses a running Node or Spring — either could be the developer\'s own, on their real database', () => {
    expect(facts.nodeReuse).toBe(false);
    expect(facts.springReuse).toBe(false);
  });

  it('may reuse the developer\'s Angular dev server — it only serves the app, and touches no database', () => {
    expect(facts.angularReuse).toBe(true);
  });

  it('checks BOTH controlled ports before the database is created', () => {
    const cmd: string = facts.nodeCommand;

    expect(cmd).toContain('preflight-ports.js');
    expect(cmd.indexOf('preflight-ports.js')).toBeLessThan(cmd.indexOf('ensure-e2e-database.js'));
    expect(cmd.indexOf('ensure-e2e-database.js')).toBeLessThan(cmd.indexOf('npm run dev'));
  });

  it('Spring is started by the guarded launcher, not directly', () => {
    expect(facts.springCommand).toBe('node e2e/support/launch-spring.js');
  });

  it('Node and Spring are given the SAME throwaway database', () => {
    expect(facts.sameDatabaseUrl).toBe(true);
    expect(facts.sameDatabaseName).toBe(true);
    expect(facts.databaseNameIsE2e).toBe(true);
  });

  it('Spring is not handed a datasource, DATABASE_URL or secret by the config — the launcher derives them from the run\'s database only', () => {
    expect(facts.springEnvKeys).toEqual(['E2E_DATABASE_NAME', 'E2E_DATABASE_URL', 'E2E_DEV_DATABASE_NAME']);
  });

  it('allows for the first-run Maven build', () => {
    expect(facts.springTimeout).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('the Interview backend specs cannot silently skip, or probe the wrong backend', () => {
  const root = join(__dirname, '..', '..');

  it.each(['interview-backend-session.spec.ts', 'interview-results-backend.spec.ts'])(
    '%s probes the controlled Spring, fails (not skips) when it is down, and has no environment override',
    (name: string) => {
      const source: string = readFileSync(join(root, 'e2e', name), 'utf8');

      expect(source).toContain("import { SPRING_HEALTH_URL } from './support/e2e-backends'");
      expect(source).toContain('context.get(SPRING_HEALTH_URL');
      expect(source).toMatch(/expect\(\s*response\.ok\(\)/);          // a failed probe FAILS the file
      expect(source).not.toMatch(/test\.skip\(/);                     // it used to skip
      expect(source).not.toContain('E2E_API_BASE_URL');               // no override that could point elsewhere
      expect(source).not.toMatch(/localhost:3000/);                   // 3000 is Node, which does not serve Interview sessions
    }
  );
});
