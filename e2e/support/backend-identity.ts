import { execFileSync } from 'node:child_process';

import { Client } from 'pg';

import { E2E_DATABASE_URL } from './e2e-database';

/**
 * Evidence about WHICH process is answering on a backend port, and what it wrote.
 *
 * A port number alone proves little: the developer's own Spring, on their own
 * database, answers on 8080 exactly as well as the harness's. So the isolation
 * spec asks for process identity (what launched it) and for behavioural proof
 * (the session it created is in the disposable database) rather than trusting
 * that "something healthy is on 8080".
 *
 * Nothing here returns or logs an environment variable, a URL or a credential:
 * only a process name and whether its command line came from the harness.
 */

export interface PortOwner {
  readonly name: string;
  /** Lower-cased, with `\` normalised to `/`. Used for matching only — never print it. */
  readonly commandLine: string;
}

/** Who is LISTENING on this local port, or null when nothing is. */
export function portOwner(port: number): PortOwner | null {
  try {
    if (process.platform === 'win32') {
      const script =
        `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($p.Name)|$($p.CommandLine)" }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
      if (!out) return null;
      const [name, ...rest] = out.split('|');
      return { name: name.toLowerCase(), commandLine: rest.join('|').replace(/\\/g, '/').toLowerCase() };
    }
    const pid = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n')[0]?.trim();
    if (!pid) return null;
    const commandLine = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
    return { name: (commandLine.split(/\s+/)[0] ?? '').split('/').pop()!.toLowerCase(), commandLine: commandLine.toLowerCase() };
  } catch {
    return null;
  }
}

/** A Java process running the jar THIS harness built out of tree (never `backend-spring/target`, never an IDE run). */
export function isHarnessSpring(owner: PortOwner | null): boolean {
  return !!owner && /^java(\.exe)?$/.test(owner.name) && owner.commandLine.includes('/.e2e-db/spring-jar/');
}

/** Interview sessions in THIS run's disposable database (the one Node migrated and Spring attached to). */
export async function countInterviewSessions(): Promise<number> {
  const client = new Client({ connectionString: E2E_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 30_000 });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM interview_sessions');
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}
