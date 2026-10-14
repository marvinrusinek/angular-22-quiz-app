import { TestBed } from '@angular/core/testing';

import { NextButtonStateService } from './next-button-state.service';

describe('NextButtonStateService', () => {
  let service: NextButtonStateService;

  beforeEach(() => {
    jest.useFakeTimers();

    TestBed.configureTestingModule({
      providers: [NextButtonStateService]
    });

    service = TestBed.inject(NextButtonStateService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should default isButtonEnabled to false', () => {
    expect(service.isButtonEnabled()).toBe(false);
  });

  // --- evaluateNextButtonState ---

  it('should return true when answered=true, loading=false, navigating=false', () => {
    const result = service.evaluateNextButtonState(true, false, false);
    expect(result).toBe(true);
    expect(service.isButtonEnabled()).toBe(true);
  });

  it('should return false when answered=false, loading=false, navigating=false', () => {
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  it('should return false when answered=true, loading=true, navigating=false', () => {
    const result = service.evaluateNextButtonState(true, true, false);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  it('should return false when answered=true, loading=false, navigating=true', () => {
    const result = service.evaluateNextButtonState(true, false, true);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  it('should return false when all arguments are true', () => {
    const result = service.evaluateNextButtonState(true, true, true);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  it('should return false when all arguments are false', () => {
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  // --- updateAndSyncNextButtonState ---

  it('should set isButtonEnabled to true via updateAndSyncNextButtonState', () => {
    service.updateAndSyncNextButtonState(true);
    expect(service.isButtonEnabled()).toBe(true);
  });

  it('should set isButtonEnabled to false via updateAndSyncNextButtonState', () => {
    service.updateAndSyncNextButtonState(true);
    service.updateAndSyncNextButtonState(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  // --- setNextButtonState ---

  it('should enable the button via setNextButtonState', () => {
    service.setNextButtonState(true);
    expect(service.isButtonEnabled()).toBe(true);
  });

  it('should disable the button via setNextButtonState', () => {
    service.setNextButtonState(true);
    service.setNextButtonState(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  it('should set a 300ms force hold when enabling via setNextButtonState', () => {
    service.setNextButtonState(true);

    // Within the 300ms hold, evaluateNextButtonState should stay true
    jest.advanceTimersByTime(100);
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(true);
    expect(service.isButtonEnabled()).toBe(true);
  });

  // --- forceEnable ---

  it('should force-enable the button', () => {
    service.forceEnable();
    expect(service.isButtonEnabled()).toBe(true);
  });

  it('should prevent disabling during force hold period', () => {
    service.forceEnable(500);

    // Attempt to disable within the hold window
    jest.advanceTimersByTime(200);
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(true);
    expect(service.isButtonEnabled()).toBe(true);
  });

  it('should allow disabling after force hold period expires', () => {
    service.forceEnable(500);

    jest.advanceTimersByTime(600);
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  // --- reset ---

  it('should clear force hold and disable the button on reset', () => {
    service.forceEnable(5000);
    expect(service.isButtonEnabled()).toBe(true);

    service.reset();
    expect(service.isButtonEnabled()).toBe(false);

    // Force hold should be cleared, so evaluate should respect actual state
    const result = service.evaluateNextButtonState(false, false, false);
    expect(result).toBe(false);
    expect(service.isButtonEnabled()).toBe(false);
  });

  // --- nextButtonStyleSig ---

  it('should return disabled style when button is disabled', () => {
    const style = service.nextButtonStyleSig();
    expect(style).toEqual({
      opacity: '0.5',
      cursor: 'not-allowed',
      'pointer-events': 'auto'
    });
  });

  it('should return enabled style when button is enabled', () => {
    service.updateAndSyncNextButtonState(true);
    const style = service.nextButtonStyleSig();
    expect(style).toEqual({
      opacity: '1',
      cursor: 'pointer',
      'pointer-events': 'auto'
    });
  });
});
