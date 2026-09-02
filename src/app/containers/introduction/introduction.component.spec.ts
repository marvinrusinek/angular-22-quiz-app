import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';

import { IntroductionComponent } from './introduction.component';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizShuffleService } from '../../shared/services/flow/quiz-shuffle.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';
import { QuizStartSpinnerService } from '../../shared/services/ui/quiz-start-spinner.service';

/**
 * Stage 14 regression A: after Introduction moved to API-backed metadata
 * (13123098 "remove introduction bank dependency"), the "Test your wits with
 * N questions" paragraph kept reading `quiz.questions?.length ?? 0` — but
 * `buildQuizFromMetadata()` never sets `questions` at all, so that expression
 * is unconditionally 0 regardless of the real, correctly-loaded count already
 * sitting in `questionCountSig()` (used correctly by the meta row above it).
 * No spec previously rendered this component's template, so the mismatch
 * between the two paragraphs went uncaught.
 */
describe('IntroductionComponent — API-backed question count (Stage 14 regression A)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'typescript' }])),
    questionCountByQuiz: signal(questionCountMap),
    milestoneByQuiz: signal(milestoneMap),
    difficultyByQuiz: signal(difficultyMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? []
  });

  function configureTestBed(): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the REAL API question count in the "Test your wits" paragraph, not 0', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Test your wits with');
    expect(text).toMatch(/Test your wits with\s*10\s*timed multiple-choice/);
    expect(text).not.toMatch(/Test your wits with\s*0\s*timed multiple-choice/);
  });

  it('the meta row and the intro paragraph agree on the same count', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component.questionCountSig()).toBe(10);

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toMatch(/10\s*Questions/);
  });

  it('never reads quiz.questions?.length — buildQuizFromMetadata never sets it', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.questions).toBeUndefined();
  });
});
