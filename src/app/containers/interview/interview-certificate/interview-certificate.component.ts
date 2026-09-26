import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  CERTIFICATE_REQUIRED_BAND,
  CERTIFICATE_TITLE,
  REQUIRED_CERTIFICATE_INTERVIEWS
} from '@shared/models';
import {
  InterviewCertificateService,
  readinessBandLabel
} from '@shared/services/features/interview/interview-certificate.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

/**
 * The Angular Interview Master Certificate page. READ-ONLY and presentation-only:
 * all eligibility / unlock / persistence logic lives in InterviewCertificateService.
 * Reachable at /interview/certificate. If the certificate hasn't been unlocked
 * (e.g. a direct visit) it shows a friendly locked state rather than a broken
 * page. Print-friendly: only the certificate itself prints (see the SCSS
 * `@media print`), so it doubles as a portfolio artifact.
 */
@Component({
  selector: 'codelab-interview-certificate',
  standalone: true,
  imports: [RouterLink, ThemeToggleComponent],
  templateUrl: './interview-certificate.component.html',
  styleUrls: ['./interview-certificate.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateComponent implements OnInit {
  private readonly certService = inject(InterviewCertificateService);
  private readonly readinessService = inject(InterviewReadinessService);
  private readonly historyService = inject(InterviewHistoryService);

  readonly title = CERTIFICATE_TITLE;
  readonly requiredInterviews = REQUIRED_CERTIFICATE_INTERVIEWS;
  readonly record = this.certService.record;
  readonly unlocked = this.certService.unlocked;
  readonly persistenceFailed = this.certService.persistenceFailed;

  // Live readiness tier for display — reuses the readiness service (no re-derive).
  // Falls back to the required tier if history has since aged out (the
  // certificate stays valid; the tier was met when it was issued).
  readonly tierLabel = computed(() =>
    readinessBandLabel(this.readinessService.readiness()?.band ?? CERTIFICATE_REQUIRED_BAND)
  );

  // Best interview score (live) from Interview History. Null only if history was
  // cleared post-issue.
  readonly score = computed(() => this.historyService.trends().best);

  readonly recipientName = computed(() => this.record()?.recipientName ?? '');

  ngOnInit(): void {
    // Make unlocking ORDER-INDEPENDENT. Previously the only place that could
    // issue the certificate was the Results status card, so a user who became
    // eligible and came straight here (or deep-linked) saw the locked page even
    // though they qualified. Both calls are idempotent: ensureQualificationStarted()
    // no-ops once the date exists, and unlock() returns the existing record when
    // already issued and null when not yet eligible — so the id and issue date
    // stay stable and no duplicate is ever generated. The celebration dialog
    // deliberately stays a Results-only moment.
    this.certService.ensureQualificationStarted();
    this.certService.unlock();
  }

  readonly issuedDate = computed(() => {
    const iso = this.record()?.unlockedAt;
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  });

  // ── recipient name editing (optional; persisted via the service) ──
  readonly editingName = signal(false);
  readonly nameDraft = signal('');

  startEditName(): void {
    this.nameDraft.set(this.recipientName());
    this.editingName.set(true);
  }

  onNameInput(value: string): void {
    this.nameDraft.set(value);
  }

  saveName(): void {
    this.certService.setRecipientName(this.nameDraft());
    this.editingName.set(false);
  }

  cancelEditName(): void {
    this.editingName.set(false);
  }

  print(): void {
    window.print();
  }
}
