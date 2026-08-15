import { Service, computed, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, Observable } from 'rxjs';
import { catchError, distinctUntilChanged, filter } from 'rxjs/operators';

import { SK_DOT_CONFIRMED, SK_SEL_Q } from '../../constants/session-keys';
import { QUESTION_ROUTE_REGEX } from '../../constants/route-patterns';

import { Option } from '../../models/Option.model';
import { QuestionState } from '../../models/QuestionState.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { swallow } from '../../utils/error-logging';

@Service()
export class QuizStateService {
  // ── signals / computed / properties ─────────────────────────────

  // ── Signal-first state (current question / index / options) ────
  readonly currentQuestionSig = signal<QuizQuestion | null>(null);
  currentQuestion$: Observable<QuizQuestion | null> =
    toObservable(this.currentQuestionSig);

  readonly currentQuestionIndexSig = signal<number>(0);
  currentQuestionIndex$: Observable<number> =
    toObservable(this.currentQuestionIndexSig);

  readonly currentOptionsSig = computed<Option[]>(
    () => this.currentQuestionSig()?.options ?? []
  );
  currentOptions$: Observable<Option[]> =
    toObservable(this.currentOptionsSig);

  questionStates: Map<number, QuestionState> = new Map();
  private quizStates: { [quizId: string]: Map<number, QuestionState> } = {};

  private quizQuestionCreated = false;
  public displayExplanationLocked = false;

  // Visibility restoration lock - prevents display state changes during tab restore
  private _visibilityRestoreLock = false;
  private _visibilityRestoreLockTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Signal-first state (loading / navigating / answered) ──────
  readonly isLoadingSig = signal<boolean>(false);
  public isLoading$ = toObservable(this.isLoadingSig);

  readonly isNavigatingSig = signal<boolean>(false);
  public isNavigating$ = toObservable(this.isNavigatingSig);

  readonly isAnsweredSig = signal<boolean>(false);
  isAnswered$: Observable<boolean> = toObservable(this.isAnsweredSig);

  // Tracks when the explanation text (FET) is fully formatted and ready
  readonly explanationReadySig = signal<boolean>(false);
  public explanationReady$ = toObservable(this.explanationReadySig);

  readonly displayStateSig = signal<{
    mode: 'question' | 'explanation';
    answered: boolean;
  }>({
    mode: 'question',
    answered: false
  });
  public displayState$ = toObservable(this.displayStateSig);

  readonly interactionReadySig = signal<boolean>(true);
  public interactionReady$ = toObservable(this.interactionReadySig);

  // Tracks whether the quiz state has completed at least one full restoration
  public hasRestoredOnce = false;

  public _hasUserInteracted = new Set<number>();
  public _answeredQuestionIndices = new Set<number>();

