import { TestBed } from '@angular/core/testing';

import { SharedOptionExplanationService } from './shared-option-explanation.service';
import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { shouldShowFet, type HeadingInputs } from '../../../utils/heading-model';

/**
 * NAVIGATING BACK MUST SHOW THE QUESTION TEXT.
 *
 * The heading suppresses the FET on a revisit unless the user has interacted
 * with the question ON THIS VISIT — that flag is what separates the live answer
 * view from a return trip, and it survives the coarse `isNavigatingToPrevious`
 * signal being stale.
 *
 * `applyExplanationText` was setting it. On a revisit the question already
 * carries a terminal verdict and its selections are restored, so the resolution
 * gate passes and the stored explanation re-emits — a RENDER. Marking that as
 * an interaction this visit told the heading it was live, and the explanation
 * stayed in the heading where the question text belonged.
 *
 * An earlier attempt fixed this in the resolution gate instead. That was the
 * wrong seam: the gate legitimately passes on a revisit (the question really is
 * answered), so tightening it could only ever suppress the FET on the live view
 * too. The lie was calling a render an interaction.
 */

const IDX = 3;

let explanations: SharedOptionExplanationService;
let quizState: QuizStateService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      SharedOptionExplanationService,
      QuizStateService,
      {
        provide: ExplanationTextService,
        useValue: {
          _activeIndex: -1,
          latestExplanation: '',
          latestExplanationIndex: -1,
          emitFormatted: () => undefined,
          setExplanationText: () => undefined,
          setShouldDisplayExplanation: () => undefined,
          setIsExplanationTextDisplayed: () => undefined,
          setResetComplete: () => undefined,
          lockExplanation: () => undefined
        }
      },
      { provide: QuizService, useValue: {} },
      { provide: SelectedOptionService, useValue: {} }
    ]
  });

  explanations = TestBed.inject(SharedOptionExplanationService);
  quizState = TestBed.inject(QuizStateService);
});

describe('re-emitting a stored explanation is a render, not an interaction', () => {
  it('does not claim the user interacted on this visit', () => {
    // Arriving at a question clears the per-visit mark (navigateToQuestion).
    quizState.clearInteractedThisVisit(IDX);

    explanations.applyExplanationText('Custom attribute directives shine for…', IDX);

    expect(quizState.wasInteractedThisVisit(IDX)).toBe(false);
  });

  it('still records the durable evidence that the question was answered', () => {
    quizState.clearInteractedThisVisit(IDX);

    explanations.applyExplanationText('Custom attribute directives shine for…', IDX);

    expect(quizState.hasUserInteracted(IDX)).toBe(true);
    expect(quizState.hasClickedInSession(IDX)).toBe(true);
  });

  it('leaves the heading on the question text for the revisited question', () => {
    quizState.clearInteractedThisVisit(IDX);
    explanations.applyExplanationText('Custom attribute directives shine for…', IDX);

    const inputs: HeadingInputs = {
      questionHtml: '<p>When is a custom attribute directive a good choice?</p>',
      fetHtml: 'Custom attribute directives shine for…',
      isMultiAnswer: true,
      isMultiAnswerComplete: true,   // answered on the first visit
      isSingleAnswered: false,
      isTimedOut: false,
      hasInteracted: true,           // durable: yes, they answered it
      optionsReady: true,
      isNavigatingToPrevious: true,  // …but this is a return trip
      interactedThisVisit: quizState.wasInteractedThisVisit(IDX)
    };

    expect(shouldShowFet(inputs)).toBe(false);
  });
});

describe('a genuine click still shows the FET on the live view', () => {
  it('marks the visit, so the heading is not suppressed', () => {
    quizState.clearInteractedThisVisit(IDX);
    quizState.markUserInteracted(IDX);   // the click path — no options

    expect(quizState.wasInteractedThisVisit(IDX)).toBe(true);

    const inputs: HeadingInputs = {
      questionHtml: '<p>When is a custom attribute directive a good choice?</p>',
      fetHtml: 'Custom attribute directives shine for…',
      isMultiAnswer: true,
      isMultiAnswerComplete: true,
      isSingleAnswered: false,
      isTimedOut: false,
      hasInteracted: true,
      optionsReady: true,
      // Stale-true after a forward Next; the visit mark is what overrides it.
      isNavigatingToPrevious: true,
      interactedThisVisit: quizState.wasInteractedThisVisit(IDX)
    };

    expect(shouldShowFet(inputs)).toBe(true);
  });
});
