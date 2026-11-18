import { EnvironmentInjector, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { getState } from '@ngrx/signals';

import { InterviewAttemptHistoryEntry, InterviewCompletionReason } from '@shared/models';
import { SK_INTERVIEW_HISTORY } from '@shared/constants/session-keys';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';

import { InterviewHistoryComponent } from './interview-history.component';
import { InterviewHistoryStore } from './interview-history.store';

/** An attempt, oldest = lowest `i`. `attemptNumber` is optional (legacy records have none). */
function entry(
  i: number,
  reason: InterviewCompletionReason = 'submitted',
  attemptNumber?: number,
  withPerf = true
): InterviewAttemptHistoryEntry {
  return {
    id: `att-${i}`,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: 50 + i,
    totalQuestions: 100,
    percentage: 50 + i,
    completionReason: reason,
    durationSeconds: 600,
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['forms', 'http'],
    topicPerformance: withPerf
      ? [{ topicId: 'forms', topicName: 'Forms', correct: 5, total: 10, percentage: 50 }]
      : [],
    ...(attemptNumber === undefined ? {} : { attemptNumber })
  } as InterviewAttemptHistoryEntry;
}

/** The store only READS the service's `history` signal, so a writable signal behind a read-only view is a faithful fake. */
function setup(initial: InterviewAttemptHistoryEntry[]) {
  const history = signal<InterviewAttemptHistoryEntry[]>(initial);
  const service = { history: history.asReadonly() } as unknown as InterviewHistoryService;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [InterviewHistoryStore, { provide: InterviewHistoryService, useValue: service }]
  });
  return { history, store: TestBed.inject(InterviewHistoryStore) };
}

