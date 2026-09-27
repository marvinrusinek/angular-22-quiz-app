import { NgClass } from '@angular/common';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatTooltipModule } from '@angular/material/tooltip';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { NEVER, Observable, of, Subject } from 'rxjs';

import { QuizService } from '@shared/services/data/quiz.service';
import { QuizSetupService } from '@shared/services/flow/quiz-setup.service';
import { SelectionMessageService } from '@shared/services/features/selection-message/selection-message.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import type { QuestionCheckResult } from '@shared/services/features/verdict/question-verdict.types';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';
import { NextButtonStateService } from '@shared/services/state/next-button-state.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { CURRENT_CHECK_FAILED_MESSAGE } from '@shared/utils/verdict-notice';

import { VerdictNoticeComponent } from '../../components/verdict-notice/verdict-notice.component';
import { QuizComponent } from './quiz.component';

/**
 * QuizComponent × failed answer check.
 *
 * The real QuizComponent (its real template, gating getters and `verdictNotice`
 * computed) is mounted with the REAL QuestionVerdictService and
 * SelectedOptionService; only the network adapter and the heavy child
 * components / orchestration services are stubbed. That makes the notice, the
 * Retry action and the Results gate behave exactly as they do in the app, while
 * each `/check` outcome stays under the test's control.
 */

const QUIZ = 'rxjs';
const QUESTION = 'Which operator maps values?';
const OPTIONS = [
  { optionId: 1, text: 'map', correct: undefined },
  { optionId: 2, text: 'filter', correct: undefined }
];
/** A second, MULTI-answer question, addressed by text only (never rendered via
 *  combinedQuestionData in these tests, which drive the verdict service directly). */
const MULTI_QUESTION = 'Select every operator that maps values';
const QUESTIONS = [{ questionText: QUESTION }, { questionText: MULTI_QUESTION }];

const RESOLVED_CORRECT = {
  status: 'resolved', correct: true, correctOptionTexts: ['map'], explanation: 'e'
} as QuestionCheckResult;
const RESOLVED_INCORRECT = {
  status: 'resolved', correct: false, correctOptionTexts: ['map'], explanation: 'e'
} as QuestionCheckResult;
const RESOLVED_CORRECT_MULTI = {
  status: 'resolved', correct: true, correctOptionTexts: ['map', 'switchMap'], explanation: 'e'
} as QuestionCheckResult;
const INCOMPLETE_MULTI = {
  status: 'incomplete', selectedVerdicts: [{ text: 'map', correct: true }], remainingCorrectCount: 1
} as QuestionCheckResult;

/** Anything not explicitly stubbed becomes a harmless no-op function. */
function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  });
}

interface Ch { texts: readonly string[]; subject: Subject<QuestionCheckResult>; unsubscribed: boolean }
let checks: Ch[];
let expiries: Ch[];
let fixture: ComponentFixture<QuizComponent>;
let component: QuizComponent;
let verdicts: QuestionVerdictService;
let selected: SelectedOptionService;
let timer: TimerService;
let retrySpy: jest.SpyInstance;

/** A controllable Observable-returning channel, shared by check() and revealExpired(). */
function channel(sink: Ch[]) {
  return (texts: readonly string[] = []): Observable<QuestionCheckResult> =>
    new Observable<QuestionCheckResult>((subscriber) => {
      const entry: Ch = { texts, subject: new Subject<QuestionCheckResult>(), unsubscribed: false };
      sink.push(entry);
      const inner = entry.subject.subscribe(subscriber);
      return () => { entry.unsubscribed = true; inner.unsubscribe(); };
    });
}

