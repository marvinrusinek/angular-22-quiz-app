import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest
} from '@angular/common/http/testing';
import { ChangeDetectorRef, signal } from '@angular/core';
import { of, Subject } from 'rxjs';

import { ResultsComponent } from './results.component';
import { AccordionComponent } from './accordion/accordion.component';
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
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { ApiTopicQuizVerdictAdapter } from '@shared/services/features/verdict/api-verdict.adapter';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';

/**
 * Option A' end to end, against a deterministic clock and a fake server that
 * enforces the real contract (receipt bound to ONE question, reveal only once
 * that receipt's deadline has passed). No network, no Spring, no real timers.
 *
 * Scenario: a HTTP-style quiz whose FINAL question (Q10) is multiple-answer and
 * is left partially answered. Its answers are not in the Quiz Review when
 * Results opens; they must arrive by themselves at the signed deadline.
 */
const BASE = 'https://api.test/api';
const QUIZ = 'http';
const Q9 = 'Q9 single';
const Q10 = 'Q10 pick two';
const T0 = 1_700_000_000_000;

/** What the (fake) server knows. Never shipped to the client until authorized. */
const KEY: Record<string, { correct: string[]; explanation: string }> = {
  [Q9]: { correct: ['A9'], explanation: 'why-9' },
  [Q10]: { correct: ['A10', 'C10'], explanation: 'why-10' }
};

const url = (p: string) => `${BASE}/quizzes/${QUIZ}/${p}`;

function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  }) as T;
}

const question = (text: string, opts: string[], type: string): QuizQuestion =>
  ({
    questionText: text,
    type,
    options: opts.map((t, i) => ({ optionId: i + 1, text: t }))
  }) as unknown as QuizQuestion;

const QUESTIONS = [
  question(Q9, ['A9', 'B9', 'C9'], 'single'),
  question(Q10, ['A10', 'B10', 'C10'], 'multiple')
];

