import { Service, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { auditTime, distinctUntilChanged, filter, shareReplay } from 'rxjs/operators';

import { SK_SAVED_QUESTION_INDEX } from '@shared/constants/session-keys';
import { swallow } from '@shared/utils/error-logging';

/**
 * Holds the user-facing banner texts that sit above/below the question:
 *   - the "Question N of M" question-number badge
 *   - the "(N answers are correct)" correct-answer banner
 *
 * Extracted from `QuizService` so that service can stay under 1k lines
 * and so banner concerns are testable without spinning up the full quiz
 * stack. Callers go through `QuizService` passthrough getters/methods
 * unchanged.
 */
@Service()
export class QuizBannerService {
  // ── Correct-answers banner ──────────────────────────────────────────
  readonly correctAnswersCountTextSig = signal<string>(
    localStorage.getItem('correctAnswersText') ?? ''
  );

  // Frame-synchronized observable for banner display — coalesced with
  // question text. Keeps empty-string emissions but skips null/undefined.
  readonly correctAnswersText$: Observable<string> =
    toObservable(this.correctAnswersCountTextSig).pipe(
      filter((v): v is string => v != null),
      auditTime(0),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );

  // Anti-flicker guards during nav.
  private _lastBanner = '';
  private _pendingBannerTimer: ReturnType<typeof setTimeout> | null = null;

  updateCorrectAnswersText(newText: string): void {
    const text = (newText ?? '').trim();
    if (this._lastBanner === text) return;

    if (this._pendingBannerTimer) {
      clearTimeout(this._pendingBannerTimer);
      this._pendingBannerTimer = null;
    }

    this._lastBanner = text;
    this.correctAnswersCountTextSig.set(text);

    try {
      localStorage.setItem('correctAnswersText', text);
    } catch (err: unknown) { swallow('quiz-banner.service.ts', err); /* localStorage may be full / unavailable */ }
  }

  clearStoredCorrectAnswersText(): void {
    try {
      localStorage.removeItem('correctAnswersText');
      this.correctAnswersCountTextSig.set('');
    } catch (err: unknown) { swallow('quiz-banner.service.ts', err); /* ignore */ }
  }

  // ── Question-number badge ──────────────────────────────────────────
  readonly badgeTextSig = signal<string>('');
  readonly badgeText$ = toObservable(this.badgeTextSig);

  updateBadgeText(questionIndex: number, totalQuestions: number): void {
    if (!Number.isInteger(questionIndex) || questionIndex < 1 ||
        !Number.isInteger(totalQuestions) || totalQuestions < 1 ||
        questionIndex > totalQuestions) {
      return;
    }
    const newBadgeText = `Question ${questionIndex} of ${totalQuestions}`;
    if (this.badgeTextSig() === newBadgeText) return;

    this.badgeTextSig.set(newBadgeText);
    localStorage.setItem(SK_SAVED_QUESTION_INDEX, JSON.stringify(questionIndex - 1));
  }
}
