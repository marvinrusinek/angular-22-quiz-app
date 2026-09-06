import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';

import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { Toolbar, ToolbarWidget, ToolbarWidgetGroup } from '@angular/aria/toolbar';

import { SK_USER_ANSWERS } from '../../../shared/constants/session-keys';

import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { Result } from '../../../shared/models/Result.model';

import { ExplanationTextService } from '../../../shared/services/features/explanation/explanation-text.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

import { norm } from '../../../shared/utils/text-norm';
import { swallow } from '../../../shared/utils/error-logging';
import { CodeSnippetComponent } from '../../../components/code-snippet/code-snippet.component';

export type ReviewFilter = 'all' | 'incorrect' | 'correct';

@Component({
  selector: 'codelab-results-accordion',
  standalone: true,
  imports: [MatExpansionModule, MatIconModule, Toolbar, ToolbarWidget, ToolbarWidgetGroup, CodeSnippetComponent],
  templateUrl: './accordion.component.html',
  styleUrls: ['./accordion.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccordionComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  // ── inputs ──────────────────────────────────────────────────────
  readonly questionsInput = input<QuizQuestion[]>([], { alias: 'questions' });
  readonly isShuffled = input(false);
  readonly accordionHeaderLabel = input('', { alias: 'headerLabel' });

  // ── remaining variables ─────────────────────────────────────────
  readonly questions = signal<QuizQuestion[]>([]);

  // ── review filter ───────────────────────────────────────────────
  readonly reviewFilter = signal<ReviewFilter>('all');

  // Questions for the current review filter, each paired with its ORIGINAL
  // index. The accordion's correctness/selection lookups are index-keyed, so
  // the original index must be preserved rather than re-derived from the
  // filtered array's position. Correctness uses the same
  // checkIfAnswersAreCorrectFromService that drives the done/clear icons, so
  // the filter always matches what's shown.
  // Per-question correctness captured in the persisted result snapshot, keyed by
  // NORMALIZED question text (identity — not array index), so it survives the
  // live selection maps being wiped on leave AND any question reordering on
  // revisit. Empty for legacy snapshots → the live derivation is used instead.
  private readonly analysisByQuestion = computed<Map<string, boolean>>(() => {
    const map = new Map<string, boolean>();
    for (const a of this.quizService.getFinalResultSnapshot()?.analysis ?? []) {
      if (a?.questionText) map.set(norm(a.questionText), a.wasCorrect);
    }
    return map;
  });

  readonly filteredQuestions = computed<{ question: QuizQuestion; index: number }[]>(() => {
    const filter = this.reviewFilter();
    const withIndex = this.questions().map((question, index) => ({ question, index }));
    switch (filter) {
      case 'correct':
        return withIndex.filter(({ question, index }) => this.isQuestionCorrect(question, index));
      case 'incorrect':
        return withIndex.filter(({ question, index }) => !this.isQuestionCorrect(question, index));
      default:
        return withIndex;
    }
  });

  // Counts shown on the filter buttons (e.g. "Correct (7)").
  readonly correctCount = computed(
    () => this.questions().filter((question, index) => this.isQuestionCorrect(question, index)).length
  );
  readonly incorrectCount = computed(() => this.questions().length - this.correctCount());

  /**
   * Authoritative per-question correctness for the review. Prefers the persisted
   * snapshot analysis (captured at completion, matched by question text); falls
   * back to the live selection-map derivation only when no analysis exists.
   */
  isQuestionCorrect(question: QuizQuestion, questionIndex: number): boolean {
    const map = this.analysisByQuestion();
    if (map.size > 0 && question?.questionText) {
      const captured = map.get(norm(question.questionText));
      if (captured !== undefined) return captured;
    }
    return this.checkIfAnswersAreCorrectFromService(question, questionIndex);
  }

  setReviewFilter(filter: ReviewFilter): void {
    this.reviewFilter.set(filter);
  }

  /**
   * Angular Aria's ngToolbar reports the user's selection here on click/
   * Enter/Space; `reviewFilter` (fed back in via `[value]="[reviewFilter()]"`)
   * remains the ONE authoritative signal — this only relays the toolbar's
   * report into the existing setter, exactly as a click handler always did.
   */
  onReviewFilterToolbarChange(values: readonly ReviewFilter[]): void {
    const next = values[0];
    if (next !== undefined) this.setReviewFilter(next);
  }

  results: Result = {
    userAnswers: [],
    elapsedTimes: [],
  };

  private hasRetried = false;

  constructor() {
    effect(() => {
      const incoming = this.questionsInput();
      if (Array.isArray(incoming) && incoming.length > 0) {
        this.questions.set(incoming);
      }
    });

    effect(() => {
      const questions = this.quizService.questionsSig();
      this.questions.set(questions);

      if (questions.length === 0 && !this.hasRetried) {
        this.hasRetried = true;
        this.retryLoadQuestionsViaDataService();
      }
    });
  }

  ngOnInit(): void {
    const userAnswersData = this.recoverUserAnswers();
    this.initializeResults(userAnswersData);
    this.loadInitialQuestionsFromService();
    this.normalizeUserAnswers();
  }

  checkIfAnswersAreCorrect(question: QuizQuestion, userAnswers: any[], index: number): boolean {
    const userIds = userAnswers[index];
    if (!userIds || (Array.isArray(userIds) && userIds.length === 0)) return false;

    // Convert IDs to visual indices for comparison
    const userIndices = this.getUserAnswerIndices(question, userIds);
    const correctIndices = this.getCorrectOptionIndices(question, index);

    if (userIndices.length !== correctIndices.length) return false;

    // Check if every user index is in correct indices
    return userIndices.every((ui) => correctIndices.includes(ui));
  }

  getUserAnswerIndices(question: QuizQuestion, userIds: number | number[]): number[] {
    if (!question || !question.options || !userIds) return [];

    const ids = Array.isArray(userIds) ? userIds : [userIds];

    return ids
      .map((id: number) => {
        // Try matching by optionId first
        let idx = question.options.findIndex(
          (opt: Option) => opt.optionId != null && String(opt.optionId) === String(id)
        );

        // Fallback: treat id as a 0-based display index (used when options lack optionId)
        if (idx === -1 && id >= 0 && id < question.options.length) idx = id;

        return idx >= 0 ? idx + 1 : -1;
      })
      .filter((idx: number) => idx !== -1)
      .sort((a, b) => a - b);
  }

  getCorrectOptionIndices(question: QuizQuestion, index?: number): number[] {
    return this.explanationTextService.getCorrectOptionIndices(question, undefined, index);
  }

  formatOptionList(indices: number[]): string {
    if (!indices || indices.length === 0) return '';
    if (indices.length === 1) return `Option ${indices[0]}`;
    if (indices.length === 2) return `Options ${indices[0]} and ${indices[1]}`;
    const last = indices[indices.length - 1];
    const rest = indices.slice(0, -1).join(', ');
    return `Options ${rest}, and ${last}`;
  }

  // ── Timer expiry (countdown only) ───────────────────────────────
  // A question "timed out" when its elapsed time reached the per-question
  // countdown duration. Stopwatch mode has no expiry, so always false.
  isQuestionTimedOut(index: number): boolean {
    if (!this.timerService.isCountdown()) return false;
    const duration = this.timerService.timePerQuestion;
    const elapsed = this.results.elapsedTimes?.[index] ?? 0;
    return duration > 0 && elapsed >= duration;
  }

  get timedOutCount(): number {
    if (!this.timerService.isCountdown()) return 0;
    const total = this.questions().length;
    let count = 0;
    for (let i = 0; i < total; i++) {
      if (this.isQuestionTimedOut(i)) count++;
    }
    return count;
  }

  // Get selected options directly from SelectedOptionService for a given question index
  // Returns visual 1-based indices (Option 1, Option 2, etc.) in SELECTION ORDER (not sorted)
  getSelectedOptionsForQuestion(questionIndex: number): { text: string; visualIndex: number }[] {
    const question = this.questions()[questionIndex];
    if (!question || !question.options) return [];

    const matchOption = (sel: any): number => {
      // Match by optionId (when both sides have it)
      let idx = question.options.findIndex(
        (opt: Option) =>
          opt.optionId != null &&
          sel.optionId != null &&
          sel.optionId !== -1 &&
          String(opt.optionId) === String(sel.optionId)
      );
      // Match by text
      if (idx === -1 && sel.text) {
        idx = question.options.findIndex((opt: Option) => opt.text === sel.text);
      }
      // Fallback: treat optionId as display index (when options lack optionId)
      if (
        idx === -1 &&
        typeof sel.optionId === 'number' &&
        sel.optionId >= 0 &&
        sel.optionId < question.options.length
      ) {
        idx = sel.optionId;
      }
      return idx;
    };

    // Try rawSelectionsMap first (more reliable)
    const rawSelections = this.selectedOptionService.rawSelectionsMap.get(questionIndex);
    if (rawSelections && rawSelections.length > 0) {
      return rawSelections
        .map((sel: any) => {
          const visualIdx = matchOption(sel);
          return {
            text:
              sel.text ||
              (visualIdx >= 0 ? question.options[visualIdx]?.text : '') ||
              `Option ${visualIdx + 1}`,
            visualIndex: visualIdx >= 0 ? visualIdx + 1 : 0,
          };
        })
        .filter((o: any) => o.visualIndex > 0);
    }

    // Fallback to selectedOptionsMap
    const selections = this.selectedOptionService.selectedOptionsMap.get(questionIndex);
    if (!selections || selections.length === 0) return [];

    return selections
      .map((sel: any) => {
        const visualIdx = matchOption(sel);
        return {
          text:
            sel.text ||
            (visualIdx >= 0 ? question.options[visualIdx]?.text : '') ||
            `Option ${visualIdx + 1}`,
          visualIndex: visualIdx >= 0 ? visualIdx + 1 : 0,
        };
      })
      .filter((o: any) => o.visualIndex > 0);
  }

  // Check if we have any selections from the service for this question
  hasSelectionsFromService(questionIndex: number): boolean {
    const rawSelections = this.selectedOptionService.rawSelectionsMap.get(questionIndex);
    if (rawSelections && rawSelections.length > 0) return true;

    const selections = this.selectedOptionService.selectedOptionsMap.get(questionIndex);
    return !!selections && selections.length > 0;
  }

  // Check if user selections match correct answers for a question (using service data)
  // Returns true if ALL correct answers are INCLUDED in the user's selections
  checkIfAnswersAreCorrectFromService(question: QuizQuestion, questionIndex: number): boolean {
    if (!question || !question.options) return false;

    // Get correct option texts
    const correctTexts = question.options.filter((opt) => opt.correct).map((opt) => norm(opt.text));

    // Get selected option texts
    const selectedOpts = this.getSelectedOptionsForQuestion(questionIndex);
    const selectedTexts = selectedOpts.map((o) => norm(o.text));

    // Check if ALL correct answers are included in selections
    return correctTexts.every((ct) => selectedTexts.includes(ct));
  }

  // Recover selections from durable localStorage store. clearState/resetAll
  // wipes rawSelectionsMap AND sessionStorage, but the durable
  // 'quizAnswersForResults' key in localStorage survives. Falls back to the
  // service's userAnswers if localStorage is empty.
  private recoverUserAnswers(): any[] {
    this.selectedOptionService.recoverAnswersForResults();

    let storedAnswers: any[] = [];
    try {
      const stored = localStorage.getItem(SK_USER_ANSWERS);
      storedAnswers = stored ? JSON.parse(stored) : [];
    } catch (err) {
      swallow('accordion.component#1', err);
    }

    return storedAnswers.length > 0 ? storedAnswers : this.quizService.userAnswers;
  }

  private initializeResults(userAnswersData: any[]): void {
    this.results = {
      userAnswers: userAnswersData,
      elapsedTimes: this.timerService.elapsedTimes,
    };
  }

  // For navigation-back scenarios — populate from service state synchronously
  // so the accordion renders without waiting for the questions$ stream.
  private loadInitialQuestionsFromService(): void {
    const currentQuestions = this.quizService.questions;
    if (currentQuestions && currentQuestions.length > 0) {
      this.questions.set(currentQuestions);
    }
  }

  // Fallback path when questions$ emits empty: resolve quizId from route or
  // service, then fetch directly from QuizDataService (bypasses shuffling /
  // state complexity).
  private retryLoadQuestionsViaDataService(): void {
    // Use a small timeout to let other initializations settle
    setTimeout(() => {
      const id = this.resolveQuizId();
      if (!id) return;

      this.quizDataService
        .getQuestionsForQuiz(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((qs: QuizQuestion[]) => {
          if (qs && qs.length > 0) {
            this.questions.set(qs);
          }
        });
    }, 100);
  }

  // Priority: URL params > service state. Syncs the service if the URL had
  // a different id so downstream consumers see consistent state.
  private resolveQuizId(): string | null {
    let id =
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      this.activatedRoute.parent?.snapshot.paramMap.get('quizId') ||
      null;

    if (!id) {
      id = this.quizService.quizId;
    } else if (this.quizService.quizId !== id) {
      this.quizService.setQuizId(id);
    }

    return id;
  }

  // Coerce userAnswers entries into arrays so Angular's template can iterate
  // them uniformly (raw values come back as either scalar or array).
  private normalizeUserAnswers(): void {
    if (!this.results?.userAnswers) return;
    this.results.userAnswers = this.results.userAnswers.map((ans) =>
      Array.isArray(ans) ? ans : ans !== null && ans !== undefined ? [ans] : []
    );
  }
}
