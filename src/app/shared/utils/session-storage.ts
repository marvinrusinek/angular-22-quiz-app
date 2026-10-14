/**
 * Safe wrappers around sessionStorage. Each method swallows errors so callers
 * don't need to re-implement try/catch every call site (private-browsing /
 * quota / serialization failures are non-fatal for visual cache data).
 *
 * Use these helpers for cache-style writes where best-effort persistence is
 * fine. For data whose loss is genuinely critical, keep an inline try/catch
 * so the failure mode can be handled explicitly.
 */

import { swallow } from './error-logging';

/**
 * Read a JSON value from sessionStorage. Returns `fallback` when:
 *   - the key isn't present
 *   - sessionStorage is unavailable (SSR, private mode, etc.)
 *   - the stored value isn't valid JSON
 */
export function readSessionJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON-serializable value to sessionStorage. Errors are swallowed. */
export function writeSessionJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err: unknown) {
    swallow('session-storage.ts', err); /* ignore */
  }
}

/** Read a raw string from sessionStorage. Returns `fallback` on miss / error. */
export function readSessionString(key: string, fallback = ''): string {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a raw string to sessionStorage. Errors are swallowed. */
export function writeSessionString(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch (err: unknown) {
    swallow('session-storage.ts', err); /* ignore */
  }
}

/** Remove a key from sessionStorage. Errors are swallowed. */
export function removeSessionKey(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch (err: unknown) {
    swallow('session-storage.ts', err); /* ignore */
  }
}
