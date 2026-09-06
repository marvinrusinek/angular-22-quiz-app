import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';
import Prism from 'prismjs';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-json';

// Prism's core auto-highlights the whole document on DOMContentLoaded unless
// told not to. This app only ever calls `Prism.highlight()` directly (see
// below), so that scan is disabled globally, once, at module load.
Prism.manual = true;

export type CodeSnippetLanguage = 'typescript' | 'html' | 'css' | 'json';

/** Prism's own grammar registry key for each language this component supports. */
const GRAMMAR_KEY: Record<CodeSnippetLanguage, string> = {
  typescript: 'typescript',
  html: 'markup',
  css: 'css',
  json: 'json'
};

const LANGUAGE_LABEL: Record<CodeSnippetLanguage, string> = {
  typescript: 'TypeScript',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON'
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Read-only, syntax-highlighted code snippet — question CONTENT, never an
 * answer-key mechanism. Owns ONLY presentation: highlighting, the filename/
 * language header, horizontal scrolling and theme styling. It knows nothing
 * about correctness, answers, scoring, timers, feedback or Interview state,
 * and injects no service to enforce that structurally.
 *
 * ── Security ──────────────────────────────────────────────────────
 *
 * `Prism.highlight()` is a pure, synchronous string-in/string-out function.
 * Its tokenizer HTML-ESCAPES the source text before wrapping tokens in
 * `<span class="token ...">` — the only elements/attributes it ever emits,
 * both already on Angular's default SafeHTML allowlist. The bound
 * `[innerHTML]` below therefore passes through Angular's ordinary automatic
 * sanitizer unchanged; `DomSanitizer.bypassSecurityTrustHtml` is never used
 * or needed anywhere in this component.
 *
 * ── Reactivity ────────────────────────────────────────────────────
 *
 * Highlighting is a plain `computed()` — `Prism.highlight()` needs no DOM
 * element to exist first (unlike Prism's OTHER API, `highlightElement`,
 * which this component deliberately does not use), so there is no
 * `afterNextRender`/`afterRenderEffect` anywhere here.
 */
@Component({
  selector: 'app-code-snippet',
  standalone: true,
  imports: [],
  templateUrl: './code-snippet.component.html',
  styleUrls: ['./code-snippet.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CodeSnippetComponent {
  readonly code = input.required<string>();
  readonly language = input.required<CodeSnippetLanguage>();
  readonly filename = input<string>();

  readonly languageLabel = computed(() => LANGUAGE_LABEL[this.language()]);

  readonly highlighted = computed(() => {
    const grammarKey = GRAMMAR_KEY[this.language()];
    const grammar = Prism.languages[grammarKey];
    // Defensive fallback only — every value `language()` can take has a
    // grammar imported above, so this never fires in practice. If it somehow
    // did, the code still renders as inert, escaped, visible text rather than
    // throwing.
    if (!grammar) return escapeHtml(this.code());
    return Prism.highlight(this.code(), grammar, grammarKey);
  });
}