async function mountQuiz(): Promise<void> {
  jest.useFakeTimers();
  const perf = performance as unknown as { getEntriesByType?: () => unknown[] };
  perf.getEntriesByType ??= () => [];
  checks = [];
  expiries = [];
  sessionStorage.clear();
  localStorage.clear();

  const adapter = {
    check: (_quiz: string, _q: string, texts: readonly string[]) => channel(checks)(texts),
    revealExpired: (_quiz: string, _q: string) => channel(expiries)([])
  };

  // Both of these track the CURRENT test's totalQuestions() rather than the
  // full fixture array's length: the shared fixture holds a single-answer AND
  // a multi-answer question so every describe block can reuse it, but
  // `shouldShowResultsButton`'s "is this the last question" check reads
  // `quizService.questions.length` directly, and would otherwise see 2
  // questions even in a test that set totalQuestions(1).
  const visibleQuestions = () => QUESTIONS.slice(0, component?.totalQuestions() || QUESTIONS.length);
  const quizService = {
    quizId: QUIZ,
    get questions() { return visibleQuestions(); },
    shuffledQuestions: [],
    questionsSig: signal(QUESTIONS),
    questions$: NEVER,
    quizReset$: NEVER,
    currentQuestionIndex$: NEVER,
    getQuestionsInDisplayOrder: () => visibleQuestions(),
    isShuffleEnabled: () => false,
    getCurrentQuizId: () => QUIZ,
    // Mirrors whatever the component's own currentQuestionIndex signal is set
    // to — the keyboard handler (quiz-setup.service.ts) reads THIS, not the
    // component signal, so the two must agree in every test.
    getCurrentQuestionIndex: () => component.currentQuestionIndex(),
    // Read by the (non-current) dot rendering path — a real Map, not the
    // lenient proxy's jest.fn() stand-in, which has no `.get`.
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
      { provide: QuizService, useValue: lenient(quizService) },
      // Orchestration is not under test: the component is driven directly.
      {
        provide: QuizSetupService,
        useValue: {
          wireConstructor: jest.fn(),
          runOnInit: jest.fn(async () => undefined),
          runAfterViewInit: jest.fn(async () => undefined),
          runOnDestroy: jest.fn(),
          runOnGlobalKey: jest.fn(async () => undefined),
          advanceQuestion: jest.fn(async () => undefined)
        }
      },
      // A completed last question, so the Results button WOULD show if unblocked.
      {
        provide: SelectionMessageService,
        useValue: lenient({
          selectionMessageSig: signal(''),
          isCompletedInSession: () => true
        })
      }
    ]
  });

  // Only the notice is real; the heavy children are inert.
  TestBed.overrideComponent(QuizComponent, {
    set: { imports: [NgClass, MatTooltipModule, VerdictNoticeComponent], schemas: [NO_ERRORS_SCHEMA] }
  });

  fixture = TestBed.createComponent(QuizComponent);
  component = fixture.componentInstance;
  verdicts = TestBed.inject(QuestionVerdictService);
  selected = TestBed.inject(SelectedOptionService);
  timer = TestBed.inject(TimerService);
  retrySpy = jest.spyOn(selected, 'retryVerdict');

  // A one-question quiz, on its (last) question, with the question rendered.
  component.totalQuestions.set(1);
  component.isQuizDataLoaded.set(true);
  component.currentQuestionIndex.set(0);
  component.combinedQuestionData.set({
    question: { questionText: QUESTION, options: OPTIONS },
    options: OPTIONS,
    explanation: ''
  } as never);
  fixture.detectChanges();
}

const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
const notice = (): HTMLElement | null => host().querySelector('.verdict-notice');
const retryButton = (): HTMLButtonElement | null => host().querySelector('.verdict-notice__retry');
const resultsButton = (): HTMLElement | null => host().querySelector('.show-results-btn');
const nextButton = (): HTMLButtonElement | null =>
  host().querySelector('.nav-btn[aria-label="Next Question"]');
const phase = (q = QUESTION): string => verdicts.verdictFor(QUIZ, q).phase;

/** The user picks an option; the first `/check` is now outstanding. */
function pick(texts: string[] = ['map'], q = QUESTION): void {
  verdicts.checkAnswer(QUIZ, q, texts).subscribe({ error: () => undefined });
}
function failCheck(index: number): void {
  checks[index]!.subject.error(new Error('network'));
  fixture.detectChanges();
}
function resolve(index: number, result: QuestionCheckResult): void {
  checks[index]!.subject.next(result);
  fixture.detectChanges();
}
/** Timer expiry, exactly as the real timer-effect service does it: no /check
 *  or /reveal round trip is required for progression to unblock. */
function expireCurrentQuestion(): void {
  timer.expiredForQuestionIndexSig.set(component.currentQuestionIndex());
  fixture.detectChanges();
}

beforeEach(mountQuiz);
afterEach(() => {
  jest.useRealTimers();
  fixture?.destroy();
});

