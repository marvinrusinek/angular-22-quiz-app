import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { of } from 'rxjs';

import { API_BASE_URL } from '../../../shared/tokens/api-base-url.token';
import { InterviewApiService } from '../../../shared/services/api/interview-api.service';

import { BuildYourInterviewComponent } from './build-your-interview.component';
import { InterviewCatalogService } from '../../../shared/services/interview/interview-catalog.service';
import { QuizStartSpinnerService } from '../../../shared/services/ui/quiz-start-spinner.service';
import { setQuizDataCache } from '../../../shared/quiz-data-cache';
import { Quiz } from '../../../shared/models/Quiz.model';
import { findInterviewPreset } from '../../../shared/models/interview-preset.model';
// S6p (Angular Stage 14): src/assets/data/quiz.json was deleted — the
// production client no longer bundles/fetches any answer-bearing bank. This
// explicit, test-only fixture (identical content, sampled from the
// authoritative backend copy) replaces it; it lives under shared/testing/,
// is imported only from specs, and is never reachable from main.ts's build
// graph, so it does not get bundled into the production artifact.
import quizData from '../../../shared/testing/quiz-catalog-fixture.json';

const REAL_CATALOG = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as Quiz[];

/**
 * What the BACKEND catalogue reports. Mutable so a test can simulate a bank
 * too small to fill a preset — the old setQuizDataCache() trick no longer
 * applies, because the builder does not read the local quiz bank.
 */
let catalogQuizzes: Quiz[] = REAL_CATALOG;
const asTopic = (quiz: Quiz) => ({
  id: quiz.quizId,
  name: quiz.milestone,
  difficulty: quiz.difficulty as string,
  questionCount: quiz.questions?.length ?? 0
});


/**
 * Stage 9C: the builder creates the assessment on the BACKEND. The fixture
 * deliberately carries no correctness and no explanation.
 */
const createSession = jest.fn();
const CREATED = {
  sessionToken: 'a'.repeat(43),
  session: {
    sessionId: 'is_preset_1',
    status: 'active' as const,
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_900_000,
    durationSeconds: 900,
    remainingSeconds: 900,
    config: { mode: 'preset' as const, presetId: 'junior', topicIds: ['typescript'], questionCount: 15 },
    questions: [
      {
        questionId: 'typescript:q:0', sourceQuizId: 'typescript', questionText: 'Q?',
        type: 'single' as const, options: [{ optionId: 101, text: 'a' }, { optionId: 102, text: 'b' }]
      }
    ],
    answers: new Map<string, readonly number[]>()
  }
};

function render(): ComponentFixture<BuildYourInterviewComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuildYourInterviewComponent],
    providers: [
      // Register the real target so startInterview()'s navigation resolves.
      // Stage 9C navigates to the id-bearing route.
      provideRouter([
        { path: 'interview/session', children: [] },
        { path: 'interview/session/:sessionId', children: [] }
      ]),
      // Stage 9C: the builder now creates the session through the API.
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: 'http://test.local/api' },
      { provide: InterviewApiService, useValue: { createSession } },
      /**
       * Topic metadata comes from the BACKEND now. These tests are about preset
       * behaviour, not catalogue loading, so the catalogue is provided already
       * populated — the real service fetches asynchronously, which this file's
       * synchronous render() helper cannot await.
       */
      {
        provide: InterviewCatalogService,
        useValue: {
          topics: () => catalogQuizzes.map(asTopic),
          loading: signal(false),
          unavailable: signal(false),
          load: async () => void 0,
          reload: async () => void 0,
          topicsFor: (difficulty: string | null) => {
            if (!difficulty) return [];
            return catalogQuizzes
              .filter((quiz) => difficulty === 'mixed' || quiz.difficulty === difficulty)
              .map(asTopic);
          },
          availableQuestions: (ids: readonly string[]) =>
            REAL_CATALOG
              .filter((quiz) => ids.includes(quiz.quizId))
              .reduce((sum, quiz) => sum + (quiz.questions?.length ?? 0), 0),
          questionsByDifficulty: (ids: readonly string[]) => {
            const counted = new Set<string>();
            const byDifficulty: Record<string, number> = {
              beginner: 0, intermediate: 0, advanced: 0
            };
            for (const quiz of catalogQuizzes) {
              if (!ids.includes(quiz.quizId) || counted.has(quiz.quizId)) continue;
              counted.add(quiz.quizId);
              const key = quiz.difficulty as string;
              if (key in byDifficulty) byDifficulty[key] += quiz.questions?.length ?? 0;
            }
            return byDifficulty;
          }
        }
      },
      { provide: QuizStartSpinnerService, useValue: { showForStart: async () => void 0 } }
    ]
  });
  const fixture = TestBed.createComponent(BuildYourInterviewComponent);
  fixture.detectChanges();
  return fixture;
}

