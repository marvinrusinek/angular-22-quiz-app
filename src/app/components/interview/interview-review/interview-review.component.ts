import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { Toolbar, ToolbarWidget, ToolbarWidgetGroup } from '@angular/aria/toolbar';

import type {
  InterviewResultViewModel,
  InterviewReviewQuestionViewModel
} from '../../../shared/models/interview/interview-view-models';
import {
  REVIEW_FILTERS,
  ReviewFilterDef,
  ReviewFilterId,
  ReviewStatus
} from './interview-review-filters';
import {
  countReviewStatuses,
  getReviewOptionLabel,
  getReviewOptionState,
  InterviewReviewOptionState,
  joinWithAnd
} from './interview-review-status';

// Re-exported so existing importers keep working after the type moved to the
// pure filters module.
export type { ReviewStatus, ReviewFilterId };

/** Server question type → the chip label shown beside the topic. */
function questionTypeLabel(type: InterviewReviewQuestionViewModel['type']): string {
  if (type === 'multiple') return $localize`Multiple answer`;
  if (type === 'trueFalse') return $localize`True or false`;
  return $localize`Single answer`;
}

interface ReviewOptionView {
  text: string;
  state: InterviewReviewOptionState;
  label: string;
  cssClass: string;   // 'rv-correct' | 'rv-wrong' | ''  (visual only)
  mark: string;       // decorative ✓ / ✕ (aria-hidden)
}

interface ReviewItem {
  number: number;
  topicName: string;
  typeLabel: string;
  questionText: string;
  explanation: string;
  status: ReviewStatus;
  /** Reserved for a future flagging feature; always false until then. */
  flagged: boolean;
  options: ReviewOptionView[];
  /** "A and C" — shown for multi-answer / unanswered where it aids clarity. */
  correctSummary: string;
}

/**
 * Post-submission per-question Review for Interview Mode. Unlike the active
 * assessment (feedback deferred), the Review DOES show correctness: each
 * question's status, the user's selected answer(s), the correct answer(s), and
 * the explanation. Filterable by All / Incorrect / Unanswered / Correct.
 *
 * READ-ONLY: options render as inert list items (never active-session controls),
 * inputs are treated as immutable, and it never mutates answers/result/session.
 * The summary uses the submitted InterviewResult as the source of truth.
 */
