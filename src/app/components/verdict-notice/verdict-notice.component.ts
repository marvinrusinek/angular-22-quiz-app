import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Message (and, when it applies, a Retry button) for a failed or timed-out
 * answer check. Presentational only: which notice to show is decided by
 * `buildVerdictNotice`, and what Retry does is the parent's business.
 *
 * `role="alert"` makes the failure announced when it appears; Retry is a native
 * button, so it is in the tab order and activates with Enter and Space.
 */
@Component({
  selector: 'codelab-verdict-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verdict-notice.component.html',
  styleUrls: ['./verdict-notice.component.scss']
})
export class VerdictNoticeComponent {
  readonly message = input.required<string>();
  readonly canRetry = input(false);
  readonly retry = output<void>();
}
