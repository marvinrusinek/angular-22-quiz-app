import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { PracticeSessionService } from '../../../shared/services/features/practice/practice-session.service';
import { PracticeOptionsComponent } from '../../../components/practice/practice-options/practice-options.component';
import { PracticeVerdictService } from '../../../shared/services/features/practice/practice-verdict.service';
import { TopicQuizMetadataService } from '../../../shared/services/api/topic-quiz-metadata.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';

/**
 * Weak Areas Practice session — a THIN container.
 *
 * It deliberately does not reuse QuizComponent: that component owns the topic
 * quiz's load/navigation/timer lifecycle, and driving a dynamically generated,
 * untimed session through it would put the normal quiz flow at risk. Instead the
 * session state lives in PracticeSessionService and this container renders it
 * with PracticeOptionsComponent.
 *
 * Practice is a LEARNING mode: untimed, with the source topic labelled on every
 * question. Feedback and navigation follow the VERIFIED topic-quiz rules exactly
 * (see practice-scoring.ts) — Interview Mode's deferred policy is never engaged,
 * and no new selection or scoring semantics are introduced.
 */
@Component({
  selector: 'codelab-weak-areas-practice',
  standalone: true,
  imports: [RouterLink, PracticeOptionsComponent, ThemeToggleComponent, ScrollDownIndicatorComponent],
  templateUrl: './weak-areas-practice.component.html',
  styleUrls: ['./weak-areas-practice.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onGlobalKey($event)' }
})
export class WeakAreasPracticeComponent {
  private readonly session = inject(PracticeSessionService);
  private readonly router = inject(Router);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  readonly total = this.session.total;
  private readonly verdicts = inject(PracticeVerdictService);
  private readonly metadataApi = inject(TopicQuizMetadataService);

  readonly currentIndex = this.session.currentIndex;
  readonly currentQuestion = this.session.currentQuestion;
  readonly answersByIndex = this.session.answersByIndex;
  readonly answeredCount = this.session.answeredCount;
  readonly allAnswered = this.session.allAnswered;
  readonly canGoPrevious = this.session.canGoPrevious;
  readonly canGoNext = this.session.canGoNext;
  readonly canSubmit = this.session.canSubmit;
  readonly isLastQuestion = this.session.isLastQuestion;
  readonly isCurrentAnswered = this.session.isCurrentAnswered;
  readonly isCurrentResolved = this.session.isCurrentResolved;
  readonly isCurrentMultiAnswer = this.session.isCurrentMultiAnswer;
  readonly currentSelection = this.session.currentSelection;

  readonly displayNumber = computed(() => this.currentIndex() + 1);

  /** Human-readable source topic for the current question. Never colour alone. */
  readonly currentTopicName = computed(() => {
    const sourceQuizId = this.currentQuestion()?.sourceQuizId;
    if (!sourceQuizId) return '';
    // FROM /quizzes. "Topic name" and the catalogue's `milestone` are the same
    // field — topicId IS the quizId — so this is a metadata lookup, not a bank
    // read. Falls back to the id exactly as before if metadata is not in yet.
    this.metadataApi.milestoneByQuiz();   // track so the label fills in on load
    return this.metadataApi.milestoneFor(sourceQuizId);
  });

  /**
   * The FET, revealed on the SAME rule as the topic quiz: only once the question
   * is RESOLVED — the correct option for single/true-false, the complete correct
   * set for multi-answer. A wrong or partial selection never reveals it.
   * Explanations for questions the user got wrong are available afterwards in
   * Practice Results → Answer Review.
   */
  readonly explanation = computed(() => {
    if (!this.isCurrentResolved()) return '';
    const question = this.currentQuestion();
    if (!question?.sourceQuizId) return '';
    // The explanation is released BY THE SERVER with the reveal. API-sourced
    // questions carry none of their own — it is answer-key material, and the
    // /check response is the only thing entitled to hand it over.
    return this.verdicts.verdictFor(question.sourceQuizId, question.questionText ?? '').explanation;
  });

  constructor() {
    // Move focus to the practice heading after navigation so keyboard and screen
    // reader users land on the session rather than at the top of the document.
    afterNextRender(() => this.heading()?.nativeElement.focus());
  }

  /**
   * Record the selection, then ask the SERVER whether it is right.
   *
   * The check is fired on every selection change, which is what keeps a wrong
   * pick marked immediately and a completed multi-answer set resolving on the
   * click that completes it. A failed check leaves the question unresolved
   * rather than guessing — there is no local answer key to fall back on.
   */
  onSelectionChange(optionIds: number[]): void {
    const index = this.currentIndex();
    this.session.select(index, optionIds);

    const question = this.currentQuestion();
    const quizId = question?.sourceQuizId;
    if (!question || !quizId) return;

    const selectedTexts = (question.options ?? [])
      .filter((option) => option.optionId != null && optionIds.includes(option.optionId))
      .map((option) => option.text ?? '')
      .filter((text) => text.length > 0);

    if (selectedTexts.length === 0) return;

    this.verdicts
      .check(quizId, question.questionText ?? '', selectedTexts)
      .subscribe({ error: () => { /* verdict marked errored; UI stays neutral */ } });
  }

  /** Correct option texts the server released for the current question. */
  readonly revealedCorrectTexts = computed<readonly string[]>(() => {
    const question = this.currentQuestion();
    if (!question?.sourceQuizId) return [];
    return this.verdicts.verdictFor(question.sourceQuizId, question.questionText ?? '').correctTexts;
  });

  /** Picked option texts the server judged wrong. Never unpicked options. */
  readonly knownIncorrectTexts = computed<readonly string[]>(() => {
    const question = this.currentQuestion();
    if (!question?.sourceQuizId) return [];
    const verdict = this.verdicts.verdictFor(question.sourceQuizId, question.questionText ?? '');
    const wrong: string[] = [];
    for (const option of question.options ?? []) {
      const text = option.text ?? '';
      if (!text) continue;
      if (verdict.selectedVerdicts.get(normalizeText(text)) === false) wrong.push(text);
    }
    return wrong;
  });

  previous(): void {
    this.session.previous();
  }

  next(): void {
    this.session.next();
  }

  /** Score the session and move to Results. Same gate as the visible button. */
  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.session.submit();
    await this.router.navigate(['/practice/results']);
  }

  /**
   * Keyboard navigation, matching the interview session's shortcuts. Ignored
   * while the user is typing in a field.
   *
   * ArrowRight calls the SAME session.next() the Next button calls, so it obeys
   * the identical gate — a partial multi-answer cannot be skipped with the
   * keyboard. It deliberately does NOT submit; ending the session stays an
   * explicit click.
   */
  onGlobalKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowLeft') {
      this.previous();
    } else if (event.key === 'ArrowRight') {
      this.next();
    }
  }

  /**
   * Leaves the session and drops it. `replaceUrl` keeps the abandoned session
   * out of the history entry the user would return to with browser Back.
   */
  async backToQuizzes(): Promise<void> {
    this.session.clear();
    await this.router.navigate(['/quiz'], { replaceUrl: true });
  }
}

/** Matches the server's canonicalization closely enough to compare texts. */
function normalizeText(text: string | null | undefined): string {
  return (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