@Component({
  selector: 'app-interview-review',
  standalone: true,
  imports: [TitleCasePipe, Toolbar, ToolbarWidget, ToolbarWidgetGroup],
  templateUrl: './interview-review.component.html',
  styleUrls: ['./interview-review.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewReviewComponent {
  /**
   * FROZEN backend review data. Question order, option order, correctness and
   * explanations are exactly what the server recorded at finalization, so an
   * edit to the quiz bank cannot alter a completed attempt.
   */
  readonly questions = input.required<readonly InterviewReviewQuestionViewModel[]>();
  // The submitted result — the source of truth for the summary + header meta.
  readonly result = input<InterviewResultViewModel | null>(null);
  // Optional header meta (from the just-recorded history entry), shown when set.
  readonly attemptNumber = input<number | null>(null);
  readonly completedAt = input<string | null>(null);
  // Future-ready: when a flagging feature ships, set this true (or populate
  // item.flagged) and the Flagged chip appears with no other change.
  readonly flaggingEnabled = input<boolean>(false);
  // Embedded mode: hide the internal header meta (attempt #, date, score, etc.)
  // when the host page already shows that context (e.g. the Interview History
  // detail page). Purely presentational; the review list is unchanged.
  readonly embedded = input<boolean>(false);

  readonly filter = signal<ReviewFilterId>('all');

  // topicId → FROZEN backend title. Never re-resolved from the local quiz bank,
  // so a renamed or removed topic still reads as it did at completion time.
  private readonly topicNames = computed<Map<string, string>>(
    () => new Map((this.result()?.byTopic ?? []).map((t) => [t.topicId, t.title]))
  );

  readonly items = computed<ReviewItem[]>(() => {
    const topics = this.topicNames();

    // Server order is preserved verbatim — no re-sort and no All-of-the-above
    // re-pin. The user saw a specific order during the assessment and the
    // review must match it.
    return (this.questions() ?? []).map((q, i) => {
      const selectedIds = new Set(q.selectedOptionIds);
      const correctIds = new Set(q.correctOptionIds);

      // Correctness comes from the two ID LISTS only. There is no `correct`
      // flag on an option any more, and none is reintroduced here.
      const status: ReviewStatus = !q.isAnswered
        ? 'unanswered'
        : q.isCorrect
          ? 'correct'
          : 'incorrect';

      const options: ReviewOptionView[] = q.options.map((o) => {
        const state = getReviewOptionState(correctIds.has(o.optionId), selectedIds.has(o.optionId));
        return {
          text: o.text,
          state,
          label: getReviewOptionLabel(state),
          cssClass:
            state === 'incorrect-selected'
              ? 'rv-wrong'
              : state === 'correct-selected' || state === 'correct-missed'
                ? 'rv-correct'
                : '',
          mark: state === 'incorrect-selected' ? '✕' : state === 'neutral' ? '' : '✓'
        };
      });

      const correctLabels = q.options
        .filter((o) => correctIds.has(o.optionId))
        .map((o) => o.text);
      // A concise "Correct answers: …" line helps most for multi-answer questions
      // and for questions the user skipped; single-answer answered questions read
      // clearly from the option labels alone.
      const showSummary =
        (correctLabels.length > 1 || status === 'unanswered') && correctLabels.length > 0;

      return {
        number: i + 1,
        topicName: topics.get(q.sourceQuizId) ?? '',
        typeLabel: questionTypeLabel(q.type),
        questionText: q.questionText,
        explanation: q.explanation,
        status,
        flagged: false,
        options,
        correctSummary: showSummary ? joinWithAnd(correctLabels) : ''
      };
    });
  });

  // Summary — the submitted result is authoritative; fall back to the derived
  // per-question tally only if no result was supplied.
  readonly summary = computed(() => {
    const r = this.result();
    if (r) {
      return { correct: r.correct, incorrect: r.incorrect, unanswered: r.unanswered, total: r.total };
    }
    return countReviewStatuses(this.items().map((i) => i.status));
  });

  readonly completionReason = computed(() =>
    this.result()?.submittedByExpiry ? $localize`Time expired` : $localize`Submitted`
  );

  private readonly anyFlagged = computed(() => this.items().some((i) => i.flagged));

  readonly visibleFilters = computed<ReviewFilterDef[]>(() =>
    REVIEW_FILTERS.filter(
      (f) => !f.requiresFlagging || this.flaggingEnabled() || this.anyFlagged()
    )
  );

  readonly counts = computed<Record<ReviewFilterId, number>>(() => {
    const items = this.items();
    const out = {} as Record<ReviewFilterId, number>;
    for (const f of REVIEW_FILTERS) {
      out[f.id] = items.filter((i) => f.match(i)).length;
    }
    return out;
  });

  readonly activeFilter = computed<ReviewFilterDef>(
    () => REVIEW_FILTERS.find((f) => f.id === this.filter()) ?? REVIEW_FILTERS[0]
  );

  readonly filtered = computed<ReviewItem[]>(() => {
    const match = this.activeFilter().match;
    return this.items().filter((i) => match(i));   // preserves original order
  });

  setFilter(id: ReviewFilterId): void {
    this.filter.set(id);
  }

  /**
   * Angular Aria's ngToolbar reports the user's selection here on click/
   * Enter/Space; `filter` (fed back in via `[value]="[filter()]"`) remains
   * the ONE authoritative signal — this only relays the toolbar's report
   * into the existing setter, exactly as a click handler always did.
   */
  onFilterToolbarChange(values: readonly ReviewFilterId[]): void {
    const next = values[0];
    if (next !== undefined) this.setFilter(next);
  }

  /** Accessible chip name with correct singular/plural. */
  filterAria(f: ReviewFilterDef): string {
    const n = this.counts()[f.id];
    return `${f.label}, ${n} ${n === 1 ? $localize`question` : $localize`questions`}`;
  }

  /** "July 23, 2026" — locale-formatted, safe fallback. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }
}
