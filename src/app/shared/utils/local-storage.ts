/**
 * Safe wrappers around localStorage. Unlike sessionStorage (see
 * session-storage.ts), localStorage persists across browser sessions — use it
 * for durable user preferences. Errors are swallowed so callers don't need to
 * re-implement try/catch (private-browsing / quota failures are non-fatal for
 * preference data).
 */

import { swallow } from './error-logging';

/** Read a raw string from localStorage. Returns `fallback` on miss / error. */
export function readLocalString(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a raw string to localStorage. Errors are swallowed. */
export function writeLocalString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err: unknown) {
    swallow('local-storage.ts', err); /* ignore */
  }
}

/** Read a JSON-serializable value from localStorage. Returns `fallback` on miss / parse error. */
export function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON-serializable value to localStorage. Errors are swallowed, but the
 * outcome is RETURNED: `true` on success, `false` if the write failed (private
 * browsing, quota exceeded, storage disabled). Callers persisting something the
 * user would notice losing — an issued certificate, say — can check this instead
 * of assuming it stuck. Existing callers may keep ignoring the result.
 */
export function writeLocalJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err: unknown) {
    swallow('local-storage.ts', err);
    return false;
  }
}

/** Remove a key from localStorage. Errors are swallowed. */
export function removeLocalKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err: unknown) {
    swallow('local-storage.ts', err); /* ignore */
  }
}
