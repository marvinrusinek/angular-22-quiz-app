import { Component, NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, map, Subject } from 'rxjs';

import { QuizService } from '@shared/services/data/quiz.service';
import { ScoreboardComponent } from './scoreboard.component';
import { ScoreComponent } from './score/score.component';
import { TimerComponent } from './timer/timer.component';

/**
 * The question badge ("Q <current> of <total>").
 *
 * `badgeParts` replaced the old `badgeparts` array: it is `null` when there is no badge text (so the badge stays hidden) and
 * `{ current, total }` otherwise. The badge text itself is still the route-derived value, with the service's text only used when it
 * agrees (a stale service value, e.g. after a tab returns to visible, never wins over the route).
 */

@Component({ selector: 'codelab-scoreboard-score', standalone: true, template: '' })
class ScoreStub {}
@Component({ selector: 'codelab-scoreboard-timer', standalone: true, template: '' })
class TimerStub {}

interface Setup {
  fixture: ComponentFixture<ScoreboardComponent>;
  component: ScoreboardComponent;
  serviceBadge$: Subject<string>;
  total$: BehaviorSubject<number>;
  updateBadgeText: jest.Mock;
  params$: BehaviorSubject<Record<string, string>>;
}

function mount(opts: { questionIndex?: string; total?: number; serviceBadge?: string } = {}): Setup {
  const serviceBadge$ = new Subject<string>();
  const total$ = new BehaviorSubject<number>(opts.total ?? 0);
  const updateBadgeText = jest.fn();
  const params: Record<string, string> = opts.questionIndex === undefined ? {} : { questionIndex: opts.questionIndex };
  const params$ = new BehaviorSubject<Record<string, string>>(params);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ScoreboardComponent],
    providers: [
      provideRouter([]),
      {
        provide: QuizService,
        useValue: { badgeText: serviceBadge$.asObservable(), totalQuestions$: total$.asObservable(), updateBadgeText }
      },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: convertToParamMap(params) },
          paramMap: params$.pipe(map((p) => convertToParamMap(p))),
          params: params$.asObservable()
        }
      }
    ],
    schemas: [NO_ERRORS_SCHEMA]
  });
  TestBed.overrideComponent(ScoreboardComponent, {
    remove: { imports: [ScoreComponent, TimerComponent] },
    add: { imports: [ScoreStub, TimerStub] }
  });

  const fixture = TestBed.createComponent(ScoreboardComponent);
  fixture.detectChanges();
  if (opts.serviceBadge !== undefined) serviceBadge$.next(opts.serviceBadge);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, serviceBadge$, total$, updateBadgeText, params$ };
}

const badge = (fixture: ComponentFixture<ScoreboardComponent>): HTMLElement | null =>
  fixture.nativeElement.querySelector('.scoreboard__badge');
const text = (fixture: ComponentFixture<ScoreboardComponent>, cls: string): string =>
  fixture.nativeElement.querySelector(`.scoreboard__badge .${cls}`)?.textContent?.trim() ?? '';

describe('ScoreboardComponent — question badge', () => {
  it('an EMPTY badge stays hidden and badgeParts is null', () => {
    const { fixture, component } = mount({ questionIndex: '1', total: 0 });
    expect(component.badgeText()).toBe('');
    expect(component.badgeParts()).toBeNull();
    expect(badge(fixture)).toBeNull();
  });

  it('"Question 1 of 6" renders as Q / 1 / of / 6 with the status role', () => {
    const { fixture, component } = mount({ questionIndex: '1', total: 6 });
    expect(component.badgeText()).toBe('Question 1 of 6');
    expect(component.badgeParts()).toEqual({ current: '1', total: '6' });

    const el = badge(fixture)!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('status');
    expect(text(fixture, 'badge-q')).toBe('Q');
    expect(text(fixture, 'badge-current')).toBe('1');
    expect(text(fixture, 'badge-of')).toBe('of');
    expect(text(fixture, 'badge-total')).toBe('6');
  });

  it('follows navigation: the badge updates when the route moves to question 4', () => {
    const { fixture, component, params$ } = mount({ questionIndex: '1', total: 6 });
    params$.next({ questionIndex: '4' });
    fixture.detectChanges();
    expect(component.badgeParts()).toEqual({ current: '4', total: '6' });
    expect(text(fixture, 'badge-current')).toBe('4');
  });

  it('a STALE service value never wins over the route (resume / tab-visibility fallback)', () => {
    const { fixture, component } = mount({ questionIndex: '3', total: 6, serviceBadge: 'Question 1 of 6' });
    expect(component.badgeText()).toBe('Question 3 of 6');
    expect(component.badgeParts()).toEqual({ current: '3', total: '6' });
    expect(text(fixture, 'badge-current')).toBe('3');
  });

  it('an agreeing service value is used as is', () => {
    const { component } = mount({ questionIndex: '2', total: 6, serviceBadge: 'Question 2 of 6' });
    expect(component.badgeText()).toBe('Question 2 of 6');
    expect(component.badgeParts()).toEqual({ current: '2', total: '6' });
  });

  it('with no route value the service text is still shown (route-derived text is empty until the total is known)', () => {
    const { fixture, component } = mount({ total: 0, serviceBadge: 'Question 5 of 10' });
    expect(component.badgeParts()).toEqual({ current: '5', total: '10' });
    expect(badge(fixture)).not.toBeNull();
  });

  it('keeps the existing synchronization with the service (updateBadgeText) once route and total are known', () => {
    const { updateBadgeText } = mount({ questionIndex: '2', total: 6 });
    expect(updateBadgeText).toHaveBeenCalledWith(2, 6);
  });

  it('badgeParts tolerates text without " of " (total falls back to an empty string)', () => {
    const { component } = mount({ total: 0, serviceBadge: 'Question 7' });
    expect(component.badgeParts()).toEqual({ current: '7', total: '' });
  });
});
