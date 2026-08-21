import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation
} from '@angular/core';

import { Option } from '../../../shared/models/Option.model';
import { pinAllOfTheAboveLast } from '../../../shared/utils/all-of-the-above';

/** Matches the server's canonicalization closely enough to compare texts. */
function canonicalText(text: string | null | undefined): string {
  return (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Self-contained option list for Weak Areas Practice.
 *
 * Modelled on InterviewOptionsComponent (same shared option styling, same
 * ownership of no quiz-load lifecycle) with ONE deliberate difference: practice
 * is a learning mode, so it reveals correctness inline rather than deferring it
 * the way Interview Mode does.
 *
 * It is a separate component rather than a flag on the interview one because
 * that component documents "NEVER shows correctness" as an invariant; adding a
 * mode would erode a guarantee Interview Mode depends on. It is equally NOT the
 * shared-option pipeline, whose sharedOptionConfig/explanation machinery has
 * historically been the source of FET flicker bugs.
 *
 * The reveal/lock rules reproduce the VERIFIED topic quiz exactly:
 *   - A wrong pick is marked wrong IMMEDIATELY, but the correct answer is NOT
 *     revealed and the options stay clickable, so the user can change it
 *     (qqc-orch-click.service.ts:167 — the disable pass runs only when the click
 *     was correct).
 *   - Once the question is RESOLVED (single: the correct option; multi: the
 *     exact correct set) the correct answers are revealed and the options lock.
 */
@Component({
  selector: 'app-practice-options',
  standalone: true,
  templateUrl: './practice-options.component.html',
  styleUrls: ['./practice-options.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PracticeOptionsComponent {
  readonly options = input.required<Option[]>();
  readonly selectedIds = input<number[]>([]);

  /**
   * True once the question is fully, exactly right — reveals the correct answers
   * and locks the list. A merely-answered (but wrong) question is NOT resolved.
   */
  readonly resolved = input<boolean>(false);

  readonly selectionChange = output<number[]>();

  /** "All of the above" pinned last, mirroring the topic quiz display. */
  readonly displayOptions = computed(() =>
    pinAllOfTheAboveLast([...(this.options() ?? [])], (o) => o?.text)
  );

  /**
   * Multi-select comes from the question's DECLARED type, supplied by the
   * parent. It was counted from `option.correct` here, which made the control
   * type an answer-key derivative: API-sourced practice options carry no
   * `correct`, so every multi-answer question would have silently rendered as
   * single-select.
   */
  readonly multiSelect = input<boolean>(false);

  /**
   * Correct option texts the SERVER revealed, once the question is terminal.
   * Empty until then — the client is never entitled to guess them.
   */
  readonly revealedCorrectTexts = input<readonly string[]>([]);

  /**
   * Option texts the SERVER judged wrong among the user's own picks. Never
   * unpicked options: their correctness is not disclosed before resolution.
   */
  readonly knownIncorrectTexts = input<readonly string[]>([]);

  private readonly correctTextSet = computed(
    () => new Set((this.revealedCorrectTexts() ?? []).map((t) => canonicalText(t)))
  );

  private readonly incorrectTextSet = computed(
    () => new Set((this.knownIncorrectTexts() ?? []).map((t) => canonicalText(t)))
  );

  readonly isMultiSelect = computed(() => this.multiSelect());

  private readonly selectedSet = computed(() => new Set(this.selectedIds() ?? []));

  isSelected(option: Option): boolean {
    return option.optionId != null && this.selectedSet().has(option.optionId);
  }

  /**
   * The correct answers are revealed only once the question is RESOLVED, and
   * only from the set the SERVER released. `option.correct` is not consulted —
   * API-sourced practice options do not carry it, and inventing it would be a
   * claim the client is not entitled to make.
   */
  isCorrectOption(option: Option): boolean {
    return this.resolved() && this.correctTextSet().has(canonicalText(option?.text));
  }

  /**
   * A wrong pick the user actually made. Shown IMMEDIATELY — the topic quiz
   * marks a wrong click wrong at once; it just does not give away the answer.
   *
   * Sourced from the server's per-selection verdicts, so an option is painted
   * wrong only once something authorized has said so. Before the verdict lands
   * the option stays neutral rather than flashing red, which matches the
   * in-flight behaviour the topic quiz already ships.
   */
  isIncorrectChoice(option: Option): boolean {
    return this.isSelected(option) && this.incorrectTextSet().has(canonicalText(option?.text));
  }

  /** Status text per option, so correctness is never conveyed by colour alone. */
  statusLabel(option: Option): string {
    if (this.isCorrectOption(option)) return $localize`Correct answer`;
    if (this.isIncorrectChoice(option)) return $localize`Your answer — incorrect`;
    return '';
  }

  onToggle(option: Option): void {
    if (this.resolved()) return;   // locks only once fully correct
    const id = option.optionId;
    if (id == null) return;

    if (this.isMultiSelect()) {
      const next = new Set(this.selectedSet());
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      this.selectionChange.emit([...next]);
    } else {
      this.selectionChange.emit([id]);
    }
  }
}
