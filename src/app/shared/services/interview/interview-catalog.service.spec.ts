import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { InterviewCatalogService } from './interview-catalog.service';
import { InterviewApiService } from '../api/interview-api.service';
import type { QuizMetadataDto } from '../../models/api/interview-api.dto';

/**
 * Phase 1 audit + Phase 2 regression coverage: proves the topic-metadata
 * request this whole task diagnosed as SLOW-BUT-NOT-DUPLICATED really is
 * fetched at most once per page life, cached correctly, and surfaces an
 * honest loading/error state throughout — directly at the service layer,
 * independent of any one component's own template logic.
 */
function metadata(quizId: string, questionCount = 10): QuizMetadataDto {
  return { quizId, milestone: quizId, summary: '', image: '', difficulty: 'beginner', questionCount };
}

describe('InterviewCatalogService', () => {
  let getQuizMetadata: jest.Mock;

  function service(): InterviewCatalogService {
    TestBed.configureTestingModule({
      providers: [{ provide: InterviewApiService, useValue: { getQuizMetadata } }]
    });
    return TestBed.inject(InterviewCatalogService);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    getQuizMetadata = jest.fn(() => of([metadata('rxjs')]));
  });

  it('is idle before load() is ever called', () => {
    const svc = service();
    expect(svc.status()).toBe('idle');
    expect(svc.loading()).toBe(false);
    expect(getQuizMetadata).not.toHaveBeenCalled();
  });

  it('goes through loading -> ready exactly once for a single load()', async () => {
    const svc = service();
    const promise = svc.load();
    expect(svc.status()).toBe('loading');
    expect(svc.loading()).toBe(true);
    await promise;
    expect(svc.status()).toBe('ready');
    expect(svc.loading()).toBe(false);
    expect(getQuizMetadata).toHaveBeenCalledTimes(1);
  });

  /**
   * The exact "duplicate fetching" question Phase 1 of this task set out to
   * answer: repeated load() calls — simulating repeated ngOnInit()/template
   * re-evaluation — must never issue a second underlying HTTP-level call.
   */
  it('never issues more than ONE underlying request across repeated load() calls', async () => {
    const svc = service();
    await Promise.all([svc.load(), svc.load(), svc.load()]);
    await svc.load(); // even a call well after the first has settled
    expect(getQuizMetadata).toHaveBeenCalledTimes(1);
  });

  it('multiple independent callers reading the SAME instance share the one loaded result', async () => {
    const svc = service();
    await svc.load();
    // A second "consumer" is just another call against the same singleton —
    // this IS the shared-result contract this service currently provides.
    await svc.load();
    expect(getQuizMetadata).toHaveBeenCalledTimes(1);
    expect(svc.topics()).toHaveLength(1);
  });

  it('an empty metadata response is reported as unavailable, not ready — never "complete with nothing"', async () => {
    getQuizMetadata.mockReturnValue(of([]));
    const svc = service();
    await svc.load();
    expect(svc.status()).toBe('unavailable');
    expect(svc.unavailable()).toBe(true);
    expect(svc.topics()).toEqual([]);
  });

  it('a failed request is reported as unavailable, with an accessible retry path (reload())', async () => {
    getQuizMetadata.mockReturnValueOnce(throwError(() => new Error('network down')));
    const svc = service();
    await svc.load();
    expect(svc.status()).toBe('unavailable');

    // reload() is the explicit retry — it must perform exactly ONE fresh
    // logical load, not replay the failed attempt or pile up requests.
    getQuizMetadata.mockReturnValueOnce(of([metadata('signals')]));
    await svc.reload();
    expect(getQuizMetadata).toHaveBeenCalledTimes(2);
    expect(svc.status()).toBe('ready');
    expect(svc.topics().map((t) => t.id)).toEqual(['signals']);
  });

  it('reload() always issues exactly one fresh request, even when already ready', async () => {
    const svc = service();
    await svc.load();
    expect(getQuizMetadata).toHaveBeenCalledTimes(1);

    getQuizMetadata.mockReturnValueOnce(of([metadata('forms')]));
    await svc.reload();
    expect(getQuizMetadata).toHaveBeenCalledTimes(2); // exactly one MORE call, not zero and not several
  });
});
