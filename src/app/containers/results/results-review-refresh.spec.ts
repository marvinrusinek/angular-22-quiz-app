import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectorRef, signal } from '@angular/core';
import { of, Subject } from 'rxjs';

import { ResultsComponent } from './results.component';
import { AccordionComponent } from './accordion/accordion.component';
import { toDurableFinalResult } from '@shared/models';
import type { FinalResult, QuizQuestion, ScoreAnalysisItem } from '@shared/models';
import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizDataService } from '@shared/services/data/quizdata.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { ScoreAnalysisService } from '@shared/services/features/results/score-analysis.service';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';
import { ThemeService } from '@shared/services/ui/theme.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { TopicQuizAttemptService } from '@shared/services/features/verdict/topic-quiz-attempt.service';
import { ReviewRevealService } from '@shared/services/features/results/review-reveal.service';
import type { ReviewReveal } from '@shared/services/features/results/review-reveal.service';
import { ApiTopicQuizVerdictAdapter } from '@shared/services/features/verdict/api-verdict.adapter';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';

/**
 * Quiz Review after a REFRESH.
 *
 * The saved result is deliberately stripped of the answer key (toDurableFinalResult) and question receipts live in
 * memory only, so a reload used to leave every Quiz Review row at "(not available)". The reveal the user ALREADY
 * earned in this completed attempt is now kept in a small, attempt-scoped session record (never the bank, never a
 * new receipt, never a request) and restored on reload.
 *
 * Flow under test: completion -> answers/explanations visible -> refresh -> still visible.
 */
const BASE = 'https://api.test/api';
const QUIZ = 'angular';
const T0 = 1_700_000_000_000;
const Q_SINGLE = 'Which one is right?';
const Q_MULTI = 'Pick the two right ones';
const Q_SKIPPED = 'Never answered';

const question = (text: string, opts: string[], type: string): QuizQuestion =>
  ({
    questionText: text,
    type,
    options: opts.map((t, i) => ({ optionId: i + 1, text: t }))
  }) as unknown as QuizQuestion;

// Displayed (possibly shuffled) order: the right answers are NOT at the front.
const QUESTIONS = [
  question(Q_SINGLE, ['wrong A', 'right one', 'wrong B'], 'single'),
  question(Q_MULTI, ['right x', 'wrong C', 'right y', 'wrong D'], 'multiple'),
  question(Q_SKIPPED, ['one', 'two'], 'single')
];

/** What the user earned DURING the attempt (in memory on first arrival). */
const earnedAnalysis = (): ScoreAnalysisItem[] => [
  {
    questionIndex: 0,
    questionText: Q_SINGLE,
    wasCorrect: true,
    selectedOptionIds: ['2'],
    correctOptionIds: ['2'],
    selectedOptionTexts: ['right one'],
    correctOptionTexts: ['right one'],
    explanation: 'it is the one that fits'
  },
  {
    questionIndex: 1,
    questionText: Q_MULTI,
    wasCorrect: true,
    selectedOptionIds: ['1', '3'],
    correctOptionIds: ['1', '3'],
    selectedOptionTexts: ['right x', 'right y'],
    correctOptionTexts: ['right x', 'right y'],
    explanation: 'both of them hold'
  },
  {
    // never reached a terminal state: nothing was authorized for it
    questionIndex: 2,
    questionText: Q_SKIPPED,
    wasCorrect: false,
    selectedOptionIds: [],
    correctOptionIds: [],
    selectedOptionTexts: [],
    explanation: null
  }
];

const result = (): FinalResult => ({
  quizId: QUIZ,
  correct: 2,
  total: 3,
  percentage: 67,
  analysis: earnedAnalysis(),
  completedAt: T0,
  completionTime: 40
});

function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  }) as T;
}

