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
      ...fixture.nativeElement.querySelectorAll('.qr-header')
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
    for (const header of [...fixture.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[]) {
      header.click();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  /** The detail rows whose single text node starts with `label`, for each question, in order. */
  const rowsFor = (fixture: ComponentFixture<AccordionComponent>, label: string): HTMLElement[] =>
    ([...fixture.nativeElement.querySelectorAll('.quiz-summary-row')] as HTMLElement[]).filter((row) =>
      (row.querySelector('.quiz-summary-text')?.textContent ?? '').startsWith(label)
    );
  const norm = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** The row value: its text after the "<label>: " prefix (label and value are ONE text node now). */
  const valueOf = (row: HTMLElement): string =>
    norm(row.querySelector('.quiz-summary-text') as HTMLElement).replace(/^[^:]+:\s*/, '');

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
    expect(rows.map(valueOf)).toEqual(['0 seconds', '1 second', '2 seconds', '30 seconds']);
    expect(rows.map(norm)).toEqual([
      'Elapsed Time: 0 seconds',
      'Elapsed Time: 1 second',
      'Elapsed Time: 2 seconds',
      'Elapsed Time: 30 seconds'
    ]);
  });

  it('a question with no recorded time still reads "0 seconds"', async () => {
    const fixture = await mountExpanded([question('Q1', 1, 'a'), question('Q2', 1, 'b')], [5]);
    expect(rowsFor(fixture, 'Elapsed Time:').map(valueOf)).toEqual(['5 seconds', '0 seconds']);
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
      expect(valueOf(row)).toMatch(/^\d+ seconds?$/);
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
    expect(exp!.querySelectorAll('.quiz-summary-text')).toHaveLength(1);
    expect(valueOf(elapsed!)).toBe('1 second');
    const e = norm(elapsed!);
    expect(e.match(/\bseconds?\b/g)).toHaveLength(1);
    expect(e.match(/\b1\b/g)).toHaveLength(1);
    expect(elapsed!.querySelectorAll('.quiz-summary-text')).toHaveLength(1);
  });
});

/**
 * Variant D — CDK accordion with native button headers and an UNNAMED expanded body.
 *
 * Material's expansion panel exposed the body as role="region" labelled by the whole question header, so Narrator
 * re-announced the question text when Down Arrow entered the details. These tests pin the replacement structure:
 * a real button per header (aria-expanded / aria-controls), a plain body with no role and no aria-labelledby, the
 * same answer rows, multi-open, and Material's header keyboard navigation (Arrow Up/Down wrap, Home/End).
 */
