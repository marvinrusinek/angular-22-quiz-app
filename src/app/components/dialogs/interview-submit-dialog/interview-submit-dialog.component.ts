import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

export interface InterviewSubmitDialogData {
  answered: number;
  unanswered: number;
  timeRemaining: string;   // mm:ss
  /** Purely informational. NEVER gates or blocks submission. */
  markedCount: number;
}

/**
 * Confirmation before an EARLY (manual) assessment submission. Reuses the
 * project's MatDialog pattern (focus trap + restore handled by MatDialog).
 * Shows answered/unanswered counts + time remaining — never any correctness.
 * Closes with `true` to submit, `false`/backdrop to continue.
 *
 * The marked-for-review note is INFORMATIONAL ONLY: it appears when
 * `markedCount > 0` and never disables or hides the Submit button, never
 * forces a second confirmation, and never blocks submission.
 */
@Component({
  selector: 'codelab-interview-submit-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title i18n>Submit Assessment?</h2>
    <mat-dialog-content>
      <dl class="submit-summary">
        <div><dt i18n>Answered</dt><dd>{{ data.answered }}</dd></div>
        <div><dt i18n>Unanswered</dt><dd>{{ data.unanswered }}</dd></div>
        <div><dt i18n>Time remaining</dt><dd>{{ data.timeRemaining }}</dd></div>
      </dl>
      @if (data.markedCount > 0) {
        <p class="submit-marked-notice" role="note">
          <ng-container i18n>You still have</ng-container>
          {{ data.markedCount }}
          <ng-container i18n>question(s) marked for review.</ng-container>
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close(false)" i18n>Continue Assessment</button>
      <button mat-flat-button color="primary" (click)="dialogRef.close(true)" i18n>
        Submit Assessment
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .submit-summary { margin: 4px 0 0; min-width: 240px; }
    .submit-summary > div {
      display: flex; justify-content: space-between; gap: 24px; padding: 5px 0;
    }
    .submit-summary dt { color: rgba(0, 0, 0, 0.6); }
    .submit-summary dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
    .submit-marked-notice {
      margin: 12px 0 0; padding-top: 10px;
      border-top: 1px solid rgba(0, 0, 0, 0.1);
      font-size: 13px; color: rgba(0, 0, 0, 0.7);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewSubmitDialogComponent {
  readonly dialogRef = inject(MatDialogRef<InterviewSubmitDialogComponent, boolean>);
  readonly data = inject<InterviewSubmitDialogData>(MAT_DIALOG_DATA);
}