describe('Results: Quiz Review survives a refresh', () => {
  let live: FinalResult | null;
  /** The reveal service's stream: a late reveal (a question completed after the quiz ended) arrives on it. */
  let late$: Subject<ReviewReveal>;
  let results: ResultsComponent;
  let http: HttpTestingController;

  /** What QuizService really does: prefer memory, else the (stripped) saved result. */
  const readSnapshot = (): FinalResult | null => {
    if (live) return live;
    const raw = sessionStorage.getItem('finalResult');
    return raw ? toDurableFinalResult(JSON.parse(raw) as FinalResult) : null;
  };

  /**
   * A brand-new page: fresh dependency injection, same browser storage.
   * `resultsKnowsQuestions: false` is what a REAL full-page reload looks like without shuffled options: the Results
   * component's own question list is empty (the accordion fetches the questions itself).
   */
  function bootPage(opts: { resultsKnowsQuestions?: boolean } = {}): void {
    const known = opts.resultsKnowsQuestions ?? true;
    const quizService = lenient({
      finalResult$: new Subject<FinalResult | null>(),
      quizId: QUIZ,
      totalQuestions: signal(3),
      correctAnswersCountSig: signal(2),
      getQuestionsInDisplayOrder: jest.fn().mockReturnValue(known ? QUESTIONS : []),
      questionsSig: () => QUESTIONS,
      userAnswers: [],
      questions: [],
      isShuffleEnabled: jest.fn().mockReturnValue(true),
      getFinalResultSnapshot: jest.fn().mockImplementation(readSnapshot),
      hasValidResultFor: jest.fn().mockReturnValue(false),
      setQuizId: jest.fn()
    });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useExisting: ApiTopicQuizVerdictAdapter },
        { provide: ReviewRevealService, useValue: { reveals: () => late$.asObservable() } },
        { provide: QuizDotStatusService, useValue: lenient({}) },
        { provide: QuizService, useValue: quizService },
        { provide: QuizDataService, useValue: lenient({}) },
        { provide: QuizStateService, useValue: lenient({}) },
        {
          provide: SelectedOptionService,
          useValue: lenient({
            recoverAnswersForResults: jest.fn(),
            rawSelectionsMap: new Map(),
            selectedOptionsMap: new Map()
          })
        },
        {
          provide: TimerService,
          useValue: lenient({ elapsedTimes: [4, 8, 0], completionTime: 12, isCountdown: () => false, timePerQuestion: 0 })
        },
        { provide: ScoreAnalysisService, useValue: lenient({ buildAnalysis: jest.fn() }) },
        {
          provide: AchievementService,
          useValue: lenient({
            recordQuizResult: jest.fn(),
            evaluate: jest.fn().mockReturnValue([]),
            catalog: jest.fn().mockReturnValue([])
          })
        },
        { provide: TopicPerformanceHistoryService, useValue: lenient({ record: jest.fn() }) },
        { provide: ThemeService, useValue: lenient({}) },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ quizId: QUIZ })),
            snapshot: { paramMap: { get: () => null } },
            parent: null
          }
        },
        { provide: Router, useValue: lenient({}) },
        { provide: ChangeDetectorRef, useValue: lenient({ markForCheck: jest.fn() }) },
        {
          provide: TopicQuizMetadataService,
          useValue: lenient({
            load: jest.fn().mockReturnValue(of([])),
            difficultyByQuiz: jest.fn().mockReturnValue(new Map()),
            factsByQuiz: jest.fn().mockReturnValue(new Map()),
            factsFor: jest.fn().mockReturnValue([]),
            milestoneFor: jest.fn().mockReturnValue('')
          })
        }
      ]
    });
    http = TestBed.inject(HttpTestingController);
    // no receipts exist on a fresh page: the attempt service starts empty
    TestBed.inject(TopicQuizAttemptService);
  }

  function openResults(): void {
    TestBed.flushEffects();
    results = TestBed.runInInjectionContext(() => new ResultsComponent());
    TestBed.flushEffects();
    results.ngOnInit();
    TestBed.flushEffects();
  }

  /** The Quiz Review rows for each question, exactly as the accordion renders them. */
  async function reviewRows(): Promise<Array<{ correct: string; expl: string }>> {
    const f: ComponentFixture<AccordionComponent> = TestBed.createComponent(AccordionComponent);
    f.componentRef.setInput('questions', QUESTIONS);
    f.componentRef.setInput('analysis', results.scoreAnalysis());
    f.detectChanges();
    await Promise.resolve();
    f.detectChanges();
    for (const h of [...f.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[]) {
      h.click();
      f.detectChanges();
    }
    return QUESTIONS.map((_, i) => {
      const rows = [...f.nativeElement.querySelectorAll(`#qr-body-${i} .quiz-summary-text`)].map((e) => {
        const c = (e as HTMLElement).cloneNode(true) as HTMLElement;
        c.querySelectorAll('i').forEach((x) => x.remove());
        return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
      });
      return { correct: rows[1], expl: rows[2] };
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    sessionStorage.clear();
    live = null;
    late$ = new Subject<ReviewReveal>();
  });

  afterEach(() => {
    jest.useRealTimers();
    sessionStorage.clear();
  });

  const EXPECTED = [
    { correct: 'Correct Answer: Option 2 — right one', expl: 'Explanation: Option 2 was correct because it is the one that fits.' },
    { correct: 'Correct Answers: Options 1 and 3 — right x, right y', expl: 'Explanation: Options 1 and 3 were correct because both of them hold.' },
    { correct: 'Correct Answers: (not available)', expl: 'Explanation: (no explanation available)' }
  ];

  it('shows answers and explanations on arrival, and STILL shows them after a refresh', async () => {
    // ── completion: the earned reveal is in memory ─────────────────────────
    live = result();
    bootPage();
    openResults();
    expect(await reviewRows()).toEqual(EXPECTED);

    // ── refresh: memory gone, fresh page, only browser storage survives ──────
    live = null;
    bootPage();
    openResults();
    expect(await reviewRows()).toEqual(EXPECTED);

    // singular / plural come from the ACTUAL correct-option count (1 vs 2), not the user's picks or the type
    const rows = await reviewRows();
    expect(rows[0].correct.startsWith('Correct Answer:')).toBe(true);
    expect(rows[1].correct.startsWith('Correct Answers:')).toBe(true);
  });

  it.each([
    ['questions known to Results (shuffled options are restored with the page)', true],
    ['questions NOT known to Results (a real full-page reload, options not shuffled)', false]
  ])('after a refresh, with %s', async (_label, resultsKnowsQuestions) => {
    live = result();
    bootPage();
    openResults();
    expect(await reviewRows()).toEqual(EXPECTED);

    live = null;
    bootPage({ resultsKnowsQuestions });
    openResults();
    expect(await reviewRows()).toEqual(EXPECTED);
  });

  it('restores through storage only: no request, no receipt, and the saved result stays stripped', async () => {
    live = result();
    bootPage();
    openResults();
    await reviewRows();

    live = null;
    bootPage();
    openResults();
    await reviewRows();
    // refresh made NO call at all: no /check, no /attempts, no /questions/start
    http.expectNone(() => true);

    // the durable saved result still carries no answer key and no explanation (the user's OWN picks stay)
    const saved = JSON.parse(sessionStorage.getItem('finalResult') ?? '{}') as FinalResult;
    for (const item of saved.analysis) {
      expect(item.correctOptionTexts).toBeUndefined();
      expect(item.explanation).toBeUndefined();
      expect(item.correctOptionIds).toEqual([]);
    }
    expect(JSON.stringify(saved)).not.toContain('it is the one that fits');
    expect(JSON.stringify(saved)).not.toContain('both of them hold');
  });

  it('restores only what was authorized: a question that never had a reveal stays "(not available)"', async () => {
    live = result();
    bootPage();
    openResults();
    live = null;
    bootPage();
    openResults();
    const rows = await reviewRows();
    expect(rows[2]).toEqual(EXPECTED[2]);
  });

  it('never restores a reveal that belongs to a different result (other attempt or other quiz)', async () => {
    live = result();
    bootPage();
    openResults();
    await reviewRows();

    // a NEW attempt of the same quiz: new completedAt, no reveals yet
    const stripped = toDurableFinalResult({ ...result(), completedAt: T0 + 60_000 });
    sessionStorage.setItem('finalResult', JSON.stringify(stripped));
    live = null;
    bootPage();
    openResults();
    const rows = await reviewRows();
    expect(rows[0]).toEqual({ correct: 'Correct Answers: (not available)', expl: 'Explanation: (no explanation available)' });
    expect(rows[1].correct).toBe('Correct Answers: (not available)');
  });

  it('ignores a corrupt or tampered record', async () => {
    live = result();
    bootPage();
    openResults();
    const key = Object.keys(sessionStorage).find((k) => /review/i.test(k) && k !== 'finalResult');
    expect(key).toBeDefined();
    sessionStorage.setItem(key!, '{"not":"valid"');
    live = null;
    bootPage();
    openResults();
    const rows = await reviewRows();
    expect(rows[0].correct).toBe('Correct Answers: (not available)');

    // well-formed but claims options that are not on the question: refused by the display-time match
    sessionStorage.setItem(
      key!,
      JSON.stringify({
        v: 1,
        quizId: QUIZ,
        completedAt: T0,
        reveals: [{ questionText: Q_SINGLE, correctOptionTexts: ['not an option'], explanation: 'x' }]
      })
    );
    bootPage();
    openResults();
    expect((await reviewRows())[0].correct).toBe('Correct Answers: (not available)');
  });

  it('keeps a reveal that arrived LATE (after the quiz ended) through a refresh', async () => {
    // Q_MULTI was left partially answered: no reveal when Results opens
    const partial = result();
    partial.analysis[1] = { ...partial.analysis[1], correctOptionTexts: undefined, correctOptionIds: [], explanation: null };
    live = partial;
    bootPage();
    openResults();
    expect((await reviewRows())[1]).toEqual({ correct: 'Correct Answers: (not available)', expl: 'Explanation: (no explanation available)' });

    // its signed deadline passes and the authorized reveal arrives by itself
    late$.next({ questionText: Q_MULTI, correctOptionTexts: ['right x', 'right y'], explanation: 'both of them hold' });
    expect((await reviewRows())[1]).toEqual(EXPECTED[1]);

    // refresh: still there, and still no request
    live = null;
    bootPage();
    openResults();
    expect((await reviewRows())[1]).toEqual(EXPECTED[1]);
    http.expectNone(() => true);
  });
});
