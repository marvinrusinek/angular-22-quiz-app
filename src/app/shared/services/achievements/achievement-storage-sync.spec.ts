import { computed, effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AchievementService } from './achievement.service';
import { SK_QUIZ_ACHIEVEMENTS, SK_QUIZ_BEST_SCORES } from '@shared/constants/session-keys';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';

/**
 * localStorage is shared by every tab of this origin, but AchievementService
 * caches the earned set. The browser fires a `storage` event in OTHER tabs when
 * a key changes, so the service must refresh for `quizAchievements` (and for a
 * full clear), and for nothing else.
 */
describe('AchievementService — other-tab storage synchronization', () => {
  const SIX = [
    'perfect-score',
    'beginner-complete',
    'intermediate-complete',
    'advanced-complete',
    'interview-master',
    'angular-explorer'
  ];
  const TWO = ['perfect-score', 'beginner-complete'];
  let service: AchievementService;

  const seed = (ids: string[]): void =>
    localStorage.setItem(
      SK_QUIZ_ACHIEVEMENTS,
      JSON.stringify(ids.map((id) => ({ id, earnedAt: '2026-11-01T10:00:00.000Z' })))
    );

  /** What the browser does in OTHER tabs; jsdom never fires it for same-window writes. */
  const storageEvent = (
    init: { key?: string | null; area?: Storage | null } = {}
  ): void => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'key' in init ? init.key : SK_QUIZ_ACHIEVEMENTS,
        storageArea: 'area' in init ? init.area : localStorage
      })
    );
  };

  const create = (): AchievementService => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: InterviewReadinessService,
          useValue: {
            readiness: signal(null),
            coverageVerified: signal(true),
            ensureCatalog: jest.fn(async () => undefined)
          }
        },
        { provide: InterviewHistoryService, useValue: { trends: signal({ best: null }) } }
      ]
    });
    return TestBed.inject(AchievementService);
  };

  const ids = (): string[] => [...service.earnedIds()].sort();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('starts with the two stored earned ids', () => {
    seed(TWO);
    service = create();
    expect(ids()).toEqual([...TWO].sort());
    expect(service.summary()).toEqual({ earned: 2, total: 6 });
  });

  describe('an external change to quizAchievements', () => {
    beforeEach(() => {
      seed(TWO);
      service = create();
      expect(service.summary().earned).toBe(2); // primes the cache
    });

    it('updates earnedIds()', () => {
      seed(SIX);
      storageEvent();
      expect(ids()).toEqual([...SIX].sort());
    });

    it('updates summary()', () => {
      seed(SIX);
      storageEvent();
      expect(service.summary()).toEqual({ earned: 6, total: 6 });
    });

    it('updates catalog() earned states', () => {
      seed(['advanced-complete']);
      storageEvent();
      const earned = service.catalog().filter((a) => a.earned).map((a) => a.id);
      expect(earned).toEqual(['advanced-complete']);
      expect(service.catalog()).toHaveLength(6);
    });

    it('goes DOWN too (6 -> 2), not just up', () => {
      seed(SIX);
      storageEvent();
      expect(service.summary().earned).toBe(6);
      seed(TWO);
      storageEvent();
      expect(service.summary().earned).toBe(2);
    });

    it('refreshes after a full localStorage.clear() in another tab (key === null)', () => {
      localStorage.clear();
      storageEvent({ key: null });
      expect(service.summary().earned).toBe(0);
    });

    it('is reflected by dependents (computed / effect) without a reload', () => {
      const count = computed(() => service.earnedIds().size);
      const seen: number[] = [];
      TestBed.runInInjectionContext(() => effect(() => seen.push(count())));
      TestBed.flushEffects();
      seed(SIX);
      storageEvent();
      TestBed.flushEffects();
      expect(seen).toEqual([2, 6]);
    });
  });

  describe('events that must NOT affect achievements', () => {
    beforeEach(() => {
      seed(TWO);
      service = create();
      expect(service.summary().earned).toBe(2);
    });

    it('ignores other localStorage keys', () => {
      seed(SIX); // storage changed, but the event is for a different key
      storageEvent({ key: SK_QUIZ_BEST_SCORES });
      expect(service.summary().earned).toBe(2); // still the cached value
      storageEvent({ key: 'theme' });
      expect(service.summary().earned).toBe(2);
    });

    it('ignores sessionStorage events, even for the same key name', () => {
      seed(SIX);
      storageEvent({ area: sessionStorage });
      expect(service.summary().earned).toBe(2);
    });

    it('ignores events with no storage area', () => {
      seed(SIX);
      storageEvent({ area: null });
      expect(service.summary().earned).toBe(2);
    });

    it('does not make dependents recompute when the ids did not change', () => {
      let runs = 0;
      const dependent = computed(() => {
        runs++;
        return service.earnedIds().size;
      });
      expect(dependent()).toBe(2);
      storageEvent(); // storage still holds the same two ids
      expect(dependent()).toBe(2);
      expect(runs).toBe(1);
    });
  });

  describe('existing service writes keep working', () => {
    it('evaluate() earns, persists and updates earnedIds()/summary()', () => {
      service = create();
      expect(service.summary().earned).toBe(0);
      localStorage.setItem(
        SK_QUIZ_BEST_SCORES,
        JSON.stringify({ a: 100, b: 80 })
      );
      const newly = service.evaluate([
        { quizId: 'a', difficulty: 'beginner' },
        { quizId: 'b', difficulty: 'beginner' }
      ]);
      expect(newly.map((d) => d.id).sort()).toEqual(['beginner-complete', 'perfect-score']);
      expect(ids()).toEqual(['beginner-complete', 'perfect-score']);
      expect(JSON.parse(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)!)).toHaveLength(2);
    });

    it('a repeat evaluate() earns nothing new', () => {
      seed(TWO);
      service = create();
      localStorage.setItem(SK_QUIZ_BEST_SCORES, JSON.stringify({ a: 100 }));
      const cat = [{ quizId: 'a', difficulty: 'beginner' }];
      expect(service.evaluate(cat)).toEqual([]);
      expect(ids()).toEqual([...TWO].sort());
    });
  });

  describe('listener lifecycle', () => {
    it('registers exactly one storage listener per service instance', () => {
      const add = jest.spyOn(window, 'addEventListener');
      service = create();
      const storageAdds = add.mock.calls.filter(([type]) => type === 'storage');
      expect(storageAdds).toHaveLength(1);
      service.summary();
      service.catalog();
      expect(add.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1);
    });

    it('removes the listener when the injector is destroyed', () => {
      const add = jest.spyOn(window, 'addEventListener');
      const remove = jest.spyOn(window, 'removeEventListener');
      service = create();
      const added = add.mock.calls.find(([type]) => type === 'storage')![1];
      TestBed.resetTestingModule(); // destroys the injector and the service
      expect(remove).toHaveBeenCalledWith('storage', added);
    });

    it('a destroyed service no longer reacts', () => {
      seed(TWO);
      service = create();
      expect(service.summary().earned).toBe(2);
      TestBed.resetTestingModule();
      seed(SIX);
      expect(() => storageEvent()).not.toThrow();
    });
  });
});
