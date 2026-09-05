import { ConfigError, loadConfig } from '../src/config';

/** Minimal env; each test overrides only what it exercises. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig — defaults', () => {
  it('defaults port, paths and dev origins', () => {
    const config = loadConfig(env());
    expect(config.nodeEnv).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    // No default connection string: a development server with no DATABASE_URL
    // should fail when it tries to connect, not silently target something.
    expect(config.databaseUrl).toBe('');
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4200',
      'http://127.0.0.1:4200'
    ]);
  });

  it('defaults NODE_ENV to development when unset', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).nodeEnv).toBe('development');
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'staging' }))).toThrow(ConfigError);
  });
});

describe('loadConfig — port', () => {
  it('parses a valid port', () => {
    expect(loadConfig(env({ PORT: '8080' })).port).toBe(8080);
  });

  it.each(['0', '65536', '-1', 'abc', '3000.5'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig(env({ PORT: port }))).toThrow(ConfigError);
  });

  it('treats an empty PORT as unset', () => {
    expect(loadConfig(env({ PORT: '   ' })).port).toBe(3000);
  });
});

describe('loadConfig — allowed origins', () => {
  it('parses and trims a comma-separated list', () => {
    const config = loadConfig(
      env({ ALLOWED_ORIGINS: 'http://localhost:4200 , https://example.github.io' })
    );
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4200',
      'https://example.github.io'
    ]);
  });

  it('REJECTS a wildcard outright', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: '*' }))).toThrow(/must not contain/i);
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'http://localhost:4200,*' })))
      .toThrow(/must not contain/i);
  });

  it('rejects a malformed origin', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('rejects an origin carrying a path, query or fragment', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'https://x.io/app' }))).toThrow(/no path/i);
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'https://x.io/?a=1' }))).toThrow(/no path/i);
  });

  it('REQUIRES origins in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(/required in production/i);
  });

  it('requires https origins in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://example.io' }))
    ).toThrow(/https/i);

    const config = loadConfig(
      env({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://example.github.io',
        DATABASE_URL: 'postgres://u:p@host/db',
        // Every production-required value must be present, or this test would
        // pass on the wrong error.
        TOPIC_QUIZ_RECEIPT_SECRET: 'a-production-grade-secret-of-sufficient-length'
      })
    );
    expect(config.isProduction).toBe(true);
    expect(config.allowedOrigins).toEqual(['https://example.github.io']);
  });

  it('does NOT fall back to dev origins in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', ALLOWED_ORIGINS: '  ,  ' }))
    ).toThrow(/required in production/i);
  });
});

describe('loadConfig — database url', () => {
  it('accepts postgres:// and postgresql://', () => {
    expect(
      loadConfig(env({ DATABASE_URL: 'postgres://u:p@host/db' })).databaseUrl
    ).toBe('postgres://u:p@host/db');
    expect(
      loadConfig(env({ DATABASE_URL: '  postgresql://u:p@host/db  ' })).databaseUrl
    ).toBe('postgresql://u:p@host/db');
  });

  it('rejects a non-postgres connection string', () => {
    // Catches the most likely migration mistake: a leftover SQLite file path.
    expect(() => loadConfig(env({ DATABASE_URL: './data/sessions.db' })))
      .toThrow(/postgres:\/\//i);
    expect(() => loadConfig(env({ DATABASE_URL: 'mysql://u:p@host/db' })))
      .toThrow(ConfigError);
  });

  it('REQUIRES a connection string in production', () => {
    // A production server that boots without a database would accept
    // interviews it cannot store.
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://x.io' }))
    ).toThrow(/DATABASE_URL is required in production/i);

    expect(() =>
      loadConfig(env({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://x.io',
        DATABASE_URL: '   '
      }))
    ).toThrow(/required in production/i);
  });
});
