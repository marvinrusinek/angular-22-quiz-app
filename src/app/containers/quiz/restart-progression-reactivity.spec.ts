import { NgClass } from '@angular/common';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatTooltipModule } from '@angular/material/tooltip';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { NEVER, Observable, Subject } from 'rxjs';

import { QuizService } from '@shared/services/data/quiz.service';
import { QuizSetupService } from '@shared/services/flow/quiz-setup.service';
import { SelectionMessageService } from '@shared/services/features/selection-message/selection-message.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import type { QuestionCheckResult } from '@shared/services/features/verdict/question-verdict.types';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';
import { NextButtonStateService } from '@shared/services/state/next-button-state.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';

import { VerdictNoticeComponent } from '../../components/verdict-notice/verdict-notice.component';
import { QuizComponent } from './quiz.component';

/**
 * RESTART REGRESSION — root cause and fix, live-reproduced 2026-09-27.
 *
 * `currentVerdictState` reads `quizService.quizId` and
 * `getQuestionsInDisplayOrder()` as PLAIN (non-reactive) property/method
 * access, and early-returns `null` (via `verdictStateForDisplayIndex`) when
 * either is momentarily unavailable. A computed's dependency set is only what
 * it read on its LAST evaluation — so if that early return fires on the
 * FIRST evaluation, `QuestionVerdictService`'s `_states` signal is never read
 * at all, and no LATER change to it (a real click resolving correctly) can
 * ever invalidate the memo again. `quizId` reads empty for a brief window
 * right after "Results → Restart Quiz" while the route/session settles
 * (`return.component.ts#restartQuiz`), which reliably triggered exactly this:
 * Next stayed permanently disabled on the restarted run's first question,
 * live-reproduced via a temporary window-log probe before the fix, and
 * confirmed cleared after it (this file pins that fix).
 *
 * The fix reads `verdicts.states()` FIRST, unconditionally, so the computed's
 * dependency set always includes it regardless of which branch runs after.
 */

const QUIZ = 'thingamajigs';
const Q1 = "Which thingamajig setting controls unit 1's speed?";
const OPTIONS = [
  { optionId: 1, text: 'low-power mode', correct: undefined },
  { optionId: 2, text: 'turbo mode', correct: undefined }
];
const RESOLVED_CORRECT: QuestionCheckResult = {
  status: 'resolved', correct: true, correctOptionTexts: ['low-power mode'], explanation: 'e'
} as QuestionCheckResult;
const RESOLVED_INCORRECT: QuestionCheckResult = {
  status: 'resolved', correct: false, correctOptionTexts: ['low-power mode'], explanation: 'e'
} as QuestionCheckResult;

interface Ch { texts: readonly string[]; subject: Subject<QuestionCheckResult> }
let checks: Ch[];
let fixture: ComponentFixture<QuizComponent>;
let component: QuizComponent;
let verdicts: QuestionVerdictService;
let timer: TimerService;
/** Mutable so a test can simulate the transient "quizId not yet settled" window. */
let quizIdRef: { value: string };

function channel(texts: readonly string[] = []): Observable<QuestionCheckResult> {
  return new Observable<QuestionCheckResult>((subscriber) => {
    const entry: Ch = { texts, subject: new Subject<QuestionCheckResult>() };
    checks.push(entry);
    return entry.subject.subscribe(subscriber);
  });
}

async function mount(): Promise<void> {
  const perf = performance as unknown as { getEntriesByType?: () => unknown[] };
  perf.getEntriesByType ??= () => [];
  checks = [];
  sessionStorage.clear();
  localStorage.clear();
  quizIdRef = { value: QUIZ };

  const adapter = { check: () => channel(), revealExpired: () => channel() };
  const quizService = {
    get quizId() { return quizIdRef.value; },
    questions: [{ questionText: Q1 }],
    shuffledQuestions: [],
    questionsSig: signal([{ questionText: Q1 }]),
    questions$: NEVER,
    quizReset$: NEVER,
    currentQuestionIndex$: NEVER,
    getQuestionsInDisplayOrder: () => (quizIdRef.value ? [{ questionText: Q1 }] : []),
    isShuffleEnabled: () => false,
    getCurrentQuizId: () => quizIdRef.value,
    getCurrentQuestionIndex: () => 0,
    questionCorrectness: new Map<string, boolean>(),
    selectedOptionsMap: new Map<number, unknown[]>(),
    scoringService: { creditResolvedQuestion: jest.fn() }
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter([]),
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: adapter },
      { provide: QuizService, useValue: quizService },
      {
        provide: QuizSetupService,
        useValue: {
          wireConstructor: jest.fn(), runOnInit: jest.fn(async () => undefined),
          runAfterViewInit: jest.fn(async () => undefined), runOnDestroy: jest.fn(),
          runOnGlobalKey: jest.fn(async () => undefined), advanceQuestion: jest.fn(async () => undefined)
        }
      },
      { provide: SelectionMessageService, useValue: { selectionMessageSig: signal(''), isCompletedInSession: () => false } }
    ]
  });
  TestBed.overrideComponent(QuizComponent, {
    set: { imports: [NgClass, MatTooltipModule, VerdictNoticeComponent], schemas: [NO_ERRORS_SCHEMA] }
  });

  fixture = TestBed.createComponent(QuizComponent);
  component = fixture.componentInstance;
  verdicts = TestBed.inject(QuestionVerdictService);
  timer = TestBed.inject(TimerService);

  component.totalQuestions.set(2);
  component.isQuizDataLoaded.set(true);
  component.currentQuestionIndex.set(0);
  component.combinedQuestionData.set({ question: { questionText: Q1, options: OPTIONS }, options: OPTIONS, explanation: '' } as never);
  TestBed.inject(NextButtonStateService).isButtonEnabled.set(true);
  fixture.detectChanges();
}

