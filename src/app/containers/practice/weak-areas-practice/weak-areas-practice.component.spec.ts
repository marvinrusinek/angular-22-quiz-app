import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { computed, signal } from '@angular/core';

import { WeakAreasPracticeComponent } from './weak-areas-practice.component';
import { PracticeSessionService } from '../../../shared/services/features/practice/practice-session.service';
import { PracticeVerdictService } from '../../../shared/services/features/practice/practice-verdict.service';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { QuestionType } from '../../../shared/models/question-type.enum';
import {
  canAdvanceFromQuestion,
  isQuestionResolved
} from '../../../shared/utils/practice-scoring';
import { setQuizDataCache } from '../../../shared/quiz-data-cache';

const SINGLE: QuizQuestion = {
  questionText: 'Single?',
  // DECLARED type — the gate no longer counts correct options to infer it.
  type: QuestionType.SingleAnswer,
  explanation: 'SINGLE-FET',
  sourceQuizId: 'rxjs',
  options: [
    { optionId: 1, text: 'Wrong', correct: false },
    { optionId: 2, text: 'Right', correct: true }
  ]
} as QuizQuestion;

const MULTI: QuizQuestion = {
  questionText: 'Pick two',
  type: QuestionType.MultipleAnswer,
  explanation: 'MULTI-FET',
  sourceQuizId: 'rxjs',
  options: [
    { optionId: 1, text: 'A', correct: true },
    { optionId: 2, text: 'B', correct: false },
    { optionId: 3, text: 'C', correct: true }
  ]
} as QuizQuestion;

/**
 * A signal-backed stand-in that reuses the SAME pure gate the real service uses,
 * so these DOM assertions pin the real rule rather than a test-only copy.
 */
function makeSessionStub(questions: QuizQuestion[]) {
  const currentIndex = signal(0);
  const answersByIndex = signal<Record<number, number[]>>({});
  const submitted = signal(false);

  const currentQuestion = computed(() => questions[currentIndex()] ?? null);
  const currentSelection = computed<number[]>(() => answersByIndex()[currentIndex()] ?? []);

  /**
   * Stands in for the AUTHORIZED verdict the real session reads from
   * PracticeVerdictService. It reproduces the backend's rule from the fixture's
   * own flags so these DOM assertions still pin real gating behaviour — the
   * production path has no such computation, which is the point of S6.
   */
  const authorizedResolved = (q: QuizQuestion): boolean => {
    const selected = currentSelection();
    if (selected.length === 0) return false;
    const correct = (q.options ?? [])
      .filter((o) => (o as { correct?: boolean }).correct === true)
      .map((o) => o.optionId as number);
    if (q.type === QuestionType.MultipleAnswer) {
      return correct.every((id) => selected.includes(id));
    }
    return selected.length === 1 && correct.includes(selected[0]);
  };

  const canAdvance = computed(() =>
    canAdvanceFromQuestion(currentQuestion(), currentSelection(), authorizedResolved)
  );
  const isLastQuestion = computed(() => currentIndex() === questions.length - 1);

  return {
    total: computed(() => questions.length),
    currentIndex,
    currentQuestion,
    answersByIndex,
    answeredCount: computed(() => Object.values(answersByIndex()).filter((a) => a.length > 0).length),
    allAnswered: computed(() => false),
    canGoPrevious: computed(() => currentIndex() > 0),
    canAdvance,
    isLastQuestion,
    canGoNext: computed(() => canAdvance() && !isLastQuestion()),
    canSubmit: computed(() => isLastQuestion() && canAdvance()),
    isCurrentAnswered: computed(() => currentSelection().length > 0),
    // Declared-type driven, exactly as the real session computes it.
    isCurrentMultiAnswer: computed(() => currentQuestion()?.type === QuestionType.MultipleAnswer),
    isCurrentResolved: computed(() => isQuestionResolved(currentQuestion(), currentSelection(), authorizedResolved)),
    currentSelection,
    submitted,
    select: (index: number, ids: number[]) =>
      answersByIndex.update((m) => ({ ...m, [index]: [...ids] })),
    next: () => { if (canAdvance() && !isLastQuestion()) currentIndex.update((i) => i + 1); },
    previous: () => { if (currentIndex() > 0) currentIndex.update((i) => i - 1); },
    submit: () => submitted.set(true),
    clear: jest.fn()
  };
}

type SessionStub = ReturnType<typeof makeSessionStub>;

