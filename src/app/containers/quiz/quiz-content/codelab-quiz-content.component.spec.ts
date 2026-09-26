import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { CodeSnippetComponent } from '../../../components/code-snippet/code-snippet.component';
import { QuestionType } from '@shared/models';
import { TopicQuizTypeRegistry } from '@shared/services/api/topic-quiz-type-registry.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizDataService } from '@shared/services/data/quizdata.service';
import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { FeedbackPolicyService } from '@shared/services/features/interview/feedback-policy.service';
import { CqcOrchestratorService } from '@shared/services/features/quiz-content/cqc-orchestrator.service';
import { QuizContentDisplayService } from '@shared/services/features/quiz-content/quiz-content-display.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizNavigationService } from '@shared/services/flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '@shared/services/flow/quizquestionmgr.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { CodelabQuizContentComponent } from './codelab-quiz-content.component';

/**
 * THE TOPIC QUIZ QUESTION IS SUPPLIED BY CONTENT PROJECTION.
 *
 * The assignment this component answers: "a question (which can be HTML - use
 * ng-content)". `CodelabQuizContentComponent` is the receiver: its template is
 * only `<ng-content select="[quiz-projected-content]">`. The routed
 * `QuizComponent` is the consumer: it projects ONE `.question-box` holding the
 * question `<h3 #qText>` and, when the question has one, an `<app-code-snippet>`.
 *
 * These tests pin that contract, and that the HTML written into the heading is
 * sanitized on the way in. They deliberately do NOT pin how the heading text is
 * decided (that is `heading-model` / `heading-inputs`, tested in shared/utils).
 *
 * ── Why the host template is read from quiz.component.html ───────────
 *
 * The consumer markup under test is EXTRACTED from the real
 * `quiz.component.html` at run time, not retyped here. A retyped copy would keep
 * passing after the real template drifted; this one cannot. The receiver, the
 * DOM-write effect, `DomSanitizer` and `Renderer2` are all the real ones. Only
 * the services that feed the heading are faked.
 */

const IDX = 0;

/** The `<codelab-quiz-content>…</codelab-quiz-content>` block of the real consumer template. */
function consumerRegion(): string {
  const source = readFileSync(join(__dirname, '..', 'quiz.component.html'), 'utf8');
  const match = source.match(/<codelab-quiz-content[\s\S]*?<\/codelab-quiz-content>/);
  if (!match) {
    throw new Error('quiz.component.html no longer contains a <codelab-quiz-content> block');
  }
  return match[0];
}

interface QuestionUnderTest {
  questionText: string;
  type: QuestionType;
  options: unknown[];
  codeSnippet?: { code: string; language: string; filename?: string };
}

function makeQuestion(over: Partial<QuestionUnderTest> = {}): QuestionUnderTest {
  return {
    questionText: 'What does the <code>ngOnInit</code> hook do?',
    type: QuestionType.SingleAnswer,
    options: [{}, {}, {}, {}],
    ...over
  };
}

/**
 * The consumer's own scope: `qa` and `questionIndex` are `@let`s in the real
 * template, so the host defines them under the same names. `questionToDisplay$`
 * is the one field the region binds by name.
 */
function makeHost(template: string) {
  @Component({
    selector: 'test-quiz-host',
    standalone: true,
    imports: [CodelabQuizContentComponent, CodeSnippetComponent],
    template: `@let qa = data(); @let questionIndex = idx(); ${template}`
  })
  class HostComponent {
    readonly data = signal<{ question: QuestionUnderTest }>({ question: makeQuestion() });
    readonly idx = signal(IDX);
    readonly questionToDisplay$ = of('');
  }
  return HostComponent;
}

/** Every service the receiver injects, as inert fakes that answer only what the heading reads. */
function fakes(question: QuestionUnderTest) {
  const expiredForQuestionIndexSig = signal(-1);
  const explanationTextService = {
    isExplanationTextDisplayed$: of(false),
    formattedExplanationSig: signal(null),
    formattedExplanations: {},
    fetByIndex: new Map<number, string>(),
    timeoutFetByIndex: new Map<number, string>(),
    fetBypassForQuestion: new Map<number, boolean>()
  };
  return {
    expiredForQuestionIndexSig,
    explanationTextService,
    providers: [
      provideNoopAnimations(),
      { provide: ActivatedRoute, useValue: {} },
      {
        provide: CqcOrchestratorService,
        useValue: { runOnInit: jest.fn(), runQuestionIndexSet: jest.fn(), runOnDestroy: jest.fn() }
      },
      {
        provide: QuizContentDisplayService,
        useValue: {
          createFormattedExplanation$: () => of(null),
          createActiveFetText$: () => of('')
        }
      },
      { provide: ExplanationTextService, useValue: explanationTextService },
      { provide: QuestionVerdictService, useValue: { states: signal(new Map()), verdictFor: () => null } },
      { provide: TopicQuizTypeRegistry, useValue: { isMultiAnswer: () => null, correctCount: () => null } },
      { provide: QuizDataService, useValue: {} },
      { provide: QuizNavigationService, useValue: { isNavigatingToPreviousSig: signal(false) } },
      { provide: QuizQuestionManagerService, useValue: { getNumberOfCorrectAnswersText: () => '' } },
      {
        provide: QuizService,
        useValue: {
          quizId: 'change-detection',
          currentQuestionIndex: IDX,
          getQuestionsInDisplayOrder: () => [question]
        }
      },
      {
        provide: QuizStateService,
        useValue: {
          lastInteractionTimeSig: signal(0),
          hasUserInteracted: () => false,
          wasInteractedThisVisit: () => false
        }
      },
      {
        provide: SelectedOptionService,
        useValue: { selectedOptionSig: signal(null), selectedOptionsMap: new Map() }
      },
      {
        provide: TimerService,
        useValue: { expiredForQuestionIndexSig, expiredOnArrivalSig: signal(-1) }
      },
      { provide: FeedbackPolicyService, useValue: { feedbackMode: signal('immediate') } }
    ]
  };
}

