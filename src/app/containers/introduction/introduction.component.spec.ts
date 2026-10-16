import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { firstValueFrom, of, ReplaySubject, Subject } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconRegistry } from '@angular/material/icon';

import { IntroductionComponent } from './introduction.component';
import { QUESTION_COUNT_ICON } from './question-count-icon';
import { Quiz, QuizDifficulty, QuizQuestion } from '@shared/models';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizDataService } from '@shared/services/data/quizdata.service';
import { QuizNavigationService } from '@shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '@shared/services/state/quiz-persistence.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizShuffleService } from '@shared/services/flow/quiz-shuffle.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { QuizStartSpinnerService } from '@shared/services/ui/quiz-start-spinner.service';

/**
 * Stage 14 regression A: after Introduction moved to API-backed metadata
 * (13123098 "remove introduction bank dependency"), the "Test your wits with
 * N questions" paragraph kept reading `quiz.questions?.length ?? 0` — but
 * `buildQuizFromMetadata()` never sets `questions` at all, so that expression
 * is unconditionally 0 regardless of the real, correctly-loaded count already
 * sitting in `questionCountSig()` (used correctly by the meta row above it).
 * No spec previously rendered this component's template, so the mismatch
 * between the two paragraphs went uncaught.
 */
describe('IntroductionComponent — API-backed question count (Stage 14 regression A)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();
  const summaryMap = new Map<string, string>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'typescript' }])),
    questionCountByQuiz: signal(questionCountMap),
    milestoneByQuiz: signal(milestoneMap),
    difficultyByQuiz: signal(difficultyMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    summaryByQuiz: signal(summaryMap),
    milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? [],
    summaryFor: (id: string) => summaryMap.get(id) ?? ''
  });

  function configureTestBed(): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the REAL API question count in the "Test your wits" paragraph, not 0', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Test your wits with');
    expect(text).toMatch(/Test your wits with\s*10\s*timed multiple-choice/);
    expect(text).not.toMatch(/Test your wits with\s*0\s*timed multiple-choice/);
  });

  it('the meta row and the intro paragraph agree on the same count', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component.questionCountSig()).toBe(10);

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toMatch(/10\s*Questions/);
  });

  it('never reads quiz.questions?.length — buildQuizFromMetadata never sets it', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.questions).toBeUndefined();
  });

  /**
   * Regression: buildQuizFromMetadata hardcoded `summary: ''` since
   * 13123098 ("remove introduction bank dependency"), even though
   * TopicQuizMetadataService.summaryFor() carries the real per-quiz summary
   * (same catalog data already used for Quiz Selection tiles) and the
   * template's very first body paragraph
   * (`<strong class="bold-text">{{ quiz.summary }}</strong>`) has always
   * rendered it — so that paragraph was silently empty for every quiz, with
   * no text for sighted users to see or an AT to read.
   */
  it('renders the real API summary in the opening bolded paragraph, not blank', () => {
    summaryMap.set('typescript', 'TypeScript makes it easier to read and debug JavaScript code.');
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.summary).toBe(
      'TypeScript makes it easier to read and debug JavaScript code.'
    );
    const boldText = (fixture.nativeElement as HTMLElement).querySelector('.bold-text');
    expect(boldText?.textContent?.trim()).toBe(
      'TypeScript makes it easier to read and debug JavaScript code.'
    );
  });

  /**
   * Regression, confirmed by a real localhost Narrator retest: the
   * subtitle's source had a newline + indentation between `<br />` and
   * "Take the quiz and find out!", which becomes a literal leading-space
   * TEXT NODE after the line break — Angular's whitespace collapsing only
   * removes insignificant INTER-ELEMENT whitespace, not this inter-word
   * text-node content. Narrator read that collapsed space aloud as "space"
   * before the sentence; the retest confirms that announcement is gone.
   * This asserts the actual markup shape (text node boundaries), not just
   * the flattened/trimmed textContent, which would pass even with the
   * stray space present.
   *
   * RESOLVED 2026-10-14+, FOR TAB NAVIGATION ONLY: three scan-mode Down
   * Arrow candidates and one earlier Tab/focus attempt all failed a real
   * retest (see introduction.component.html's own comment for that full
   * history). What finally worked: `tabindex="0"` added directly to this
   * SAME element — no other markup change — making it a normal Tab stop.
   * A real Narrator retest, on the local production build, confirmed
   * both sentences read together from one Tab press, with the two-line
   * layout preserved. Scan-mode Down Arrow reading of this SAME element
   * was retested at the same time and STILL reads the two sentences
   * separately — do not read this test (or this fix) as having resolved
   * that; it hasn't, and isn't claimed to. This test now also asserts the
   * Tab-stop shape; the original text-node/whitespace assertions below
   * are unchanged since the underlying markup (text, `<br>` placement)
   * never changed.
   */
  it('has no leading-space text node after the subtitle line break; is a Tab stop reading both sentences together (Tab navigation only — scan-mode Down Arrow reading is unchanged and still separate)', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const subtitleSpan = (fixture.nativeElement as HTMLElement).querySelector(
      'mat-card-subtitle span'
    );
    expect(subtitleSpan).toBeTruthy();

    const childNodes = Array.from(subtitleSpan!.childNodes);
    const brIndex = childNodes.findIndex((n) => n.nodeName === 'BR');
    expect(brIndex).toBeGreaterThanOrEqual(0);

    // The line break itself is still there (visible line break preserved).
    const textAfterBr = childNodes[brIndex + 1];
    expect(textAfterBr?.nodeType).toBe(Node.TEXT_NODE);
    // No leading space/newline before "Take" — the actual regression.
    expect(textAfterBr?.textContent).toMatch(/^Take the quiz and find out!/);
    expect(textAfterBr?.textContent?.startsWith(' ')).toBe(false);

    // Wording and reading order are unchanged end to end. The two lines are
    // separated by the <br> itself (a real line break), which contributes no
    // text of its own, so there is no space between them at the text-node
    // level — exactly the point of this fix.
    const fullText = (subtitleSpan!.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(fullText).toBe('How well versed are you in TypeScript?Take the quiz and find out!');

    // The Tab-stop fix: this exact element is keyboard-focusable, and
    // carries the class the SCSS uses for its visible :focus-visible
    // outline (that outline itself can't be asserted in jsdom, which has
    // no real layout/pseudo-elements — confirmed separately via CDP
    // against a real browser).
    expect(subtitleSpan!.getAttribute('tabindex')).toBe('0');
    expect(subtitleSpan!.classList.contains('intro-subtitle-text')).toBe(true);
  });

  /**
   * REOPENED: a real localhost Narrator retest still required multiple
   * Down Arrow presses after an earlier `role="presentation"` attempt —
   * that attribute only changes the accessibility tree's ROLE for the
   * `<strong>`, not the fact that it was still a separate DOM element (and
   * therefore a separate rendered text run/leaf object) from its
   * neighbors. The AX-tree shape alone does not establish what Narrator's
   * own scan-mode navigation actually stops on, and claiming otherwise was
   * an unproven assumption, now disproven by a real retest.
   *
   * Fix: the ENTIRE sentence is now one Angular interpolation
   * (`introDetailsTextSig()`), compiling to exactly ONE DOM text node —
   * confirmed via CDP to produce exactly one `StaticText` accessibility
   * node, structurally identical to a plain single-text-node paragraph's
   * own AX shape (see e2e-cert-claim/
   * a11y-introduction-question-count-paragraph.spec.ts for the real-
   * browser comparison against that baseline). No wrapping element
   * remains around the count, because ANY wrapping element — role or not
   * — reintroduces a second leaf object, which is the actual defect.
   *
   * Trade-off, not hidden: the question count is no longer individually
   * bolded (there is no longer a separate element to apply it to); the
   * paragraph's own centering (`.intro-centered-text`) is unaffected.
   */
  it('renders the full "Test your wits..." sentence as one interpolation, preserving the real dynamic count and exact wording', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const paragraph = (fixture.nativeElement as HTMLElement).querySelector('p.intro-centered-text');
    expect(paragraph).toBeTruthy();

    // No child elements at all — exactly one text node, the actual point
    // of this fix.
    expect(paragraph!.childNodes.length).toBe(1);
    expect(paragraph!.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph!.querySelector('strong')).toBeNull();

    // The real, dynamic count is preserved, not hidden or replaced.
    expect(fixture.componentInstance.questionCountSig()).toBe(10);

    // Exact wording and reading order, built from the real count.
    const fullText = (paragraph!.textContent ?? '').trim();
    expect(fullText).toBe(
      'Test your wits with 10 timed multiple-choice questions! Have fun and share!'
    );
  });
});