describe('AccordionComponent — CDK accordion semantics (Variant D)', () => {
  const headersOf = (f: ComponentFixture<AccordionComponent>): HTMLButtonElement[] =>
    [...f.nativeElement.querySelectorAll('.qr-header')] as HTMLButtonElement[];
  const key = (el: HTMLElement, name: string, keyCode: number): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
  };

  it('each header is a native button: aria-expanded=false and aria-controls initially, no body rendered', async () => {
    const { fixture } = await render();
    const headers = headersOf(fixture);
    expect(headers).toHaveLength(2);
    for (const [i, h] of headers.entries()) {
      expect(h.tagName).toBe('BUTTON');
      expect(h.getAttribute('type')).toBe('button');
      expect(h.getAttribute('aria-expanded')).toBe('false');
      expect(h.getAttribute('aria-controls')).toBe(`qr-body-${i}`);
    }
    expect(fixture.nativeElement.querySelectorAll('.qr-body')).toHaveLength(0);
  });

  it('expanding renders the body whose id matches aria-controls; the body has NO role and NO aria-labelledby', async () => {
    const { fixture } = await render();
    const [h0] = headersOf(fixture);
    h0.click();
    fixture.detectChanges();
    expect(h0.getAttribute('aria-expanded')).toBe('true');
    const body = fixture.nativeElement.querySelector('#qr-body-0') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.id).toBe(h0.getAttribute('aria-controls'));
    expect(body.hasAttribute('role')).toBe(false);
    expect(body.hasAttribute('aria-labelledby')).toBe(false);
    expect(body.hasAttribute('aria-label')).toBe(false);
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
    // the question text lives ONLY in the header, never repeated inside the body
    expect(body.textContent).not.toContain('Q1');
    expect(h0.textContent).toContain('Q1');
  });

  it('keeps the four answer rows inside the expanded body, in order', async () => {
    const { fixture } = await render();
    headersOf(fixture)[0].click();
    fixture.detectChanges();
    const rows = [...fixture.nativeElement.querySelectorAll('#qr-body-0 .quiz-summary-row')] as HTMLElement[];
    const labels = rows.map((r) => (r.querySelector('.quiz-summary-text')!.textContent ?? '').split(':')[0]);
    expect(labels).toEqual(['Your Answer(s)', 'Correct Answer(s)', 'Explanation', 'Elapsed Time']);
  });

  it('is multi-open: expanding a second panel leaves the first open, and a click collapses again', async () => {
    const { fixture } = await render();
    const [h0, h1] = headersOf(fixture);
    h0.click(); h1.click();
    fixture.detectChanges();
    expect([h0, h1].map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    h0.click();
    fixture.detectChanges();
    expect([h0, h1].map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    expect(fixture.nativeElement.querySelector('#qr-body-0')).toBeNull();
  });

  it('the decorative +/- icon is aria-hidden and switches add/remove with the state', async () => {
    const { fixture } = await render();
    const [h0] = headersOf(fixture);
    const icon = h0.querySelector('.accordion-icon') as HTMLElement;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.textContent!.trim()).toBe('add');
    h0.click();
    fixture.detectChanges();
    expect(icon.textContent!.trim()).toBe('remove');
  });

  it('Arrow Down/Up move focus between headers and wrap; Home/End jump to the first/last', async () => {
    const { fixture } = await render();
    document.body.appendChild(fixture.nativeElement);
    const [h0, h1] = headersOf(fixture);
    h0.focus();
    key(h0, 'ArrowDown', 40);
    expect(document.activeElement).toBe(h1);
    key(h1, 'ArrowDown', 40); // wraps to the first
    expect(document.activeElement).toBe(h0);
    key(h0, 'ArrowUp', 38); // wraps to the last
    expect(document.activeElement).toBe(h1);
    key(h1, 'Home', 36);
    expect(document.activeElement).toBe(h0);
    key(h0, 'End', 35);
    expect(document.activeElement).toBe(h1);
    fixture.nativeElement.remove();
  });
});

/**
 * Variant D — the four detail rows are plain containers, not a list.
 *
 * A native <ul>/<li> made Narrator append list positions to every row ("1 of 4" ... "4 of 4"). The rows are now
 * div.quiz-summary-row inside div.quiz-summary-fields. The glyph icons are aria-hidden; for answered questions the
 * meaning (Correct / Incorrect) is carried by real visually-hidden text instead of the spoken ligature word.
 */
