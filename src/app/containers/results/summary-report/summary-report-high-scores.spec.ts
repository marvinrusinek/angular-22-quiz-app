import { formatDate } from '@angular/common';
import { LOCALE_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { TimerService } from '@shared/services/features/timer/timer.service';

import { SummaryReportComponent } from './summary-report.component';

/**
 * High Scores: each score row is ONE scan stop that says "[Quiz]. [Score]%. [Date and time]." built from the same
 * data as the visible cells; the visible values stay (hidden from AT), and header/row structure remains a table.
 */
describe('SummaryReportComponent — High Scores rows', () => {
  const scores = [
    { quizId: 'dependency-injection', score: 100, attemptDateTime: new Date(2026, 10, 17, 17, 42, 9), totalQuestions: 7 },
    { quizId: 'typescript', score: 57, attemptDateTime: new Date(2026, 11, 25, 23, 59, 7), totalQuestions: 7 }
  ];
  const labels: Record<string, string> = { 'dependency-injection': 'Dependency Injection', typescript: 'TypeScript' };
  let fixture: ComponentFixture<SummaryReportComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SummaryReportComponent],
      providers: [
        { provide: LOCALE_ID, useValue: 'en-US' },
        { provide: TopicQuizMetadataService, useValue: { load: () => of(null), milestoneFor: (id: string) => labels[id] ?? id } },
        {
          provide: QuizService,
          useValue: {
            quizId: 'dependency-injection',
            highScores: scores,
            totalQuestions: () => 7,
            correctAnswersCountSig: 7,
            calculatePercentageOfCorrectlyAnsweredQuestions: () => 100,
            isShuffleEnabled: () => false,
            getFinalResultSnapshot: () => null,
            patchFinalResultCompletionTime: () => undefined
          }
        },
        {
          provide: TimerService,
          useValue: {
            elapsedTimes: [],
            completionTime: 0,
            calculateTotalElapsedTime: () => 0,
            getDurableCompletionTime: () => 0,
            setDurableCompletionTime: () => undefined
          }
        }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(SummaryReportComponent);
    fixture.componentRef.setInput('viewMode', 'highscores');
    fixture.componentRef.setInput('quizId', 'dependency-injection');
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  const rows = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('li.score-row'));
  const exposed = (r: HTMLElement): HTMLElement[] =>
    Array.from(r.querySelectorAll<HTMLElement>('.intro-exposed-text')).filter((e) => !e.closest('[aria-hidden="true"]'));
  const when = (d: Date): string => formatDate(d, 'medium', 'en-US');

  it('is a list of complete score records, in the same order, not a table', () => {
    expect(el.querySelectorAll('table, tr, td, th')).toHaveLength(0);
    const list = el.querySelector('ul[role="list"]')!;
    expect(Array.from(list.children).every((c) => c.tagName === 'LI' && c.getAttribute('role') === 'listitem')).toBe(true);
    expect(rows().map((r) => r.querySelector('[data-intro-visible]')?.textContent?.trim())).toEqual(['Dependency Injection', 'TypeScript']);
  });

  it('keeps the three visible columns and their titles, with the titles visual only', () => {
    const head = el.querySelector('.hs-head')!;
    expect(head.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(head.querySelectorAll('.hs-th')).map((h) => h.textContent?.trim())).toEqual(['Milestone', 'Score (%)', 'Date/Time']);
    for (const r of rows()) expect(r.querySelectorAll('.hs-td')).toHaveLength(3);
  });

  it('each record exposes exactly ONE text item: "[Quiz]. [Score]%. [Date and time]."', () => {
    expect(rows().map((r) => exposed(r).map((e) => e.textContent))).toEqual([
      [`Dependency Injection. 100%. ${when(scores[0].attemptDateTime)}.`],
      [`TypeScript. 57%. ${when(scores[1].attemptDateTime)}.`]
    ]);
  });

  it('the spoken date is the visible date: same pipe, same format', () => {
    for (const r of rows()) {
      const visibleDate = (r.querySelectorAll('.hs-td')[2] as HTMLElement).textContent!.trim();
      expect(exposed(r)[0].textContent).toContain(`${visibleDate}.`);
    }
  });

  it('every visible value is hidden from assistive technology, so no value is a second stop', () => {
    for (const r of rows()) {
      for (const c of Array.from(r.querySelectorAll('.hs-td'))) expect(c.getAttribute('aria-hidden')).toBe('true');
      const exposedText = Array.from(r.querySelectorAll('*')).filter((n) => !n.closest('[aria-hidden="true"]') && n.childNodes.length && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim()));
      expect(exposedText).toHaveLength(1);
    }
  });

  it('adds no role="img"/"group"/"table", no label, no Tab stop', () => {
    expect(el.querySelectorAll('[role="img"], [role="group"], [role="table"], [role="row"], [role="cell"], [aria-label], [tabindex], a[href], button, input')).toHaveLength(0);
  });

  it('the exposed text is a direct child of the record, so it is fitted to the whole row (the group is the <li>)', () => {
    for (const r of rows()) expect(exposed(r)[0].parentElement).toBe(r);
  });
});