describe('QuizComponent — failed answer check', () => {
  it('shows no notice while nothing has failed', () => {
    expect(notice()).toBeNull();
    pick();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(notice()).toBeNull();                        // pending is not a failure
  });

  it('renders the notice as an accessible alert with the retry message when the check fails', () => {
    pick();
    failCheck(0);

    expect(phase()).toBe('error');
    const alert = host().querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.classList.contains('verdict-notice')).toBe(true);
    expect(alert!.textContent).toContain(CURRENT_CHECK_FAILED_MESSAGE);
  });

  it('offers a keyboard-accessible Retry: a native, focusable, enabled button', () => {
    pick();
    failCheck(0);

    const button = retryButton()!;
    expect(button).not.toBeNull();
    expect(button.tagName).toBe('BUTTON');              // native: Enter and Space activate it
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);  // in the tab order
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('keeps Results unavailable while the check is failed or pending, and shows it once verified', () => {
    // (Idle — no selection yet — correctly blocks too; see the dedicated
    // final-question submission-policy suite below for that case.)
    pick();
    fixture.detectChanges();
    expect(resultsButton()).toBeNull();                 // checking

    failCheck(0);
    expect(resultsButton()).toBeNull();                 // error

    retryButton()!.click();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(resultsButton()).toBeNull();                 // retry pending

    checks[1]!.subject.next(RESOLVED_CORRECT);
    fixture.detectChanges();
    expect(phase()).toBe('resolved');
    expect(resultsButton()).not.toBeNull();             // verified: available
  });

  it('clicking Retry invokes retryVerdict() exactly once, with the current question, and resends the same selection', () => {
    pick();
    failCheck(0);

    retryButton()!.click();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(0);
    expect(checks).toHaveLength(2);
    expect(checks[1]!.texts).toEqual(['map']);          // the unchanged selection
  });

  it('rapid repeated activation cannot create duplicate requests', () => {
    pick();
    failCheck(0);

    const button = retryButton()!;
    button.click();
    button.click();
    button.click();
    fixture.detectChanges();

    expect(checks).toHaveLength(2);                     // the original + exactly ONE retry
    expect(notice()).toBeNull();                        // now pending: nothing to retry
  });

  it('removes the notice after a successful retry', () => {
    pick();
    failCheck(0);
    expect(notice()).not.toBeNull();

    retryButton()!.click();
    checks[1]!.subject.next(RESOLVED_CORRECT);
    fixture.detectChanges();

    expect(phase()).toBe('resolved');
    expect(notice()).toBeNull();
  });

  it('a failed retry brings the notice straight back, still retryable', () => {
    pick();
    failCheck(0);
    retryButton()!.click();
    failCheck(1);

    expect(phase()).toBe('error');
    expect(retryButton()).not.toBeNull();
    expect(resultsButton()).toBeNull();
  });
});

/**
 * THE PROGRESSION GATE — Next, keyboard, forward-dot, and Results must all
 * agree, and must all read the SAME backend verdict, never `option.correct`
 * (both fixtures above set every option's `correct` to `undefined`, exactly
 * matching the live API shape).
 */
