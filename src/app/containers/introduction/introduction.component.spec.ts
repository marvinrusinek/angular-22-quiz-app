import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject } from 'rxjs';
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

/**
 * Stage 15 follow-up: Introduction used to gate its first paint on
 * `metadataApi.load()`'s HTTP round trip, so a cold `GET /api/quizzes` (e.g. a
 * cold Render backend) left the page on the template's `Loading…` branch for
 * however long that took — even though `TopicQuizMetadataService` already
 * seeds its public-metadata signals synchronously from `QUIZ_CATALOG_METADATA`,
 * the exact mechanism QuizSelection's tiles already rely on to paint instantly.
 * `load()` here is a controllable Subject that never emits on its own, so these
 * specs can assert what renders WHILE the request is still pending.
 */
describe('IntroductionComponent — instant first paint from seeded metadata (Stage 15 follow-up)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  function makeMetadataApi(loadSource: Subject<any[]>): any {
    return {
      load: jest.fn(() => loadSource.asObservable()),
      questionCountByQuiz: signal(questionCountMap),
      milestoneByQuiz: signal(milestoneMap),
      difficultyByQuiz: signal(difficultyMap),
      imageByQuiz: signal(imageMap),
      factsByQuiz: signal(factsMap),
      milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
      imageFor: (id: string) => imageMap.get(id) ?? '',
      factsFor: (id: string) => factsMap.get(id) ?? []
    };
  }

  function configureTestBed(metadataApi: any, quizId: string): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
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
        { provide: ActivatedRoute, useValue: { params: of({ quizId }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the card immediately from seeded metadata, before /api/quizzes resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // `pending` has not emitted — the metadata request is still in flight.
    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('TypeScript');
  });

  it('shows no request-status text for a known quiz while the metadata refresh is in flight', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const loadingEl = (fixture.nativeElement as HTMLElement).querySelector('.loading-message');
    expect(loadingEl).toBeNull();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Loading');
  });

  it('the HTTP metadata refresh still lands and updates state once it resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    expect(fixture.componentInstance.questionCountSig()).toBe(10);
  });

  it('an unknown quiz id absent from both the seed and the live response stays on Loading — no fabrication', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'not-a-real-quiz');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // Not in the bundled seed, so no immediate paint.
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
    const beforeText = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(beforeText).toContain('Loading');

    // The live response arrives but still doesn't include it — still no
    // fabricated quiz; selectedQuiz stays null.
    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
  });
});