describe('AccordionComponent — detail rows are not a list (Variant D)', () => {
  const Q = (text: string): QuizQuestion =>
    ({
      questionText: text,
      explanation: 'because',
      options: [
        { optionId: 1, text: 'A', correct: true },
        { optionId: 2, text: 'B' }
      ]
    }) as QuizQuestion;

  async function mount(selections: Map<number, { optionId: number; text: string }[]>): Promise<ComponentFixture<AccordionComponent>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AccordionComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, parent: null } },
        {
          provide: QuizService,
          useValue: {
            questionsSig: () => [Q('Q1'), Q('Q2'), Q('Q3')],
            userAnswers: [],
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        { provide: QuizDataService, useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) } },
        {
          provide: SelectedOptionService,
          useValue: { recoverAnswersForResults: jest.fn(), rawSelectionsMap: selections, selectedOptionsMap: new Map() }
        },
        { provide: TimerService, useValue: { elapsedTimes: [], isCountdown: () => false } }
      ]
    });
    const fixture = TestBed.createComponent(AccordionComponent);
    fixture.componentRef.setInput('questions', [Q('Q1'), Q('Q2'), Q('Q3')]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    for (const h of [...fixture.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[]) {
      h.click();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  // Q1 answered wrongly (B), Q2 answered correctly (A), Q3 unanswered.
  const SELECTIONS = new Map([
    [0, [{ optionId: 2, text: 'B' }]],
    [1, [{ optionId: 1, text: 'A' }]]
  ]);
  const body = (f: ComponentFixture<AccordionComponent>, i: number): HTMLElement => f.nativeElement.querySelector(`#qr-body-${i}`) as HTMLElement;
  const answerRow = (f: ComponentFixture<AccordionComponent>, i: number): HTMLElement => body(f, i).querySelector('.quiz-summary-row') as HTMLElement;

  it('exposes NO list semantics: no ul/ol/li and no role=list/listitem anywhere in the expanded bodies', async () => {
    const f = await mount(SELECTIONS);
    for (const i of [0, 1, 2]) {
      expect(body(f, i).querySelector('ul, ol, li, [role="list"], [role="listitem"]')).toBeNull();
    }
  });

  it('each body has exactly four rows, each a plain div with ONE label followed by its value, in order', async () => {
    const f = await mount(SELECTIONS);
    for (const i of [0, 1, 2]) {
      const rows = [...body(f, i).querySelectorAll('.quiz-summary-fields > .quiz-summary-row')] as HTMLElement[];
      expect(rows.map((r) => r.tagName)).toEqual(['DIV', 'DIV', 'DIV', 'DIV']);
      // bold-label variant: one span per row = a label span + ONE value text node (textContent is still "<label>: <value>")
      for (const r of rows) {
        const spans = r.querySelectorAll('.quiz-summary-text');
        expect(spans).toHaveLength(1);
        expect(spans[0].getAttribute('role')).toBe('img');
        expect((spans[0].childNodes[0] as HTMLElement).classList.contains('quiz-summary-label')).toBe(true);
        expect([...spans[0].childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())).toHaveLength(1);
        expect(r.querySelector('.leader')).toBeNull();
      }
      expect(rows.map((r) => (r.querySelector('.quiz-summary-text')!.textContent ?? '').split(':')[0])).toEqual([
        'Your Answer(s)', 'Correct Answer(s)', 'Explanation', 'Elapsed Time'
      ]);
    }
    expect(norm2(rowsOf(f, 1)[1])).toContain('Option 1');
  });

  it('answered INCORRECT: icon-only look; the clear icon is an image named "Incorrect"; no verdict text in the sentence', async () => {
    const f = await mount(SELECTIONS);
    const row = answerRow(f, 0);
    const img = row.querySelector('.quiz-summary-text[role="img"]')!;
    expect(plain(img)).toBe('Your Answer(s): Option 2: B');
    expect(img.getAttribute('aria-label')).toBe('Your Answer(s): Option 2: B, Incorrect');
    expect(img.querySelector('i.incorrect')!.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('i.correct')).toBeNull();
  });

  it('answered CORRECT: icon-only look; the done icon is an image named "Correct"; no verdict text in the sentence', async () => {
    const f = await mount(SELECTIONS);
    const row = answerRow(f, 1);
    const img = row.querySelector('.quiz-summary-text[role="img"]')!;
    expect(plain(img)).toBe('Your Answer(s): Option 1: A');
    expect(img.getAttribute('aria-label')).toBe('Your Answer(s): Option 1: A, Correct');
    expect(img.querySelector('i.correct')!.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('i.incorrect')).toBeNull();
  });

  it('UNANSWERED: the visible "(no answer provided)" text stays; its X icon is an image named "Incorrect"', async () => {
    const f = await mount(SELECTIONS);
    const row = answerRow(f, 2);
    expect(norm2(row)).toContain('(no answer provided)');
    expect(row.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): (no answer provided), Incorrect');
    expect(row.querySelector('[role="img"] i.incorrect')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('adds no ARIA labels (other than the two icon images) or live regions to the rows', async () => {
    const f = await mount(SELECTIONS);
    for (const i of [0, 1, 2]) {
      expect(body(f, i).querySelector('[aria-label]:not([role="img"]), [aria-labelledby], [aria-live], [role="status"], [role="alert"]')).toBeNull();
    }
  });
});

const plain = (el: Element): string => {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('i').forEach((i) => i.remove());
  return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
};
const norm2 = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const rowsOf = (f: ComponentFixture<AccordionComponent>, i: number): HTMLElement[] =>
  [...f.nativeElement.querySelectorAll(`#qr-body-${i} .quiz-summary-row`)] as HTMLElement[];

/**
 * Variant D — consolidated detail rows: the exact sentence of every row, across the answer branches.
 *
 * Each row is ONE text node ("<label>: <value>"). These pin the wording for: a single correct selection, an incorrect
 * selection, a multi-answer question, the stored-answers fallback (no live selection), an unanswered question, an empty
 * explanation, and the "was"/"were" and "second"/"seconds" choices that replaced the ICU plurals.
 */
describe('AccordionComponent — consolidated detail row sentences (Variant D)', () => {
  const single = (text: string, explanation = 'because'): QuizQuestion =>
    ({
      questionText: text,
      explanation,
      options: [
        { optionId: 1, text: 'A', correct: true },
        { optionId: 2, text: 'B' }
      ]
    }) as QuizQuestion;
  const multi = (text: string): QuizQuestion =>
    ({
      questionText: text,
      explanation: 'both are needed',
      options: [
        { optionId: 1, text: 'A', correct: true },
        { optionId: 2, text: 'B' },
        { optionId: 3, text: 'C', correct: true }
      ]
    }) as QuizQuestion;

  async function mount(
    questions: QuizQuestion[],
    selections: Map<number, { optionId: number; text: string }[]>,
    userAnswers: number[][],
    elapsedTimes: number[]
  ): Promise<ComponentFixture<AccordionComponent>> {
    localStorage.removeItem('quizAnswersForResults');
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
            userAnswers,
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        { provide: QuizDataService, useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) } },
        {
          provide: SelectedOptionService,
          useValue: { recoverAnswersForResults: jest.fn(), rawSelectionsMap: selections, selectedOptionsMap: new Map() }
        },
        { provide: TimerService, useValue: { elapsedTimes, isCountdown: () => false } }
      ]
    });
    const fixture = TestBed.createComponent(AccordionComponent);
    fixture.componentRef.setInput('questions', questions);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    for (const h of [...fixture.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[]) {
      h.click();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const rowTexts = (f: ComponentFixture<AccordionComponent>, i: number): string[] =>
    ([...f.nativeElement.querySelectorAll(`#qr-body-${i} .quiz-summary-row .quiz-summary-text`)] as HTMLElement[]).map(
      (e) => plain(e)
    );
  const answerRow = (f: ComponentFixture<AccordionComponent>, i: number): HTMLElement =>
    f.nativeElement.querySelector(`#qr-body-${i} .quiz-summary-row`) as HTMLElement;

  it('correct single selection: four exact sentences, "was", "1 second", icon image "Correct"', async () => {
    const f = await mount([single('Q1')], new Map([[0, [{ optionId: 1, text: 'A' }]]]), [], [1]);
    expect(rowTexts(f, 0)).toEqual([
      'Your Answer(s): Option 1: A',
      'Correct Answer(s): Option 1 — A',
      'Explanation: Option 1 was correct because because.',
      'Elapsed Time: 1 second'
    ]);
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): Option 1: A, Correct');
  });

  it('incorrect selection: shows the picked option and an incorrect icon image named "Incorrect"', async () => {
    const f = await mount([single('Q1')], new Map([[0, [{ optionId: 2, text: 'B' }]]]), [], [30]);
    expect(rowTexts(f, 0)[0]).toBe('Your Answer(s): Option 2: B');
    expect(rowTexts(f, 0)[3]).toBe('Elapsed Time: 30 seconds');
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): Option 2: B, Incorrect');
  });

  it('multi-answer: lists both options, "Options 1 and 3", and "were"', async () => {
    const f = await mount(
      [multi('Q1')],
      new Map([[0, [{ optionId: 1, text: 'A' }, { optionId: 3, text: 'C' }]]]),
      [],
      [2]
    );
    expect(rowTexts(f, 0)).toEqual([
      'Your Answer(s): Option 1: A, Option 3: C',
      'Correct Answer(s): Options 1 and 3 — A, C',
      'Explanation: Options 1 and 3 were correct because both are needed.',
      'Elapsed Time: 2 seconds'
    ]);
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'Your Answer(s): Option 1: A, Option 3: C, Correct'
    );
  });

  it('stored-answers fallback (no live selection): "Option 1 — A", marked correct', async () => {
    const f = await mount([single('Q1')], new Map(), [[1]], [0]);
    expect(rowTexts(f, 0)[0]).toBe('Your Answer(s): Option 1 — A');
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): Option 1 — A, Correct');
    expect(rowTexts(f, 0)[3]).toBe('Elapsed Time: 0 seconds');
  });

  it('stored-answers fallback with a wrong answer is marked Incorrect', async () => {
    const f = await mount([single('Q1')], new Map(), [[2]], [0]);
    expect(rowTexts(f, 0)[0]).toBe('Your Answer(s): Option 2 — B');
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): Option 2 — B, Incorrect');
  });

  it('unanswered: "(no answer provided)" and an X icon image named "Incorrect"', async () => {
    const f = await mount([single('Q1')], new Map(), [], []);
    expect(rowTexts(f, 0)[0]).toBe('Your Answer(s): (no answer provided)');
    expect(rowTexts(f, 0)[3]).toBe('Elapsed Time: 0 seconds');
    expect(answerRow(f, 0).querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Your Answer(s): (no answer provided), Incorrect');
  });

  it('empty explanation keeps the same sentence shape (full stop directly after the blank)', async () => {
    const f = await mount([single('Q1', '')], new Map(), [], [1]);
    expect(rowTexts(f, 0)[2]).toBe('Explanation: Option 1 was correct because .');
  });

  it('every row is one span: a bold label span + ONE value text node, no leader span, for all branches', async () => {
    const f = await mount(
      [single('Q1'), single('Q2'), multi('Q3')],
      new Map([[0, [{ optionId: 1, text: 'A' }]]]),
      [],
      [0, 1, 2]
    );
    for (const i of [0, 1, 2]) {
      const spans = [...f.nativeElement.querySelectorAll(`#qr-body-${i} .quiz-summary-text`)] as HTMLElement[];
      expect(spans).toHaveLength(4);
      for (const s of spans) {
        expect(s.getAttribute('role')).toBe('img');
        expect((s.childNodes[0] as HTMLElement).classList.contains('quiz-summary-label')).toBe(true);
        expect([...s.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())).toHaveLength(1);
      }
      expect(f.nativeElement.querySelector(`#qr-body-${i} .leader`)).toBeNull();
    }
  });
});

