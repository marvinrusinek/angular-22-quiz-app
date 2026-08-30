import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { KeyboardShortcutsDialogComponent } from '../../../components/dialogs/keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

import { TopicQuizMetadataService } from '../../../shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';

@Component({
  selector: 'codelab-quiz-header',
  standalone: true,
  imports: [
    NgOptimizedImage,
    RouterModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    ThemeToggleComponent,
  ],
  templateUrl: './quiz-header.component.html',
  styleUrls: ['./quiz-header.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodelabQuizHeaderComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly quizService = inject(QuizService);
  private readonly dialog = inject(MatDialog);

  // ── remaining variables ─────────────────────────────────────────
  // S6i: metadata-only — the only field the template reads is `.milestone`,
  // so this carries a narrow `{ milestone }` shape rather than a full Quiz.
  // `questionCountByQuiz` is populated for EVERY known quiz (even a null
  // count), so `.has(quizId)` is the "is this quiz known yet" gate — the
  // same existence check the S6i-migrated Introduction page uses.
  readonly currentQuiz = computed<{ milestone: string } | null>(() => {
    const quizId = this.quizService.quizId;
    if (!quizId || !this.metadataApi.questionCountByQuiz().has(quizId)) return null;
    return { milestone: this.metadataApi.milestoneFor(quizId) };
  });

  // Open the presentational keyboard-shortcuts dialog. ariaLabelledBy /
  // ariaDescribedBy point at the ids in the dialog template; width + maxWidth
  // keep it responsive on mobile.
  openKeyboardShortcuts(): void {
    this.dialog.open(KeyboardShortcutsDialogComponent, {
      panelClass: 'keyboard-shortcuts-dialog',
      width: '90vw',
      maxWidth: '460px',
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'ksd-title',
      ariaDescribedBy: 'ksd-desc',
    });
  }
}
