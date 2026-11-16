import { ChangeDetectorRef, NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';

import { ResultsComponent } from './results.component';
import { BestScoreService } from '@shared/services/progress/best-score.service';
import { ProgressService } from '@shared/services/progress/progress.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { ScoreAnalysisService } from '@shared/services/features/results/score-analysis.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';
import { ThemeService } from '@shared/services/ui/theme.service';

/** Unknown members resolve to a jest.fn, so only what matters is declared. */
function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  }) as T;
}

/**
 * Closing the Results hamburger menu removes the focused menu item from the
 * DOM. Focus used to fall to <body> (Narrator then read the page title, "Angular
 * Quiz App"). It must return to the toggle, except for an outside click, where
 * focus stays on whatever the user clicked.
 */
describe('Results hamburger menu — focus management', () => {
  let fixture: ComponentFixture<ResultsComponent>;
  let host: HTMLElement;
  let results: ResultsComponent;

  const toggle = (): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>('.hamburger-btn')!;
  const menu = (): HTMLElement | null => host.querySelector('nav.nav-dropdown');
  const items = (): HTMLButtonElement[] =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('nav.nav-dropdown .nav-item'));
  const item = (text: string): HTMLButtonElement =>
    items().find((b) => (b.textContent ?? '').includes(text))!;
  /** Render, including the afterNextRender() that restores focus. */
  const settle = (): void => {
    fixture.detectChanges();
    TestBed.tick();
  };
  const open = (): void => {
    toggle().click();
    settle();
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: InterviewReadinessService,
          useValue: {
            readiness: signal(null),
            coverageVerified: signal(true),
            ensureCatalog: jest.fn(async () => undefined)
          }
        },
        {
          provide: QuizService,
          useValue: lenient({
            finalResult$: of(null),
            totalQuestions: signal(0),
            correctAnswersCountSig: signal(0),
            getQuestionsInDisplayOrder: jest.fn(() => []),
            isShuffleEnabled: jest.fn(() => false),
            getFinalResultSnapshot: jest.fn(() => null),
            hasValidResultFor: jest.fn(() => false),
            quizCompleted: false
          })
        },
        { provide: ProgressService, useValue: lenient({}) },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}), recordBestScore: jest.fn() } },
        {
          provide: TopicQuizMetadataService,
          useValue: lenient({
            load: jest.fn(() => of([])),
            difficultyByQuiz: signal(new Map()),
            factsFor: jest.fn(() => []),
            milestoneFor: jest.fn(() => '')
          })
        },
        { provide: QuizDotStatusService, useValue: lenient({}) },
        { provide: QuizStateService, useValue: lenient({}) },
        { provide: SelectedOptionService, useValue: lenient({ recoverAnswersForResults: jest.fn() }) },
        { provide: TimerService, useValue: lenient({ elapsedTimes: [], completionTime: 0 }) },
        { provide: ScoreAnalysisService, useValue: lenient({ buildAnalysis: jest.fn(() => []) }) },
        { provide: TopicPerformanceHistoryService, useValue: { record: jest.fn() } },
        { provide: ThemeService, useValue: lenient({}) },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ quizId: 'q' })) } }
      ]
    });
    // Render the REAL template; child components are irrelevant to the menu.
    TestBed.overrideComponent(ResultsComponent, {
      set: { imports: [NgTemplateOutlet], schemas: [NO_ERRORS_SCHEMA] }
    });
    jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

    fixture = TestBed.createComponent(ResultsComponent);
    host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host); // focus only works on attached elements
    results = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    host.remove();
    jest.restoreAllMocks();
  });

  it('starts closed: aria-expanded is false and there is no menu', () => {
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(menu()).toBeNull();
  });

  it('opening exposes aria-expanded=true and the menu it controls', () => {
    open();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe(menu()!.id);
  });

  describe('activating a menu item (Enter or Space, which a button turns into a click)', () => {
    it('closes the menu and returns focus to the toggle, not <body>', () => {
      open();
      item('Quiz Review').focus();
      expect(document.activeElement).toBe(item('Quiz Review'));

      item('Quiz Review').click();
      settle();

      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(toggle());
      expect(document.activeElement).not.toBe(document.body);
    });

    it('collapses the toggle: aria-expanded=false, aria-controls removed', () => {
      open();
      item('Resources').click();
      settle();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(toggle().hasAttribute('aria-controls')).toBe(false);
    });

    it('still switches the section and scrolls to the top, as before', () => {
      open();
      item('Quiz Review').click();
      settle();
      expect(results.activeSection()).toBe('summary');
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    it('works for every item', () => {
      for (const label of ['Score Analysis', 'Summary Report', 'High Scores', 'Resources']) {
        open();
        item(label).focus();
        item(label).click();
        settle();
        expect(document.activeElement).toBe(toggle());
        expect(menu()).toBeNull();
      }
    });
  });

  describe('Escape', () => {
    const escape = (): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      settle();
    };

    it('from a focused menu item closes the menu and focuses the toggle', () => {
      open();
      item('High Scores').focus();
      escape();
      expect(menu()).toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle());
    });

    it('while the toggle itself is focused keeps focus on the toggle', () => {
      open();
      toggle().focus();
      escape();
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(toggle());
    });

    it('with the menu open but focus elsewhere does not pull focus to the toggle', () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      open();
      outside.focus();
      escape();
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });

    it('does nothing when the menu is already closed', () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      escape();
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });

  describe('header logo button', () => {
    const NAME = 'Angular Quiz Platform — back to quiz selection';
    const logo = (): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>('.logo-btn')!;

    it('is named with the product name and its purpose', () => {
      expect(logo().getAttribute('aria-label')).toBe(NAME);
    });

    it('keeps title equal to the name, so no second description is added', () => {
      expect(logo().getAttribute('title')).toBe(NAME);
      expect(logo().hasAttribute('aria-describedby')).toBe(false);
    });

    it('keeps the decorative image hidden and still navigates on click', () => {
      expect(logo().querySelector('img')!.getAttribute('alt')).toBe('');
      const select = jest.spyOn(results, 'selectQuiz').mockImplementation(() => undefined);
      logo().click();
      expect(select).toHaveBeenCalledTimes(1);
    });

    it('leaves the hamburger name unchanged', () => {
      expect(toggle().getAttribute('aria-label')).toBe('Toggle navigation menu');
    });
  });

  describe('outside click', () => {
    let outside: HTMLButtonElement;

    beforeEach(() => {
      outside = document.createElement('button');
      document.body.appendChild(outside);
    });
    afterEach(() => outside.remove());

    it('dismisses the menu WITHOUT stealing focus from the clicked element', () => {
      open();
      outside.focus(); // what a real click does before the click event
      outside.click();
      settle();
      expect(menu()).toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(outside);
    });

    it('does not move focus when focus was inside the menu but the click was outside', () => {
      open();
      item('Score Analysis').focus();
      outside.click(); // click without focusing: the item keeps focus until removed
      settle();
      expect(menu()).toBeNull();
      expect(document.activeElement).not.toBe(toggle());
    });

    it('a click on the toggle or inside the menu does not dismiss it', () => {
      open();
      menu()!.click();
      settle();
      expect(menu()).not.toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
    });
  });
});