/**
 * Variant D — timed-out state. A question whose elapsed time reached the per-question countdown shows the
 * "Timed out" badge in its header (inside the single header button, so the header name still carries it) and the
 * summary line above the list. Questions under the limit show neither.
 */
describe('AccordionComponent — timed-out questions (Variant D)', () => {
  const Q = (text: string): QuizQuestion =>
    ({
      questionText: text,
      explanation: 'because',
      options: [
        { optionId: 1, text: 'A', correct: true },
        { optionId: 2, text: 'B' }
      ]
    }) as QuizQuestion;

  async function mountCountdown(elapsedTimes: number[]): Promise<ComponentFixture<AccordionComponent>> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AccordionComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, parent: null } },
        {
          provide: QuizService,
          useValue: {
            questionsSig: () => [Q('Q1'), Q('Q2')],
            userAnswers: [],
            questions: [],
            quizId: 'fixture-quiz',
            setQuizId: jest.fn(),
            getFinalResultSnapshot: () => null
          }
        },
        { provide: QuizDataService, useValue: { getQuestionsForQuiz: () => ({ pipe: () => ({ subscribe: () => undefined }) }) } },
        {
          provide: SelectedOptionService,
          useValue: { recoverAnswersForResults: jest.fn(), rawSelectionsMap: new Map(), selectedOptionsMap: new Map() }
        },
        { provide: TimerService, useValue: { elapsedTimes, isCountdown: () => true, timePerQuestion: 30 } }
      ]
    });
    const fixture = TestBed.createComponent(AccordionComponent);
    fixture.componentRef.setInput('questions', [Q('Q1'), Q('Q2')]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows the "Timed out" badge inside the header button only for the question that reached the limit', async () => {
    const f = await mountCountdown([30, 10]);
    const headers = [...f.nativeElement.querySelectorAll('.qr-header')] as HTMLElement[];
    expect(headers[0].querySelector('.timed-out-badge')).not.toBeNull();
    expect(headers[0].textContent).toContain('Timed out');
    expect(headers[1].querySelector('.timed-out-badge')).toBeNull();
    expect(f.componentInstance.timedOutCount).toBe(1);
    expect(f.nativeElement.querySelector('.timed-out-summary')!.textContent).toContain('1 of 2');
  });

  it('a timed-out, unanswered question still renders its four rows with the expected sentences', async () => {
    const f = await mountCountdown([30, 10]);
    (f.nativeElement.querySelectorAll('.qr-header')[0] as HTMLElement).click();
    f.detectChanges();
    const rows = [...f.nativeElement.querySelectorAll('#qr-body-0 .quiz-summary-text')].map((e) => plain(e));
    expect(rows).toEqual([
      'Your Answer(s): (no answer provided)',
      'Correct Answer(s): Option 1 — A',
      'Explanation: Option 1 was correct because because.',
      'Elapsed Time: 30 seconds'
    ]);
  });
});