describe('QuizComponent — progression gate (single-answer)', () => {
  // A two-question quiz, on the FIRST (single-answer) question.
  beforeEach(() => {
    component.totalQuestions.set(2);
    component.currentQuestionIndex.set(0);
    TestBed.inject(NextButtonStateService).isButtonEnabled.set(true);   // what an option click does
    fixture.detectChanges();
  });

  const advance = (): jest.Mock => TestBed.inject(QuizSetupService).advanceQuestion as unknown as jest.Mock;
  const laterDotClickable = (): boolean => component.isDotClickable(1);   // a FORWARD jump

  it('1. selection alone (before the check is even dispatched) does not enable Next', () => {
    // isButtonEnabled was already forced true above, exactly as a real click
    // does; nothing has been checked yet, so the verdict is still idle.
    expect(phase()).toBe('idle');
    expect(nextButton()!.disabled).toBe(true);
  });

  it('2. Next remains disabled during `checking`', () => {
    pick();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(nextButton()!.disabled).toBe(true);
  });

  it('3. clicking Next during `checking` is a no-op', async () => {
    pick();
    fixture.detectChanges();
    await component.advanceToNextQuestion();
    expect(advance()).not.toHaveBeenCalled();
  });

  it('4. ArrowRight/Enter during `checking` is a no-op (the keyboard path shares the same gate)', () => {
    pick();
    fixture.detectChanges();
    // The keyboard handler's OWN guard (`!host.nextButtonEnabled()`) is exactly
    // what my fix drives; assert the shared signal it reads, directly.
    expect(component.nextButtonEnabled()).toBe(false);
  });

  it('5. a forward paginator dot cannot bypass `checking`', () => {
    pick();
    fixture.detectChanges();
    expect(laterDotClickable()).toBe(false);
  });

  it('6. resolved INCORRECT remains blocked — the user must try again', () => {
    pick();
    resolve(0, RESOLVED_INCORRECT);
    expect(phase()).toBe('resolved');
    expect(nextButton()!.disabled).toBe(true);
    expect(laterDotClickable()).toBe(false);
  });

  it('7. resolved CORRECT enables Next (and the forward dot, and the keyboard path)', () => {
    pick();
    resolve(0, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);
    expect(laterDotClickable()).toBe(true);
    expect(component.nextButtonEnabled()).toBe(true);
  });

  it('8. `error` remains blocked and shows Retry', () => {
    pick();
    failCheck(0);
    expect(nextButton()!.disabled).toBe(true);
    expect(retryButton()).not.toBeNull();
  });

  it('9. retry pending remains blocked', () => {
    pick();
    failCheck(0);
    retryButton()!.click();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(nextButton()!.disabled).toBe(true);
  });

  it('10. retry resolved INCORRECT remains blocked', () => {
    pick();
    failCheck(0);
    retryButton()!.click();
    resolve(1, RESOLVED_INCORRECT);
    expect(nextButton()!.disabled).toBe(true);
  });

  it('11. retry resolved CORRECT enables progression', async () => {
    pick();
    failCheck(0);
    retryButton()!.click();
    resolve(1, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);
    await component.advanceToNextQuestion();
    expect(advance()).toHaveBeenCalledWith(component, 'next');
  });

  it('12. expiry enables progression through the established expiry path, even before/without the reveal resolving', () => {
    // Nothing was ever answered (still idle) — the reveal request has not
    // even been dispatched — yet the established expiry policy still unblocks.
    expect(phase()).toBe('idle');
    expireCurrentQuestion();
    expect(nextButton()!.disabled).toBe(false);
    expect(laterDotClickable()).toBe(true);
  });

  it('22. button, direct method, keyboard signal, and forward-dot all agree, in both directions', async () => {
    pick();
    fixture.detectChanges();
    expect(nextButton()!.disabled).toBe(true);
    expect(component.nextButtonEnabled()).toBe(false);
    expect(laterDotClickable()).toBe(false);
    await component.advanceToNextQuestion();
    expect(advance()).not.toHaveBeenCalled();

    resolve(0, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);
    expect(component.nextButtonEnabled()).toBe(true);
    expect(laterDotClickable()).toBe(true);
    await component.advanceToNextQuestion();
    expect(advance()).toHaveBeenCalledWith(component, 'next');
  });

  it('24. a late, STALE response cannot reopen a verdict a newer one already resolved', () => {
    // Two overlapping submissions for the same question (e.g. a fast
    // re-pick); the NEWER one resolves correct first, then the OLDER one
    // fails — the generation guard in QuestionVerdictService must drop it.
    pick(['map']);
    pick(['filter']);
    resolve(1, RESOLVED_CORRECT);
    expect(nextButton()!.disabled).toBe(false);

    failCheck(0);   // the stale, superseded request fails LAST
    expect(phase()).toBe('resolved');       // unchanged — the stale failure was dropped
    expect(nextButton()!.disabled).toBe(false);   // NOT reopened
  });
});

describe('QuizComponent — progression gate (multi-answer)', () => {
  // The SECOND question in the fixture is multi-answer, and NOT the last
  // question (totalQuestions=3), so Next actually renders (shouldShowNextButton
  // is false on the last question of the quiz — that path is Results, covered
  // separately below).
  beforeEach(() => {
    component.totalQuestions.set(3);
    component.currentQuestionIndex.set(1);
    TestBed.inject(NextButtonStateService).isButtonEnabled.set(true);   // "any selection" — the existing click-time policy
    fixture.detectChanges();
  });

  const pickMulti = (texts: string[]) => pick(texts, MULTI_QUESTION);

  it('13. a PARTIAL selection remains blocked', () => {
    pickMulti(['map']);
    resolve(0, INCOMPLETE_MULTI);
    expect(phase(MULTI_QUESTION)).toBe('incomplete');
    expect(nextButton()!.disabled).toBe(true);
  });

  it('14. pending verification remains blocked', () => {
    pickMulti(['map', 'switchMap']);
    fixture.detectChanges();
    expect(phase(MULTI_QUESTION)).toBe('checking');
    expect(nextButton()!.disabled).toBe(true);
  });

  it('15. resolved incorrect / incomplete selection remains blocked', () => {
    pickMulti(['map', 'filter']);            // one correct, one wrong extra — still not the exact set
    resolve(0, INCOMPLETE_MULTI);
    expect(nextButton()!.disabled).toBe(true);

    pickMulti(['map', 'switchMap', 'filter']);
    resolve(1, RESOLVED_INCORRECT);
    expect(nextButton()!.disabled).toBe(true);
  });

  it('16. the complete resolved-correct answer enables progression', () => {
    pickMulti(['map', 'switchMap']);
    resolve(0, RESOLVED_CORRECT_MULTI);
    expect(nextButton()!.disabled).toBe(false);
    expect(component.isDotClickable(2)).toBe(true);   // a further forward index, now unblocked
  });

  it('17. retry uses the UNCHANGED selected set and follows the same gate', () => {
    pickMulti(['map', 'switchMap']);
    failCheck(0);
    expect(nextButton()!.disabled).toBe(true);

    selected.retryVerdict(1);   // display index 1 — this question
    expect(checks[1]!.texts).toEqual(['map', 'switchMap']);
    expect(nextButton()!.disabled).toBe(true);      // pending again

    resolve(1, RESOLVED_CORRECT_MULTI);
    expect(nextButton()!.disabled).toBe(false);
  });
});