/**
 * Stage 15 follow-up: Introduction used to gate its first paint on
 * `metadataApi.load()`'s HTTP round trip, so a cold `GET /api/quizzes` (e.g. a
 * cold Render backend) left the page on the template's `Loading…` branch for
 * however long that took — even though `TopicQuizMetadataService` already
 * seeds its public-metadata signals synchronously from `QUIZ_CATALOG_METADATA`,
 * the exact mechanism QuizSelection's tiles already rely on to paint instantly.
 * `load()` here is a controllable Subject that never emits on its own, so these
 * specs can assert what renders WHILE the request is still pending.
 */
describe('IntroductionComponent — instant first paint from seeded metadata (Stage 15 follow-up)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();
  const summaryMap = new Map<string, string>();

  function makeMetadataApi(loadSource: Subject<any[]>): any {
    return {
      load: jest.fn(() => loadSource.asObservable()),
      questionCountByQuiz: signal(questionCountMap),
      milestoneByQuiz: signal(milestoneMap),
      difficultyByQuiz: signal(difficultyMap),
      imageByQuiz: signal(imageMap),
      factsByQuiz: signal(factsMap),
      summaryByQuiz: signal(summaryMap),
      milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
      imageFor: (id: string) => imageMap.get(id) ?? '',
      factsFor: (id: string) => factsMap.get(id) ?? [],
      summaryFor: (id: string) => summaryMap.get(id) ?? ''
    };
  }

  function configureTestBed(metadataApi: any, quizId: string): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the card immediately from seeded metadata, before /api/quizzes resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // `pending` has not emitted — the metadata request is still in flight.
    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('TypeScript');
  });

  it('shows no request-status text for a known quiz while the metadata refresh is in flight', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const loadingEl = (fixture.nativeElement as HTMLElement).querySelector('.loading-message');
    expect(loadingEl).toBeNull();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Loading');
  });

  it('the HTTP metadata refresh still lands and updates state once it resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    expect(fixture.componentInstance.questionCountSig()).toBe(10);
  });

  it('an unknown quiz id absent from both the seed and the live response stays on Loading — no fabrication', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'not-a-real-quiz');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // Not in the bundled seed, so no immediate paint.
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
    const beforeText = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(beforeText).toContain('Loading');

    // The live response arrives but still doesn't include it — still no
    // fabricated quiz; selectedQuiz stays null.
    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
  });
});

