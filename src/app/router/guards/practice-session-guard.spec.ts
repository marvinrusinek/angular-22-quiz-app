import { TestBed } from '@angular/core/testing';
import { Router, Routes, UrlTree } from '@angular/router';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { PracticeSessionGuard } from './practice-session-guard';
import { PracticeResultGuard } from './practice-result-guard';
import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';
import { QuizSelectionComponent } from '../../containers/quiz-selection/quiz-selection.component';
import { routes } from '../quiz-routing.routes';

const hasSession = signal(false);
const hasResult = signal(false);
const sessionStub = { hasSession, hasResult } as unknown as PracticeSessionService;

function configure(): void {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      PracticeSessionGuard,
      PracticeResultGuard,
      { provide: PracticeSessionService, useValue: sessionStub }
    ]
  });
}

function sessionGuard(): PracticeSessionGuard {
  configure();
  return TestBed.inject(PracticeSessionGuard);
}

function resultGuard(): PracticeResultGuard {
  configure();
  return TestBed.inject(PracticeResultGuard);
}

function serialize(result: boolean | UrlTree): string {
  return TestBed.inject(Router).serializeUrl(result as UrlTree);
}

/** Resolve a redirect target against the REAL route table. */
function componentFor(path: string): unknown {
  const clean = path.replace(/^\//, '');
  const match = (routes as Routes).find((route) => route.path === clean);
  return match?.component;
}

describe('PracticeSessionGuard', () => {
  beforeEach(() => { hasSession.set(false); hasResult.set(false); });

  it('REJECTS direct navigation when no session has been generated', () => {
    const result = sessionGuard().canActivate();
    expect(result).not.toBe(true);
    expect(result instanceof UrlTree).toBe(true);
    expect(serialize(result)).toBe('/quiz');
  });

  it('redirects to the REAL Quiz Selection screen, not merely an existing route', () => {
    const target = serialize(sessionGuard().canActivate());
    // Pinned against the app's own route table: /quiz must render Quiz Selection.
    expect(componentFor(target)).toBe(QuizSelectionComponent);
  });

  it('ALLOWS entry when an active session exists', () => {
    hasSession.set(true);
    expect(sessionGuard().canActivate()).toBe(true);
  });

  it('allows a REFRESH — the session rehydrates before the guard runs', () => {
    // PracticeSessionService restores its sessionStorage snapshot in its
    // constructor, so by guard time hasSession() is already true.
    hasSession.set(true);
    expect(sessionGuard().canActivate()).toBe(true);
  });

  it('sends a SUBMITTED session forward to Results instead of back into the questions', () => {
    hasSession.set(false);
    hasResult.set(true);
    expect(serialize(sessionGuard().canActivate())).toBe('/practice/results');
  });
});

describe('PracticeResultGuard', () => {
  beforeEach(() => { hasSession.set(false); hasResult.set(false); });

  it('ALLOWS Results when a submitted result exists', () => {
    hasResult.set(true);
    expect(resultGuard().canActivate()).toBe(true);
  });

  it('allows a REFRESH on Results — the result rehydrates with the snapshot', () => {
    hasResult.set(true);
    expect(resultGuard().canActivate()).toBe(true);
  });

  it('sends an UNFINISHED session back to the questions', () => {
    hasSession.set(true);
    expect(serialize(resultGuard().canActivate())).toBe('/practice/weak-areas');
  });

  it('REJECTS direct access with no session at all, landing on Quiz Selection', () => {
    const target = serialize(resultGuard().canActivate());
    expect(target).toBe('/quiz');
    expect(componentFor(target)).toBe(QuizSelectionComponent);
  });

  it('blocks browser Back after Back to Quizzes cleared the snapshot', () => {
    // clear() leaves both flags false — the completed session cannot be restored.
    hasSession.set(false);
    hasResult.set(false);
    expect(resultGuard().canActivate()).not.toBe(true);
  });
});