/**
 * THE FINAL QUESTION'S SUBMISSION POLICY — deliberately DIFFERENT from
 * intermediate progression. "Show Results only after at least one option has
 * been selected": correctness is NOT required, so a resolved-incorrect or a
 * completed partial (`incomplete`) multi-answer response both allow it, as
 * long as the user made a selection and the backend has actually responded.
 * This fixture's `isCompletedInSession()` stub is always true (see mountQuiz)
 * — deliberately, to prove `hasBlockingVerdicts()` (which now embeds this
 * policy) is the layer actually enforcing "no selection" / "still pending",
 * not a coincidence of that legacy per-session flag.
 */
describe('QuizComponent — final question submission policy (Results)', () => {
  it('13. no selection does not show or enable Results', () => {
    expect(phase()).toBe('idle');
    expect(resultsButton()).toBeNull();
  });

  it('14. a selection with a PENDING check blocks Results', () => {
    pick();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(resultsButton()).toBeNull();
  });

  it('15. error and retry-pending both block Results', () => {
    pick();
    failCheck(0);
    expect(resultsButton()).toBeNull();

    retryButton()!.click();
    fixture.detectChanges();
    expect(phase()).toBe('checking');
    expect(resultsButton()).toBeNull();
  });

  it('16. resolved CORRECT with a selection allows Results', () => {
    pick();
    resolve(0, RESOLVED_CORRECT);
    expect(resultsButton()).not.toBeNull();
  });

  it('17. resolved INCORRECT with a selection allows Results — correctness is NOT required on the final question', () => {
    pick();
    resolve(0, RESOLVED_INCORRECT);
    expect(resultsButton()).not.toBeNull();
  });

  it('18. a completed INCOMPLETE (partial multi-answer) response with a selection allows Results', () => {
    // `incomplete` is a COMPLETED backend response (not a pending one — see
    // canSubmitFinalQuestion's doc comment), so on the final question it
    // follows the same "selection + backend responded" policy as `resolved`.
    pick(['map']);
    resolve(0, { status: 'incomplete', selectedVerdicts: [{ text: 'map', correct: true }], remainingCorrectCount: 1 } as QuestionCheckResult);
    expect(phase()).toBe('incomplete');
    expect(resultsButton()).not.toBeNull();
  });

  it('18b. a completed INCOMPLETE response with NO current selection (deselected to empty) still blocks — "no selection" wins', () => {
    pick([]);
    resolve(0, { status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 2 } as QuestionCheckResult);
    expect(phase()).toBe('incomplete');
    expect(resultsButton()).toBeNull();
  });

  it('19. expiry allows Results through the approved path, even with no selection and no completed response', () => {
    expect(phase()).toBe('idle');
    expireCurrentQuestion();
    expect(resultsButton()).not.toBeNull();
  });

  it('20. Results reads only the backend verdict — no client-side correctness is inferred', () => {
    // OPTIONS carries `correct: undefined` throughout this file, matching the
    // live API shape; Results only ever becomes available here because a
    // `checkAnswer`/`resolve()` call supplied an explicit backend result.
    expect(OPTIONS.every((o) => o.correct === undefined)).toBe(true);
    pick();
    resolve(0, RESOLVED_INCORRECT);
    expect(resultsButton()).not.toBeNull();
  });
});