/**
 * Cold-start "Start the Quiz looks dead" regression coverage.
 *
 * Root cause (confirmed via a live browser reproduction against the real
 * production Spring service with an 11s-delayed response): the spinner
 * overlay used to hide itself on its OWN fixed 1600ms timer, independent of
 * whether onStartQuiz's real fetch (prepareAndSetCurrentQuiz) had actually
 * finished — so on a cold Render/Neon backend the overlay vanished ~1.6s in
 * while the real work kept running silently for several more seconds,
 * making a working click look broken.
 *
 * QuizStartSpinnerService now separates "minimum elapsed" (still 1600ms,
 * unchanged) from "hide requested" (an explicit hide() call) — the overlay
 * only disappears once BOTH are true. These specs drive the REAL service
 * (not a stub) so the two are exercised together, the way production does.
 */
describe('IntroductionComponent — Start Quiz spinner lifecycle (cold-start fix)', () => {
  let prepareQuizSession$: ReplaySubject<QuizQuestion[]>;
  let quizDataService: {
    clearQuizQuestionCache: jest.Mock;
    setSelectedQuiz: jest.Mock;
    setCurrentQuiz: jest.Mock;
    prepareQuizSession: jest.Mock;
  };
  let quizNavigationService: {
    resolveEffectiveQuizId: jest.Mock;
    ensureSessionQuestions: jest.Mock;
    tryResolveQuestion: jest.Mock;
    resetUIAndNavigate: jest.Mock;
  };
  let routerNavigate: jest.Mock;
  let spinner: QuizStartSpinnerService;
  let component: IntroductionComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<IntroductionComponent>>;

  const ACTIVE_QUIZ: Quiz = {
    quizId: 'typescript',
    milestone: 'TypeScript',
    summary: '',
    image: '',
    difficulty: 'beginner' as QuizDifficulty,
    facts: []
  };

  // A real (non-empty) result — prepareAndSetCurrentQuiz treats an EMPTY
  // array as the failure signal (see its own doc comment), so every test
  // representing a genuine SUCCESS must resolve with at least one question.
  const FAKE_QUESTIONS = [{ questionText: 'Q1', options: [] }] as unknown as QuizQuestion[];

  function configureTestBed(): void {
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService = {
      clearQuizQuestionCache: jest.fn(),
      setSelectedQuiz: jest.fn(),
      setCurrentQuiz: jest.fn(),
      prepareQuizSession: jest.fn(() => prepareQuizSession$.asObservable())
    };
    quizNavigationService = {
      resolveEffectiveQuizId: jest.fn((override?: string) => override ?? 'typescript'),
      ensureSessionQuestions: jest.fn().mockResolvedValue(undefined),
      tryResolveQuestion: jest.fn().mockResolvedValue(null),
      resetUIAndNavigate: jest.fn().mockResolvedValue(true)
    };
    routerNavigate = jest.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: { clearAllMaps: jest.fn() } },
        {
          provide: TopicQuizMetadataService,
          useValue: {
            load: jest.fn(() => of([])),
            questionCountByQuiz: signal(new Map()),
            milestoneByQuiz: signal(new Map()),
            difficultyByQuiz: signal(new Map()),
            imageByQuiz: signal(new Map()),
            factsByQuiz: signal(new Map()),
            summaryByQuiz: signal(new Map()),
            milestoneFor: (id: string) => id,
            imageFor: () => '',
            factsFor: () => [],
            summaryFor: () => ''
          }
        },
        { provide: QuizDataService, useValue: quizDataService },
        { provide: QuizNavigationService, useValue: quizNavigationService },
        {
          provide: QuizPersistenceService,
          useValue: {
            clearClickConfirmedDotStatus: jest.fn(),
            clearAllPersistedDotStatus: jest.fn(),
            clearAllForFreshStart: jest.fn()
          }
        },
        {
          provide: QuizService,
          useValue: {
            clearStoredCorrectAnswersText: jest.fn(),
            setCheckedShuffle: jest.fn(),
            resetQuizSessionState: jest.fn(),
            startNewAttempt: jest.fn(),
            resetScore: jest.fn(),
            questionCorrectness: { clear: jest.fn() },
            selectedOptionsMap: { clear: jest.fn() },
            userAnswers: [],
            answers: [],
            setSelectedQuiz: jest.fn(),
            setActiveQuiz: jest.fn(),
            setQuizId: jest.fn(),
            setCurrentQuestionIndex: jest.fn()
          }
        },
        { provide: QuizShuffleService, useValue: { clear: jest.fn() } },
        {
          provide: SelectedOptionService,
          useValue: {
            clearAllSelectionsForQuiz: jest.fn(),
            clearRefreshBackup: jest.fn(),
            clickConfirmedDotStatus: { clear: jest.fn() },
            lastClickedCorrectByQuestion: { clear: jest.fn() }
          }
        },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        // The REAL service — this suite exists specifically to prove ITS
        // behavior, unlike the describe blocks above which stub it out.
        QuizStartSpinnerService,
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: routerNavigate } }
      ]
    });

    fixture = TestBed.createComponent(IntroductionComponent);
    component = fixture.componentInstance;
    spinner = TestBed.inject(QuizStartSpinnerService);
    // AFTER detectChanges(): ngOnInit's own route-params pipeline resolves
    // against the (empty) metadata mock and would otherwise overwrite this
    // right back to null via handleLoadedQuiz(null).
    fixture.detectChanges();
    component.selectedQuiz.set(ACTIVE_QUIZ); // resolveActiveQuiz short-circuits to this
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configureTestBed();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('warm response (finishes well before 1600ms): spinner remains visible for the minimum, then hides', async () => {
    const started = component.onStartQuiz('typescript');

    // Resolve the "fetch" almost immediately — far under the 1600ms floor.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await Promise.resolve();
    await Promise.resolve();

    expect(spinner.visible()).toBe(true); // minimum not yet elapsed

    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(routerNavigate).not.toHaveBeenCalled(); // resetUIAndNavigate succeeded, no fallback needed
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('cold response (exceeds 1600ms): spinner remains visible until the response AND navigation complete — no dead gap', async () => {
    const started = component.onStartQuiz('typescript');

    // Let the minimum elapse WHILE the "fetch" is still pending.
    await jest.advanceTimersByTimeAsync(1600);
    expect(spinner.visible()).toBe(true); // must still be up — this is the fixed bug

    // Now the cold backend finally answers.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await started;

    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('request failure (thrown error): spinner clears, Retry is shown, and navigation is NOT attempted (no duplicate fetch)', async () => {
    const started = component.onStartQuiz('typescript');

    prepareQuizSession$.error(new Error('cold backend timed out'));
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    // prepareAndSetCurrentQuiz's own catch falls back to the already-known
    // quiz for display purposes, but reports failure so onStartQuiz stops
    // here — it must NOT proceed to navigateToFirstQuestion, which is what
    // used to silently re-issue a second real fetch via ensureSessionQuestions.
    expect(quizDataService.setCurrentQuiz).toHaveBeenCalledWith(ACTIVE_QUIZ);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(quizNavigationService.ensureSessionQuestions).not.toHaveBeenCalled();
    expect(component.startFailed()).toBe(true);
    expect(component.isStartingQuiz()).toBe(false);
  });

  it('request "succeeds" with an empty question array (the same failure signal QuizDataService.prepareQuizSession resolves to on a caught fetch error): treated identically to a thrown error', async () => {
    const started = component.onStartQuiz('typescript');

    prepareQuizSession$.next([]); // empty, not an error — matches prepareQuizSession's own catchError(() => of([]))
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(component.startFailed()).toBe(true);
  });

  it('a Retry click after a failure clears the failed state and completes normally on success', async () => {
    const started = component.onStartQuiz('typescript');
    prepareQuizSession$.error(new Error('cold backend timed out'));
    await jest.advanceTimersByTimeAsync(1600);
    await started;
    expect(component.startFailed()).toBe(true);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();

    // Retry: same button, same handler ("Retry" calls onStartQuiz() exactly
    // like "Start the Quiz!" does), a fresh Subject standing in for the
    // backend now actually responding.
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService.prepareQuizSession.mockImplementation(() => prepareQuizSession$.asObservable());

    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false); // cleared immediately on the new attempt

    prepareQuizSession$.next(FAKE_QUESTIONS); // this time the backend genuinely answers
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1); // the retry completed the start
  });

  it('navigation failure/cancellation: spinner still clears', async () => {
    quizNavigationService.resetUIAndNavigate.mockResolvedValue(false);
    routerNavigate.mockResolvedValue(false);

    const started = component.onStartQuiz('typescript');
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(routerNavigate).toHaveBeenCalledTimes(1); // the fallback path ran
  });

  it('repeated clicks while pending create only one request and one navigation', async () => {
    const first = component.onStartQuiz('typescript');
    const second = component.onStartQuiz('typescript'); // no-op: isStartingQuiz() guard

    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await Promise.all([first, second]);

    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(1);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('component destruction while a request is still pending does not leave the GLOBAL overlay stuck', () => {
    void component.onStartQuiz('typescript'); // prepareQuizSession$ never resolves in this test

    expect(spinner.visible()).toBe(true);

    fixture.destroy(); // triggers this component's DestroyRef.onDestroy

    expect(spinner.visible()).toBe(false);
  });
});

/**
 * Bounded 45s client-side timeout on the Start-Quiz question-loading
 * operation. A hung `/questions` request (observed directly against the real
 * production Spring/Render backend for 2+ minutes) previously left the
 * spinner and the isStartingQuiz() guard stuck forever — no error, no
 * Retry, nothing the user could act on. `prepareAndSetCurrentQuiz` now pipes
 * `prepareQuizSession(...)` through `timeout(45_000)` and returns a distinct
 * 'timeout' outcome so the UI can show "server is still waking up" instead
 * of the generic unreachable-service message.
 *
 * Per explicit product clarification, Retry does NOT always have to issue a
 * fresh HTTP request: TopicQuizQuestionsService's cache multicasts via
 * `shareReplay({ refCount: false })`, so if the real request is STILL in
 * flight when the user retries, Retry should safely reuse it; only once the
 * request has actually failed (and the cache entry evicted) should Retry
 * create a new one. These specs model that distinction at the
 * QuizDataService.prepareQuizSession boundary: reusing the SAME mock source
 * across the retry represents "still in flight, reused"; swapping in a NEW
 * mock source after erroring the old one represents "failed, evicted, fresh
 * request".
 */
describe('IntroductionComponent — bounded 45s Start Quiz timeout', () => {
  let prepareQuizSession$: ReplaySubject<QuizQuestion[]>;
  let quizDataService: {
    clearQuizQuestionCache: jest.Mock;
    setSelectedQuiz: jest.Mock;
    setCurrentQuiz: jest.Mock;
    prepareQuizSession: jest.Mock;
  };
  let quizNavigationService: {
    resolveEffectiveQuizId: jest.Mock;
    ensureSessionQuestions: jest.Mock;
    tryResolveQuestion: jest.Mock;
    resetUIAndNavigate: jest.Mock;
  };
  let routerNavigate: jest.Mock;
  let spinner: QuizStartSpinnerService;
  let component: IntroductionComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<IntroductionComponent>>;

  const ACTIVE_QUIZ: Quiz = {
    quizId: 'typescript',
    milestone: 'TypeScript',
    summary: '',
    image: '',
    difficulty: 'beginner' as QuizDifficulty,
    facts: []
  };

  const FAKE_QUESTIONS = [{ questionText: 'Q1', options: [] }] as unknown as QuizQuestion[];

  function configureTestBed(): void {
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService = {
      clearQuizQuestionCache: jest.fn(),
      setSelectedQuiz: jest.fn(),
      setCurrentQuiz: jest.fn(),
      prepareQuizSession: jest.fn(() => prepareQuizSession$.asObservable())
    };
    quizNavigationService = {
      resolveEffectiveQuizId: jest.fn((override?: string) => override ?? 'typescript'),
      ensureSessionQuestions: jest.fn().mockResolvedValue(undefined),
      tryResolveQuestion: jest.fn().mockResolvedValue(null),
      resetUIAndNavigate: jest.fn().mockResolvedValue(true)
    };
    routerNavigate = jest.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: { clearAllMaps: jest.fn() } },
        {
          provide: TopicQuizMetadataService,
          useValue: {
            load: jest.fn(() => of([])),
            questionCountByQuiz: signal(new Map()),
            milestoneByQuiz: signal(new Map()),
            difficultyByQuiz: signal(new Map()),
            imageByQuiz: signal(new Map()),
            factsByQuiz: signal(new Map()),
            summaryByQuiz: signal(new Map()),
            milestoneFor: (id: string) => id,
            imageFor: () => '',
            factsFor: () => [],
            summaryFor: () => ''
          }
        },
        { provide: QuizDataService, useValue: quizDataService },
        { provide: QuizNavigationService, useValue: quizNavigationService },
        {
          provide: QuizPersistenceService,
          useValue: {
            clearClickConfirmedDotStatus: jest.fn(),
            clearAllPersistedDotStatus: jest.fn(),
            clearAllForFreshStart: jest.fn()
          }
        },
        {
          provide: QuizService,
          useValue: {
            clearStoredCorrectAnswersText: jest.fn(),
            setCheckedShuffle: jest.fn(),
            resetQuizSessionState: jest.fn(),
            startNewAttempt: jest.fn(),
            resetScore: jest.fn(),
            questionCorrectness: { clear: jest.fn() },
            selectedOptionsMap: { clear: jest.fn() },
            userAnswers: [],
            answers: [],
            setSelectedQuiz: jest.fn(),
            setActiveQuiz: jest.fn(),
            setQuizId: jest.fn(),
            setCurrentQuestionIndex: jest.fn()
          }
        },
        { provide: QuizShuffleService, useValue: { clear: jest.fn() } },
        {
          provide: SelectedOptionService,
          useValue: {
            clearAllSelectionsForQuiz: jest.fn(),
            clearRefreshBackup: jest.fn(),
            clickConfirmedDotStatus: { clear: jest.fn() },
            lastClickedCorrectByQuestion: { clear: jest.fn() }
          }
        },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        QuizStartSpinnerService,
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: routerNavigate } }
      ]
    });

    fixture = TestBed.createComponent(IntroductionComponent);
    component = fixture.componentInstance;
    spinner = TestBed.inject(QuizStartSpinnerService);
    fixture.detectChanges();
    component.selectedQuiz.set(ACTIVE_QUIZ);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configureTestBed();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('success just under the 45s boundary still completes normally — the timeout never fires', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(44_000);
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600); // let the (already-elapsed) spinner minimum settle
    await started;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('a request that never responds within 45s hits the bounded timeout: Retry is shown with the "still waking up" state, not the generic error', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(45_000);
    await started;

    expect(component.startFailed()).toBe(true);
    expect(component.startTimedOut()).toBe(true);
    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(quizNavigationService.ensureSessionQuestions).not.toHaveBeenCalled();
  });

  it('a late response arriving on the original source AFTER the 45s timeout already fired is ignored', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startFailed()).toBe(true);
    expect(component.startTimedOut()).toBe(true);

    // The real backend eventually answers anyway, on the SAME (already
    // timed-out, from this component's perspective) source.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);

    expect(component.startFailed()).toBe(true); // unchanged — the outcome already settled
    expect(component.startTimedOut()).toBe(true);
    expect(spinner.visible()).toBe(false); // did not reopen
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
  });

  it('Retry after a timeout, while the original request is STILL in flight, safely reuses it instead of racing a second concurrent request', async () => {
    const started = component.onStartQuiz('typescript');
    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startTimedOut()).toBe(true);

    // Retry — the cache entry was never evicted (the real request never
    // failed; only this component's own bounded wait gave up), so
    // QuizDataService/TopicQuizQuestionsService's shareReplay({refCount:false})
    // would hand back the SAME still-in-flight source. Modeled here by NOT
    // changing quizDataService.prepareQuizSession's implementation.
    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false); // cleared immediately on retry

    // The one real, still-in-flight request finally answers.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1); // exactly one successful start
    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(2); // one call per attempt — same underlying source both times
  });

  it('Retry after a timeout, once the original request has since FAILED and its cache entry was evicted, issues exactly one fresh request', async () => {
    const started = component.onStartQuiz('typescript');
    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startTimedOut()).toBe(true);

    // The original request eventually fails for real; TopicQuizQuestionsService's
    // own catchError deletes the cache entry (see its doc comment) — modeled
    // here by erroring the original source.
    prepareQuizSession$.error(new Error('cold backend eventually failed'));

    // Retry — a fresh cache entry means a fresh Observable this time.
    const freshSource = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService.prepareQuizSession.mockImplementation(() => freshSource.asObservable());

    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false);

    freshSource.next(FAKE_QUESTIONS);
    freshSource.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(2); // exactly one fresh call on retry
  });

  it('duplicate clicks while the 45s timeout is still pending create only one request', async () => {
    const first = component.onStartQuiz('typescript');
    const second = component.onStartQuiz('typescript'); // no-op: isStartingQuiz() guard

    await jest.advanceTimersByTimeAsync(45_000);
    await Promise.all([first, second]);

    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(1);
    expect(component.startTimedOut()).toBe(true);
  });

  it('destruction while the 45s timeout is still pending clears the spinner immediately; the timeout later firing is a harmless no-op', async () => {
    void component.onStartQuiz('typescript');
    expect(spinner.visible()).toBe(true);

    fixture.destroy();
    expect(spinner.visible()).toBe(false);

    // Let the bounded timeout actually fire after destruction — must not
    // throw or surface as an unhandled rejection.
    await jest.advanceTimersByTimeAsync(45_000);
  });
});

