import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';

import { CodelabQuizHeaderComponent } from './quiz-header.component';
import { TopicQuizMetadataService } from '../../../shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';

/**
 * S6i — the header no longer reads QuizDataService.quizzesSig() (the
 * bundled bank's full Quiz array). `currentQuiz` now carries only the one
 * field the template uses (`milestone`), sourced from
 * TopicQuizMetadataService — the same service the S6h Guard and S6f
 * resolver already depend on for this route.
 */
describe('CodelabQuizHeaderComponent', () => {
  let metadataApi: any;
  let quizService: any;

  function configure(quizId: string) {
    TestBed.resetTestingModule();
    metadataApi = {
      questionCountByQuiz: jest.fn().mockReturnValue(new Map()),
      milestoneFor: jest.fn().mockReturnValue(''),
    };
    quizService = { quizId };

    TestBed.configureTestingModule({
      imports: [CodelabQuizHeaderComponent],
      providers: [
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: QuizService, useValue: quizService },
        { provide: MatDialog, useValue: { open: jest.fn() } },
        { provide: ActivatedRoute, useValue: { snapshot: {}, params: { subscribe: () => ({ unsubscribe: () => undefined }) } } },
      ],
    });
  }

  it('shows the milestone from TopicQuizMetadataService for the current quizId', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()?.milestone).toBe('RxJS');
    expect(metadataApi.milestoneFor).toHaveBeenCalledWith('rxjs');
  });

  it('tracks quizService.quizId as the current quiz id', () => {
    configure('typescript');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['typescript', 5]]));
    metadataApi.milestoneFor.mockReturnValue('TypeScript');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()?.milestone).toBe('TypeScript');
  });

  it('each quiz id resolves its own milestone (cross-quiz SPA navigation verified separately by E2E)', () => {
    // quizService.quizId is a plain (non-signal) field — computed() has no way
    // to react to a raw mutation of it, exactly as the pre-S6i computed()
    // (which also read the plain field) could not either. This proves the
    // per-id resolution is correct; the live cross-quiz-navigation case is
    // covered by e2e/topic-quiz-lifecycle.spec.ts (tests G and N), which
    // exercise a real router-driven quiz switch end to end.
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');
    const rxjsFixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    rxjsFixture.detectChanges();
    expect(rxjsFixture.componentInstance.currentQuiz()?.milestone).toBe('RxJS');

    configure('signals');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['signals', 6]]));
    metadataApi.milestoneFor.mockReturnValue('Signals');
    const signalsFixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    signalsFixture.detectChanges();
    expect(signalsFixture.componentInstance.currentQuiz()?.milestone).toBe('Signals');
  });

  it('renders nothing (null) on a cold quiz — metadata not yet loaded', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map()); // empty — not loaded yet

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
  });

  it('renders nothing (null) when the quiz is unknown to metadata', () => {
    configure('nope');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]])); // 'nope' absent

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
  });

  it('renders nothing (null) when quizService.quizId is empty', () => {
    configure('');
    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
    expect(metadataApi.milestoneFor).not.toHaveBeenCalled();
  });

  it('requires no QuizDataService and no quizzesSig() bank lookup', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    // Structural proof: the component's only quiz-data dependency is the
    // injected TopicQuizMetadataService mock — no QuizDataService provider
    // was registered above, and TestBed would throw NullInjectorError on
    // creation if the component still tried to inject it.
    expect(fixture.componentInstance).toBeTruthy();
    expect(metadataApi.questionCountByQuiz).toHaveBeenCalled();
  });
});