describe('CodelabQuizContentComponent — the question is projected content', () => {
  let fixture: ComponentFixture<unknown>;
  // Angular logs "sanitizing HTML stripped some content" whenever it removes
  // something. Captured so the hostile cases stay quiet, and so the tests can
  // assert the sanitizer really did strip (and did NOT for ordinary HTML).
  let sanitizerWarning: jest.SpyInstance;

  beforeEach(() => {
    sanitizerWarning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  function render(template: string, question: QuestionUnderTest = makeQuestion()) {
    const f = fakes(question);
    TestBed.configureTestingModule({ providers: f.providers });
    const Host = makeHost(template);
    const created = TestBed.createComponent(Host);
    created.componentInstance.data.set({ question });
    fixture = created;
    // The heading is written by an effect that waits for the content query to
    // resolve, so a second pass is needed before the <h3> has its text.
    created.detectChanges();
    created.detectChanges();
    return { fixture: created, ...f };
  }

  const el = (): HTMLElement => fixture.nativeElement;
  const receiver = (): HTMLElement => el().querySelector('codelab-quiz-content')!;
  const box = (): HTMLElement => receiver().querySelector(':scope > .question-box')!;
  const heading = (): HTMLElement => box().querySelector(':scope > h3')!;

  afterEach(() => {
    sanitizerWarning.mockRestore();
    fixture?.destroy();
    document.querySelectorAll('.option-row').forEach((n) => n.remove());
  });

  describe('projection contract', () => {
    it('renders codelab-quiz-content > .question-box > h3 for an ordinary question, with no code snippet', () => {
      ({ fixture } = render(consumerRegion()));

      expect(receiver()).not.toBeNull();
      expect(box()).not.toBeNull();
      expect(heading()).not.toBeNull();
      expect(box().querySelector('app-code-snippet')).toBeNull();
    });

    it('the .question-box is the ONE element projected through the [quiz-projected-content] slot', () => {
      ({ fixture } = render(consumerRegion()));

      expect(box().hasAttribute('quiz-projected-content')).toBe(true);
      expect(Array.from(receiver().children)).toEqual([box()]);
    });

    it('the marker is on the box, not on the <h3>', () => {
      ({ fixture } = render(consumerRegion()));

      expect(heading().hasAttribute('quiz-projected-content')).toBe(false);
    });

    it('the slot is what admits the box: without the marker, the same markup is not rendered at all', () => {
      // Same real markup, marker attribute removed. The receiver's only slot is
      // `select="[quiz-projected-content]"`, so unmatched content is dropped.
      ({ fixture } = render(consumerRegion().replace(/\s+quiz-projected-content\b/, '')));

      expect(receiver()).not.toBeNull();
      expect(receiver().querySelector('.question-box')).toBeNull();
      expect(receiver().querySelector('h3')).toBeNull();
    });

    it('the receiver finds the projected heading (contentChild #qText) and fills it', () => {
      ({ fixture } = render(consumerRegion()));

      const receiverInstance = fixture.debugElement
        .query(By.directive(CodelabQuizContentComponent))
        .componentInstance as CodelabQuizContentComponent;

      expect(receiverInstance.qText()?.nativeElement).toBe(heading());
      expect(heading().textContent).toContain('What does the');
    });

    it('a question with a code snippet renders <app-code-snippet> as the <h3>\'s sibling inside the SAME .question-box', () => {
      const question = makeQuestion({
        codeSnippet: { code: 'export class A {}', language: 'typescript', filename: 'a.ts' }
      });
      ({ fixture } = render(consumerRegion(), question));

      const snippet = box().querySelector(':scope > app-code-snippet');

      expect(snippet).not.toBeNull();
      expect(snippet!.parentElement).toBe(box());
      expect(heading().parentElement).toBe(box());
      expect(heading().nextElementSibling).toBe(snippet);
      expect(receiver().querySelectorAll('.question-box')).toHaveLength(1);
    });
  });

  describe('accessibility: the live region is the heading, not the whole box', () => {
    it('the <h3> is a polite, atomic live region', () => {
      ({ fixture } = render(consumerRegion()));

      expect(heading().getAttribute('aria-live')).toBe('polite');
      expect(heading().getAttribute('aria-atomic')).toBe('true');
    });

    it('the .question-box is not a live region, so a code snippet is never announced as part of the question', () => {
      const question = makeQuestion({
        codeSnippet: { code: 'export class A {}', language: 'typescript' }
      });
      ({ fixture } = render(consumerRegion(), question));

      expect(box().hasAttribute('aria-live')).toBe(false);
      expect(box().hasAttribute('aria-atomic')).toBe(false);
      expect(box().querySelector('app-code-snippet')!.closest('[aria-live]')).toBeNull();
    });
  });

  describe('the question can be HTML — and it is sanitized on the way in', () => {
    it('keeps the ordinary inline HTML a question uses', () => {
      ({ fixture } = render(consumerRegion()));

      expect(heading().querySelector('code')?.textContent).toBe('ngOnInit');
      expect(heading().textContent).toBe('What does the ngOnInit hook do?');
      expect(sanitizerWarning).not.toHaveBeenCalled();   // nothing was stripped
    });

    it.each([
      ['<strong>', 'Which is <strong>NOT</strong> a lifecycle hook?', 'strong'],
      ['<em>', 'Which is <em>always</em> true?', 'em'],
      ['<span class>', 'Pick <span class="hint">one</span>.', 'span.hint']
    ])('keeps %s formatting', (_label, questionText, selector) => {
      ({ fixture } = render(consumerRegion(), makeQuestion({ questionText })));

      expect(heading().querySelector(selector)).not.toBeNull();
    });

    const HOSTILE =
      'Safe <code>text</code> ' +
      '<img src="x" onerror="window.__pwned = 1"> ' +
      '<a href="javascript:window.__pwned = 2" onclick="window.__pwned = 3">link</a> ' +
      '<script>window.__pwned = 4</script>' +
      '<iframe src="https://example.invalid"></iframe> ' +
      '<b onmouseover="window.__pwned = 5">bold</b>';

    /** Everything an attacker-controlled heading could use to run code. */
    function unsafeThingsIn(root: HTMLElement): string[] {
      const found: string[] = [];
      if (root.querySelector('script')) found.push('<script>');
      if (root.querySelector('iframe')) found.push('<iframe>');
      root.querySelectorAll('*').forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          if (/^on/i.test(attr.name)) found.push(`${node.tagName.toLowerCase()}[${attr.name}]`);
          if (/^\s*javascript:/i.test(attr.value)) found.push(`${node.tagName.toLowerCase()}[${attr.name}=javascript:]`);
        }
      });
      return found;
    }

    it('test control: the unsanitized string WOULD be dangerous, so the assertions below cannot pass vacuously', () => {
      const probe = document.createElement('div');
      probe.innerHTML = HOSTILE;   // what an unguarded Renderer2 / innerHTML write would do

      expect(unsafeThingsIn(probe).length).toBeGreaterThan(0);
    });

    it('a hostile question is neutralized: no script, iframe, event-handler attribute or javascript: URL reaches the DOM', () => {
      ({ fixture } = render(consumerRegion(), makeQuestion({ questionText: HOSTILE })));

      expect(unsafeThingsIn(heading())).toEqual([]);
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
      // Angular's own sanitizer reported stripping — it is what did the work.
      expect(sanitizerWarning).toHaveBeenCalledWith(
        expect.stringContaining('sanitizing HTML stripped some content')
      );
    });

    it('a hostile question keeps its harmless part', () => {
      ({ fixture } = render(consumerRegion(), makeQuestion({ questionText: HOSTILE })));

      expect(heading().querySelector('code')?.textContent).toBe('text');
      expect(heading().textContent).toContain('Safe');
      expect(heading().textContent).toContain('link');
      expect(heading().textContent).toContain('bold');
    });

    it('the explanation (FET) that replaces the question in the heading is sanitized the same way', () => {
      // A live timeout is the one path that shows the FET without any click.
      const optionRow = document.createElement('div');
      optionRow.className = 'option-row';
      document.body.appendChild(optionRow);   // the heading only reveals a FET once options exist

      const { fixture: f, expiredForQuestionIndexSig, explanationTextService } = render(
        consumerRegion()
      );
      fixture = f;
      explanationTextService.timeoutFetByIndex.set(
        IDX,
        'Time is up: <strong>useful</strong> <img src="x" onerror="window.__pwned = 6">'
      );

      expiredForQuestionIndexSig.set(IDX);
      f.detectChanges();
      f.detectChanges();

      expect(heading().textContent).toContain('Time is up');
      expect(heading().textContent).not.toContain('What does the');
      expect(heading().querySelector('strong')?.textContent).toBe('useful');
      expect(unsafeThingsIn(heading())).toEqual([]);
    });
  });
});
