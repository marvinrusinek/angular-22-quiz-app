import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseTemplate } from '@angular/compiler';

/**
 * Results must hand its analysis to the Quiz Review accordion.
 *
 * The Topic Quiz API sends no explanation with a question, so the accordion can
 * only show one if Results passes the analysis (which carries the explanation
 * the player earned). Without the binding the Explanation row is silently
 * empty. This reads the REAL results template, so a removed or renamed binding
 * fails here.
 */
function findElements(nodes: unknown[], name: string, out: any[] = []): any[] {
  const seen = new Set<unknown>();
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n.constructor?.name === 'Element' && n.name === name) out.push(n);
    for (const key of Object.keys(n)) {
      if (/Span$/.test(key) || key === 'i18n') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  nodes.forEach(walk);
  return out;
}

describe('Results template — Quiz Review accordion inputs', () => {
  const html = readFileSync(join(__dirname, 'results.component.html'), 'utf8');
  const parsed = parseTemplate(html, 'results.component.html', {
    preserveWhitespaces: false,
    enableBlockSyntax: true,
    enableLetSyntax: true
  });

  it('parses without errors', () => {
    expect(parsed.errors ?? []).toHaveLength(0);
  });

  it('passes scoreAnalysis() to the accordion as [analysis]', () => {
    const [acc] = findElements(parsed.nodes, 'codelab-results-accordion');
    expect(acc).toBeDefined();
    const inputs: Record<string, string> = {};
    for (const i of acc.inputs) inputs[i.name] = i.value?.source ?? '';
    expect(inputs['analysis']).toBe('scoreAnalysis()');
  });

  it('still passes the questions and the header label', () => {
    const [acc] = findElements(parsed.nodes, 'codelab-results-accordion');
    const inputs: Record<string, string> = {};
    for (const i of acc.inputs) inputs[i.name] = i.value?.source ?? '';
    expect(inputs['questions']).toBe('detailedSummaryQuestions()');
    expect(inputs['headerLabel']).toBe('headerLabel()');
  });
});
