import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

export interface ConfirmDialogData {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: 'primary' | 'warn';
}

@Component({
  selector: 'codelab-confirm-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2
      mat-dialog-title
      class="confirm-title"
    >
      {{ data.title ?? 'Are you sure?' }}
    </h2>

    <mat-dialog-content class="confirm-message">
      {{ data.message }}
    </mat-dialog-content>

    <mat-dialog-actions
      align="end"
      class="confirm-actions"
    >
      <button
        mat-stroked-button
        class="confirm-cancel"
        (click)="dialogRef.close(false)"
      >
        {{ data.cancelText ?? 'Cancel' }}
      </button>

      <button
        mat-flat-button
        [color]="data.confirmColor ?? 'warn'"
        (click)="dialogRef.close(true)"
      >
        {{ data.confirmText ?? 'Confirm' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .confirm-title {
        color: var(--text-primary);
        font-weight: 600;
      }

      .confirm-message {
        color: var(--text-secondary);
        font-size: 15px;
        line-height: 1.5;
      }

      .confirm-actions {
        gap: 8px;
        padding: 8px 24px 16px;
      }

      .confirm-cancel {
        color: var(--text-primary);
        border-color: var(--border-color);
      }
    `
  ]
})
export class ConfirmDialogComponent {
  // ── injects ─────────────────────────────────────────────────────
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<ConfirmDialogComponent, boolean>);
}