  // All signals are now signal-first (declared above)

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.questionStates = new Map<number, QuestionState>();
    this.restoreInteractionState();
    // Seed the click-in-session tracker ONLY for the refresh-initial URL
    // idx. This is the single source of truth for "should FET show": it
    // only grows on actual user clicks or refresh-of-answered-question.
    this.seedClickedInSessionFromRefresh();
  }

  // ── methods / additional state ──────────────────────────────────

  // Persist _hasUserInteracted and _answeredQuestionIndices across page
  // refreshes so that the FET display pipeline recognises previously
  // answered questions and shows their explanation text.
  private readonly INTERACTED_STORAGE_KEY = 'userInteractedQuestions';
  private readonly ANSWERED_STORAGE_KEY = 'userAnsweredQuestions';

  private restoreInteractionState(): void {
    try {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
      if (!isPageRefresh) {
        sessionStorage.removeItem(this.INTERACTED_STORAGE_KEY);
        sessionStorage.removeItem(this.ANSWERED_STORAGE_KEY);
        return;
      }

      // Determine which question index (0-based) the URL is currently on —
      // restore ONLY that index's interaction state. This prevents stale
      // "answered" flags from other questions (persisted during a prior
      // play session) from leaking into the post-refresh display and
      // causing resolveDisplayText to surface FET instead of question text
      // when the user later navigates to a sibling question.
      let currentUrlIdx: number | null = null;
      try {
        const match = (window?.location?.pathname ?? '').match(QUESTION_ROUTE_REGEX);
        if (match && match[1]) {
          const oneBased = parseInt(match[1], 10);
          if (Number.isFinite(oneBased) && oneBased >= 1) {
            currentUrlIdx = oneBased - 1;
          }
        }
      } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }

      const restore = (key: string, target: Set<number>) => {
        const raw = sessionStorage.getItem(key);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const idx of arr) {
            if (typeof idx === 'number' && Number.isFinite(idx)) {
              // Only restore the currently-displayed question's state;
              // drop all other persisted indices so post-refresh
              // navigation to siblings starts fresh.
              if (currentUrlIdx === null || idx === currentUrlIdx) {
                target.add(idx);
              }
            }
          }
        }
      };
      restore(this.INTERACTED_STORAGE_KEY, this._hasUserInteracted);
      restore(this.ANSWERED_STORAGE_KEY, this._answeredQuestionIndices);

      // Also re-persist the pruned sets so sessionStorage no longer
      // carries stale entries for the dropped indices. If the user
      // refreshes AGAIN on a different question later, this ensures the
      // new refresh starts from a clean slate for the non-current index.
      try {
        sessionStorage.setItem(
          this.INTERACTED_STORAGE_KEY,
          JSON.stringify(Array.from(this._hasUserInteracted))
        );
        sessionStorage.setItem(
          this.ANSWERED_STORAGE_KEY,
          JSON.stringify(Array.from(this._answeredQuestionIndices))
        );
      } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
    } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
  }

  public persistInteractionState(): void {
    try {
      sessionStorage.setItem(
        this.INTERACTED_STORAGE_KEY,
        JSON.stringify(Array.from(this._hasUserInteracted))
      );
      sessionStorage.setItem(
        this.ANSWERED_STORAGE_KEY,
        JSON.stringify(Array.from(this._answeredQuestionIndices))
      );
    } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
  }

  setDisplayState(state: {
    mode: 'question' | 'explanation';
    answered: boolean;
  }, options?: { force?: boolean }): void {
    // If visibility restore lock is active, block state changes unless forced
    if (this._visibilityRestoreLock && !options?.force) return;
    this.displayStateSig.set(state);
  }

  // Lock display state changes (used during tab visibility restoration)
  lockDisplayStateForVisibilityRestore(durationMs: number = 500): void {
    this._visibilityRestoreLock = true;

    // Clear any existing timeout
    if (this._visibilityRestoreLockTimeout) {
      clearTimeout(this._visibilityRestoreLockTimeout);
    }

    // Automatically unlock after duration
    this._visibilityRestoreLockTimeout = setTimeout(() => {
      this._visibilityRestoreLock = false;
      this._visibilityRestoreLockTimeout = null;
    }, durationMs);
  }

  unlockDisplayStateForVisibilityRestore(): void {
    if (this._visibilityRestoreLockTimeout) {
      clearTimeout(this._visibilityRestoreLockTimeout);
      this._visibilityRestoreLockTimeout = null;
    }
    this._visibilityRestoreLock = false;
  }

  getStoredState(quizId: string): Map<number, QuestionState> | null {
    const stateJSON = localStorage.getItem(`quizState_${quizId}`);
    if (stateJSON) {
      try {
        const stateObject = JSON.parse(stateJSON);

        // Additional check to ensure the parsed object matches the expected structure
        if (typeof stateObject === 'object' && !Array.isArray(stateObject)) {
          return new Map<number, QuestionState>(
            Object.entries(stateObject).map(
              ([key, value]): [number, QuestionState] => {
                // Further validation to ensure each key-value pair matches the expected types
                const parsedKey = Number(key);
                if (
                  !isNaN(parsedKey) &&
                  typeof value === 'object' &&
                  value !== null &&
                  'isAnswered' in value
                ) {
                  return [parsedKey, value as QuestionState];
                } else {
                  throw new Error(
                    `Invalid question state format for questionId ${key}`
                  );
                }
              }
            )
          );
        } else {
          // Stored state is not in object format
        }
      } catch (err: unknown) {
        console.error('QuizStateService.loadState stored state parse failed:', err);
        return null;
      }
    }
    return null;
  }

  // Method to set or update the state for a question
  setQuestionState(
    quizId: string,
    questionId: number,
    state: QuestionState
  ): void {
    // Check if the quizId already exists in the quizStates map, if not, create a new Map for it
    if (!this.quizStates[quizId]) {
      this.quizStates[quizId] = new Map<number, QuestionState>();
    }

    // Set the state for the given questionId within the specified quizId
    this.quizStates[quizId].set(questionId, state);
  }

  // Method to get the state of a question by its ID
  getQuestionState(
    quizId: string,
    questionId: number,
  ): QuestionState | undefined {
    // Initialize the state map for this quiz if it doesn't exist
    if (!this.quizStates[quizId]) {
      this.quizStates[quizId] = new Map<number, QuestionState>();
    }

    let state =
      this.quizStates[quizId].get(questionId) ??
      this.createDefaultQuestionState();
    this.quizStates[quizId].set(questionId, state);  // store default state in quiz's state map

    return state;
  }

  updateQuestionState(
    quizId: string,
    questionIndex: number,
    stateUpdates: Partial<QuestionState>,
    totalCorrectAnswers: number
  ): void {
    // Retrieve the current state for the question or initialize if not present
    let currentState = this.getQuestionState(quizId, questionIndex) || {
      isAnswered: false,
      selectedOptions: [],
      numberOfCorrectAnswers: 0  // ensure this property is properly initialized
    };

    // If updating selected options and the question has correct answers to track
    if (stateUpdates.selectedOptions && totalCorrectAnswers > 0) {
      // Ensure selectedOptions is an array and update it based on stateUpdates
      currentState.selectedOptions = Array.isArray(currentState.selectedOptions)
        ? currentState.selectedOptions
        : [];

      for (const option of stateUpdates.selectedOptions) {
        if (
          !currentState.selectedOptions.some(
            (selectedOption) => selectedOption.optionId === option.optionId
          )
        ) {
          currentState.selectedOptions.push(option);

          const numCorrect = currentState.numberOfCorrectAnswers ?? 0;
          if (isOptionCorrect(option) && numCorrect < totalCorrectAnswers) {
            currentState.numberOfCorrectAnswers = numCorrect + 1;
          }
        }
      }

      // Mark as answered if the number of correct answers is reached
      currentState.isAnswered =
        (currentState.numberOfCorrectAnswers ?? 0) >= totalCorrectAnswers;
    }

    // Merge the current state with other updates not related to selected options
    const newState = { ...currentState, ...stateUpdates };

    // Save the updated state
    this.setQuestionState(quizId, questionIndex, newState);
  }

  updateQuestionStateForExplanation(quizId: string, index: number): void {
    let questionState = this.getQuestionState(quizId, index);

    if (!questionState) {
      questionState = {
        isAnswered: false,
        explanationDisplayed: false,
        selectedOptions: []
      };
    }

    questionState.explanationDisplayed = true;
    questionState.isAnswered = true;

    // Save the updated state
    this.setQuestionState(quizId, index, questionState);
  }

  createDefaultQuestionState(): QuestionState {
    return {
      isAnswered: false,
      numberOfCorrectAnswers: 0,
      selectedOptions: [],
      explanationDisplayed: false
    };
  }

  applyDefaultStates(quizId: string, questions: QuizQuestion[]): void {
    // Initialize the state map for this quiz if it doesn't exist
    if (!this.quizStates[quizId]) {
      this.quizStates[quizId] = new Map<number, QuestionState>();
    }

    for (const [index] of questions.entries()) {
      const defaultState = this.createDefaultQuestionState();
      // Apply the default state to each question using its index as the identifier within the specific quiz's state map
      this.quizStates[quizId].set(index, defaultState);
    }
  }

  updateCurrentQuizState(question$: Observable<QuizQuestion | null>): void {
    if (!question$) throw new Error('question$ must be an observable.');

    question$
      .pipe(
        filter((q): q is QuizQuestion => q !== null),
        distinctUntilChanged((a, b) => a === b),  // object reference check
        catchError(() => {
          return EMPTY;  // safest fallback
        })
      )
      .subscribe((question: QuizQuestion) => {
        this.currentQuestionSig.set(question);
        // currentOptionsSig auto-derives from currentQuestionSig via computed()
      });
  }

  updateCurrentQuestion(newQuestion: QuizQuestion): void {
    this.currentQuestionSig.set(newQuestion);
  }

  setQuizQuestionCreated(): void {
    this.quizQuestionCreated = true;
  }

  getQuizQuestionCreated(): boolean {
    return this.quizQuestionCreated;
  }

  isLoading(): boolean {
    return this.isLoadingSig();
  }

  setNavigating(isNavigating: boolean): void {
    this.isNavigatingSig.set(isNavigating);
  }

  setLoading(isLoading: boolean): void {
    this.isLoadingSig.set(isLoading);
  }

  setAnswered(isAnswered: boolean): void {
    this.isAnsweredSig.set(isAnswered);
  }

  // Method to set isAnswered and lock displayExplanation
  setAnswerSelected(isAnswered: boolean): void {
    this.isAnsweredSig.set(isAnswered);
    if (isAnswered && !this.displayExplanationLocked) {
      this.displayExplanationLocked = true;
    }
  }

  setExplanationReady(isReady: boolean): void {
    this.explanationReadySig.set(isReady);
  }

  startLoading(): void {
    if (!this.isLoading()) this.isLoadingSig.set(true);
  }

  setInteractionReady(v: boolean) {
    this.interactionReadySig.set(v);
  }

  isInteractionReady(): boolean {
    return this.interactionReadySig();
  }

  // Timestamp of the last user interaction
  readonly lastInteractionTimeSig = signal<number>(0);
  public lastInteractionTime$ = toObservable(this.lastInteractionTimeSig);

  // Index of the question the user just interacted with
  readonly userHasInteractedSig = signal<number>(-1);
  public userHasInteracted$ = toObservable(this.userHasInteractedSig);

  /**
   * @param opts.visitScoped Pass `false` from a RENDER path (one that replays
   * stored state rather than reacting to a click). Such a path may record the
   * durable "this question was interacted with" evidence, but it must not claim
   * the interaction happened on THIS VISIT — that flag is the only thing that
   * distinguishes the live answer view from a revisit, and the heading uses it
   * to decide question text vs FET. Re-emitting a stored explanation while
   * navigating back used to set it, which turned the revisit into a live view
   * and left the explanation in the heading. Defaults to true: every genuine
   * click path calls this with no options.
   */
  markUserInteracted(idx: number, opts?: { visitScoped?: boolean }): void {
    this._hasUserInteracted.add(idx);
    this.userHasInteractedSig.set(idx);
    this.lastInteractionTimeSig.set(Date.now());
    this.persistInteractionState();
    // Also register as a click-in-session: every real user click path
    // calls markUserInteracted, while sessionStorage restore populates
    // _hasUserInteracted directly (without calling this method). So
    // hooking here ensures clicks are captured in _clickedInSession
    // without being polluted by F5 restoration.
    this.markClickedInSession(idx);
    // ...and as an interaction THIS visit (race-immune live-view marker).
    if (opts?.visitScoped !== false) this.markInteractedThisVisit(idx);
  }

  hasUserInteracted(idx: number): boolean {
    return this._hasUserInteracted.has(idx);
  }

  markQuestionAnswered(idx: number): void {
    this._answeredQuestionIndices.add(idx);
    this.persistInteractionState();
  }

  isQuestionAnswered(idx: number): boolean {
    return this._answeredQuestionIndices.has(idx);
  }

  // ───────────────────────────────────────────────────────────────
  // Click-in-session tracking — authoritative source of truth for
  // "should FET show for this idx". Populated ONLY by actual user
  // click events (via quiz-setup.service.onOptionSelected). On page
  // refresh, it is seeded *only* for the refresh-initial URL idx if
  // sessionStorage says that idx was already answered — this keeps
  // Q1's FET visible after F5 without contaminating sibling indices.
  // ───────────────────────────────────────────────────────────────
  public _clickedInSession = new Set<number>();

  markClickedInSession(idx: number): void {
    if (!Number.isFinite(idx) || idx < 0) return;
    this._clickedInSession.add(idx);
  }

  hasClickedInSession(idx: number): boolean {
    return this._clickedInSession.has(idx);
  }

  // ───────────────────────────────────────────────────────────────
  // Visit-scoped interaction flag. Unlike _clickedInSession (which is
  // session-durable — it stays set for an answered idx across navigation),
  // this is SET synchronously on a genuine click this visit and CLEARED when
  // navigating TO a question (a fresh visit). That distinguishes the LIVE
  // answer view (keep the FET) from a revisit of an already-answered question
  // (show question text). Race-immune: it does NOT depend on the async
  // isNavigatingToPrevious clear, so a genuine forward-nav answer still shows
  // its FET even if that flag has not cleared yet.
  // ───────────────────────────────────────────────────────────────
  public _interactedThisVisit = new Set<number>();

  markInteractedThisVisit(idx: number): void {
    if (!Number.isFinite(idx) || idx < 0) return;
    this._interactedThisVisit.add(idx);
  }

  wasInteractedThisVisit(idx: number): boolean {
    return this._interactedThisVisit.has(idx);
  }

  clearInteractedThisVisit(idx: number): void {
    this._interactedThisVisit.delete(idx);
  }

  seedClickedInSessionFromRefresh(): void {
    try {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      const isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
      if (!isPageRefresh) return;
      let currentUrlIdx: number | null = null;
      try {
        const match = (window?.location?.pathname ?? '').match(QUESTION_ROUTE_REGEX);
        if (match && match[1]) {
          const oneBased = parseInt(match[1], 10);
          if (Number.isFinite(oneBased) && oneBased >= 1) {
            currentUrlIdx = oneBased - 1;
          }
        }
      } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
      if (currentUrlIdx === null) return;
      // Only seed if sessionStorage says this exact idx was answered.
      // Check multiple evidence sources because QuizStateService.reset()
      // (triggered by a resetAll → quizReset$ cycle)
      // wipes _answeredQuestionIndices and _hasUserInteracted from
      // sessionStorage. The durable sel_Q* and dot_confirmed_* keys
      // survive reset and serve as fallback evidence.
      let hasEvidence = this._answeredQuestionIndices.has(currentUrlIdx) || 
        this._hasUserInteracted.has(currentUrlIdx);
      if (!hasEvidence) {
        try {
          const selRaw = sessionStorage.getItem(SK_SEL_Q + currentUrlIdx);
          if (selRaw) {
            const parsed = JSON.parse(selRaw);
            if (Array.isArray(parsed) && parsed.length > 0) hasEvidence = true;
          }
        } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
      }
      if (!hasEvidence) {
        try {
          const dot = sessionStorage.getItem(SK_DOT_CONFIRMED + currentUrlIdx);
          if (dot === 'correct' || dot === 'wrong') hasEvidence = true;
        } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
      }
      if (hasEvidence) {
        this._clickedInSession.add(currentUrlIdx);
      }
    } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
  }

  clearClickedInSession(): void {
    this._clickedInSession.clear();
    this._interactedThisVisit.clear();
  }

  // Reset interaction state (called on Navigation)
  resetInteraction(): void {
    this.userHasInteractedSig.set(-1);
    this.lastInteractionTimeSig.set(0);
  }

  // Reset all state (called on Shuffle Toggle or Quiz Reset)
  reset(): void {
    this.questionStates.clear();
    this.quizStates = {};
    this._hasUserInteracted.clear();
    this._answeredQuestionIndices.clear();
    try {
      sessionStorage.removeItem(this.INTERACTED_STORAGE_KEY);
      sessionStorage.removeItem(this.ANSWERED_STORAGE_KEY);
    } catch (err: unknown) { swallow('quizstate.service.ts', err); /* ignore */ }
    this.userHasInteractedSig.set(-1);  // Reset so stale index doesn't falsely pass hasInteracted checks
    this.currentQuestionSig.set(null);
    this.explanationReadySig.set(false);
    this.isAnsweredSig.set(false);
  }
}