const nextButton = (): HTMLButtonElement | null =>
  (fixture.nativeElement as HTMLElement).querySelector('.nav-btn[aria-label="Next Question"]');
function pick(): void { verdicts.checkAnswer(QUIZ, Q1, ['low-power mode']).subscribe({ error: () => undefined }); }
function resolve(i: number, r: QuestionCheckResult): void { checks[i]!.subject.next(r); fixture.detectChanges(); }

beforeEach(mount);
afterEach(() => fixture?.destroy());

describe('Restart: the progression gate keeps reacting after a transient quizId-empty window', () => {
  it('1 & 5. a completed quiz reaches Results, and after Restart a resolved-correct pick enables Next', () => {
    // First "run": answer correctly, confirm Next enabled (a completed quiz
    // legitimately reaches Results via this same, already-proven path).
    pick();
    resolve(0, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);

    // 2. Restart clears the prior run's verdict/progression state.
    verdicts.clearAll();
    verdicts.clearEarnedVerdicts(QUIZ);

    // Simulate the restart's transient window: quizId (and therefore the
    // question list) reads empty for one render — exactly what
    // return.component.ts's restartQuiz() produces before the route settles.
    quizIdRef.value = '';
    fixture.detectChanges();       // forces the FIRST post-clear evaluation
    quizIdRef.value = QUIZ;        // settles, as it does moments later in the app
    fixture.detectChanges();

    // 3. Question 1 begins blocked before any selection in the new run.
    expect(nextButton()!.disabled).toBe(true);

    // 5. Resolved correct enables Next in the RESTARTED run — this is the
    // exact assertion that used to hang forever pre-fix.
    pick();
    resolve(1, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);
  });

  it('4. a pending verdict in the restarted run remains blocked', () => {
    pick(); resolve(0, RESOLVED_CORRECT);
    verdicts.clearAll(); verdicts.clearEarnedVerdicts(QUIZ);
    quizIdRef.value = ''; fixture.detectChanges(); quizIdRef.value = QUIZ; fixture.detectChanges();

    pick();
    fixture.detectChanges();
    expect(nextButton()!.disabled).toBe(true);
  });

  it('6. resolved incorrect in the restarted run remains blocked', () => {
    pick(); resolve(0, RESOLVED_CORRECT);
    verdicts.clearAll(); verdicts.clearEarnedVerdicts(QUIZ);
    quizIdRef.value = ''; fixture.detectChanges(); quizIdRef.value = QUIZ; fixture.detectChanges();

    pick();
    resolve(1, RESOLVED_INCORRECT);
    expect(nextButton()!.disabled).toBe(true);
  });

  it('7. timer state belongs to the new run — an expiry flag from the OLD run does not leak in, and a fresh one still unblocks', () => {
    timer.expiredForQuestionIndexSig.set(0);   // stale from the completed run
    verdicts.clearAll(); verdicts.clearEarnedVerdicts(QUIZ);
    timer.expiredForQuestionIndexSig.set(-1);  // what beginNewRun() does on restart
    quizIdRef.value = ''; fixture.detectChanges(); quizIdRef.value = QUIZ; fixture.detectChanges();

    expect(nextButton()!.disabled).toBe(true);  // the stale expiry must not carry over

    timer.expiredForQuestionIndexSig.set(0);    // a genuine expiry in the NEW run
    fixture.detectChanges();
    expect(nextButton()!.disabled).toBe(false);
  });

  it('8. a SECOND restart also behaves correctly (not a one-shot fix)', () => {
    for (let run = 0; run < 2; run++) {
      pick();
      resolve(checks.length - 1, RESOLVED_CORRECT);
      expect(nextButton()!.disabled).toBe(false);

      verdicts.clearAll();
      verdicts.clearEarnedVerdicts(QUIZ);
      quizIdRef.value = '';
      fixture.detectChanges();
      quizIdRef.value = QUIZ;
      fixture.detectChanges();
      expect(nextButton()!.disabled).toBe(true);
    }
  });

  it('9. no previous-run verdict leaks into the new run\'s question identity', () => {
    pick();
    resolve(0, RESOLVED_INCORRECT);   // old run: Q1 answered WRONG
    verdicts.clearAll();
    verdicts.clearEarnedVerdicts(QUIZ);
    quizIdRef.value = ''; fixture.detectChanges(); quizIdRef.value = QUIZ; fixture.detectChanges();

    // The new run's Q1 must read as genuinely unanswered, not carry the old
    // run's resolved-incorrect verdict forward.
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('idle');
    expect(nextButton()!.disabled).toBe(true);
  });
});
