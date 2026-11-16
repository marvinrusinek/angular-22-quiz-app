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
  const label = (a: Element | undefined): string =>
    (a?.textContent ?? '').replace(/[\s ]+/g, ' ').trim();

  it('offers "View Your Progress", routed to /progress', () => {
    const progress = byTitle('your progress');
    expect(progress).toBeDefined();
    expect(label(progress)).toContain('View Your Progress');
    expect(progress!.getAttribute('href')).toBe('/progress');
  });

  it('is a REAL link — keyboard-reachable — not a click-only anchor', () => {
    const progress = byTitle('your progress')!;
    expect(progress.tagName).toBe('A');
    expect(progress.hasAttribute('href')).toBe(true);
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

    byTitle('your progress')!.click();

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