/**
 * Document-title fix: index.html's static "Angular Quiz App" title never
 * updated for a Topic Quiz in progress. These specs use the REAL Angular
 * `Title` service (not a fake) so `document.title` itself is the
 * assertion target, exactly as a browser tab would show it.
 */
describe('IntroductionComponent — browser tab title (document-title fix)', () => {
  const questionCountMap = new Map<string, number | null>([['dependency-injection', 7]]);
  const milestoneMap = new Map<string, string>([['dependency-injection', 'Dependency Injection']]);
  const difficultyMap = new Map<string, string | null>([['dependency-injection', 'intermediate']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();
  const summaryMap = new Map<string, string>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'dependency-injection' }])),
    questionCountByQuiz: signal(questionCountMap),
    milestoneByQuiz: signal(milestoneMap),
    difficultyByQuiz: signal(difficultyMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    summaryByQuiz: signal(summaryMap),
    milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? [],
    summaryFor: (id: string) => summaryMap.get(id) ?? ''
  });

  function configureTestBed(): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'dependency-injection' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  const ORIGINAL_TITLE = 'Angular Quiz App';

  beforeEach(() => {
    document.title = ORIGINAL_TITLE;
  });

  it('sets the tab title to "<milestone> Quiz | Angular Quiz App" once the quiz loads', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(document.title).toBe('Dependency Injection Quiz | Angular Quiz App');
  });

  it('restores the original title on destroy, if this instance ever changed it', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
    expect(document.title).toBe('Dependency Injection Quiz | Angular Quiz App');

    fixture.destroy();
    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it('never touches the title if the quiz never loads (no milestone available)', () => {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        {
          provide: TopicQuizMetadataService,
          useValue: {
            load: jest.fn(() => of([])),
            questionCountByQuiz: signal(new Map()),
            milestoneByQuiz: signal(new Map()),
            difficultyByQuiz: signal(new Map()),
            imageByQuiz: signal(new Map()),
            factsByQuiz: signal(new Map()),
            summaryByQuiz: signal(new Map()),
            milestoneFor: (id: string) => id,
            imageFor: () => '',
            factsFor: () => [],
            summaryFor: () => ''
          }
        },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'nonexistent-quiz' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(document.title).toBe(ORIGINAL_TITLE);
    fixture.destroy();
    expect(document.title).toBe(ORIGINAL_TITLE);
  });
});

