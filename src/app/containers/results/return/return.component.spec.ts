import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ReturnComponent } from './return.component';

/**
 * Topic Quiz Results — the action buttons under the result.
 *
 * "View Your Progress" is navigation to the AGGREGATE page; it must not touch
 * this attempt's result or session. Unlike the three existing actions (anchors
 * with a click handler and no href), it is a REAL link.
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

  const anchors = (): HTMLAnchorElement[] => Array.from(el.querySelectorAll<HTMLAnchorElement>('a.btn'));
  const byTitle = (title: string): HTMLAnchorElement | undefined =>
    anchors().find((a) => a.getAttribute('title') === title);
  const label = (a: Element | undefined): string => (a?.textContent ?? '').replace(/[\s ]+/g, ' ').trim();

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

  it('keeps the three existing actions, unchanged', () => {
    expect(label(byTitle('restart'))).toContain('Restart Quiz');
    expect(label(byTitle('select quiz'))).toContain('Select Quiz');
    expect(label(byTitle('back to Codelab'))).toContain('Back to Codelab');
    expect(anchors()).toHaveLength(4);
  });

  it('navigates to /progress when activated, without running the quiz-reset paths', () => {
    const navigateByUrl = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const restart = jest.spyOn(fixture.componentInstance, 'restartQuiz');
    const select = jest.spyOn(fixture.componentInstance, 'selectQuiz');

    byTitle('your progress')!.click();

    expect(navigateByUrl).toHaveBeenCalledTimes(1);
    expect(navigateByUrl.mock.calls[0][0].toString()).toBe('/progress');
    expect(restart).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
