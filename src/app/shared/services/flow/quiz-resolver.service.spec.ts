import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { of, throwError } from 'rxjs';

import { QuizResolverService } from './quiz-resolver.service';
import { QuizService } from '../data/quiz.service';
import { TopicQuizMetadataService } from '../api/topic-quiz-metadata.service';
import { Quiz } from '../../models/Quiz.model';

/**
 * S6f — the resolver no longer fetches the bundled answer-bearing bank.
 *
 * These pin the new contract: identity/existence only, from
 * TopicQuizMetadataService, never QuizDataService/quiz.json. The resolved
 * `Quiz.questions` is always `[]` — real question content comes from a
 * separate, already-established API path, never from this object.
 */
describe('QuizResolverService', () => {
  let resolver: QuizResolverService;
  let router: any;
  let quizService: any;
  let metadataApi: any;

  const mockRouterState = {} as RouterStateSnapshot;
  const mockUrlTree = new UrlTree();

  function makeRoute(params: Record<string, string>): ActivatedRouteSnapshot {
    return { params } as unknown as ActivatedRouteSnapshot;
  }

  const METADATA_ENTRIES = [
    { quizId: 'angular', milestone: 'Angular', image: 'https://cdn.test/angular.png', difficulty: 'beginner', facts: ['fact 1'] },
    { quizId: 'rxjs', milestone: 'RxJS', difficulty: 'intermediate' }
  ];

  beforeEach(() => {
    router = { createUrlTree: jest.fn().mockReturnValue(mockUrlTree) };
    quizService = { selectedQuiz: null };
    metadataApi = { load: jest.fn().mockReturnValue(of(METADATA_ENTRIES)) };

    TestBed.configureTestingModule({
      providers: [
        QuizResolverService,
        { provide: Router, useValue: router },
        { provide: QuizService, useValue: quizService },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
      ],
    });
    resolver = TestBed.inject(QuizResolverService);
  });

  it('should be created', () => {
    expect(resolver).toBeTruthy();
  });

  it('resolves a known quiz from metadata, with fields populated from the DTO', (done) => {
    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      const quiz = result as Quiz;
      expect(quiz.quizId).toBe('angular');
      expect(quiz.milestone).toBe('Angular');
      expect(quiz.image).toBe('https://cdn.test/angular.png');
      expect(quiz.difficulty).toBe('beginner');
      expect(quiz.facts).toEqual(['fact 1']);
      done();
    });
  });

  it('a known quiz missing optional metadata fields still resolves, with safe defaults', (done) => {
    resolver.resolve(makeRoute({ quizId: 'rxjs' }), mockRouterState).subscribe((result) => {
      const quiz = result as Quiz;
      expect(quiz.quizId).toBe('rxjs');
      expect(quiz.milestone).toBe('RxJS');
      expect(quiz.image).toBe('');
      expect(quiz.facts).toEqual([]);
      done();
    });
  });

  it('redirects to /quiz for a quizId absent from the metadata list', (done) => {
    resolver.resolve(makeRoute({ quizId: 'nope' }), mockRouterState).subscribe((result) => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz']);
      expect(result).toBeInstanceOf(UrlTree);
      done();
    });
  });

  it('redirects to /quiz, without throwing, when the metadata request fails', (done) => {
    metadataApi.load.mockReturnValue(throwError(() => new Error('network error')));
    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz']);
      expect(result).toBeInstanceOf(UrlTree);
      done();
    });
  });

  it('fast path: an already-selected quiz with a matching id is returned without calling metadataApi.load()', (done) => {
    const active: Quiz = { quizId: 'angular', milestone: 'Angular', summary: '', image: '', questions: [] };
    quizService.selectedQuiz = active;

    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      expect(result).toBe(active);
      expect(metadataApi.load).not.toHaveBeenCalled();
      done();
    });
  });

  it('does NOT take the fast path when the active quiz id does not match the route', (done) => {
    quizService.selectedQuiz = { quizId: 'other', milestone: '', summary: '', image: '', questions: [] };

    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      expect(metadataApi.load).toHaveBeenCalled();
      expect((result as Quiz).quizId).toBe('angular');
      done();
    });
  });

  it('the resolved quiz never carries real question content — questions is always []', (done) => {
    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      const quiz = result as Quiz;
      expect(quiz.questions).toEqual([]);
      // No answer-bearing shape can ride along: an empty array structurally
      // cannot carry .options[].correct or .explanation for any question.
      done();
    });
  });

  it('the resolved object has no field capable of carrying options/correct/explanation', (done) => {
    resolver.resolve(makeRoute({ quizId: 'angular' }), mockRouterState).subscribe((result) => {
      const quiz = result as Quiz;
      // The Quiz type itself has no top-level `correct`/`options`/`explanation`
      // field — the only place those could ever live is inside `questions`,
      // which is proven empty above. This is a structural guarantee, not a
      // best-effort one: TypeScript would reject any resolver code path that
      // tried to populate them without also populating `questions`.
      expect(Object.keys(quiz)).not.toContain('correct');
      expect(Object.keys(quiz)).not.toContain('options');
      expect(Object.keys(quiz)).not.toContain('explanation');
      done();
    });
  });
});
