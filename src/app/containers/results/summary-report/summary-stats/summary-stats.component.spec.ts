import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizScore } from '@shared/models';

import { SummaryStatsComponent } from './summary-stats.component';

describe('SummaryStatsComponent', () => {
  let fixture: ComponentFixture<SummaryStatsComponent>;

  const setUp = (
    opts: {
      correct?: number;
      total?: number;
      attempted?: number;
      percentage?: number;
      minutes?: number;
      seconds?: number;
      shuffled?: boolean;
      attemptDateTime?: Date | null;
    } = {}
  ): void => {
    fixture.componentRef.setInput('quizMetadata', {
      correctAnswersCount: signal(opts.correct ?? 7),
      totalQuestions: opts.total ?? 7,
      totalQuestionsAttempted: opts.attempted ?? 7,
      percentage: opts.percentage ?? 100,
      completionTime: 17
    });
    fixture.componentRef.setInput('elapsedMinutes', opts.minutes ?? 0);
    fixture.componentRef.setInput('elapsedSeconds', opts.seconds ?? 17);
    fixture.componentRef.setInput('isShuffled', opts.shuffled ?? false);
    const when =
      opts.attemptDateTime === undefined ? new Date(2026, 9, 26, 18, 23, 26) : opts.attemptDateTime;
    fixture.componentRef.setInput(
      'score',
      when
        ? ({ quizId: 'q', attemptDateTime: when, score: 7, totalQuestions: 7 } as QuizScore)
        : null
    );
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SummaryStatsComponent] });
    fixture = TestBed.createComponent(SummaryStatsComponent);
  });

  const items = (): HTMLElement[] => [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('ul.summary-stats > li')
  ];
  const text = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rows = (): string[] => items().map(text);

  it('renders every row as complete "label: value" text using the real dynamic values', () => {
    setUp();
    expect(rows()).toEqual([
      'Your Score: 7',
      'Total Questions: 7',
      'Total Questions Attempted: 7',
      'Your Score (percentage): 100%',
      'Passing Score: 60%',
      'Test Status: Passed',
      'Test Mode: Unshuffled',
      'Time Elapsed: 0 minutes and 17 seconds',
      'Date/Time Completed: Oct 26, 2026, 6:23:26 PM'
    ]);
  });

  it('keeps each row as ONE visible text node with no nested value span', () => {
    setUp();
    for (const li of items()) {
      const textNodes: Node[] = [];
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim()) textNodes.push(n);
      }
      expect(textNodes).toHaveLength(1);
      expect(li.querySelector('.result')).toBeNull();
    }
  });

  it('follows the dynamic inputs: failed, shuffled, singular minute, N/A date', () => {
    setUp({
      correct: 3,
      total: 8,
      attempted: 6,
      percentage: 38,
      minutes: 1,
      seconds: 5,
      shuffled: true,
      attemptDateTime: null
    });
    const r = rows();
    expect(r[0]).toBe('Your Score: 3');
    expect(r[1]).toBe('Total Questions: 8');
    expect(r[2]).toBe('Total Questions Attempted: 6');
    expect(r[3]).toBe('Your Score (percentage): 38%');
    expect(r[5]).toBe('Test Status: Failed');
    expect(r[6]).toBe('Test Mode: Shuffled');
    expect(r[7]).toBe('Time Elapsed: 1 minute and 5 seconds');
    expect(r[8]).toBe('Date/Time Completed: N/A');
  });

  it('keeps the existing pass threshold (strictly above 60%)', () => {
    setUp({ percentage: 60 });
    expect(rows()[5]).toBe('Test Status: Failed');
    setUp({ percentage: 61 });
    expect(rows()[5]).toBe('Test Status: Passed');
  });

  it('is not exposed as a list, so no "N of 9" list position is announced', () => {
    setUp();
    const ul = (fixture.nativeElement as HTMLElement).querySelector('ul.summary-stats')!;
    expect(ul.getAttribute('role')).toBe('none');
    expect(items()).toHaveLength(9);
    for (const li of items()) {
      expect(li.getAttribute('role')).toBe('none');
    }
  });

  it('adds no aria-label, live region or interactive content', () => {
    setUp();
    const ul = (fixture.nativeElement as HTMLElement).querySelector('ul.summary-stats')!;
    expect(ul.querySelector('[aria-label],[aria-live]')).toBeNull();
    expect(ul.querySelector('a,button,input,select,textarea,[tabindex]')).toBeNull();
  });
});
