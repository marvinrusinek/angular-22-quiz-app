import { TestBed } from '@angular/core/testing';

import { QqcOptionClickOrchestratorService } from './qqc-option-click-orchestrator.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuizService } from '../../data/quiz.service';
import { QuizShuffleService } from '../../flow/quiz-shuffle.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { QuestionType } from '../../../models/question-type.enum';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

/**
 * Stage 10 (Chokepoint #1 audit) — `buildCanonicalOptions` and
 * `applyOptionLocks` regression coverage.
 *
 * THE FINDING: both methods had a branch keyed on `evtOpt?.correct` (locking
 * every option / stamping `_singleAnswerCorrectLock` once "the clicked option
 * is correct"). Under the API adapter, an `Option`/`SelectedOption` NEVER
 * carries `.correct` — confirmed by an exhaustive search of every write site
 * feeding this pipeline (quiz.service.ts, qqc-ql-option-build.service.ts,
 * qqc-ql-stream.service.ts, shared-option-init.service.ts), which all guard
 * `option.correct === undefined ? {} : { correct: isOptionCorrect(option) }`
 * — so the field only ever survives as `undefined`. These branches therefore
 * NEVER executed against real (API-shaped) data; the equivalent
 * verdict-authoritative behavior already exists elsewhere
 * (selection-message.service.ts's `phase === 'resolved'` branch, and
 * option-lock-policy.service.ts#applyForceDisableAll).
 *
 * These tests pin: (1) realistic API-shaped clicks (no `.correct`) behave
 * identically to how they did before the dead branches were removed, and (2)
 * even a synthetic `.correct: true` payload — which cannot occur from the
 * live API, but proves the removal is total, not merely untriggered by this
 * test's specific fixture — no longer special-cases anything.
 */
describe('QqcOptionClickOrchestratorService — dead evtOpt.correct branches (Stage 10)', () => {
  let service: QqcOptionClickOrchestratorService;
  let selectedOptionService: any;
  let selectionMessageService: any;

  const makeQuestion = (type: QuestionType): QuizQuestion => ({
    questionText: 'Sample question?',
    type,
    options: [
      { optionId: 1, text: 'A' },
      { optionId: 2, text: 'B' }
    ],
    explanation: 'because'
  } as unknown as QuizQuestion);

  beforeEach(() => {
    selectedOptionService = {
      selectedOptionsMap: new Map(),
      lockOption: jest.fn(),
      lockMany: jest.fn(),
      isOptionLocked: jest.fn().mockReturnValue(false)
    };
    selectionMessageService = {
      stableKey: (opt: any, idx?: number) => String(opt?.optionId ?? idx ?? 0),
      _singleAnswerCorrectLock: new Set<number>(),
      _singleAnswerIncorrectLock: new Set<number>()
    };

    TestBed.configureTestingModule({
      providers: [
        QqcOptionClickOrchestratorService,
        { provide: NextButtonStateService, useValue: {} },
        { provide: QuizService, useValue: {} },
        { provide: QuizShuffleService, useValue: {} },
        { provide: QuizStateService, useValue: {} },
        { provide: SelectedOptionService, useValue: selectedOptionService },
        { provide: SelectionMessageService, useValue: selectionMessageService }
      ]
    });
    service = TestBed.inject(QqcOptionClickOrchestratorService);
  });

  describe('buildCanonicalOptions', () => {
    it('single-answer, realistic API-shaped click (no .correct): selects only the clicked option, no lock stamped', () => {
      const question = makeQuestion(QuestionType.SingleAnswer);
      const evtOpt: SelectedOption = { optionId: 2, text: 'B' } as SelectedOption; // no `.correct`

      const result = service.buildCanonicalOptions({
        question, questionIndex: 0, evtIdx: 1, evtOpt, checked: true
      });

      expect(result.map((o) => o.selected)).toEqual([false, true]);
      expect(selectionMessageService._singleAnswerCorrectLock.has(0)).toBe(false);
    });

    it('single-answer, a synthetic .correct:true payload (cannot occur from the live API): still no special-case lock stamped', () => {
      const question = makeQuestion(QuestionType.SingleAnswer);
      const evtOpt = { optionId: 2, text: 'B', correct: true } as SelectedOption;

      const result = service.buildCanonicalOptions({
        question, questionIndex: 0, evtIdx: 1, evtOpt, checked: true
      });

      // Already selected via the unconditional `i === evtIdx` assignment —
      // the removed branch was fully redundant even when it did fire.
      expect(result[1]!.selected).toBe(true);
      expect(selectionMessageService._singleAnswerCorrectLock.has(0)).toBe(false);
      expect(selectionMessageService._singleAnswerIncorrectLock.has(0)).toBe(false);
    });

    it('multi-answer click marks only the clicked option, independent of .correct', () => {
      const question = makeQuestion(QuestionType.MultipleAnswer);
      const evtOpt: SelectedOption = { optionId: 1, text: 'A' } as SelectedOption;

      const result = service.buildCanonicalOptions({
        question, questionIndex: 0, evtIdx: 0, evtOpt, checked: true
      });

      expect(result[0]!.selected).toBe(true);
    });
  });

  describe('applyOptionLocks', () => {
    it('single-answer, realistic API-shaped click (no .correct): locks only the clicked option, never lockMany', () => {
      const question = makeQuestion(QuestionType.SingleAnswer);
      const evtOpt: SelectedOption = { optionId: 2, text: 'B' } as SelectedOption;

      service.applyOptionLocks({
        questionIndex: 0, evtOpt, question, optionsToDisplay: question.options as any
      });

      expect(selectedOptionService.lockOption).toHaveBeenCalledWith(0, 2);
      expect(selectedOptionService.lockMany).not.toHaveBeenCalled();
    });

    it('single-answer, a synthetic .correct:true payload: still never calls lockMany (verdict-authoritative lock-all lives in option-lock-policy.service.ts)', () => {
      const question = makeQuestion(QuestionType.SingleAnswer);
      const evtOpt = { optionId: 2, text: 'B', correct: true } as SelectedOption;

      service.applyOptionLocks({
        questionIndex: 0, evtOpt, question, optionsToDisplay: question.options as any
      });

      expect(selectedOptionService.lockMany).not.toHaveBeenCalled();
    });

    it('multi-answer click locks only the clicked option', () => {
      const question = makeQuestion(QuestionType.MultipleAnswer);
      const evtOpt: SelectedOption = { optionId: 1, text: 'A' } as SelectedOption;

      service.applyOptionLocks({
        questionIndex: 0, evtOpt, question, optionsToDisplay: question.options as any
      });

      expect(selectedOptionService.lockOption).toHaveBeenCalledWith(0, 1);
      expect(selectedOptionService.lockMany).not.toHaveBeenCalled();
    });
  });
});
