import {
  CLOUDFLARE_ANALYTICS_HOST,
  CLOUDFLARE_ANALYTICS_TOKEN,
  CLOUDFLARE_BEACON_SRC,
  installCloudflareAnalytics
} from './cloudflare-analytics';

/**
 * The loader must insert the beacon ONLY on the production host for a normal
 * (non-WebDriver) browser, exactly once, and must never throw. No real network is
 * involved: each case uses a fresh detached document, and jsdom does not fetch scripts.
 */
describe('installCloudflareAnalytics', () => {
  const PROD = 'marvinrusinek.github.io';
  let doc: Document;

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument('t');
  });

  const beacons = (): HTMLScriptElement[] =>
    Array.from(doc.querySelectorAll<HTMLScriptElement>('script[data-cf-beacon]'));

  describe('production human browser', () => {
    it('inserts the beacon with the exact src, type=module and the site token', () => {
      expect(installCloudflareAnalytics(doc, PROD, false)).toBe(true);

      const [script] = beacons();
      expect(beacons()).toHaveLength(1);
      expect(script.getAttribute('src')).toBe('https://static.cloudflareinsights.com/beacon.min.js');
      expect(script.type).toBe('module');
      expect(JSON.parse(script.getAttribute('data-cf-beacon')!)).toEqual({ token: 'c29822f3c9394d9aab170a07597cbd66' });
    });

    it('treats a browser that does not report webdriver (undefined / false) as a normal visitor', () => {
      expect(installCloudflareAnalytics(doc, PROD, undefined)).toBe(true);
      expect(beacons()).toHaveLength(1);
      const other = document.implementation.createHTMLDocument('t2');
      expect(installCloudflareAnalytics(other, PROD, false)).toBe(true);
    });

    it('configures ONLY the token — no spa flag (automatic SPA tracking stays on), no custom fields', () => {
      installCloudflareAnalytics(doc, PROD, false);
      const config = JSON.parse(beacons()[0].getAttribute('data-cf-beacon')!);
      expect(Object.keys(config)).toEqual(['token']);
      expect(config).not.toHaveProperty('spa');
    });

    it('puts the script in <head>, not in the app root', () => {
      installCloudflareAnalytics(doc, PROD, false);
      expect(beacons()[0].parentElement).toBe(doc.head);
    });

    it('the token is a 32-character lowercase hex identifier', () => {
      expect(CLOUDFLARE_ANALYTICS_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    });

    it('exposes the exact standard beacon URL and host constants the CSP is written for', () => {
      expect(CLOUDFLARE_BEACON_SRC).toBe('https://static.cloudflareinsights.com/beacon.min.js');
      expect(CLOUDFLARE_ANALYTICS_HOST).toBe(PROD);
    });
  });

  describe('hosts that must NEVER load the beacon', () => {
    it.each([
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['IPv6 loopback', '[::1]'],
      ['empty hostname', ''],
      ['StackBlitz webcontainer preview', 'abc123xyz--4200--96435430.local-credentialless.webcontainer.io'],
      ['StackBlitz editor host', 'stackblitz.com'],
      ['another github.io site', 'someoneelse.github.io'],
      ['bare github.io', 'github.io'],
      ['a www. subdomain of the production host', 'www.marvinrusinek.github.io'],
      ['a look-alike prefix', 'evil-marvinrusinek.github.io'],
      ['a look-alike suffix', 'marvinrusinek.github.io.evil.example'],
      ['the production host as a substring', 'notmarvinrusinek.github.io'],
      ['a preview/staging host', 'preview.marvinrusinek.dev']
    ])('%s (%s) → no script', (_label, host) => {
      expect(installCloudflareAnalytics(doc, host, false)).toBe(false);
      expect(beacons()).toHaveLength(0);
      expect(doc.querySelectorAll('script')).toHaveLength(0);
    });
  });

  describe('automated browsers', () => {
    it('does not load on the production host when navigator.webdriver is true', () => {
      expect(installCloudflareAnalytics(doc, PROD, true)).toBe(false);
      expect(doc.querySelectorAll('script')).toHaveLength(0);
    });
  });

  describe('duplicate protection', () => {
    it('a second call does not insert a second beacon', () => {
      expect(installCloudflareAnalytics(doc, PROD, false)).toBe(true);
      expect(installCloudflareAnalytics(doc, PROD, false)).toBe(false);
      expect(installCloudflareAnalytics(doc, PROD, false)).toBe(false);
      expect(beacons()).toHaveLength(1);
    });

    it('does not double up if a beacon tag is already in the page', () => {
      const existing = doc.createElement('script');
      existing.setAttribute('data-cf-beacon', '{"token":"other"}');
      doc.head.appendChild(existing);
      expect(installCloudflareAnalytics(doc, PROD, false)).toBe(false);
      expect(beacons()).toHaveLength(1);
    });
  });

  describe('non-critical behaviour', () => {
    it('never throws — a failing document just reports "not loaded"', () => {
      const hostile = {
        querySelector: () => null,
        createElement: () => { throw new Error('boom'); }
      } as unknown as Document;
      expect(() => installCloudflareAnalytics(hostile, PROD, false)).not.toThrow();
      expect(installCloudflareAnalytics(hostile, PROD, false)).toBe(false);
    });

    it('makes no network call of its own (it only appends an element)', () => {
      const fetchSpy = jest.fn();
      const original = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        installCloudflareAnalytics(doc, PROD, false);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = original;
      }
    });

    it('with the REAL defaults (jsdom = localhost) it inserts nothing into the real page', () => {
      expect(installCloudflareAnalytics()).toBe(false);
      expect(document.querySelector('script[data-cf-beacon]')).toBeNull();
    });
  });

  // The CSP is a static <meta> in index.html; this pins exactly what the loader needs
  // and that nothing was loosened to get it.
  describe('index.html CSP', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const html: string = require('fs').readFileSync('src/index.html', 'utf8');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1];
    const directive = (name: string): string[] =>
      csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name)?.slice(1) ?? [];

    it('script-src allows exactly self + the exact beacon file', () => {
      expect(directive('script-src')).toEqual(["'self'", 'https://static.cloudflareinsights.com/beacon.min.js']);
    });

    it('connect-src gains only https://cloudflareinsights.com and keeps its existing entries', () => {
      const connect = directive('connect-src');
      expect(connect).toContain('https://cloudflareinsights.com');
      for (const kept of ["'self'", 'https://cdn.jsdelivr.net', 'https://interview-api-spring.marvinrusinek.com', 'https://interview-api-c842.onrender.com', 'http://localhost:8080', 'http://localhost:3000']) {
        expect(connect).toContain(kept);
      }
    });

    it('is not loosened: no wildcard, no unsafe-eval, no unsafe-inline in script-src, default-src still self', () => {
      expect(directive('script-src').join(' ')).not.toMatch(/\*|unsafe-inline|unsafe-eval/);
      expect(directive('default-src')).toEqual(["'self'"]);
      expect(csp).not.toMatch(/unsafe-eval/);
      expect(csp).not.toMatch(/(^|[\s;])\*($|[\s;])/);
      expect(directive('object-src')).toEqual(["'none'"]);
    });
  });
});
