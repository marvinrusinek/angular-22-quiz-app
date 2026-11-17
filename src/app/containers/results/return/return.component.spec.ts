import * as fs from 'fs';
import * as path from 'path';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { QuizProgressionService } from '@shared/services/flow/quiz-progression.service';
import { ReturnComponent } from './return.component';

/**
 * Topic Quiz Results — the action buttons under the result.
 *
 * "View Your Progress" is navigation to the AGGREGATE page; it must not touch
 * this attempt's result or session. It is a REAL link (has an href).
 */
describe('ReturnComponent — Results actions', () => {
  let fixture: ComponentFixture<ReturnComponent>;
  let el: HTMLElement;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ imports: [ReturnComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(ReturnComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  afterEach(() => sessionStorage.clear());

  const anchors = (): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>('.btn'));
  const byTitle = (title: string): HTMLElement | undefined =>
    anchors().find((a) => a.getAttribute('title') === title);
  // The progress link has no title any more (its accessible name is explicit): find it as the one <a>.
  const progressLink = (): HTMLAnchorElement | undefined =>
    el.querySelector<HTMLAnchorElement>('a.btn') ?? undefined;
  const label = (a: Element | undefined): string =>
    (a?.textContent ?? '').replace(/[\s ]+/g, ' ').trim();

  it('offers "View Your Progress", routed to /progress', () => {
    const progress = progressLink();
    expect(progress).toBeDefined();
    expect(label(progress)).toContain('View Your Progress');
    expect(progress!.getAttribute('href')).toBe('/progress');
  });

  it('is a REAL link — keyboard-reachable — not a click-only anchor', () => {
    const progress = progressLink()!;
    expect(progress.tagName).toBe('A');
    expect(progress.hasAttribute('href')).toBe(true);
  });

  it('is a native link named by its single visible label: no title, no aria-label, nothing hiding the link', () => {
    const progress = progressLink()!;
    expect(progress.tagName).toBe('A');
    expect(progress.getAttribute('href')).toBe('/progress');
    expect(progress.hasAttribute('title')).toBe(false); // the old title="your progress" was a redundant description
    expect(progress.hasAttribute('aria-label')).toBe(false);
    expect(progress.hasAttribute('aria-hidden')).toBe(false);
    expect(progress.hasAttribute('role')).toBe(false);
    expect(progress.hasAttribute('tabindex')).toBe(false);
    expect(label(progress)).toContain('View Your Progress');
  });

  it('has exactly ONE exposed text node inside the link (the label): no blank nbsp text line, label not aria-hidden', () => {
    const progress = progressLink()!;
    const walker = document.createTreeWalker(progress, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    // no whitespace-only / no-break-space-only text node (it was a blank text line Narrator stopped on)
    expect(texts.filter((n) => /^[\s\u00a0]*$/.test(n.data) && n.data.includes('\u00a0'))).toEqual([]);
    const exposed = texts.filter((n) => !n.parentElement!.closest('[aria-hidden="true"]') && n.data.trim());
    expect(exposed.map((n) => n.data.trim())).toEqual(['View Your Progress']);
    expect(progress.querySelector('.mdc-button__label')?.hasAttribute('aria-hidden')).toBe(false);
    expect(progress.querySelector('.material-icons')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the icon-to-label spacing in CSS (scoped to the link), not in a text node', () => {
    const scss = fs.readFileSync(path.join(__dirname, 'return.component.scss'), 'utf8').replace(/\s+/g, ' ');
    expect(progressLink()!.classList.contains('progress-link')).toBe(true);
    expect(scss).toContain('.progress-link .mdc-button__label { margin-inline-start: calc(0.556em + 4px); }');
  });

  it('leaves Restart Quiz and Select Quiz unchanged (native buttons with their titles)', () => {
    const restart = byTitle('restart')!;
    const select = byTitle('select quiz')!;
    expect(restart.tagName).toBe('BUTTON');
    expect(select.tagName).toBe('BUTTON');
    expect(restart.hasAttribute('aria-label')).toBe(false);
    expect(select.hasAttribute('aria-label')).toBe(false);
    expect(restart.querySelector('.mdc-button__label')?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('keeps the remaining actions, unchanged', () => {
    expect(label(byTitle('restart'))).toContain('Restart Quiz');
    expect(label(byTitle('select quiz'))).toContain('Select Quiz');
    expect(anchors()).toHaveLength(3);
  });

  it('no longer offers a "Back to Codelab" action or external link', () => {
    expect(fixture.nativeElement.textContent).not.toContain('Back to Codelab');
    expect(fixture.nativeElement.querySelector('a[href*="codelab.fun"]')).toBeNull();
  });

  it('navigates to /progress when activated, without running the quiz-reset paths', () => {
    const navigateByUrl = jest
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    const restart = jest.spyOn(fixture.componentInstance, 'restartQuiz');
    const select = jest.spyOn(fixture.componentInstance, 'selectQuiz');

    progressLink()!.click();

    expect(navigateByUrl).toHaveBeenCalledTimes(1);
    expect(navigateByUrl.mock.calls[0][0].toString()).toBe('/progress');
    expect(restart).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});

/**
 * Restart Quiz / Select Quiz used to be <a (click)> with no href, so they were
 * not keyboard-reachable and were not exposed as controls. They are native
 * buttons now: focusable, and activated by Enter and Space by the browser.
 */
describe('ReturnComponent — Restart and Select are native buttons', () => {
  let fixture: ComponentFixture<ReturnComponent>;
  let el: HTMLElement;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ imports: [ReturnComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(ReturnComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  afterEach(() => {
    el.remove();
    sessionStorage.clear();
  });

  const button = (title: string): HTMLButtonElement =>
    el.querySelector<HTMLButtonElement>(`button.btn[title="${title}"]`)!;

  it.each(['restart', 'select quiz'])('"%s" is a <button type="button">', (title) => {
    const b = button(title);
    expect(b).not.toBeNull();
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.disabled).toBe(false);
  });

  it('is in the Tab order (not tabindex -1) and takes focus', () => {
    document.body.appendChild(el);
    for (const title of ['restart', 'select quiz']) {
      const b = button(title);
      expect(b.tabIndex).toBeGreaterThanOrEqual(0);
      b.focus();
      expect(document.activeElement).toBe(b);
    }
  });

  it('no click-only anchor is left (an <a> without href)', () => {
    expect(el.querySelectorAll('a:not([href])')).toHaveLength(0);
  });

  it('keeps the visible label and the same classes as before', () => {
    const restart = button('restart');
    expect(restart.textContent).toContain('Restart Quiz');
    expect(restart.classList.contains('mdc-button')).toBe(true);
    expect(button('select quiz').textContent).toContain('Select Quiz');
  });

  it('runs the existing handlers when activated', () => {
    const restart = jest
      .spyOn(fixture.componentInstance, 'restartQuiz')
      .mockImplementation(() => undefined);
    const select = jest
      .spyOn(fixture.componentInstance, 'selectQuiz')
      .mockImplementation(() => undefined);
    // A native button turns Enter and Space into this click.
    button('restart').click();
    button('select quiz').click();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

/**
 * DIRECT-ROUTE PROGRESSION BYPASS FIX — this Restart path is the one that
 * does NOT mint a new attemptId (see resetQuizRuntimeState's own comment), so
 * it must clear the furthest-unlocked marker EXPLICITLY rather than relying
 * on attempt-id invalidation the way the in-quiz Restart button can.
 */
describe('ReturnComponent — Restart clears the progression marker', () => {
  let fixture: ComponentFixture<ReturnComponent>;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ imports: [ReturnComponent], providers: [provideRouter([])] });
    fixture = TestBed.createComponent(ReturnComponent);
    fixture.detectChanges();
  });

  afterEach(() => sessionStorage.clear());

  it('restartQuiz() calls QuizProgressionService.clear()', () => {
    const clearSpy = jest.spyOn(TestBed.inject(QuizProgressionService), 'clear');
    jest.spyOn(Router.prototype, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.restartQuiz();

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