async function mount(questions: QuizQuestion[]): Promise<{
  fixture: ComponentFixture<WeakAreasPracticeComponent>;
  session: SessionStub;
}> {
  const session = makeSessionStub(questions);

  /**
   * Stands in for PracticeVerdictService, i.e. for what `POST /check` returned.
   *
   * It derives its answers from the fixture's own flags so these DOM assertions
   * keep pinning real behaviour — but note what that proves: the COMPONENT now
   * paints and reveals purely from this, never from `option.correct`. Feeding it
   * nothing would leave every option unpainted, which is exactly the
   * no-local-fallback guarantee.
   */
  const verdictStub = {
    verdicts: signal(new Map()),
    verdictFor: (_quizId: string, questionText: string) => {
      const q = questions.find((x) => x.questionText === questionText);
      const selected = session.currentSelection();
      const correctTexts = (q?.options ?? [])
        .filter((o) => (o as { correct?: boolean }).correct === true)
        .map((o) => o.text ?? '');
      const resolved = q ? session.isCurrentResolved() : false;
      const selectedVerdicts = new Map<string, boolean>();
      for (const option of q?.options ?? []) {
        if (option.optionId != null && selected.includes(option.optionId)) {
          selectedVerdicts.set(
            (option.text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(),
            (option as { correct?: boolean }).correct === true
          );
        }
      }
      return {
        resolved,
        terminal: resolved || selected.length > 0,
        selectedVerdicts,
        correctTexts: resolved ? correctTexts : [],
        remainingCorrectCount: null,
        explanation: resolved ? (q?.explanation ?? '') : '',
        errored: false
      };
    },
    isResolved: () => session.isCurrentResolved(),
    check: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    clear: jest.fn()
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [WeakAreasPracticeComponent],
    providers: [
      provideRouter([]),
      { provide: PracticeSessionService, useValue: session },
      { provide: PracticeVerdictService, useValue: verdictStub }
    ]
  });
  const fixture = TestBed.createComponent(WeakAreasPracticeComponent);
  fixture.detectChanges();
  return { fixture, session };
}

function nextButton(fixture: ComponentFixture<WeakAreasPracticeComponent>): HTMLButtonElement {
  const buttons = [...fixture.nativeElement.querySelectorAll('.wap__nav button')] as HTMLButtonElement[];
  return buttons[buttons.length - 1];
}

function explanationText(fixture: ComponentFixture<WeakAreasPracticeComponent>): string {
  return fixture.nativeElement.querySelector('.wap__explanation')?.textContent?.trim() ?? '';
}

function pressArrowRight(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
}

