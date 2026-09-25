import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { FET_UNLOCK_WATCHDOG_MS } from '@shared/constants/timing';

import { ExplanationDisplayStateService } from './explanation-display-state.service';
import { ExplanationFormatterService } from './explanation-formatter.service';

describe('ExplanationDisplayStateService', () => {
  let service: ExplanationDisplayStateService;
  let formatterMock: any;

  beforeEach(() => {
    formatterMock = {
      resetFormatterState: jest.fn(),
      resetProcessedQuestionsState: jest.fn(),
      validateAndCorrectFetPrefix: jest.fn((text: string) => text),
      formattedExplanationSig: Object.assign(jest.fn().mockReturnValue(''), { set: jest.fn() }),
      formattedExplanation$: new BehaviorSubject<string>('').asObservable(),
      formattedExplanations: {},
      fetByIndex: new Map<number, string>(),
      lockedFetIndices: new Set<number>(),
      explanationsUpdatedSig: { set: jest.fn() },
      explanationsInitializedSig: jest.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        ExplanationDisplayStateService,
        { provide: ExplanationFormatterService, useValue: formatterMock }
      ]
    });

    service = TestBed.inject(ExplanationDisplayStateService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // ── Initial values ──────────────────────────────────────────────────

  it('should have isExplanationTextDisplayedSig with initial value of false', () => {
    expect(service.isExplanationTextDisplayedSig()).toBe(false);
  });

  it('should have shouldDisplayExplanationSig with initial value of false', () => {
    expect(service.shouldDisplayExplanationSig()).toBe(false);
  });

  it('should have latestExplanation initialized to empty string', () => {
    expect(service.latestExplanation).toBe('');
  });

  // ── Signal defaults ─────────────────────────────────────────────────

  it('should have activeIndexSig default to 0', () => {
    expect(service.activeIndexSig()).toBe(0);
  });

  it('should have questionRenderedSig default to false', () => {
    expect(service.questionRenderedSig()).toBe(false);
  });

  it('should have quietZoneUntilSig default to 0', () => {
    expect(service.quietZoneUntilSig()).toBe(0);
  });

  // ── Getters / accessors ─────────────────────────────────────────────

  it('shouldDisplayExplanationSnapshot should return current value of shouldDisplayExplanationSig', () => {
    expect(service.shouldDisplayExplanationSnapshot).toBe(false);

    service.shouldDisplayExplanationSig.set(true);
    expect(service.shouldDisplayExplanationSnapshot).toBe(true);

    service.shouldDisplayExplanationSig.set(false);
    expect(service.shouldDisplayExplanationSnapshot).toBe(false);
  });

  it('getLatestExplanation should return current latestExplanation value', () => {
    expect(service.getLatestExplanation()).toBe('');

    service.latestExplanation = 'Test explanation';
    expect(service.getLatestExplanation()).toBe('Test explanation');
  });

  // ── setExplanationText ──────────────────────────────────────────────

  it('setExplanationText with force should update latestExplanation', () => {
    service.setExplanationText('Hello world', { force: true, index: 0 });

    expect(service.latestExplanation).toBe('Hello world');
  });

  it('setExplanationText with empty string and force should clear latestExplanation', () => {
    service.setExplanationText('First value', { force: true, index: 0 });
    service.setExplanationText('', { force: true, index: 0 });

    expect(service.latestExplanation).toBe('');
  });

  // ── Lock / unlock explanation ───────────────────────────────────────

  it('lockExplanation should prevent non-forced updates', () => {
    service.lockExplanation();
    expect(service.isExplanationLocked()).toBe(true);

    // Empty text is blocked when locked (without force)
    service.setExplanationText('First', { force: true, index: 0 });
    service.lockExplanation();
    service.setExplanationText('', { context: 'global', index: 0 });
    expect(service.latestExplanation).toBe('First');
  });

  it('unlockExplanation should allow updates again', () => {
    service.lockExplanation();
    service.unlockExplanation();
    expect(service.isExplanationLocked()).toBe(false);
  });

  // ── normalizeContext ────────────────────────────────────────────────

  it('normalizeContext should return "global" for falsy input', () => {
    expect(service.normalizeContext(undefined)).toBe('global');
    expect(service.normalizeContext(null)).toBe('global');
    expect(service.normalizeContext('')).toBe('global');
  });

  it('normalizeContext should trim and return non-empty input', () => {
    expect(service.normalizeContext('  test  ')).toBe('test');
    expect(service.normalizeContext('myContext')).toBe('myContext');
  });

  // ── resetExplanationText ────────────────────────────────────────────

  it('resetExplanationText should clear all explanation state', () => {
    service.setExplanationText('Some explanation', { force: true, index: 0 });
    service.shouldDisplayExplanationSig.set(true);
    service.isExplanationTextDisplayedSig.set(true);

    service.resetExplanationText();

    expect(service.latestExplanation).toBe('');
    expect(service.shouldDisplayExplanationSig()).toBe(false);
    expect(service.isExplanationTextDisplayedSig()).toBe(false);
  });

  // ── _activeIndex getter/setter ──────────────────────────────────────

  it('setting _activeIndex should update activeIndexSig', () => {
    service._activeIndex = 5;
    expect(service.activeIndexSig()).toBe(5);
    expect(service._activeIndex).toBe(5);
  });

  it('setting _activeIndex to null should not update activeIndexSig', () => {
    service._activeIndex = 3;
    expect(service.activeIndexSig()).toBe(3);

    service._activeIndex = null;
    expect(service._activeIndex).toBeNull();
    // Signal stays at last non-null value
    expect(service.activeIndexSig()).toBe(3);
  });

  // ── getOrCreate ─────────────────────────────────────────────────────

  it('getOrCreate should return text$ and gate$ subjects for an index', () => {
    const result = service.getOrCreate(0);
    expect(result.text$).toBeDefined();
    expect(result.gate$).toBeDefined();
  });

  it('getOrCreate should reuse existing subjects for the same index', () => {
    const first = service.getOrCreate(2);
    const second = service.getOrCreate(2);
    expect(first.gate$).toBe(second.gate$);
  });

  // ── setGate ─────────────────────────────────────────────────────────

  it('setGate should create and update gate subjects', () => {
    service.setGate(1, true);
    const gate = service._gate.get(1);
    expect(gate).toBeDefined();
    expect(gate!.getValue()).toBe(true);

    service.setGate(1, false);
    expect(gate!.getValue()).toBe(false);
  });

  // ── emitFormatted lock-leak tripwires (E6) ──────────────────────────
  // emitFormatted sets _fetLocked = true up front, then bails early on an
  // empty/null value. The early-return must NOT leak the lock — an empty
  // "clear" emit should leave _fetLocked at whatever it was on entry, so a
  // subsequent real emit isn't permanently gated. See E6 design doc §3.2.

  it('emitFormatted with an empty string should not leave _fetLocked stuck true', () => {
    service._fetLocked = false;
    service.emitFormatted(0, '', { bypassGuard: true });
    expect(service._fetLocked).toBe(false);
  });

  it('emitFormatted with a null value should not leave _fetLocked stuck true', () => {
    service._fetLocked = false;
    service.emitFormatted(0, null, { bypassGuard: true });
    expect(service._fetLocked).toBe(false);
  });

  it('emitFormatted empty-value bail should preserve a prior locked state', () => {
    service._fetLocked = true;
    service.emitFormatted(0, '', { bypassGuard: true });
    // A no-op empty emit must not change the lock either way.
    expect(service._fetLocked).toBe(true);
  });

  // ── prepareExplanationText ──────────────────────────────────────────

  it('prepareExplanationText returns the explanation or a fallback', () => {
    expect(service.prepareExplanationText({ explanation: 'Hi' } as any)).toBe('Hi');
    expect(service.prepareExplanationText({} as any)).toBe('No explanation available');
  });

  // ── getLatestFormattedExplanation ───────────────────────────────────

  it('getLatestFormattedExplanation reads the formatter signal', () => {
    formatterMock.formattedExplanationSig.mockReturnValue('Live text');
    expect(service.getLatestFormattedExplanation()).toBe('Live text');
  });

  // ── getFormattedExplanation (uninitialized fallback) ────────────────

  it('getFormattedExplanation emits the fallback string before init', () => {
    let emitted: string | undefined;
    service.getFormattedExplanation(0).subscribe((v) => (emitted = v));
    expect(emitted).toBe('No explanation available');
  });

  // ── emitFormatted non-empty (applyFormattedEmit) ────────────────────

  it('emitFormatted with real text stores it and flips the display signals on', () => {
    service._fetLocked = false;
    service.emitFormatted(5, 'Because reasons', { bypassGuard: true });

    expect(service.latestExplanation).toBe('Because reasons');
    expect(service.latestExplanationIndex).toBe(5);
    expect(formatterMock.fetByIndex.get(5)).toBe('Because reasons');
    expect(formatterMock.formattedExplanationSig.set).toHaveBeenCalledWith('Because reasons');
    expect(service.shouldDisplayExplanationSig()).toBe(true);
    expect(service.isExplanationTextDisplayedSig()).toBe(true);
    // applyFormattedEmit leaves the lock engaged for the active question.
    expect(service._fetLocked).toBe(true);
  });

  // ── setExplanationTextForQuestionIndex ──────────────────────────────

  it('setExplanationTextForQuestionIndex stores the text and opens the gate', () => {
    service.setExplanationTextForQuestionIndex(2, 'Indexed text');
    expect(service.explanationTexts[2]).toBe('Indexed text');
    expect(service._gate.get(2)?.getValue()).toBe(true);
  });

  it('setExplanationTextForQuestionIndex ignores negative indices', () => {
    service.setExplanationTextForQuestionIndex(-1, 'nope');
    expect(service.explanationTexts[-1]).toBeUndefined();
  });

  // ── setShouldDisplayExplanation (context aggregation) ────────────────

  it('setShouldDisplayExplanation aggregates across contexts (force-bypassed guard)', () => {
    service.setShouldDisplayExplanation(true, { force: true });
    expect(service.shouldDisplayExplanationSig()).toBe(true);

    service.setShouldDisplayExplanation(false, { force: true });
    expect(service.shouldDisplayExplanationSig()).toBe(false);

    service.setShouldDisplayExplanation(true, { context: 'a', force: true });
    service.setShouldDisplayExplanation(true, { context: 'b', force: true });
    expect(service.shouldDisplayExplanationSig()).toBe(true);

    // Removing one context leaves the other -> still aggregated true.
    service.setShouldDisplayExplanation(false, { context: 'a', force: true });
    expect(service.shouldDisplayExplanationSig()).toBe(true);

    // A global false clears every context.
    service.setShouldDisplayExplanation(false, { force: true });
    expect(service.shouldDisplayExplanationSig()).toBe(false);
  });

  // ── setIsExplanationTextDisplayed (context aggregation) ──────────────

  it('setIsExplanationTextDisplayed aggregates and a global false clears all', () => {
    service.setIsExplanationTextDisplayed(true, { context: 'a', force: true });
    service.setIsExplanationTextDisplayed(true, { context: 'b', force: true });
    expect(service.isExplanationTextDisplayedSig()).toBe(true);

    service.setIsExplanationTextDisplayed(false, { context: 'a', force: true });
    expect(service.isExplanationTextDisplayedSig()).toBe(true);

    service.setIsExplanationTextDisplayed(false, { force: true });
    expect(service.isExplanationTextDisplayedSig()).toBe(false);
  });

  // ── quiet zone / nav time ───────────────────────────────────────────

  it('setQuietZone mirrors the deadline into the signal', () => {
    service.setQuietZone(100);
    expect(service.quietZoneUntilSig()).toBe(service._quietZoneUntil);
    expect(service.quietZoneUntilSig()).toBeGreaterThan(0);
  });

  it('markLastNavTime records the nav timestamp', () => {
    service.markLastNavTime(123456);
    expect(service._lastNavTime).toBe(123456);
  });

  // ── purgeAndDefer (deferred-unlock timer cluster) ───────────────────
  // The heaviest timing path: locks immediately on nav, then releases the FET
  // lock via rAF + setTimeout, with a watchdog backstop. Fake timers + a
  // synchronous rAF stub make the unlock deterministic.
  describe('purgeAndDefer', () => {
    let rafSpy: jest.SpyInstance;
    let cafSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      rafSpy = jest.spyOn(window, 'requestAnimationFrame')
        .mockImplementation(((cb: FrameRequestCallback) => { cb(0); return 1; }) as any);
      cafSpy = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    });

    afterEach(() => {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
      jest.useRealTimers();
    });

    it('locks immediately and sets the new active index + token', () => {
      service._fetLocked = false;
      service.purgeAndDefer(2);
      expect(service._fetLocked).toBe(true);
      expect(service._activeIndex).toBe(2);
      expect(service._gateToken).toBeGreaterThan(0);
    });

    it('releases the lock after the settle delay', () => {
      service.purgeAndDefer(2);
      jest.advanceTimersByTime(200);  // > 120ms settle
      expect(service._fetLocked).toBe(false);
    });

    it('a newer purge bumps the token and its own cycle unlocks', () => {
      service.purgeAndDefer(1);
      const firstToken = service._gateToken;
      service.purgeAndDefer(2);
      expect(service._gateToken).toBe(firstToken + 1);

      jest.advanceTimersByTime(200);
      expect(service._fetLocked).toBe(false);
      expect(service._activeIndex).toBe(2);
    });

    it('watchdog force-unlocks when the rAF settle path never runs', () => {
      rafSpy.mockImplementation((() => 1) as any);  // never invoke the callback
      service._fetLocked = false;
      service.purgeAndDefer(3);
      expect(service._fetLocked).toBe(true);

      jest.advanceTimersByTime(FET_UNLOCK_WATCHDOG_MS + 10);
      expect(service._fetLocked).toBe(false);
    });
  });
});