/**
 * Narrator/keyboard accessibility candidate, real-Narrator-confirmed
 * 2026-10-15 (localhost:4200 and the local production build served at
 * localhost:8104 — metadata wording, Tab order, subtitle, and the visible
 * question-count icon all passed). Covers what a real AT retest can't
 * assert for itself in CI: the exact attribute/signal shape those passes
 * depended on, so a future change that silently breaks one of them fails
 * a test instead of only being caught by another manual retest.
 *
 * Deliberately NOT covered here (jsdom has no real layout, pseudo-elements,
 * or screen reader): the actual :focus-visible outline rendering, and
 * anything about what Narrator itself chooses to speak (e.g. "group",
 * the duplicated "heading level 1" on arrival) — those remain real-AT-only
 * observations, recorded in the template's own comments, not asserted here.
 */
describe('IntroductionComponent — Narrator/keyboard accessibility (2026-10-15 candidate)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();
  const summaryMap = new Map<string, string>([['typescript', 'TypeScript summary.']]);

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'typescript' }])),
    questionCountByQuiz: signal(questionCountMap),
    milestoneByQuiz: signal(milestoneMap),
    difficultyByQuiz: signal(difficultyMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    summaryByQuiz: signal(summaryMap),
    milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? [],
    summaryFor: (id: string) => summaryMap.get(id) ?? ''
  });

  function configureTestBed(): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('has exactly the requested Tab sequence: subtitle, image, metadata group, summary paragraph, "wits" paragraph, Shuffle toggle — title stays out of the Tab order', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const title = root.querySelector('h1');
    expect(title?.getAttribute('tabindex')).toBe('-1');

    // mat-slide-toggle's own internal <button role="switch"> carries its
    // OWN `tabindex="0"` (Angular Material's doing, confirmed via a real
    // browser Tab-order check — see introduction.component.html's own
    // history), so it legitimately shows up in this same query; the Start
    // button after it does not (a plain <button> needs no explicit
    // tabindex to be focusable), so it correctly does NOT appear here.
    const tabStops = Array.from(root.querySelectorAll('[tabindex="0"]'));
    const identify = (el: Element) => {
      if (el.classList.contains('intro-subtitle-text')) return 'subtitle';
      if (el.classList.contains('quiz-topic-image')) return 'image';
      if (el.classList.contains('quiz-meta')) return 'metadata';
      if (el.querySelector('.bold-text')) return 'summary';
      if (el.classList.contains('intro-centered-text')) return 'wits';
      if (el.getAttribute('role') === 'switch') return 'toggle';
      return el.outerHTML.slice(0, 60);
    };
    expect(tabStops.map(identify)).toEqual([
      'subtitle',
      'image',
      'metadata',
      'summary',
      'wits',
      'toggle'
    ]);
  });

  it('the metadata group is role="group", aria-labelledby the difficulty/count/time spans in reading order, and announces difficulty + count + "approximately N minutes"', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const group = root.querySelector('.quiz-meta');
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('tabindex')).toBe('0');
    expect(group?.getAttribute('aria-labelledby')).toBe(
      'quiz-meta-difficulty-text quiz-meta-count-text quiz-meta-time-text'
    );

    const difficultyEl = root.querySelector('#quiz-meta-difficulty-text');
    const countEl = root.querySelector('#quiz-meta-count-text');
    const timeEl = root.querySelector('#quiz-meta-time-text');
    expect(difficultyEl?.textContent?.trim()).toBe('Beginner');
    expect(countEl?.textContent?.trim()).toBe('10 Questions');

    // Visible text stays the short "~N min" form; the spoken wording is
    // carried separately via aria-label, not the element's own text.
    expect(timeEl?.textContent?.trim()).toBe('~5 min');
    expect(timeEl?.getAttribute('aria-label')).toBe('approximately 5 minutes');
  });

  it('omits the difficulty id from aria-labelledby when the quiz has no difficulty (the @if branch never renders that span)', () => {
    difficultyMap.set('typescript', null as unknown as string);
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('#quiz-meta-difficulty-text')).toBeNull();
    expect(root.querySelector('.quiz-meta')?.getAttribute('aria-labelledby')).toBe(
      'quiz-meta-count-text quiz-meta-time-text'
    );
    difficultyMap.set('typescript', 'beginner'); // restore for later tests in this file
  });

  it('the question-count icon is a registered SVG icon (the official "quiz" glyph), not the absent font ligature', async () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const countIcon = root.querySelector('#quiz-meta-count-text')?.previousElementSibling;
    expect(countIcon?.tagName.toLowerCase()).toBe('mat-icon');
    // No ligature text left behind — svgIcon mode renders an inline <svg>,
    // never the literal word "quiz" as text content.
    expect(countIcon?.textContent?.trim()).toBe('');
    expect(countIcon?.getAttribute('aria-hidden')).toBe('true');

    const svg = await firstValueFrom(TestBed.inject(MatIconRegistry).getNamedSvgIcon(QUESTION_COUNT_ICON));
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('path')).not.toBeNull();
  });
});
