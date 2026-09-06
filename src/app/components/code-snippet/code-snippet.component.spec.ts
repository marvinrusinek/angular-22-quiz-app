import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CodeSnippetComponent } from './code-snippet.component';

describe('CodeSnippetComponent', () => {
  let fixture: ComponentFixture<CodeSnippetComponent>;
  let component: CodeSnippetComponent;

  function setup(code: string, language: 'typescript' | 'html' | 'css' | 'json', filename?: string) {
    fixture = TestBed.createComponent(CodeSnippetComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('code', code);
    fixture.componentRef.setInput('language', language);
    if (filename !== undefined) fixture.componentRef.setInput('filename', filename);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;

  it('renders the code inside <pre><code>', () => {
    setup('const x = 1;', 'typescript');
    expect(el().querySelector('pre')).toBeTruthy();
    expect(el().querySelector('code')).toBeTruthy();
    expect(el().querySelector('code')!.textContent).toContain('const x = 1;');
  });

  it('shows the language label', () => {
    setup('const x = 1;', 'typescript');
    expect(el().querySelector('.code-snippet__language')!.textContent).toContain('TypeScript');
  });

  it('shows the filename only when provided', () => {
    setup('const x = 1;', 'typescript', 'counter.component.ts');
    expect(el().querySelector('.code-snippet__filename')!.textContent).toContain('counter.component.ts');
  });

  it('omits the filename element when not provided', () => {
    setup('const x = 1;', 'typescript');
    expect(el().querySelector('.code-snippet__filename')).toBeNull();
  });

  it('preserves multiline formatting and whitespace', () => {
    const code = 'line one\n  line two indented\nline three';
    setup(code, 'typescript');
    expect(el().querySelector('code')!.textContent).toBe(code);
  });

  it('applies Prism token classes for TypeScript', () => {
    setup('const x = 1;', 'typescript');
    expect(el().querySelectorAll('.token').length).toBeGreaterThan(0);
    expect(el().querySelector('.token.keyword')).toBeTruthy();
  });

  it('applies Prism token classes for HTML', () => {
    setup('<button>Click</button>', 'html');
    expect(el().querySelectorAll('.token').length).toBeGreaterThan(0);
  });

  it('applies Prism token classes for CSS and JSON', () => {
    setup('.x { color: red; }', 'css');
    expect(el().querySelectorAll('.token').length).toBeGreaterThan(0);

    setup('{"a": 1}', 'json');
    expect(el().querySelectorAll('.token').length).toBeGreaterThan(0);
  });

  it('shows Angular interpolation and template syntax LITERALLY, never interpreted', () => {
    setup('template: `<button (click)="count.update(v => v + 1)">{{ count() }}</button>`', 'typescript');
    // Rendered as visible text — never bound/interpreted by Angular a second time.
    expect(el().querySelector('code')!.textContent).toContain('{{ count() }}');
    expect(el().querySelector('code')!.textContent).toContain('(click)="count.update(v => v + 1)"');
  });

  // ── security ────────────────────────────────────────────────────────
  //
  // The load-bearing regression: script-like text in stored code must render
  // as inert, visible text — never executable markup. Proven against the
  // REAL rendered DOM, not a string/snapshot assertion.
  describe('XSS: script-like content stays inert', () => {
    const malicious = '<script>window.__CODE_SNIPPET_XSS__ = true</script>';

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>)['__CODE_SNIPPET_XSS__'];
    });

    it('never executes the script', () => {
      setup(malicious, 'html');
      expect((window as unknown as Record<string, unknown>)['__CODE_SNIPPET_XSS__']).toBeUndefined();
    });

    it('never inserts a live <script> element into the rendered DOM', () => {
      setup(malicious, 'html');
      expect(el().querySelectorAll('script').length).toBe(0);
    });

    it('shows the script tag as literal, visible text', () => {
      setup(malicious, 'html');
      expect(el().querySelector('code')!.textContent).toContain('<script>');
      expect(el().querySelector('code')!.textContent).toContain('window.__CODE_SNIPPET_XSS__ = true');
    });

    it('is inert across every supported language, not just HTML', () => {
      for (const language of ['typescript', 'html', 'css', 'json'] as const) {
        setup(malicious, language);
        expect((window as unknown as Record<string, unknown>)['__CODE_SNIPPET_XSS__']).toBeUndefined();
        expect(el().querySelectorAll('script').length).toBe(0);
      }
    });

    it('other HTML-shaped code (button/div/event handlers) never becomes live markup', () => {
      setup('<div onclick="window.__CODE_SNIPPET_XSS__ = true"><button>Click</button></div>', 'html');
      expect(el().querySelectorAll('button').length).toBe(0);   // no REAL button was created
      expect(el().querySelector('code')!.textContent).toContain('<button>Click</button>');
      el().querySelector('code')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect((window as unknown as Record<string, unknown>)['__CODE_SNIPPET_XSS__']).toBeUndefined();
    });
  });
});