describe('Results — late Quiz Review reveal (Option A\')', () => {
  let http: HttpTestingController;
  let attempts: TopicQuizAttemptService;
  let verdicts: QuestionVerdictService;
  let quizService: any;
  let results: ResultsComponent;
  let attemptSeq = 0;
  let terminal: jest.Mock;

  /** The fake server's answer to a /check, following the real rules. */
  function serve(req: TestRequest): 'expired' | 'incomplete' | 'rejected' {
    const header = req.request.headers.get('X-Question-Receipt') ?? '';
    const [tag, quiz, text, expiresAt] = header.split('|');
    const asked = String(req.request.body?.questionText ?? '');
    if (tag !== 'rcpt' || quiz !== QUIZ || text !== asked || !KEY[asked]) {
      req.flush({}, { status: 401, statusText: 'Unauthorized' });
      return 'rejected';
    }
    if (Date.now() >= Number(expiresAt)) {
      req.flush({
        status: 'expired',
        correctOptionTexts: KEY[asked].correct,
        explanation: KEY[asked].explanation
      });
      return 'expired';
    }
    req.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 2 });
    return 'incomplete';
  }

  const checks = () => http.match((r) => r.url === url('check'));

  /** Issue a real receipt for `text` through the real service (deadline = now + 30 s). */
  function issueReceipt(text: string, quizId = QUIZ): void {
    attempts.startQuestion(quizId, text).subscribe();
    const attempt = http.match(`${BASE}/quizzes/${quizId}/attempts`);
    if (attempt.length > 0) attempt[0].flush({ attemptReceipt: `attempt-${++attemptSeq}` });
    const expiresAt = Date.now() + 30_000;
    http.expectOne(`${BASE}/quizzes/${quizId}/questions/start`).flush({
      questionReceipt: `rcpt|${quizId}|${text}|${expiresAt}`,
      startedAt: Date.now(),
      expiresAt
    });
  }

  /** The user's partial pick on Q10: one right option, so the server says incomplete. */
  function pickOneOnQ10(): void {
    verdicts.checkAnswer(QUIZ, Q10, ['A10']).subscribe();
    const [req] = checks();
    expect(serve(req)).toBe('incomplete');
  }

  const analysis = (): ScoreAnalysisItem[] => [
    {
      questionIndex: 0,
      questionText: Q9,
      wasCorrect: true,
      selectedOptionIds: ['1'],
      correctOptionIds: ['1'],
      selectedOptionTexts: ['A9'],
      correctOptionTexts: ['A9'],
      explanation: 'why-9'
    },
    {
      questionIndex: 1,
      questionText: Q10,
      wasCorrect: false,
      selectedOptionIds: ['1'],
      correctOptionIds: [], // never revealed in the quiz
      selectedOptionTexts: ['A10'],
      explanation: null
    }
  ];

  const snapshot = (): FinalResult => ({
    quizId: QUIZ,
    correct: 1,
    total: 2,
    percentage: 50,
    analysis: analysis(),
    completedAt: T0,
    completionTime: 40
  });

  /** Open Results exactly as the router does: real component, real services. */
  function openResults(): void {
    TestBed.flushEffects();
    results = TestBed.runInInjectionContext(() => new ResultsComponent());
    TestBed.flushEffects();
    results.ngOnInit();
    TestBed.flushEffects();
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    sessionStorage.clear();
    attemptSeq = 0;

    quizService = lenient({
      finalResult$: new Subject<FinalResult | null>(),
      quizId: QUIZ,
      totalQuestions: signal(2),
      correctAnswersCountSig: signal(1),
      getQuestionsInDisplayOrder: jest.fn().mockReturnValue(QUESTIONS),
      questionsSig: () => QUESTIONS,
      userAnswers: [],
      questions: [],
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      getFinalResultSnapshot: jest.fn().mockImplementation(() => snapshot()),
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
        { provide: QuizDotStatusService, useValue: lenient({}) },
        { provide: QuizService, useValue: quizService },
        { provide: QuizDataService, useValue: lenient({}) },
        { provide: QuizStateService, useValue: lenient({}) },
        {
          provide: SelectedOptionService,
          useValue: lenient({
            recoverAnswersForResults: jest.fn(),
            rawSelectionsMap: new Map([[1, [{ optionId: 1, text: 'A10' }]]]),
            selectedOptionsMap: new Map()
          })
        },
        {
          provide: TimerService,
          useValue: lenient({
            elapsedTimes: [4, 12],
            completionTime: 16,
            isCountdown: () => true,
            timePerQuestion: 30
          })
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
    attempts = TestBed.inject(TopicQuizAttemptService);
    verdicts = TestBed.inject(QuestionVerdictService);
    terminal = jest.fn();
    verdicts.terminalVerdicts$.subscribe(terminal);
  });

  afterEach(() => {
    jest.useRealTimers();
    sessionStorage.clear();
  });

  // The two rows the Accordion shows for question `i` (icon text removed).
  async function accordionRows(
    items: ScoreAnalysisItem[],
    fixture?: ComponentFixture<AccordionComponent>
  ): Promise<{ fixture: ComponentFixture<AccordionComponent>; correct: string; expl: string }> {
    const f = fixture ?? TestBed.createComponent(AccordionComponent);
    if (!fixture) f.componentRef.setInput('questions', QUESTIONS);
    f.componentRef.setInput('analysis', items);
    f.detectChanges();
    await Promise.resolve();
    f.detectChanges();
    if (!fixture) {
      for (const h of [...f.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[]) {
        h.click();
        f.detectChanges();
      }
    }
    const rows = [...f.nativeElement.querySelectorAll('#qr-body-1 .quiz-summary-text')].map((e) => {
      const c = (e as HTMLElement).cloneNode(true) as HTMLElement;
      c.querySelectorAll('i').forEach((i) => i.remove());
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    return { fixture: f, correct: rows[1], expl: rows[2] };
  }

  it('reveals Q10 by itself at the signed deadline, with nothing sent before it', async () => {
    issueReceipt(Q9);
    issueReceipt(Q10); // Q10 starts at T0
    jest.advanceTimersByTime(3_000);
    pickOneOnQ10(); // partial: server says incomplete, nothing revealed
    const verdictBefore = verdicts.verdictFor(QUIZ, Q10);
    expect(verdictBefore.phase).toBe('incomplete');
    const scoreBefore = { ...snapshot() };

    jest.advanceTimersByTime(2_000); // Results opens 5 s after Q10 started
    openResults();

    // 3. Initially unavailable — in the data and on screen.
    const q10 = () => results.scoreAnalysis()[1];
    expect(q10().explanation).toBeNull();
    expect(q10().correctOptionTexts ?? []).toEqual([]);
    let view = await accordionRows(results.scoreAnalysis());
    expect(view.correct).toBe('Correct Answers: (not available)');
    expect(view.expl).toBe('Explanation: (no explanation available)');

    // 4. Nothing is sent while the deadline is in the future (25 s left, then 0.1 s).
    jest.advanceTimersByTime(24_900);
    expect(checks()).toHaveLength(0);

    // 5. At / just after the deadline the authorized request goes out.
    jest.advanceTimersByTime(200);
    const sent = checks();
    expect(sent).toHaveLength(1); // Q10 only: Q9 already carries its reveal
    expect(sent[0].request.body).toEqual({ questionText: Q10, selectedOptionTexts: [] });
    expect(sent[0].request.headers.get('X-Question-Receipt')).toBe(
      `rcpt|${QUIZ}|${Q10}|${T0 + 30_000}`
    );

    // 6. The response carries the reveal.
    expect(serve(sent[0])).toBe('expired');
    expect(q10().correctOptionTexts).toEqual(['A10', 'C10']);
    expect(q10().explanation).toBe('why-10');

    // 7. Both accordion rows update on their own, no refresh, nothing re-mounted.
    view = await accordionRows(results.scoreAnalysis(), view.fixture);
    expect(view.correct).toBe('Correct Answers: Options 1 and 3 — A10, C10');
    expect(view.expl).toBe('Explanation: Options 1 and 3 were correct because why-10.');

    // 8. Score and verdict are untouched.
    expect(results.finalResult()?.correct).toBe(scoreBefore.correct);
    expect(results.finalResult()?.percentage).toBe(scoreBefore.percentage);
    expect(quizService.correctAnswersCountSig()).toBe(1);
    expect(results.scoreAnalysis()[1].wasCorrect).toBe(false);
    expect(verdicts.verdictFor(QUIZ, Q10)).toBe(verdictBefore);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
    expect(terminal).not.toHaveBeenCalled();

    // The reveal is not written to browser storage.
    expect(sessionStorage.getItem('finalResult') ?? '').not.toContain('why-10');
    http.verify();
  });

  it('a stale receipt from a previous attempt is never used after a restart', () => {
    issueReceipt(Q10); // previous attempt, expires at T0 + 30 s
    const staleHeader = `rcpt|${QUIZ}|${Q10}|${T0 + 30_000}`;
    jest.advanceTimersByTime(600_000); // ten minutes later: long expired

    attempts.clear(); // restart = new attempt (return.component / quiz-reset)
    issueReceipt(Q10); // fresh receipt, expires 30 s from NOW
    const freshHeader = `rcpt|${QUIZ}|${Q10}|${Date.now() + 30_000}`;
    jest.advanceTimersByTime(5_000);
    openResults();

    // The expired receipt would be revealable at once; it must not be consulted.
    jest.advanceTimersByTime(24_900);
    expect(checks()).toHaveLength(0);
    jest.advanceTimersByTime(200);
    const [req] = checks();
    expect(req.request.headers.get('X-Question-Receipt')).toBe(freshHeader);
    expect(req.request.headers.get('X-Question-Receipt')).not.toBe(staleHeader);
    expect(serve(req)).toBe('expired');
    expect(results.scoreAnalysis()[1].explanation).toBe('why-10');
  });

  it('a receipt from another quiz is never used for this quiz', () => {
    issueReceipt(Q10, 'other-quiz'); // same question text, different quiz
    openResults();
    jest.advanceTimersByTime(120_000);
    expect(checks()).toHaveLength(0);
    expect(results.scoreAnalysis()[1].explanation).toBeNull();
    http.verify();
  });

  it('no receipt for the question means no request and no reveal', () => {
    openResults();
    jest.advanceTimersByTime(120_000);
    expect(checks()).toHaveLength(0);
    expect(results.scoreAnalysis()[1].explanation).toBeNull();
    http.verify();
  });

  it('shows nothing when the SERVER still says incomplete (client clock early)', async () => {
    issueReceipt(Q10);
    // The server's clock is behind: the receipt it signed is 10 s further out.
    openResults();
    jest.advanceTimersByTime(30_100);
    const [req] = checks();
    // Re-answer as a server whose deadline has not passed yet.
    const lateHeader = `rcpt|${QUIZ}|${Q10}|${Date.now() + 10_000}`;
    const spoofed = {
      ...req,
      request: { ...req.request, headers: { get: () => lateHeader }, body: req.request.body },
      flush: req.flush.bind(req)
    } as unknown as TestRequest;
    expect(serve(spoofed)).toBe('incomplete');

    const item = results.scoreAnalysis()[1];
    expect(item.explanation).toBeNull();
    expect(item.correctOptionTexts ?? []).toEqual([]);
    const view = await accordionRows(results.scoreAnalysis());
    expect(view.correct).toBe('Correct Answers: (not available)');
    expect(view.expl).toBe('Explanation: (no explanation available)');
  });

  it('each request carries its own question\'s receipt, never another\'s', () => {
    // Both questions unrevealed and holding receipts.
    quizService.getFinalResultSnapshot.mockImplementation(() => ({
      ...snapshot(),
      analysis: analysis().map((a) => ({
        ...a, correctOptionTexts: [], explanation: null
      }))
    }));
    issueReceipt(Q9);
    issueReceipt(Q10);
    openResults();
    jest.advanceTimersByTime(30_200);

    const sent = checks();
    expect(sent).toHaveLength(2);
    for (const req of sent) {
      const asked = req.request.body.questionText as string;
      expect(req.request.headers.get('X-Question-Receipt')).toContain(`|${asked}|`);
      expect(serve(req)).toBe('expired');
    }
    const byText = Object.fromEntries(
      results.scoreAnalysis().map((a) => [a.questionText, a])
    );
    expect(byText[Q9].explanation).toBe('why-9');
    expect(byText[Q10].explanation).toBe('why-10');
    expect(byText[Q9].correctOptionTexts).toEqual(['A9']);
    expect(byText[Q10].correctOptionTexts).toEqual(['A10', 'C10']);
  });
});
