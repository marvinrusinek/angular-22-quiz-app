import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { StatisticsComponent } from './statistics.component';
import { TopicQuizResourcesService } from '../../../shared/services/api/topic-quiz-resources.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { API_BASE_URL } from '../../../shared/tokens/api-base-url.token';
import * as quizDataCache from '../../../shared/quiz-data-cache';

/**
 * WHERE THE RESULTS-PAGE RESOURCE LINKS COME FROM.
 *
 * This panel was the last consumer of the `resources` block in
 * `assets/data/quiz.json`, and therefore one of the things keeping the public
 * asset alive. It now reads `GET /api/quizzes/:quizId/resources`.
 *
 * The assertions that matter are the negative ones: `loadResourcesForQuiz` must
 * not be called, the local cache must not be read, and a failed request must
 * leave the rest of the statistics panel intact rather than taking it down.
 */

const BASE = 'https://api.test/api';
const QUIZ_ID = 'router';

let http: HttpTestingController;
let loadResourcesForQuiz: jest.Mock;

function quizServiceStub() {
  loadResourcesForQuiz = jest.fn();
  return {
    quizId: QUIZ_ID,
    // The local path this slice removes. Present so a regression CALLS it and
    // the spy catches it, rather than throwing an unrelated TypeError.
    loadResourcesForQuiz,
    resources: [
      { title: 'LOCAL BANK LINK', url: 'https://local.test', host: 'local' }
    ],
    totalQuestions: () => 5,
    correctAnswersCountSig: signal(3),
    getFinalResultSnapshot: () => null,
    patchFinalResultCompletionTime: () => undefined,
    setQuizStatus: () => undefined
  };
}

function timerServiceStub() {
  return {
    calculateTotalElapsedTime: () => 42,
    completionTime: 42,
    elapsedTimes: [10, 10, 10, 12],
    getDurableCompletionTime: () => 42,
    setDurableCompletionTime: () => undefined,
    isCountdown: () => false,
    timePerQuestion: 30
  };
}

function build() {
  TestBed.configureTestingModule({
    imports: [StatisticsComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: QuizService, useValue: quizServiceStub() },
      { provide: TimerService, useValue: timerServiceStub() },
      {
        provide: QuizDataService,
        useValue: {
          quizzesSig: signal([
            { quizId: QUIZ_ID, milestone: 'Angular Router', summary: '', image: '' }
          ]),
          getCachedQuizById: () => ({ quizId: QUIZ_ID, milestone: 'Angular Router' }),
          quizzes$: of([])
        }
      }
    ]
  });

  http = TestBed.inject(HttpTestingController);

  const fixture = TestBed.createComponent(StatisticsComponent);
  fixture.componentRef.setInput('quizId', QUIZ_ID);
  fixture.detectChanges();
  return fixture;
}

const resourcesRequest = () => http.expectOne(`${BASE}/quizzes/${QUIZ_ID}/resources`);

afterEach(() => http.verify({ ignoreCancelled: true }));

describe('resources are sourced from the API', () => {
  it('requests the resources endpoint for the displayed quiz', () => {
    build();
    expect(resourcesRequest().request.method).toBe('GET');
  });

  it('renders what the API returned, in the API\'s order', () => {
    const fixture = build();
    resourcesRequest().flush({
      quizId: QUIZ_ID,
      resources: [
        { title: 'Router guide', url: 'https://angular.dev/router', host: 'Angular' },
        { title: 'Router API', url: 'https://angular.dev/api/router', host: 'Angular' }
      ]
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.resources().map((r) => r.title))
      .toEqual(['Router guide', 'Router API']);
  });

  it('renders an empty panel when the quiz has no resources', () => {
    const fixture = build();
    resourcesRequest().flush({ quizId: QUIZ_ID, resources: [] });
    fixture.detectChanges();

    expect(fixture.componentInstance.resources()).toEqual([]);
  });
});

describe('THE LOCAL BANK IS NOT THE SOURCE, AND NOT A FALLBACK', () => {
  it('never calls quizService.loadResourcesForQuiz', () => {
    const fixture = build();
    resourcesRequest().flush({ quizId: QUIZ_ID, resources: [] });
    fixture.detectChanges();

    expect(loadResourcesForQuiz).not.toHaveBeenCalled();
  });

  it('never renders the local bank\'s list, even though the stub still exposes one', () => {
    const fixture = build();
    resourcesRequest().flush({
      quizId: QUIZ_ID,
      resources: [{ title: 'API LINK', url: 'https://api.test/link', host: 'API' }]
    });
    fixture.detectChanges();

    const titles = fixture.componentInstance.resources().map((r) => r.title);
    expect(titles).toEqual(['API LINK']);
    expect(titles).not.toContain('LOCAL BANK LINK');
  });

  it('does NOT fall back to the local bank when the API fails', () => {
    // The regression this whole slice exists to prevent: an error path that
    // quietly reads the bundled asset would pass every other test here and then
    // break the day the asset is deleted.
    const spy = jest.spyOn(quizDataCache, 'getQuizData');
    const fixture = build();
    resourcesRequest().flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(fixture.componentInstance.resources()).toEqual([]);
    expect(loadResourcesForQuiz).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('requests no local asset path', () => {
    const fixture = build();
    resourcesRequest().flush({ quizId: QUIZ_ID, resources: [] });
    fixture.detectChanges();

    http.expectNone('assets/data/quiz.json');
    http.expectNone('/assets/data/quiz.json');
  });
});

describe('a failed resources load is not fatal', () => {
  it('leaves the rest of the statistics panel working', () => {
    // Resources are supplemental. The score, totals and elapsed time come from
    // data the component already has, and must survive the panel being empty.
    const fixture = build();
    resourcesRequest().flush('boom', { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();

    const metadata = fixture.componentInstance.quizMetadata();
    expect(metadata.totalQuestions).toBe(5);
    expect(fixture.componentInstance.resources()).toEqual([]);
    expect(fixture.nativeElement.textContent.length).toBeGreaterThan(0);
  });
});
