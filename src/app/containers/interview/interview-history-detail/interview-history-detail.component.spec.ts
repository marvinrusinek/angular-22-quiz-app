import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideApiBaseUrl } from '@shared/tokens/api-base-url.token';

import { InterviewAttemptHistoryEntry } from '@shared/models';
import { SK_INTERVIEW_HISTORY } from '@shared/constants/session-keys';
import { InterviewHistoryDetailComponent } from './interview-history-detail.component';

function entry(id: string, i: number): InterviewAttemptHistoryEntry {
  return {
    id,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: 17,
    totalQuestions: 20,
    percentage: 85,
    completionReason: 'submitted',
    durationSeconds: 1471,
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['forms', 'http'],
    topicPerformance: [
      { topicId: 'forms', topicName: 'Forms', correct: 4, total: 5, percentage: 80 },
      { topicId: 'http', topicName: 'HTTP', correct: 1, total: 2, percentage: 50 }
    ]
  };
}

function seed(attempts: InterviewAttemptHistoryEntry[]): void {
  localStorage.setItem(SK_INTERVIEW_HISTORY, JSON.stringify({ version: 2, attempts }));
}

function render(id: string): ComponentFixture<InterviewHistoryDetailComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewHistoryDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id })) } },
      // The page asks the BACKEND for a past review; no durable pointer is
      // seeded here, so it never issues a request and shows the note instead.
      provideHttpClient(),
      provideHttpClientTesting(),
      provideApiBaseUrl('http://test.local/api')
    ]
  });
  const fixture = TestBed.createComponent(InterviewHistoryDetailComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewHistoryDetailComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('9. reopens the read-only summary for the requested attempt', () => {
    seed([entry('a1', 1), entry('a2', 2)]);
    const el = render('a2').nativeElement as HTMLElement;
    expect(el.querySelector('.ihd__title')?.textContent).toContain('Interview #2');
    expect(el.querySelector('.score-pct')?.textContent).toContain('85%');
    expect(el.querySelector('.score-sub')?.textContent).toContain('17 / 20');
  });

  it('17. announces read-only status', () => {
    seed([entry('a1', 1)]);
    const el = render('a1').nativeElement as HTMLElement;
    const ro = el.querySelector('.ihd__readonly');
    expect(ro?.textContent).toContain('Read Only');
    expect(ro?.getAttribute('role')).toBe('status');
    expect(ro?.getAttribute('aria-label')).toContain('Read only');
  });

  it('10. explains when a past attempt has no retrievable answers', () => {
    seed([entry('a1', 1)]);
    const el = render('a1').nativeElement as HTMLElement;
    // No durable pointer for this attempt, so the server is never asked and
    // the page says so rather than implying the answers were kept locally.
    expect(el.querySelector('.ihd-note')?.textContent)
      .toContain('no longer available');
    expect(el.querySelector('app-interview-review')).toBeNull();
  });

  it('never renders answers from LOCAL storage — they come from the backend', () => {
    // Even if a stale store still carried v1 review data, it must not render:
    // the field is gone from the schema and the page fetches from the server.
    seed([{ ...entry('a1', 1), review: [{ questionText: 'leftover' }] } as never]);
    const el = render('a1').nativeElement as HTMLElement;

    expect(el.textContent).not.toContain('leftover');
    expect(el.querySelector('.rv-item')).toBeNull();
  });

  it('reuses the shared Topic Performance component', () => {
    seed([entry('a1', 1)]);
    const el = render('a1').nativeElement as HTMLElement;
    expect(el.querySelectorAll('.topic-row').length).toBeGreaterThan(0);
    expect(el.querySelector('.topics-heading')?.textContent).toContain('Topic Performance');
  });

  it('shows performance context (attempt N of M) from the shared trends', () => {
    seed([entry('a1', 1), entry('a2', 2), entry('a3', 3)]);
    const el = render('a2').nativeElement as HTMLElement;
    expect(el.querySelector('.ihd-context__line')?.textContent).toContain('Attempt 2 of 3');
  });

  it('includes the shared elevator scroll chevron on a found detail page', () => {
    seed([entry('a1', 1)]);
    const el = render('a1').nativeElement as HTMLElement;
    expect(el.querySelector('app-scroll-down-indicator')).not.toBeNull();
  });

  it('shows a not-found state for an unknown id', () => {
    seed([entry('a1', 1)]);
    const el = render('does-not-exist').nativeElement as HTMLElement;
    expect(el.querySelector('.ihd__notfound')?.textContent).toContain('Interview not found');
    expect(el.querySelector('.score-pct')).toBeNull();
  });
});
