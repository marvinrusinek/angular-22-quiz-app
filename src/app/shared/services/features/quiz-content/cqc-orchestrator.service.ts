﻿import { inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ParamMap } from '@angular/router';
import {
  BehaviorSubject, combineLatest, firstValueFrom, forkJoin, Observable, of, Subject
} from 'rxjs';
import {
  catchError, distinctUntilChanged, filter, map, shareReplay, startWith,
  switchMap, take, tap, withLatestFrom
} from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { CombinedQuestionDataType } from '../../../models/CombinedQuestionDataType.model';
import { Option } from '../../../models/Option.model';
import { QuestionPayload } from '../../../models/QuestionPayload.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { CqcQuestionNavService } from './cqc-question-nav.service';
import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';

import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';

import { bannerCorrectCount } from '../../../utils/question-type-authority';
import { swallow } from '../../../utils/error-logging';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * Orchestrates CodelabQuizContentComponent logic, extracted via the typed host pattern.
 */
@Service()
export class CqcOrchestratorService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly questionNav = inject(CqcQuestionNavService);
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);

  async runOnInit(host: Host): Promise<void> {
    await this.runInitialSetup(host);
    this.subscribeToTimerExpiryFetWrite(host);
  }

  /**
   * Initial setup: reset state (preserving F5-restored interaction evidence),
   * wire the reset/explanation/FET/display-text pipelines, load quiz data, and
   * await component init. Extracted verbatim from runOnInit's head.
   */
  private async runInitialSetup(host: Host): Promise<void> {
    host.resetInitialState();

    // Preserve sessionStorage-restored interaction state across F5 refresh.
    // `_hasUserInteracted` is restored by quizStateService.restoreInteractionState()
    // when performance.navigation.type === 'reload' — wiping it here would undo
    // that and break FET display after refresh.
    let isPageRefresh = false;
    try {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
    } catch (err: unknown) { swallow('cqc-orchestrator.service.ts page-refresh detect', err); }
    if (!isPageRefresh) host.quizStateService._hasUserInteracted?.clear();

    host.quizStateService.resetInteraction();

    host.setupQuestionResetSubscription();
    host.resetExplanationService();

    // (Removed: setupShouldShowFet / setupFetToDisplay / initDisplayTextPipeline —
    // those built the displayText$/shouldShowFet$/fetToDisplay$ streams, which no
    // longer have any consumers since the heading became single-source.)
    host.setupContentAvailability();

    host.emitContentAvailableState();
    host.loadQuizDataFromRoute();
    await host.initializeComponent();

    host.quizService.questions$
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        filter((qs: any) => Array.isArray(qs) && qs.length > 0)
      )
      .subscribe(() => {});
  }


  /**
   * On timer expiry, resolve the LIVE question index (signal-first to avoid
   * stale Q(N) leaking into Q(N+1)), store the formatted explanation, and write
   * the FET directly to the qText DOM (bypassing the service/guard layers) with
   * navigation-guarded delayed retries. Extracted verbatim from runOnInit; this
   * is FET-display pipeline code — keep it byte-for-byte.
   */
  private subscribeToTimerExpiryFetWrite(host: Host): void {
    host.timerService.expired$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(() => this.handleTimerExpiry(host));
  }

  /**
   * Timer-expiry handler: resolve the LIVE question index (signal-first to avoid
   * stale Q(N) leaking into Q(N+1)), mark it timed out, store the formatted
   * explanation, write the FET to the DOM, and markForCheck. Extracted verbatim.
   */
  private handleTimerExpiry(host: Host): void {
    // Use signal-first idx resolution. host.currentIndex is a plain field
    // updated asynchronously by an effect, so it lags the signal by a
    // microtask. Reading it first prevents stale Q(N) timer expiry from
    // writing Q(N)'s FET into Q(N+1)'s heading after navigation.
    const sigIdx = host.questionIndex?.();
    const idx = (typeof sigIdx === 'number' && sigIdx >= 0)
      ? sigIdx
      : (host.currentIndex >= 0
          ? host.currentIndex
          : (host.quizService.getCurrentQuestionIndex?.() ?? host.currentQuestionIndexValue ?? 0));

    // A previously-answered question being revisited keeps its question text
    // even if its timer expires again — only a first-time (unanswered) expiry
    // stamps the FET. A genuine answer sets clickConfirmedDotStatus
    // ('correct'/'wrong'); skip the entire timeout-FET machinery (durable flag +
    // direct DOM write) so the heading stays the question text on revisit.
    const _dot = host.selectedOptionService?.clickConfirmedDotStatus?.get?.(idx);
    const alreadyAnswered = _dot === 'correct' || _dot === 'wrong'
      || host.quizService?.questionCorrectness?.get?.(idx) === true;
    if (alreadyAnswered) {
      host.cdRef.markForCheck();
      return;
    }

    host.timedOutIdxSig.set(idx);
    host.timedOutIdxSubject.next(idx);
    // DURABLE timeout record (same idx as timedOutIdxSubject) — survives nav so
    // the heading re-asserts the FET on revisit for any timed-out question.
    this.dotStatusService.timedOutFetForced.add(idx);
    (window as any).__quizTimerExpired = true;

    const isShuffled = host.quizService.isShuffleEnabled?.() && Array.isArray(host.quizService.shuffledQuestions) && host.quizService.shuffledQuestions.length > 0;
    let q = isShuffled
      ? host.quizService.shuffledQuestions[idx]
      : host.quizService.questions?.[idx];

    q = q ?? null;
    if (q?.explanation) {
      const visualOpts = host.quizQuestionComponent?.()?.optionsToDisplay ?? q.options;
      host.explanationTextService.storeFormattedExplanation(idx, q.explanation, q, visualOpts);
    }

    // Timer expiry no longer writes the heading directly — the single-source
    // headingHtml computed reacts to the timer-expiry signal and renders the FET
    // itself. storeFormattedExplanation (above) makes the FET text available to it.
    host.cdRef.markForCheck();
  }


  runOnDestroy(host: Host): void {
    host.combinedSub?.unsubscribe();
  }

  runQuestionIndexSet(host: Host, idx: number): void {
    this.questionNav.runQuestionIndexSet(host, idx);
  }

  runSetupQuestionResetSubscription(host: Host): void {
    const q$ = host.questionToDisplay$();
    if (!q$) return;
    combineLatest([
      q$.pipe(startWith(''), distinctUntilChanged()),
      host.quizService.currentQuestionIndex$.pipe(
        startWith(host.quizService?.currentQuestionIndex ?? 0)
      )
    ])
      .pipe(
        // Only act when the index actually changes. This was an `if` inside the
        // subscribe; as a filter it lets the answered-lookup below be flattened.
        map((pair: any) => pair[1] as number),
        filter((index: number) => host.lastQuestionIndexForReset !== index),
        tap((index: number) => {
          host.explanationTextService.setShouldDisplayExplanation(false);
          host.lastQuestionIndexForReset = index;
        }),
        // switchMap, NOT a nested subscribe. Two reasons:
        //  1) cancellation — a newer index must abandon the in-flight lookup for
        //     the previous one. Nested subscribes let both resolve, so a slow
        //     lookup for question N could land after N+1 and apply STALE state.
        //  2) lifetime — the inner stream now inherits takeUntilDestroyed below,
        //     so it can no longer write display state after the host is gone
        //     (take(1) prevented a leak but not a post-destroy write).
        // concatMap would preserve the stale write, mergeMap keeps the race, and
        // exhaustMap would drop legitimate newer indices.
        switchMap((index: number) => host.quizService.isAnswered(index).pipe(take(1))),
        takeUntilDestroyed(host.destroyRef)
      )
      .subscribe((isAnswered: boolean) => {
        if (!isAnswered) {
          host.quizStateService.setDisplayState({ mode: 'question', answered: false });
          host.explanationTextService.setIsExplanationTextDisplayed(false, { force: true });
        }
      });
  }

  runSetupContentAvailability(host: Host): void {
    host.isContentAvailable$ = host.combineCurrentQuestionAndOptions().pipe(
      map(({ currentQuestion, currentOptions }: { currentQuestion: QuizQuestion | null; currentOptions: Option[] }) => {
        return !!currentQuestion && currentOptions.length > 0;
      }),
      distinctUntilChanged(),
      catchError((_error: Error) => {
        return of(false);
      }),
      startWith(false)
    );

    host.isContentAvailable$
      .pipe(distinctUntilChanged())
      .subscribe(() => {});
  }

  runEmitContentAvailableState(host: Host): void {
    host.isContentAvailable$.pipe(takeUntilDestroyed(host.destroyRef)).subscribe({
      next: (isAvailable: boolean) => {
        host.isContentAvailableChange.emit(isAvailable);
        host.quizDataService.updateContentAvailableState(isAvailable);
      },
      error: () => { }
    });
  }

  runLoadQuizDataFromRoute(host: Host): void {
    this.questionNav.runLoadQuizDataFromRoute(host);
  }

  async runLoadQuestion(host: Host, quizId: string, zeroBasedIndex: number): Promise<void> {
    return this.questionNav.runLoadQuestion(host, quizId, zeroBasedIndex);
  }

  async runInitializeQuestionData(host: Host): Promise<void> {
    try {
      const params: ParamMap = await firstValueFrom(
        host.activatedRoute.paramMap.pipe(take(1))
      );

      const data: [QuizQuestion[], string[]] = await firstValueFrom(
        host.fetchQuestionsAndExplanationTexts(params).pipe(
          takeUntilDestroyed(host.destroyRef)
        )
      );

      const [questions, explanationTexts] = data;
      if (!questions || questions.length === 0) return;  // no questions found

      host.explanationTexts = explanationTexts;

      host.quizService.questions = questions;
      if (host.quizService.questions$ instanceof BehaviorSubject || 
        host.quizService.questions$ instanceof Subject
      ) {
        (host.quizService.questions$ as unknown as Subject<QuizQuestion[]>).next(questions);
      }

      for (const [index] of questions.entries()) {
        const explanation = host.explanationTexts[index] ?? 'No explanation available';
        host.explanationTextService.setExplanationTextForQuestionIndex(index, explanation);
      }

      host.explanationTextService.explanationsInitialized = true;

      host.initializeCurrentQuestionIndex();
    } catch (err: unknown) {
      swallow('cqc-orchestrator.service.ts initialization', err);
    }
  }

  runFetchQuestionsAndExplanationTexts(host: Host, params: ParamMap): Observable<[QuizQuestion[], string[]]> {
    host.setQuizId(params.get('quizId') ?? '');
    const qid = host.quizId();
    if (!qid) {
      return of([[], []] as [QuizQuestion[], string[]]);  // no quizId provided
    }

    return forkJoin([
      host.quizDataService.getQuestionsForQuiz(qid).pipe(
        catchError((_error: Error) => {
          return of([] as QuizQuestion[]);
        })
      ),
      host.quizDataService.getAllExplanationTextsForQuiz(qid).pipe(
        catchError((_error: Error) => {
          return of([] as string[]);
        })
      )
    ]).pipe(
      map((results: any) => {
        const [questions, explanationTexts] = results;
        return [questions as QuizQuestion[], explanationTexts as string[]];
      })
    );
  }

  runUpdateCorrectAnswersDisplay(host: Host, question: QuizQuestion | null): Observable<void> {
    if (!question) return of(void 0);

    return host.quizQuestionManagerService
      .isMultipleAnswerQuestion(question)
      .pipe(
        tap((isMultipleAnswer: boolean) => {
          // DECLARED, not tallied — `question.options.filter(o => o.correct)`
          // made this banner an answer-key read. Null omits it.
          const bannerCount = bannerCorrectCount(
            isMultipleAnswer, this.topicQuizTypeRegistry, question.questionText
          );
          const explanationDisplayed = host.explanationTextService.isExplanationTextDisplayedSig();
          const newCorrectAnswersText =
            bannerCount !== null && !explanationDisplayed
              ? host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
                bannerCount,
                question.options?.length ?? 0
              )
              : '';

          if (host.correctAnswersTextSig() !== newCorrectAnswersText) {
            host.correctAnswersTextSig.set(newCorrectAnswersText);
          }
        }),
        map(() => void 0)
      );
  }

  runInitializeCombinedQuestionData(host: Host): void {
    const currentQuizAndOptions$ = host.combineCurrentQuestionAndOptions();

    currentQuizAndOptions$.pipe(takeUntilDestroyed(host.destroyRef)).subscribe({
      next: () => {},
      error: () => { }
    });

    host.setCombinedQuestionData$(combineLatest([
      currentQuizAndOptions$.pipe(
        startWith<{
          currentQuestion: QuizQuestion | null;
          currentOptions: Option[];
          explanation: string;
          currentIndex: number;
        } | null>(null)
      ),
      host.numberOfCorrectAnswers$.pipe(startWith(0)),
      host.isExplanationTextDisplayed$.pipe(startWith(false)),
      host.activeFetText$.pipe(startWith(''))
    ]).pipe(
      map((arr: any): CombinedQuestionDataType => this.mapToCombinedQuestionData(host, arr)),
      filter((data: CombinedQuestionDataType | null): data is CombinedQuestionDataType => data !== null),
      catchError((_error: Error) => of<CombinedQuestionDataType>(this.buildCombinedQuestionDataFallback())),
    ));
  }

  /** Project the combineLatest tuple into combined question data. Extracted verbatim. */
  private mapToCombinedQuestionData(host: Host, arr: any): CombinedQuestionDataType {
    const quiz: { currentQuestion: QuizQuestion | null; currentOptions: Option[]; explanation: string; currentIndex: number; } | null = arr[0];
    const numberOfCorrectAnswers: number | string = arr[1];
    const isExplanationDisplayed: boolean = arr[2];
    const formattedExplanation: string = arr[3];
    const safeQuizData = quiz?.currentQuestion
      ? quiz
      : { currentQuestion: null, currentOptions: [], explanation: '', currentIndex: 0 };

    const currentQuizData = this.buildCurrentQuizData(safeQuizData, !!isExplanationDisplayed);

    return host.calculateCombinedQuestionData(
      currentQuizData,
      +(numberOfCorrectAnswers ?? 0),
      !!isExplanationDisplayed,
      formattedExplanation ?? ''
    );
  }

  /** Build the pre-calculation combined-question-data shape from the safe quiz data. */
  private buildCurrentQuizData(safeQuizData: any, isExplanationDisplayed: boolean): CombinedQuestionDataType {
    const selectionMessage =
      'selectionMessage' in safeQuizData
        ? (safeQuizData as any).selectionMessage || ''
        : '';
    return {
      currentQuestion: safeQuizData.currentQuestion,
      currentOptions: safeQuizData.currentOptions ?? [],
      options: safeQuizData.currentOptions ?? [],
      questionText: safeQuizData.currentQuestion?.questionText || 'No question available',
      explanation: safeQuizData.explanation ?? '',
      correctAnswersText: '',
      isExplanationDisplayed,
      isNavigatingToPrevious: false,
      selectionMessage
    };
  }

  /** The error fallback for the combined-question-data stream. Extracted verbatim. */
  private buildCombinedQuestionDataFallback(): CombinedQuestionDataType {
    return {
      currentQuestion: {
        questionText: 'Error loading question',
        options: [],
        explanation: '',
        selectedOptions: [],
        answer: [],
        selectedOptionIds: [],
        type: undefined as any,
        maxSelections: 0
      },
      currentOptions: [],
      options: [],
      questionText: 'Error loading question',
      explanation: '',
      correctAnswersText: '',
      isExplanationDisplayed: false,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runCombineCurrentQuestionAndOptions(host: Host): Observable<{
    currentQuestion: QuizQuestion | null;
    currentOptions: Option[];
    explanation: string;
    currentIndex: number;
  }> {
    return host.quizService.questionPayload$.pipe(
      withLatestFrom(host.quizService.currentQuestionIndex$),
      filter(
        (value: [QuestionPayload | null, number]): value is [QuestionPayload, number] => {
          const [payload] = value;
          return (
            !!payload &&
            !!payload.question &&
            Array.isArray(payload.options) &&
            payload.options.length > 0
          );
        }
      ),
      map(([payload, index]: [QuestionPayload, number]) => ({
        payload,
        index: Number.isFinite(index)
          ? index
          : host.currentIndex >= 0
            ? host.currentIndex
            : 0
      })),
      map(({ payload, index }: { payload: QuestionPayload; index: number }) => {
        const normalizedOptions = payload.options
          .map((option, optionIndex) => ({
            ...option,
            optionId: typeof option.optionId === 'number' ? option.optionId : optionIndex + 1,
            displayOrder: typeof option.displayOrder === 'number' ? option.displayOrder : optionIndex
          }))
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

        const normalizedQuestion: QuizQuestion = {
          ...payload.question,
          options: normalizedOptions
        };

        return {
          currentQuestion: normalizedQuestion,
          currentOptions: normalizedOptions,
          explanation:
            payload.explanation?.trim() ||
            payload.question.explanation?.trim() ||
            '',
          currentIndex: index
        };
      }),
      distinctUntilChanged(
        (prev: { currentQuestion: QuizQuestion; currentOptions: Option[]; explanation: string; currentIndex: number },
          curr: { currentQuestion: QuizQuestion; currentOptions: Option[]; explanation: string; currentIndex: number }) => {
          const norm = (s?: string) =>
            (s ?? '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .trim()
              .toLowerCase()
              .replace(/\s+/g, ' ');

          const questionKey = (q: QuizQuestion | null | undefined, idx?: number) => {
            const textKey = norm(q?.questionText);
            return `${textKey}#${Number.isFinite(idx) ? idx : -1}`;
          };

          const sameQuestion =
            questionKey(prev.currentQuestion, prev.currentIndex) ===
            questionKey(curr.currentQuestion, curr.currentIndex);
          if (!sameQuestion) return false;

          if (prev.explanation !== curr.explanation) return false;

          return host.haveSameOptionOrder(prev.currentOptions, curr.currentOptions);
        }),
      shareReplay({ bufferSize: 1, refCount: true }),
      catchError((_error: Error) => {
        return of({
          currentQuestion: null,
          currentOptions: [],
          explanation: '',
          currentIndex: -1
        });
      })
    );
  }

  /** The "no question available" combined-question-data shape. Extracted verbatim. */
  private emptyCombinedQuestionData(): CombinedQuestionDataType {
    return {
      currentQuestion: null,
      currentOptions: [],
      options: [],
      questionText: 'No question available',
      explanation: '',
      correctAnswersText: '',
      isExplanationDisplayed: false,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runCalculateCombinedQuestionData(
    host: Host,
    currentQuizData: CombinedQuestionDataType,
    numberOfCorrectAnswers: number,
    isExplanationDisplayed: boolean,
    formattedExplanation: string
  ): CombinedQuestionDataType {
    const { currentQuestion, currentOptions } = currentQuizData;

    if (!currentQuestion) {
      return this.emptyCombinedQuestionData();
    }

    const normalizedCorrectCount = Number.isFinite(numberOfCorrectAnswers) ? numberOfCorrectAnswers : 0;

    const totalOptions = Array.isArray(currentOptions)
      ? currentOptions.length
      : Array.isArray(currentQuestion?.options)
        ? currentQuestion.options.length : 0;

    const isMultipleAnswerQuestion =
      currentQuestion.type === QuestionType.MultipleAnswer ||
      (Array.isArray(currentQuestion.options)
        ? currentQuestion.options.filter((option) => option.correct).length > 1
        : false);

    // DECLARED, not tallied. `normalizedCorrectCount` is derived from the local
    // key upstream; the banner no longer consumes it.
    const bannerCount = bannerCorrectCount(
      isMultipleAnswerQuestion, this.topicQuizTypeRegistry, currentQuestion.questionText
    );
    const correctAnswersText =
      bannerCount !== null
        ? host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
          bannerCount, totalOptions
        )
        : '';

    const explanationText = isExplanationDisplayed
      ? formattedExplanation?.trim() || currentQuizData.explanation || currentQuestion.explanation || ''
      : '';

    return {
      currentQuestion: currentQuestion,
      currentOptions: currentOptions,
      options: currentOptions ?? [],
      questionText: currentQuestion.questionText,
      explanation: explanationText,
      correctAnswersText,
      isExplanationDisplayed: isExplanationDisplayed,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runHaveSameOptionOrder(_host: Host, left: Option[] = [], right: Option[] = []): boolean {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;

    return left.every((option, index) => {
      const other = right[index];
      if (!other) return false;
      const optionText = (option.text ?? '').toString();
      const otherText = (other.text ?? '').toString();
      return (
        option.optionId === other.optionId &&
        option.displayOrder === other.displayOrder &&
        optionText === otherText
      );
    });
  }

  runNormalizeKeySource(_host: Host, value: string | null | undefined): string {
    return (value ?? '')
      .toString()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}