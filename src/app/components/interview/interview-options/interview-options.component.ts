import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation
} from '@angular/core';

import type {
  InterviewOptionViewModel,
  InterviewQuestionType
} from '@shared/models/interview/interview-view-models';

/**
 * Self-contained option list for Interview Mode. Renders the current question's
 * options using the shared option styling (light-gray `--bg-option`, neutral
 * selected) but owns NO quiz-load lifecycle — so it always renders, stays
 * clickable, and refreshes cleanly when `options` changes on navigation.
 *
 * It NEVER shows correctness, and as of the backend migration it no longer HAS
 * correctness to inspect: the active model carries only `optionId` and `text`.
 *
 * Single- vs multiple-answer comes from the server-provided `questionType`.
 * This previously counted `correct === true` options, which quietly required
 * the answer key just to choose radio vs checkbox — with the API that count
 * would be zero and every question would render as a radio group.
 *
 * Option ORDER is the server's frozen display order. Nothing is re-sorted and
 * "All of the above" is not re-pinned here; the backend already placed it last
 * at generation, and reordering would diverge from the stored display order.
 */
@Component({
  selector: 'app-interview-options',
  standalone: true,
  templateUrl: './interview-options.component.html',
  styleUrls: ['./interview-options.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewOptionsComponent {
  readonly options = input.required<readonly InterviewOptionViewModel[]>();
  readonly selectedIds = input<readonly number[]>([]);

  /** Server-provided. `trueFalse` is single-selection, exactly like `single`. */
  readonly questionType = input.required<InterviewQuestionType>();

  /** Locks the list while the question is saving, expired or submitted. */
  readonly disabled = input<boolean>(false);

  /** Emits the COMPLETE next selection for the current question. */
  readonly selectionChange = output<number[]>();

  readonly isMultiSelect = computed(() => this.questionType() === 'multiple');

  /** Rendered in the order the server delivered. */
  readonly displayOptions = computed(() => [...(this.options() ?? [])]);

  private readonly selectedSet = computed(() => new Set(this.selectedIds() ?? []));

  isSelected(option: InterviewOptionViewModel): boolean {
    return this.selectedSet().has(option.optionId);
  }

  onToggle(option: InterviewOptionViewModel): void {
    if (this.disabled()) return;
    const id = option.optionId;

    if (this.isMultiSelect()) {
      const next = new Set(this.selectedSet());
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      this.selectionChange.emit([...next]);
    } else {
      // Single-answer: selecting replaces the prior choice. Re-selecting the
      // same option leaves it selected rather than clearing it.
      this.selectionChange.emit([id]);
    }
  }
}