describe('WeakAreasPracticeComponent — Next gating', () => {
  beforeEach(() => { sessionStorage.clear(); setQuizDataCache([], []); });

  it('disables Next while the question is unanswered', async () => {
    const { fixture } = await mount([SINGLE, MULTI]);
    expect(nextButton(fixture).disabled).toBe(true);
  });

  it('SINGLE: a WRONG selection ENABLES Next (verified topic-quiz behaviour)', async () => {
    const { fixture, session } = await mount([SINGLE, MULTI]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(nextButton(fixture).disabled).toBe(false);
  });

  it('MULTI: a PARTIAL selection leaves Next disabled', async () => {
    const { fixture, session } = await mount([MULTI, SINGLE]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(nextButton(fixture).disabled).toBe(true);
  });

  it('MULTI: the COMPLETE correct set enables Next', async () => {
    const { fixture, session } = await mount([MULTI, SINGLE]);
    session.select(0, [1, 3]);
    fixture.detectChanges();
    expect(nextButton(fixture).disabled).toBe(false);
  });

  it('shows Finish Practice instead of Next on the LAST question', async () => {
    const { fixture, session } = await mount([SINGLE, MULTI]);
    session.select(0, [2]);
    fixture.detectChanges();
    nextButton(fixture).click();
    fixture.detectChanges();

    expect(nextButton(fixture).textContent).toContain('Finish Practice');
    expect(nextButton(fixture).disabled).toBe(true);      // multi still unanswered

    session.select(1, [1, 3]);
    fixture.detectChanges();
    expect(nextButton(fixture).disabled).toBe(false);
  });
});

describe('WeakAreasPracticeComponent — right-arrow obeys the SAME gate as Next', () => {
  beforeEach(() => { sessionStorage.clear(); setQuizDataCache([], []); });

  it('ArrowRight does nothing while Next is disabled (partial multi-answer)', async () => {
    const { fixture, session } = await mount([MULTI, SINGLE]);
    session.select(0, [1]);
    fixture.detectChanges();

    expect(nextButton(fixture).disabled).toBe(true);
    pressArrowRight();
    fixture.detectChanges();
    expect(session.currentIndex()).toBe(0);   // keyboard cannot bypass the gate
  });

  it('ArrowRight advances exactly when Next is enabled', async () => {
    const { fixture, session } = await mount([MULTI, SINGLE]);
    session.select(0, [1, 3]);
    fixture.detectChanges();

    expect(nextButton(fixture).disabled).toBe(false);
    pressArrowRight();
    fixture.detectChanges();
    expect(session.currentIndex()).toBe(1);
  });

  it('ArrowRight advances after a WRONG single answer, matching the enabled Next', async () => {
    const { fixture, session } = await mount([SINGLE, MULTI]);
    session.select(0, [1]);
    fixture.detectChanges();
    pressArrowRight();
    fixture.detectChanges();
    expect(session.currentIndex()).toBe(1);
  });

  it('ArrowLeft goes back and is never gated', async () => {
    const { fixture, session } = await mount([SINGLE, MULTI]);
    session.select(0, [2]);
    fixture.detectChanges();
    pressArrowRight();
    fixture.detectChanges();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(session.currentIndex()).toBe(0);
  });
});

describe('WeakAreasPracticeComponent — FET reveal', () => {
  beforeEach(() => { sessionStorage.clear(); setQuizDataCache([], []); });

  it('hides the FET while unanswered', async () => {
    const { fixture } = await mount([SINGLE]);
    expect(explanationText(fixture)).toBe('');
  });

  it('SINGLE: a WRONG selection does NOT reveal the FET', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('');
  });

  it('SINGLE: the correct selection reveals the FET', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [2]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('SINGLE-FET');
  });

  it('MULTI: a PARTIAL selection does NOT reveal the FET', async () => {
    const { fixture, session } = await mount([MULTI]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('');
  });

  it('MULTI: the complete correct set reveals the FET', async () => {
    const { fixture, session } = await mount([MULTI]);
    session.select(0, [1, 3]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('MULTI-FET');
  });

  it('re-hides the FET if the answer is changed back to a wrong one', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [2]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('SINGLE-FET');

    session.select(0, [1]);
    fixture.detectChanges();
    expect(explanationText(fixture)).toBe('');
  });
});

describe('WeakAreasPracticeComponent — options stay changeable until resolved', () => {
  beforeEach(() => { sessionStorage.clear(); setQuizDataCache([], []); });

  function inputs(fixture: ComponentFixture<WeakAreasPracticeComponent>): HTMLInputElement[] {
    return [...fixture.nativeElement.querySelectorAll('.io-input')] as HTMLInputElement[];
  }

  it('leaves options enabled after a WRONG single answer', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(inputs(fixture).every((input) => !input.disabled)).toBe(true);
  });

  it('marks the wrong pick incorrect immediately without revealing the answer', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [1]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Your answer — incorrect');
    expect(text).not.toContain('Correct answer');
  });

  it('locks options and reveals the answer once resolved', async () => {
    const { fixture, session } = await mount([SINGLE]);
    session.select(0, [2]);
    fixture.detectChanges();

    expect(inputs(fixture).every((input) => input.disabled)).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Correct answer');
  });

  it('leaves multi-answer options enabled while partial', async () => {
    const { fixture, session } = await mount([MULTI]);
    session.select(0, [1]);
    fixture.detectChanges();
    expect(inputs(fixture).every((input) => !input.disabled)).toBe(true);
  });
});

describe('WeakAreasPracticeComponent — exits', () => {
  beforeEach(() => { sessionStorage.clear(); setQuizDataCache([], []); });

  it('Back to Quizzes clears the session and navigates to Quiz Selection', async () => {
    const { fixture, session } = await mount([SINGLE]);
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.backToQuizzes();
    expect(session.clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/quiz'], { replaceUrl: true });
  });

  it('Finish Practice submits and navigates to Practice Results', async () => {
    const { fixture, session } = await mount([SINGLE]);
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);

    session.select(0, [2]);
    fixture.detectChanges();
    await fixture.componentInstance.submit();

    expect(session.submitted()).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/practice/results']);
  });

  it('does not submit when the gate is closed', async () => {
    const { fixture, session } = await mount([MULTI]);
    const router = TestBed.inject(Router);
    const navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);

    session.select(0, [1]);                 // partial
    fixture.detectChanges();
    await fixture.componentInstance.submit();

    expect(session.submitted()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
