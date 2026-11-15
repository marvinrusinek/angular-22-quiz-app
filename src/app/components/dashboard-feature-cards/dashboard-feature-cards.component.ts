import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

/**
 * The four dashboard entry cards. Presentational only: the two cards that are
 * not plain links (browse the topic list, start a Weak Areas session) tell the
 * parent through outputs, so no session logic or guard bypass lives here.
 */
@Component({
  selector: 'codelab-dashboard-feature-cards',
  standalone: true,
  imports: [RouterLink, MatIconModule],
  templateUrl: './dashboard-feature-cards.component.html',
  styleUrl: './dashboard-feature-cards.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardFeatureCardsComponent {
  /** True when weak topics exist, i.e. a practice session can be started. */
  readonly weakAreasReady = input(false);

  /** True while a Weak Areas session is being started (blocks nothing here;
   *  the parent ignores clicks, this only reflects the state). */
  readonly weakAreasBusy = input(false);

  /** "Topic Quizzes": scroll to the topic list. */
  readonly browse = output<void>();

  /** "Weak Areas Practice": the parent starts the session, then navigates. */
  readonly practiceWeakAreas = output<void>();
}
