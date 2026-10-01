import type { QuizRepository } from './quiz/quiz.repository';
import type { SessionRepository } from './interview/session.repository';
import type { InterviewSessionService } from './interview/session.service';
import type { CertificateClaimService } from './certificate/certificate-claim.service';

/**
 * Everything the HTTP layer needs, passed in explicitly.
 *
 * No module-global singleton: the repository holds the answer key, and hidden
 * global state is both hard to isolate in tests and easy to reach from code
 * that has no business touching it. Tests build an app with a fixture
 * repository; production builds one from the private file before listening.
 */
export interface AppDependencies {
  readonly quizRepository: QuizRepository;
  /** Wired in server.ts so database lifecycle never leaks into route code. */
  readonly sessionRepository?: SessionRepository;
  /** Absent in tests that only exercise metadata/health routes. */
  readonly interviewSessionService?: InterviewSessionService;
  /**
   * Absent whenever config.certificateClaims.enabled is false (the default —
   * see config.ts#parseCertificateClaims). createCertificateClaimsRouter
   * responds 503 to every route when this is undefined, so the feature
   * being off costs nothing beyond that one flag check.
   */
  readonly certificateClaimService?: CertificateClaimService | undefined;
  /**
   * Injected clock for Topic Quiz attempt expiry, so tests can cross the
   * deadline without waiting. Defaults to Date.now().
   */
  readonly now?: (() => number) | undefined;
}
