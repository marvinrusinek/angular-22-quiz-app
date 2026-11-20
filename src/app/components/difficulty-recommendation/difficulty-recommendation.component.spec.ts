import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';

import { DifficultyRecommendation, InterviewCertificateProgress } from '@shared/models';
import { InterviewCertificateService } from '@shared/services/features/interview/interview-certificate.service';
import { DifficultyRecommendationComponent } from './difficulty-recommendation.component';

const unlockedSig = signal(false);
const progressSig = signal<InterviewCertificateProgress>(progress());
const ensureQualificationStarted = jest.fn();

function progress(over: Partial<InterviewCertificateProgress> = {}): InterviewCertificateProgress {
  const requiredInterviews = over.requiredInterviews ?? 5;
  const qualifyingInterviewsCompleted = over.qualifyingInterviewsCompleted ?? 0;
  return {
    interviewMasterEarned: false,
    angularExplorerEarned: false,
    qualifyingInterviewsCompleted,
    requiredInterviews,
    // DERIVED, exactly as the real service does — a hard-coded value here let a
    // stub claim "3 of 5 done, 5 remaining", which no real progress model can.
    interviewsRemaining: Math.max(requiredInterviews - qualifyingInterviewsCompleted, 0),
    isEligible: false,
    isUnlocked: false,
    ...over
  };
}

const COMPLETE: DifficultyRecommendation = {
  level: 'complete',
  heading: 'Ready for Interview Mode?',
  message: 'ignored in complete state',
  action: { label: 'Build an Interview', kind: 'interview' }
};

const stub = {
  unlocked: unlockedSig,
  progress: progressSig,
  ensureQualificationStarted
} as unknown as InterviewCertificateService;

function render(
  rec: DifficultyRecommendation | null
): ComponentFixture<DifficultyRecommendationComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DifficultyRecommendationComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: stub }]
  });
  const fixture = TestBed.createComponent(DifficultyRecommendationComponent);
  fixture.componentRef.setInput('recommendation', rec);
  fixture.detectChanges();
  return fixture;
}

const text = (el: HTMLElement) => el.textContent ?? '';

describe('DifficultyRecommendationComponent — certificate-journey completion card', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    progressSig.set(progress());
    ensureQualificationStarted.mockClear();
  });

  it('before Interview Master: prompts to become an Interview Master + Build action', () => {
    progressSig.set(progress({ interviewMasterEarned: false }));
    const el = render(COMPLETE).nativeElement as HTMLElement;
    expect(el.querySelector('.dr__message')?.textContent).toContain(
      'Build a mixed-topic interview and become an Interview Master.'
    );
    expect(text(el)).toContain('Ready for Interview Mode?');
    expect(el.querySelector('button.dr__btn')?.textContent).toContain('Build an Interview');
  });

  // Uses the SHARED certificateNextAction() helper, so this surface says the same
  // thing as the Results card and Builder callout. With Explorer still locked,
  // interviews alone would NOT unlock the certificate — the old hard-coded
  // "Complete 5 qualifying interviews to unlock…" implied they would.
  it('after Interview Master, Explorer still locked: names BOTH outstanding requirements', () => {
    progressSig.set(progress({ interviewMasterEarned: true }));
    const el = render(COMPLETE).nativeElement as HTMLElement;
    expect(el.querySelector('.dr__message')?.textContent).toContain(
      'Continue earning achievements and completing interviews.'
    );
    expect(el.querySelector('button.dr__btn')?.textContent).toContain('Build an Interview');
  });

  it('Explorer earned, interviews outstanding: counts down the REMAINING interviews', () => {
    progressSig.set(
      progress({
        interviewMasterEarned: true,
        angularExplorerEarned: true,
        qualifyingInterviewsCompleted: 3
      })
    );
    const el = render(COMPLETE).nativeElement as HTMLElement;
    // 2 remaining — not a restatement of the requirement.
    expect(el.querySelector('.dr__message')?.textContent).toContain(
      'Complete 2 more interviews to earn your certificate.'
    );
  });

  it('certificate earned: shows the medal + a native View Certificate button', () => {
    unlockedSig.set(true);
    const el = render(COMPLETE).nativeElement as HTMLElement;
    expect(text(el)).toContain('Certificate Earned');
    expect(el.querySelector('.dr__message')?.textContent).toContain(
      'View your Angular Interview Master Certificate.'
    );
    const button = el.querySelector('button.dr__btn--cert') as HTMLButtonElement;
    expect(button.type).toBe('button');
    expect(button.textContent).toContain('View Certificate');
    expect(button.hasAttribute('href')).toBe(false);
    expect(el.querySelector('a.dr__btn')).toBeNull();
    // Not the "become an Interview Master" prompt at the same time.
    expect(text(el)).not.toContain('become an Interview Master');
  });

  // The visible text names the button: no longer aria-label override, so the name is exactly "View Certificate".
  // Narrator behaviour is verified by hand.
  it('View Certificate is named by its visible text alone and navigates to the certificate once', () => {
    unlockedSig.set(true);
    const fixture = render(COMPLETE);
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const button = (fixture.nativeElement as HTMLElement).querySelector('button.dr__btn--cert') as HTMLButtonElement;
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.hasAttribute('aria-labelledby')).toBe(false);
    expect((button.textContent ?? '').replace(/s+/g, ' ').trim()).toBe('View Certificate');
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(router.serializeUrl(navigate.mock.calls[0][0] as UrlTree)).toBe('/interview/certificate');
  });

  it('the decorative icon is hidden from assistive tech', () => {
    const el = render(COMPLETE).nativeElement as HTMLElement;
    expect(el.querySelector('.dr__icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('non-complete level renders the difficulty advice unchanged', () => {
    const el = render({
      level: 'beginner',
      heading: 'Beginner',
      message: 'Build confidence with more Beginner quizzes.',
      action: { label: 'Browse Beginner', kind: 'browse', difficulty: 'beginner' }
    } as DifficultyRecommendation).nativeElement as HTMLElement;
    expect(el.querySelector('.dr__message')?.textContent).toContain(
      'Build confidence with more Beginner quizzes.'
    );
    expect(el.querySelector('button.dr__btn')?.textContent).toContain('Browse Beginner');
  });

  it('starts the certificate qualification period on init', () => {
    render(COMPLETE);
    expect(ensureQualificationStarted).toHaveBeenCalled();
  });
});
