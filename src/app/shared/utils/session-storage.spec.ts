/**
 * Contract tests for the session-storage helpers (A4 work, 2026-05-31).
 *
 * These wrappers exist to collapse ~24 inline try/JSON.parse/catch sites
 * across the codebase. Each helper is best-effort: errors are swallowed
 * so callers don't need to reimplement try/catch.
 *
 * The contract guards:
 *   - readSessionJson returns fallback on missing / malformed JSON
 *   - writeSessionJson doesn't throw on serialization failure
 *   - readSessionString returns fallback on miss
 *   - removeSessionKey doesn't throw on missing key
 */
import {
  readSessionJson,
  readSessionString,
  removeSessionKey,
  writeSessionJson,
  writeSessionString
} from './session-storage';

describe('session-storage helpers', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });

  // ── readSessionJson ───────────────────────────────────────────────

  it('readSessionJson returns parsed value for valid JSON', () => {
    sessionStorage.setItem('k', JSON.stringify({ a: 1, b: 'two' }));
    const out = readSessionJson<{ a: number; b: string }>('k', { a: 0, b: '' });
    expect(out).toEqual({ a: 1, b: 'two' });
  });

  it('readSessionJson returns fallback when key is absent', () => {
    const out = readSessionJson<number[]>('missing', []);
    expect(out).toEqual([]);
  });

  it('readSessionJson returns fallback when stored value is malformed JSON', () => {
    sessionStorage.setItem('bad', 'not-valid-json{{{');
    const out = readSessionJson<number>('bad', 42);
    expect(out).toBe(42);
  });

  it('readSessionJson handles primitive types (number, string, boolean, null)', () => {
    sessionStorage.setItem('num', '7');
    sessionStorage.setItem('str', '"hello"');
    sessionStorage.setItem('bool', 'true');
    sessionStorage.setItem('nil', 'null');
    expect(readSessionJson('num', 0)).toBe(7);
    expect(readSessionJson('str', '')).toBe('hello');
    expect(readSessionJson('bool', false)).toBe(true);
    expect(readSessionJson('nil', 'fallback')).toBeNull();
  });

  // ── writeSessionJson ──────────────────────────────────────────────

  it('writeSessionJson serializes and stores the value', () => {
    writeSessionJson('k', { x: 1, y: [2, 3] });
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ x: 1, y: [2, 3] });
  });

  it('writeSessionJson round-trips via readSessionJson', () => {
    const original = { ids: [1, 2, 3], flag: true };
    writeSessionJson('round', original);
    expect(readSessionJson('round', null)).toEqual(original);
  });

  it('writeSessionJson does not throw on circular references (swallows error)', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => writeSessionJson('circ', circular)).not.toThrow();
  });

  // ── readSessionString ─────────────────────────────────────────────

  it('readSessionString returns the raw stored string', () => {
    sessionStorage.setItem('s', 'hello world');
    expect(readSessionString('s')).toBe('hello world');
  });

  it('readSessionString returns fallback for missing key', () => {
    expect(readSessionString('missing')).toBe('');
    expect(readSessionString('missing', 'default')).toBe('default');
  });

  it('readSessionString returns the empty string when stored value is empty', () => {
    sessionStorage.setItem('empty', '');
    expect(readSessionString('empty', 'fallback')).toBe('');
  });

  // ── writeSessionString ────────────────────────────────────────────

  it('writeSessionString stores the raw string', () => {
    writeSessionString('s', 'plain text');
    expect(sessionStorage.getItem('s')).toBe('plain text');
  });

  it('writeSessionString round-trips via readSessionString', () => {
    writeSessionString('round', 'roundtrip');
    expect(readSessionString('round')).toBe('roundtrip');
  });

  // ── removeSessionKey ──────────────────────────────────────────────

  it('removeSessionKey deletes an existing key', () => {
    sessionStorage.setItem('toRemove', 'value');
    removeSessionKey('toRemove');
    expect(sessionStorage.getItem('toRemove')).toBeNull();
  });

  it('removeSessionKey does not throw when key is absent', () => {
    expect(() => removeSessionKey('never-existed')).not.toThrow();
  });
});
