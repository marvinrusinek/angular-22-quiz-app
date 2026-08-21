import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architecture boundary for Interview Mode, enforced as a test.
 *
 * After Stage 9F there is exactly ONE authoritative Interview pipeline:
 *
 *   Builder → backend session → backend submit → backend result
 *          → Review → history adapter → analytics
 *
 * These checks read the source files themselves, because the property being
 * protected is "this code never imports that code" — something no runtime test
 * can observe once the wiring is correct.
 *
 * Topic Quizzes are deliberately NOT covered: they keep scoring locally over
 * assets/data/quiz.json exactly as before, and the last block proves it.
 */
const SRC = join(__dirname, '..', '..', '..');

const read = (relative: string): string => readFileSync(join(SRC, relative), 'utf8');

/**
 * Source with comments stripped.
 *
 * The boundary is about what the code DOES. A comment explaining *why* a file
 * no longer reads `assets/data/quiz.json` must not be mistaken for the file
 * still reading it — otherwise documenting the rule would break the rule.
 */
const code = (relative: string): string =>
  read(relative)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');

/** Interview runtime files (specs excluded — they may reference anything). */
const INTERVIEW_RUNTIME = [
  'containers/interview/build-your-interview/build-your-interview.component.ts',
  'containers/interview/interview-session/interview-session.component.ts',
  'containers/interview/interview-results/interview-results.component.ts',
  'containers/interview/interview-history/interview-history.component.ts',
  'containers/interview/interview-history-detail/interview-history-detail.component.ts',
  'components/interview/interview-review/interview-review.component.ts',
  'components/interview/interview-review/interview-review-status.ts',
  'components/interview/interview-options/interview-options.component.ts',
  'shared/services/interview/backend-interview-session.service.ts',
  'shared/services/interview/backend-interview-result.service.ts',
  'shared/services/interview/interview-result-history.adapter.ts',
  'shared/services/interview/interview-catalog.service.ts',
  'shared/services/features/interview/interview-readiness.service.ts',
  'router/guards/backend-interview-session-guard.ts',
  'router/guards/backend-interview-result-guard.ts'
];

describe('the legacy Interview pipeline is gone', () => {
  it.each([
    'shared/services/features/interview/interview-session.service.ts',
    'router/guards/interview-result-guard.ts',
    'router/guards/interview-session-guard.ts',
    'containers/interview/interview-session-handoff/interview-session-handoff.component.ts'
  ])('%s no longer exists', (relative) => {
    expect(() => read(relative)).toThrow();
  });

  it('computeInterviewResult is no longer exported', () => {
    expect(read('shared/utils/interview-scoring.ts')).not.toContain('export function computeInterviewResult');
  });

  it('the review-snapshot builders are gone', () => {
    const history = read('shared/services/features/interview/interview-history.service.ts');
    expect(history).not.toContain('export function buildReviewSnapshot');
    expect(history).not.toContain('export function validateReviewSnapshots');
  });
});

describe('no Interview runtime file touches the local quiz bank or local scoring', () => {
  it.each(INTERVIEW_RUNTIME)('%s', (relative) => {
    const source = code(relative);

    // The quiz bank: questions, options and per-option correctness flags.
    expect(source).not.toMatch(/^import .*quiz-data-cache/m);
    expect(source).not.toContain('getQuizData');
    expect(source).not.toContain('assets/data/quiz.json');
    expect(source).not.toMatch(/^import .*quiz-data-loader/m);
    expect(source).not.toMatch(/^import .*quizdata\.service/m);
    expect(source).not.toMatch(/^import .*assessment-builder\.service/m);

    // Local scoring.
    expect(source).not.toMatch(/^import .*interview-scoring/m);
    expect(source).not.toContain('computeInterviewResult');

    // The legacy session service and its generated assessment.
    expect(source).not.toMatch(/^import .*features\/interview\/interview-session\.service/m);
    expect(source).not.toContain('GeneratedAssessment');
  });
});

describe('exactly one Interview scoring authority', () => {
  it('the results page renders backend fields and computes no score', () => {
    const results = read('containers/interview/interview-results/interview-results.component.ts');
    expect(results).toContain('BackendInterviewResultService');
    // Achievements are refreshed WITHOUT the quiz bank. Interview Master reads
    // history and Angular Explorer is meta over earned ids, so the catalogue is
    // never needed — and the topic-quiz achievements stay with the topic-quiz
    // flow, which already evaluates them.
    expect(results).toContain('evaluateInterviewAchievements()');
    expect(results).not.toContain('evaluate(getQuizData())');
  });

  it('review derives correctness from the backend id lists only', () => {
    const review = read('components/interview/interview-review/interview-review.component.ts');
    expect(review).toContain('correctOptionIds');
    expect(review).not.toMatch(/o\.correct|option\.correct/);
  });

  it('history persists no answer key', () => {
    const adapter = read('shared/services/interview/interview-result-history.adapter.ts');
    for (const banned of ['review:', 'correctOptionIds:', 'explanation:', 'questionText:']) {
      expect(adapter).not.toContain(banned);
    }
  });
});

describe('Topic Quizzes are untouched', () => {
  it('still load the local quiz bank', () => {
    expect(read('shared/services/data/quiz-data-loader.service.ts')).toMatch(/quiz\.json|assets/);
    expect(read('shared/quiz-data-cache.ts')).toBeTruthy();
  });

  it('still score locally over the local questions', () => {
    expect(read('shared/services/data/quiz-scoring.service.ts')).toBeTruthy();
    expect(read('shared/services/features/practice/practice-session.service.ts'))
      .toContain('AssessmentBuilderService');
  });
});

describe('Weak Areas Practice no longer holds an answer key (Stage 14 S6)', () => {
  /**
   * This replaces an assertion that practice "deliberately remains a local
   * mode". S6 reversed that premise on purpose, so the check is inverted rather
   * than dropped: the same file is still pinned, now against the OPPOSITE
   * property, which is what stops the local scorer quietly coming back.
   */
  it('practice-scoring decides nothing locally', () => {
    const scoring = read('shared/utils/practice-scoring.ts');
    // The shared local scorer is gone from this path.
    expect(scoring).not.toContain('isAnswerCorrect');
    // …and so is every way of recomputing correctness from the options.
    expect(scoring).not.toContain('isOptionCorrect');
    // Correctness arrives as an authorized verdict instead.
    expect(scoring).toContain('AuthorizedResolved');
  });

  it('practice questions come from the API, not the local bank', () => {
    const session = read('shared/services/features/practice/practice-session.service.ts');
    expect(session).toContain('TopicQuizQuestionsService');
    expect(session).toContain('questionsFromApiViews');
    expect(session).toContain('PracticeVerdictService');
  });

  it('the builder does not fabricate correctness for practice options', () => {
    const builder = read('shared/services/features/assessment/assessment-builder.service.ts');
    expect(builder).not.toContain('correct: option.correct === true');
  });

  it('practice uses an UNTIMED receipt, never the cached timed one', () => {
    const verdict = read('shared/services/features/practice/practice-verdict.service.ts');
    expect(verdict).toContain('withFreshUntimedPracticeReceipt');
    // The Topic Quiz's cached activation must not be reused for practice.
    expect(verdict).not.toContain('withQuestionReceipt(');
  });
});
