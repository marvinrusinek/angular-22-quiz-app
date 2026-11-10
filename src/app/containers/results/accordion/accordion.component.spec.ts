import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute } from '@angular/router';

import { AccordionComponent } from './accordion.component';
import { QuizDataService } from '@shared/services/data/quizdata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { QuizQuestion } from '@shared/models';

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
  {
    questionText: 'Q1',
    options: [
      { optionId: 1, text: 'A', correct: true },
      { optionId: 2, text: 'B' }
    ]
  } as QuizQuestion,
  {
    questionText: 'Q2',
    options: [
      { optionId: 1, text: 'C' },
      { optionId: 2, text: 'D' }
    ]
  } as QuizQuestion
];

async function render(): Promise<{
  fixture: ComponentFixture<AccordionComponent>;
  comp: AccordionComponent;
}> {
  TestBed.configureTestingModule({
    imports: [AccordionComponent],
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => null } }, parent: null }
      },
      {
        provide: QuizService,
        useValue: {
          questionsSig: () => QUESTIONS,
          userAnswers: [],
          questions: [],
          quizId: 'fixture-quiz',
          setQuizId: jest.fn(),
          getFinalResultSnapshot: () => null
        }
      },
      {
        provide: QuizDataService,
        useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) }
      },
      {
        provide: SelectedOptionService,
        useValue: {
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
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => null } }, parent: null }
        },
        {
          provide: QuizService,
          useValue: {
            questionsSig: () => withSnippet,
            userAnswers: [],
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        {
          provide: QuizDataService,
          useValue: {
            getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) })
          }
        },
        {
          provide: SelectedOptionService,
          useValue: {
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

    const headers = [
      ...fixture.nativeElement.querySelectorAll('mat-expansion-panel-header')
    ] as HTMLElement[];
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

/**
 * Review detail wording: "was/were" in the Explanation line and "second/seconds" in the Elapsed Time line.
 *
 * Singular only for exactly 1 (0 and 2+ are plural). Rendered through the real expanded panel, so these assert what a user (and
 * a screen reader) actually gets: the exact sentence, single spaces, and the full stop directly after the explanation.
 */
describe('AccordionComponent — Explanation was/were and Elapsed Time second/seconds', () => {
  const opts = (correctCount: number) =>
    ['A', 'B', 'C', 'D'].map((text, i) => ({ optionId: i + 1, text, ...(i < correctCount ? { correct: true } : {}) }));
  const question = (text: string, correctCount: number, explanation: string): QuizQuestion =>
    ({ questionText: text, explanation, options: opts(correctCount) }) as unknown as QuizQuestion;

  async function mountExpanded(
    questions: QuizQuestion[],
    elapsedTimes: number[]
  ): Promise<ComponentFixture<AccordionComponent>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AccordionComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, parent: null } },
        {
          provide: QuizService,
          useValue: {
            questionsSig: () => questions,
            userAnswers: [],
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        {
          provide: QuizDataService,
          useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) }
        },
        {
          provide: SelectedOptionService,
          useValue: { recoverAnswersForResults: jest.fn(), rawSelectionsMap: new Map(), selectedOptionsMap: new Map() }
        },
        { provide: TimerService, useValue: { elapsedTimes, isCountdown: () => false } }
      ]
    });
    const fixture = TestBed.createComponent(AccordionComponent);
    fixture.componentRef.setInput('questions', questions);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    for (const header of [...fixture.nativeElement.querySelectorAll('mat-expansion-panel-header')] as HTMLElement[]) {
      header.click();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  /** The <li> whose leader label is `label`, for each question, in order. */
  const rowsFor = (fixture: ComponentFixture<AccordionComponent>, label: string): HTMLElement[] =>
    ([...fixture.nativeElement.querySelectorAll('li')] as HTMLElement[]).filter(
      (li) => li.querySelector('.leader')?.textContent?.trim() === label
    );
  const norm = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** The Elapsed Time value: the sibling after the label (label and value are separate spans with no text between them). */
  const valueOf = (li: HTMLElement): HTMLElement =>
    [...li.children].find((c) => !c.classList.contains('leader')) as HTMLElement;

  it('Explanation: "was" for exactly one correct option, "were" for two or more', async () => {
    const fixture = await mountExpanded(
      [question('Q1', 1, 'one is right'), question('Q2', 2, 'two are right'), question('Q3', 3, 'three are right')],
      [0, 0, 0]
    );
    const rows = rowsFor(fixture, 'Explanation:');
    expect(rows.map(norm)).toEqual([
      'Explanation: Option 1 was correct because one is right.',
      'Explanation: Options 1 and 2 were correct because two are right.',
      'Explanation: Options 1, 2, and 3 were correct because three are right.'
    ]);
  });

  it('Elapsed Time: "0 seconds", "1 second", "2 seconds", "30 seconds"', async () => {
    const fixture = await mountExpanded(
      [question('Q1', 1, 'a'), question('Q2', 1, 'b'), question('Q3', 1, 'c'), question('Q4', 1, 'd')],
      [0, 1, 2, 30]
    );
    const rows = rowsFor(fixture, 'Elapsed Time:');
    expect(rows.map((li) => norm(valueOf(li)))).toEqual(['0 seconds', '1 second', '2 seconds', '30 seconds']);
    expect(rows.map((li) => norm(li.querySelector('.leader') as HTMLElement))).toEqual(Array(4).fill('Elapsed Time:'));
  });

  it('a question with no recorded time still reads "0 seconds"', async () => {
    const fixture = await mountExpanded([question('Q1', 1, 'a'), question('Q2', 1, 'b')], [5]);
    expect(rowsFor(fixture, 'Elapsed Time:').map((li) => norm(valueOf(li)))).toEqual(['5 seconds', '0 seconds']);
  });

  it('spacing and punctuation: single spaces only, and the full stop follows the explanation directly', async () => {
    const fixture = await mountExpanded([question('Q1', 1, 'one is right'), question('Q2', 2, 'two are right')], [1, 30]);
    for (const row of rowsFor(fixture, 'Explanation:')) {
      const raw = (row.textContent ?? '').trim();
      expect(raw).not.toMatch(/ {2,}|[\r\n\t]/); // no doubled or non-space whitespace in the exposed text
      expect(raw).not.toMatch(/\s\./); // no space before the full stop
      expect(raw).toMatch(/ correct because [a-z ]+\.$/);
    }
    for (const row of rowsFor(fixture, 'Elapsed Time:')) {
      // The value reads exactly "N second(s)" (surrounding collapsed whitespace is not rendered), and the whole row has no
      // doubled or non-space whitespace, so there is at most one space between the label and the value.
      expect((valueOf(row).textContent ?? '').trim()).toMatch(/^\d+ seconds?$/);
      expect((row.textContent ?? '').trim()).not.toMatch(/ {2,}|[\r\n\t]/);
    }
  });

  it('no duplicated or missing text: each sentence part appears exactly once, labels are preserved', async () => {
    const fixture = await mountExpanded([question('Q1', 2, 'unique-explanation-text')], [1]);
    const [exp] = rowsFor(fixture, 'Explanation:');
    const [elapsed] = rowsFor(fixture, 'Elapsed Time:');
    const text = norm(exp!);
    expect(text.match(/unique-explanation-text/g)).toHaveLength(1);
    expect(text.match(/correct because/g)).toHaveLength(1);
    expect(text.match(/\b(was|were)\b/g)).toHaveLength(1);
    expect(exp!.querySelectorAll('.leader')).toHaveLength(1);
    expect(norm(valueOf(elapsed!))).toBe('1 second');
    const e = norm(elapsed!);
    expect(e.match(/\bseconds?\b/g)).toHaveLength(1);
    expect(e.match(/\b1\b/g)).toHaveLength(1);
    expect(elapsed!.querySelectorAll('.leader')).toHaveLength(1);
  });
});
