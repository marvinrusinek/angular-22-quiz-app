import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, provideRouter, Router, UrlTree } from '@angular/router';

import { routes } from '../quiz-routing.routes';
import { BackendInterviewResultGuard } from './backend-interview-result-guard';
import { InterviewReportComponent } from '../../containers/interview/interview-report/interview-report.component';
import { InterviewResultsComponent } from '../../containers/interview/interview-results/interview-results.component';
import { BackendInterviewResultService } from '@shared/services/interview/backend-interview-result.service';

/**
 * The Interview Report route is a SECOND view of the finalized result, so it must be
 * exactly as fail-closed as Results: the same guard, no separate policy. These tests
 * pin (a) that wiring and (b) the guard outcomes the report inherits.
 */
describe('Interview Report route — guard contract', () => {
  describe('route table', () => {
    const report = routes.find((r) => r.path === 'interview/report/:sessionId');
    const results = routes.find((r) => r.path === 'interview/results/:sessionId');

    it('exists, renders the report component, and is NOT unprotected', () => {
      expect(report?.component).toBe(InterviewReportComponent);
      expect(report?.canActivate).toContain(BackendInterviewResultGuard);
    });

    it('uses exactly the same guard(s) as Interview Results — no second security policy', () => {
      expect(results?.component).toBe(InterviewResultsComponent);
      expect(report?.canActivate).toEqual(results?.canActivate);
    });

    it('sends an id-less report URL to the builder, like Results does', () => {
      const idless = routes.find((r) => r.path === 'interview/report');
      expect(idless).toMatchObject({ redirectTo: 'interview', pathMatch: 'full' });
    });

    it('adds no other report route (no history/public/print variants)', () => {
      expect(routes.filter((r) => (r.path ?? '').includes('report')).map((r) => r.path).sort())
        .toEqual(['interview/report', 'interview/report/:sessionId']);
    });
  });

  describe('outcomes the report inherits', () => {
    let load: jest.Mock;
    let router: Router;

    const run = async (sessionId: string): Promise<boolean | UrlTree> => {
      const guard = TestBed.inject(BackendInterviewResultGuard);
      const route = { paramMap: convertToParamMap(sessionId ? { sessionId } : {}) } as ActivatedRouteSnapshot;
      return guard.canActivate(route);
    };
    const url = (r: boolean | UrlTree): string => router.serializeUrl(r as UrlTree);

    beforeEach(() => {
      load = jest.fn();
      TestBed.configureTestingModule({
        providers: [provideRouter([]), { provide: BackendInterviewResultService, useValue: { load } }]
      });
      router = TestBed.inject(Router);
    });

    it('a finalized, authorized session may open the report', async () => {
      load.mockResolvedValue({ kind: 'loaded', result: {} });
      expect(await run('s1')).toBe(true);
      expect(load).toHaveBeenCalledWith('s1');
    });

    it('an UNFINISHED session is sent back to the session — never to any review data', async () => {
      load.mockResolvedValue({ kind: 'not-ready' });
      expect(url(await run('s1'))).toBe('/interview/session/s1');
    });

    it('a missing token / unknown session fails closed to the builder', async () => {
      load.mockResolvedValue({ kind: 'none' });
      expect(url(await run('s1'))).toBe('/interview');
    });

    it('an unauthorized token fails closed to the builder', async () => {
      load.mockResolvedValue({ kind: 'unauthorized' });
      expect(url(await run('s1'))).toBe('/interview');
    });

    it('no session id at all goes to the builder without even attempting a load', async () => {
      expect(url(await run(''))).toBe('/interview');
      expect(load).not.toHaveBeenCalled();
    });
  });
});
