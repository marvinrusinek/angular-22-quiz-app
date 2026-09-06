import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';

import { AccordionComponent } from './accordion.component';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';

/**
 * Angular Aria Toolbar prototype coverage for the Quiz Review filter
 * (All / Correct / Incorrect).
 *
 * ROOT BEHAVIOR being pinned: `ngToolbar`/`ngToolbarWidgetGroup` replace the
 * plain `role="group"` + `aria-pressed` buttons with `role="radiogroup"` +
 * `role="radio"`/`aria-checked` and native roving-tabindex + Arrow Left/Right
 * navigation — while `reviewFilter` remains the ONE authoritative signal
 * (fed in one-way via `[value]`, reported back via `(valueChange)`).
 *
 * Two questions are deliberately crafted so correctness is fully
 * deterministic without mocking real selections: with `userAnswers: []`
 * (nothing selected), a question with a `correct:true` option reads as
 * INCORRECT (its required text was never selected); a question with NO
 * `correct:true` option reads as CORRECT (vacuously — zero required texts).
 */
const QUESTIONS: QuizQuestion[] = [
  { questionText: 'Q1', options: [{ optionId: 1, text: 'A', correct: true }, { optionId: 2, text: 'B' }] } as QuizQuestion,
  { questionText: 'Q2', options: [{ optionId: 1, text: 'C' }, { optionId: 2, text: 'D' }] } as QuizQuestion
];

async function render(): Promise<{ fixture: ComponentFixture<AccordionComponent>; comp: AccordionComponent }> {
  TestBed.configureTestingModule({
    imports: [AccordionComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, parent: null } },
      {
        provide: QuizService, useValue: {
          questionsSig: () => QUESTIONS,
          userAnswers: [],
          questions: [],
          quizId: 'fixture-quiz',
          setQuizId: jest.fn(),
          getFinalResultSnapshot: () => null
        }
      },
      { provide: QuizDataService, useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) } },
      {
        provide: SelectedOptionService, useValue: {
          recoverAnswersForResults: jest.fn(),
          rawSelectionsMap: new Map(),
          selectedOptionsMap: new Map()
        }
      },
      { provide: TimerService, useValue: { elapsedTimes: [], isCountdown: () => false } }
    ]
  });

  const fixture = TestBed.createComponent(AccordionComponent);
  fixture.componentRef.setInput('questions', QUESTIONS);
  fixture.detectChanges();
  // Angular Aria's ngToolbar establishes its default active/roving-tabindex
  // item via afterRenderEffect, which flushes on the next render pass rather
  // than synchronously within the first detectChanges().
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, comp: fixture.componentInstance };
}

function filterButtons(fixture: ComponentFixture<AccordionComponent>): HTMLButtonElement[] {
  return [...fixture.nativeElement.querySelectorAll('.review-filter-btn')] as HTMLButtonElement[];
}

describe('AccordionComponent — Review filter Angular Aria Toolbar prototype', () => {
  it('correctness split is deterministic from the crafted fixture: Q1 incorrect, Q2 correct', async () => {
    const { comp } = await render();
    expect(comp.correctCount()).toBe(1);
    expect(comp.incorrectCount()).toBe(1);
  });

  it('initial selected filter is "all", correctly reflected as the checked radio', async () => {
    const { fixture } = await render();
    const buttons = filterButtons(fixture);
    const checked = buttons.filter((b) => b.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain('All');
  });

  it('the group exposes role=radiogroup and each button role=radio (mutually-exclusive semantics)', async () => {
    const { fixture } = await render();
    const group = fixture.nativeElement.querySelector('.review-filter');
    expect(group.getAttribute('role')).toBe('radiogroup');
    for (const btn of filterButtons(fixture)) {
      expect(btn.getAttribute('role')).toBe('radio');
    }
  });

  it('only ONE button participates in the initial Tab order (native roving tabindex)', async () => {
    const { fixture } = await render();
    const tabbable = filterButtons(fixture).filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });

  it('mouse click on "Correct" updates reviewFilter AND the filtered/checked state, without touching correctCount/incorrectCount', async () => {
    const { fixture, comp } = await render();
    const before = { correct: comp.correctCount(), incorrect: comp.incorrectCount() };

    const correctBtn = filterButtons(fixture).find((b) => b.textContent?.includes('Correct'))!;
    correctBtn.click();
    fixture.detectChanges();

    expect(comp.reviewFilter()).toBe('correct');
    expect(comp.filteredQuestions().map((q) => q.question.questionText)).toEqual(['Q2']);
    expect(correctBtn.getAttribute('aria-checked')).toBe('true');
    // The counts themselves are untouched by which filter is active.
    expect(comp.correctCount()).toBe(before.correct);
    expect(comp.incorrectCount()).toBe(before.incorrect);
  });

  it('renders app-code-snippet in the expanded panel only for a question that has one', async () => {
    const withSnippet: QuizQuestion[] = [
      { ...QUESTIONS[0]!, codeSnippet: { language: 'typescript', code: 'const x = 1;' } },
      QUESTIONS[1]!
    ];
    TestBed.configureTestingModule({
      imports: [AccordionComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, parent: null } },
        {
          provide: QuizService, useValue: {
            questionsSig: () => withSnippet,
            userAnswers: [],
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        { provide: QuizDataService, useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) } },
        {
          provide: SelectedOptionService, useValue: {
            recoverAnswersForResults: jest.fn(),
            rawSelectionsMap: new Map(),
            selectedOptionsMap: new Map()
          }
        },
        { provide: TimerService, useValue: { elapsedTimes: [], isCountdown: () => false } }
      ]
    });
    const fixture = TestBed.createComponent(AccordionComponent);
    fixture.componentRef.setInput('questions', withSnippet);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const headers = [...fixture.nativeElement.querySelectorAll('mat-expansion-panel-header')] as HTMLElement[];
    headers[0]!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const snippetEls = fixture.nativeElement.querySelectorAll('app-code-snippet');
    expect(snippetEls.length).toBe(1);
    expect(snippetEls[0].textContent).toContain('const x = 1;');
  });

  it('mouse click on "Incorrect" filters to Q1 only', async () => {
    const { fixture, comp } = await render();
    const incorrectBtn = filterButtons(fixture).find((b) => b.textContent?.includes('Incorrect'))!;
    incorrectBtn.click();
    fixture.detectChanges();

    expect(comp.reviewFilter()).toBe('incorrect');
    expect(comp.filteredQuestions().map((q) => q.question.questionText)).toEqual(['Q1']);
  });

  it('the ngToolbar valueChange path drives the SAME setReviewFilter() a click always has', async () => {
    const { comp } = await render();
    const spy = jest.spyOn(comp, 'setReviewFilter');

    comp.onReviewFilterToolbarChange(['incorrect']);

    expect(spy).toHaveBeenCalledWith('incorrect');
    expect(comp.reviewFilter()).toBe('incorrect');
  });
});
