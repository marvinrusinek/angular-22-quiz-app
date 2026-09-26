import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, inject, input, signal,
  ViewEncapsulation
} from '@angular/core';

import { Resource } from '@shared/models';

/**
 * Presentational-only "Brush up your knowledge…" resources panel: the
 * expand/collapse toggle, heading, caret and the external-link list. The parent
 * StatisticsComponent passes the milestone name + resources via signal inputs;
 * the collapse state lives here since it is not used anywhere else.
 *
 * Uses ViewEncapsulation.None because the panel is styled DIFFERENTLY depending
 * on where the parent renders it — inside `.quiz-feedback` (the low-score inline
 * case) vs inside `.resources-view` (the standalone case). Those ancestor-context
 * rules must cross the component boundary, which emulated encapsulation cannot
 * do. The involved class names (`.quiz-feedback`, `.resources-view`,
 * `.resources-section`) are unique to the statistics feature, so the global
 * rules cannot leak elsewhere.
 */
@Component({
  selector: 'app-quiz-resources',
  standalone: true,
  imports: [],
  templateUrl: './quiz-resources.component.html',
  styleUrls: ['./quiz-resources.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None
})
export class QuizResourcesComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly cdRef = inject(ChangeDetectorRef);

  // ── inputs ──────────────────────────────────────────────────────
  readonly milestoneName = input<string>('');
  readonly resources = input<Resource[]>([]);

  // Signal-controlled expand/collapse for the resources panel (replaces a native
  // <details>, whose [open] CSS didn't flip the caret reliably here). COLLAPSED by
  // default — starts with a ▼, and the first click reveals the resources.
  readonly resourcesExpanded = signal(false);
  toggleResources(): void {
    this.resourcesExpanded.update(open => !open);
    this.cdRef.markForCheck();
  }
}