describe('InterviewHistoryStore', () => {
  it('starts on the "all" filter and owns NOTHING but the filter (no copy of the history)', () => {
    const { store } = setup([entry(1), entry(2)]);
    expect(store.filter()).toBe('all');
    expect(Object.keys(getState(store))).toEqual(['filter']);
  });

  it('counts every filter over the FULL history, whichever filter is selected', () => {
    const { store } = setup([entry(1), entry(2, 'time-expired'), entry(3), entry(4, 'time-expired'), entry(5, 'time-expired')]);
    const expected = { all: 5, submitted: 2, 'time-expired': 3 };
    expect(store.counts()).toEqual(expected);
    store.setFilter('submitted');
    expect(store.counts()).toEqual(expected);
    store.setFilter('time-expired');
    expect(store.counts()).toEqual(expected);
  });

  it('lists cards newest first, in the history\'s own order reversed', () => {
    const { store } = setup([entry(1), entry(2), entry(3)]);
    expect(store.cards().map((c) => c.entry.id)).toEqual(['att-3', 'att-2', 'att-1']);
  });

  it('numbers cards by the persisted attemptNumber, else by chronological position', () => {
    const { store } = setup([entry(1, 'submitted', 6), entry(2, 'submitted', 7), entry(3)]); // third is a legacy record
    expect(store.cards().map((c) => c.number)).toEqual([3, 7, 6]);
  });

  it('setFilter narrows the cards, keeps their newest-first order and their numbers, and "all" restores them', () => {
    const { store } = setup([
      entry(1, 'submitted', 11),
      entry(2, 'time-expired', 12),
      entry(3, 'submitted', 13),
      entry(4, 'time-expired', 14)
    ]);
    store.setFilter('time-expired');
    expect(store.filter()).toBe('time-expired');
    expect(store.cards().map((c) => [c.entry.id, c.number])).toEqual([['att-4', 14], ['att-2', 12]]);
    store.setFilter('submitted');
    expect(store.cards().map((c) => [c.entry.id, c.number])).toEqual([['att-3', 13], ['att-1', 11]]);
    store.setFilter('all');
    expect(store.cards().map((c) => c.entry.id)).toEqual(['att-4', 'att-3', 'att-2', 'att-1']);
  });

  it('shows no cards (not an error) when the selected filter matches nothing', () => {
    const { store } = setup([entry(1), entry(2)]);
    store.setFilter('time-expired');
    expect(store.cards()).toEqual([]);
    expect(store.counts()['time-expired']).toBe(0);
  });

  it('reacts to the SERVICE\'s history changing, with no store call at all', () => {
    const { history, store } = setup([entry(1, 'submitted', 1)]);
    store.setFilter('time-expired');
    expect(store.cards()).toEqual([]);

    history.set([entry(1, 'submitted', 1), entry(2, 'time-expired', 2)]); // a new attempt is recorded elsewhere
    expect(store.counts()).toEqual({ all: 2, submitted: 1, 'time-expired': 1 });
    expect(store.cards().map((c) => c.entry.id)).toEqual(['att-2']); // the selected filter still applies
    expect(Object.keys(getState(store))).toEqual(['filter']); // and still nothing mirrored into the store
  });

  it('never mutates or reorders the service\'s history', () => {
    const attempts = [entry(1), entry(2, 'time-expired'), entry(3)];
    const { history, store } = setup(attempts);
    store.cards();
    store.setFilter('submitted');
    store.cards();
    expect(history()).toBe(attempts);
    expect(attempts.map((a) => a.id)).toEqual(['att-1', 'att-2', 'att-3']);
  });

  it('takes a card\'s topics from its performance names, else from its selected topic ids', () => {
    const { store } = setup([entry(1, 'submitted', undefined, false), entry(2)]);
    const byId = Object.fromEntries(store.cards().map((c) => [c.entry.id, c.topics]));
    expect(byId['att-2']).toEqual(['Forms']);
    expect(byId['att-1']).toEqual(['forms', 'http']);
  });

  it('is component-scoped: two instances are independent while sharing the one service history', () => {
    const history = signal<InterviewAttemptHistoryEntry[]>([entry(1), entry(2, 'time-expired')]);
    const service = { history: history.asReadonly() } as unknown as InterviewHistoryService;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const parent = TestBed.inject(EnvironmentInjector);
    const make = () =>
      Injector.create({
        parent,
        providers: [InterviewHistoryStore, { provide: InterviewHistoryService, useValue: service }]
      }).get(InterviewHistoryStore);
    const a = make();
    const b = make();

    expect(a).not.toBe(b);
    a.setFilter('time-expired');
    expect(a.filter()).toBe('time-expired');
    expect(b.filter()).toBe('all');
    expect(a.cards().map((c) => c.entry.id)).toEqual(['att-2']);
    expect(b.cards()).toHaveLength(2);

    history.update((h) => [...h, entry(3, 'time-expired')]); // both see the same service change
    expect(a.counts()['time-expired']).toBe(2);
    expect(b.counts()['time-expired']).toBe(2);
    expect(b.filter()).toBe('all');
  });
});

describe('InterviewHistoryComponent: its store is per component instance', () => {
  const readinessStub = { readiness: () => null } as unknown as InterviewReadinessService;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      SK_INTERVIEW_HISTORY,
      JSON.stringify({ version: 2, attempts: [entry(1), entry(2, 'time-expired'), entry(3)] })
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [InterviewHistoryComponent],
      providers: [
        provideRouter([]),
        { provide: InterviewReadinessService, useValue: readinessStub },
        { provide: ActivatedRoute, useValue: { snapshot: { fragment: null } } }
      ]
    });
  });
  afterEach(() => localStorage.clear());

  const make = () => {
    const f = TestBed.createComponent(InterviewHistoryComponent);
    f.detectChanges();
    return f;
  };
  const titles = (f: { nativeElement: HTMLElement }) =>
    Array.from(f.nativeElement.querySelectorAll('.ih-card__title')).map((e) => e.textContent!.trim());

  it('two page instances keep their own selected filter', () => {
    const a = make();
    const b = make();
    a.componentInstance.setFilter('time-expired');
    a.detectChanges();
    b.detectChanges();
    expect(titles(a)).toHaveLength(1);
    expect(titles(b)).toHaveLength(3);
  });

  it('recreating the page resets the filter to "all"', () => {
    const first = make();
    first.componentInstance.setFilter('submitted');
    first.detectChanges();
    expect(titles(first)).toHaveLength(2);
    first.destroy();

    const second = make();
    expect(second.componentInstance.filter()).toBe('all');
    expect(titles(second)).toHaveLength(3);
  });
});
