import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';

/**
 * Calm, accessible warning shown when the user RETURNS to the assessment after a
 * focus-loss (tab switch / minimize / app switch / fullscreen exit). Reuses the
 * project's MatDialog pattern (focus trap + restore handled by MatDialog;
 * `themed-confirm-dialog` panel = dark/light themed), matching the submit dialog.
 *
 * Deliberately non-aggressive: no "cheating detected" language, a single
 * acknowledge action, and it never fails/submits/resets the assessment.
 */
@Component({
  selector: 'codelab-assessment-integrity-warning-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2
      mat-dialog-title
      i18n
    >
      Assessment focus lost
    </h2>
    <mat-dialog-content>
      <p
        class="aiw-message"
        i18n
      >
        This assessment is intended to be completed without external resources. Leaving the
        assessment may be recorded.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button
        mat-flat-button
        color="primary"
        (click)="dialogRef.close()"
        cdkFocusInitial
        i18n
      >
        Return to Assessment
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .aiw-message {
        margin: 4px 0 0;
        max-width: 300px;
        line-height: 1.45;
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AssessmentIntegrityWarningDialogComponent {
  readonly dialogRef = inject(MatDialogRef<AssessmentIntegrityWarningDialogComponent>);
}