const text = (el: HTMLElement): string => el.textContent ?? '';

describe('BuildYourInterviewComponent — Quick Setup presets', () => {
  beforeEach(() => {
    // Restore the full catalogue — the starvation tests mutate it, and without
    // this the next test inherits a bank too small to fill any preset.
    catalogQuizzes = REAL_CATALOG;
    setQuizDataCache(REAL_CATALOG, []);
    sessionStorage.clear();
    createSession.mockReset();
    createSession.mockReturnValue(of(CREATED));
  });

  it('offers Custom plus the three role presets as a radiogroup', () => {
    const el = render().nativeElement as HTMLElement;
    const group = el.querySelector('[role="radiogroup"][aria-label="Interview setup"]');
    expect(group).not.toBeNull();
    const labels = [...(group?.querySelectorAll('label.chip') ?? [])].map((l) => text(l as HTMLElement).trim());
    expect(labels).toEqual(['Custom', 'Junior', 'Mid-Level', 'Senior']);
  });

  it('selects Custom by default and shows no preset preview', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.selectedPresetId()).toBe('custom');
    expect(fixture.componentInstance.isCustom()).toBe(true);
    expect(el.querySelector('.preset-preview')).toBeNull();
  });

  it('communicates the selected state programmatically, not by colour alone', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[name="quickSetup"]')];
    expect(radios[0].checked).toBe(true);            // Custom

    fixture.componentInstance.selectPreset('senior');
    fixture.detectChanges();
    const after = [...el.querySelectorAll<HTMLInputElement>('input[name="quickSetup"]')];
    expect(after[0].checked).toBe(false);
    expect(after[3].checked).toBe(true);             // Senior
  });

  it.each([
    ['junior', 'Junior Angular Developer', '15', '20'],
    ['mid-level', 'Mid-Level Angular Developer', '20', '30'],
    ['senior', 'Senior Angular Developer', '25', '40']
  ] as const)('previews %s with name, description, count and duration', (id, name, count, minutes) => {
    const fixture = render();
    fixture.componentInstance.selectPreset(id);
    fixture.detectChanges();

    const preview = fixture.nativeElement.querySelector('.preset-preview') as HTMLElement;
    expect(preview).not.toBeNull();
    expect(text(preview)).toContain(name);
    expect(text(preview)).toContain(findInterviewPreset(id)!.description);
    expect(text(preview)).toContain(count);
    expect(text(preview)).toContain(minutes);
  });

  it('shows the resolved difficulty MIX as counts, not percentages', () => {
    const fixture = render();
    fixture.componentInstance.selectPreset('mid-level');
    fixture.detectChanges();
    const mix = text(fixture.nativeElement.querySelector('.preset-preview__mix') as HTMLElement);
    expect(mix).toContain('4 Beginner');
    expect(mix).toContain('12 Intermediate');
    expect(mix).toContain('4 Advanced');
    expect(mix).not.toContain('%');
  });

  it('lists the preset topic names', () => {
    const fixture = render();
    fixture.componentInstance.selectPreset('junior');
    fixture.detectChanges();
    expect(fixture.componentInstance.presetTopicNames().length)
      .toBe(findInterviewPreset('junior')!.topicIds.length);
    expect(text(fixture.nativeElement.querySelector('.preset-preview__topics') as HTMLElement))
      .toContain('Topics:');
  });

  it('always shows the representativeness disclaimer', () => {
    const el = render().nativeElement as HTMLElement;
    expect(text(el)).toContain('Preset mixes are representative');
  });

  it('selecting a preset does NOT auto-start the interview', () => {
    const fixture = render();
    fixture.componentInstance.selectPreset('senior');
    fixture.detectChanges();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('Start uses the SELECTED preset rather than the Custom config', async () => {
    const fixture = render();
    fixture.componentInstance.selectPreset('mid-level');
    fixture.detectChanges();
    await fixture.componentInstance.startInterview();

    // Stage 9C: the preset goes to the BACKEND as just its id.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({ mode: 'preset', presetId: 'mid-level' });
  });

  // REGRESSION: the Start button bound to startDisabled(), which only describes
  // the CUSTOM configuration — so selecting a preset with Custom left untouched
  // left the button disabled and the preset unstartable. Earlier tests called
  // startInterview() directly and never saw it; these assert the real button.
  it('ENABLES the real Start button as soon as a preset is selected', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const button = () => el.querySelector<HTMLButtonElement>('button.start-interview-btn')!;

    // Custom with nothing configured → correctly disabled.
    expect(button().disabled).toBe(true);

    for (const id of ['junior', 'mid-level', 'senior'] as const) {
      fixture.componentInstance.selectPreset(id);
      fixture.detectChanges();
      expect(button().disabled).toBe(false);
    }

    // Back to an unconfigured Custom → disabled again.
    fixture.componentInstance.selectPreset('custom');
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
  });

  it('clicking the real Start button begins the selected preset', async () => {
    const fixture = render();
    fixture.componentInstance.selectPreset('junior');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button.start-interview-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({ mode: 'preset', presetId: 'junior' });
  });

  it('keeps the real Start button DISABLED when a preset cannot be filled', () => {
    // Starve the BACKEND catalogue — the builder no longer reads the local bank.
    catalogQuizzes = REAL_CATALOG.map((q) => ({ ...q, questions: (q.questions ?? []).slice(0, 1) })) as Quiz[];
    const fixture = render();
    fixture.componentInstance.selectPreset('senior');
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button.start-interview-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('preserves an in-progress Custom configuration while previewing a preset', () => {
    const fixture = render();
    const comp = fixture.componentInstance;

    // Build up a partial Custom configuration.
    comp.setDifficulty('intermediate');
    fixture.detectChanges();
    comp.toggleTopic('router', true);
    comp.toggleTopic('http', true);
    comp.setCount(10);
    fixture.detectChanges();

    // Wander through the presets…
    comp.selectPreset('senior');
    fixture.detectChanges();
    comp.selectPreset('junior');
    fixture.detectChanges();

    // …and back to Custom: everything is exactly as it was left.
    comp.selectPreset('custom');
    fixture.detectChanges();
    expect(comp.isCustom()).toBe(true);
    expect(comp.difficulty()).toBe('intermediate');
    expect([...comp.selectedTopicIds()].sort()).toEqual(['http', 'router']);
    expect(comp.questionCount()).toBe(10);
  });

  it('Custom start sends a custom backend request', async () => {
    const fixture = render();
    const comp = fixture.componentInstance;
    comp.setDifficulty('beginner');
    fixture.detectChanges();
    comp.toggleTopic('typescript', true);
    comp.toggleTopic('templates', true);
    comp.setCount(10);
    fixture.detectChanges();

    await comp.startInterview();
    // Custom now sends exactly the four permitted fields to the backend.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({
      mode: 'custom', difficulty: 'beginner',
      topicIds: ['typescript', 'templates'], questionCount: 10
    });
  });

  it('every preset is startable against the real question bank', () => {
    const fixture = render();
    for (const id of ['junior', 'mid-level', 'senior'] as const) {
      fixture.componentInstance.selectPreset(id);
      fixture.detectChanges();
      expect(fixture.componentInstance.presetStartDisabled()).toBe(false);
      expect(fixture.componentInstance.presetInvalidReason()).toBe('');
    }
  });

  it('disables Start and explains the shortfall when capacity is insufficient', () => {
    // Starve the bank so no preset can be filled.
    // Starve the BACKEND catalogue — the builder no longer reads the local bank.
    catalogQuizzes = REAL_CATALOG.map((q) => ({ ...q, questions: (q.questions ?? []).slice(0, 1) })) as Quiz[];

    const fixture = render();
    fixture.componentInstance.selectPreset('senior');
    fixture.detectChanges();

    expect(fixture.componentInstance.presetStartDisabled()).toBe(true);
    const reason = fixture.componentInstance.presetInvalidReason();
    expect(reason).toContain('25');                      // required
    expect(reason).toMatch(/Only \d+ of the 25/);        // available vs required
  });
});
