import { readFileSync } from 'fs';

import { validateQuizData } from './quiz-data-validation';

/**
 * Coverage for the (now unreachable in production — see below) quiz data
 * guard.
 *
 * The most important test here is the FIRST one: the validator must be a pure
 * no-op on a well-formed dataset. If it ever drops or rewrites live content
 * that is a user-visible regression, not a security win — so the fixture is
 * asserted to survive byte-for-byte, by object identity.
 *
 * S6p (Angular Stage 14): src/assets/data/quiz.json — the file this block
 * used to read from disk — is deleted; the client no longer fetches, caches,
 * or bundles any answer-bearing bank, and main.ts no longer calls
 * validateQuizData() at all (there is nothing left to validate at bootstrap).
 * This describe block now reads the explicit, test-only fixture at
 * shared/testing/quiz-catalog-fixture.json (identical real content, sampled
 * from the authoritative backend copy) instead, preserving the same coverage
 * of validateQuizData()'s behavior against realistic, well-formed data.
 */
describe('validateQuizData', () => {
  describe('against a realistic well-formed dataset', () => {
    let raw: any;

    beforeAll(() => {
      const text = readFileSync('src/app/shared/testing/quiz-catalog-fixture.json', 'utf8');
      expect(() => JSON.parse(text)).not.toThrow();
      raw = JSON.parse(text);
    });

    it('reports no problems for the shipped dataset', () => {
      const { problems } = validateQuizData(raw);
      expect(problems).toEqual([]);
    });

    it('passes every quiz through unchanged, by reference (no-op)', () => {
      const { quizzes, resources } = validateQuizData(raw);

      expect(quizzes.length).toBe(raw.quizzes.length);
      expect(resources.length).toBe(raw.resources.length);

      const mutated: string[] = [];
      for (const [i, q] of quizzes.entries()) {
        // Identity, not deep-equality: proves nothing was cloned or rebuilt.
        if (q !== raw.quizzes[i]) mutated.push(`quiz[${i}] (${q.quizId}) was not passed through by reference`);
      }
      expect(mutated).toEqual([]);
    });

    it('preserves the full question and option counts', () => {
      const { quizzes } = validateQuizData(raw);

      const countQuestions = (list: any[]) =>
        list.reduce((n, q) => n + (q.questions?.length ?? 0), 0);
      const countOptions = (list: any[]) =>
        list.reduce(
          (n, q) => n + (q.questions ?? []).reduce((m: number, qn: any) => m + (qn.options?.length ?? 0), 0),
          0
        );

      expect(countQuestions(quizzes)).toBe(countQuestions(raw.quizzes));
      expect(countOptions(quizzes)).toBe(countOptions(raw.quizzes));
    });

    it('does not require a question "type" (absent throughout the dataset)', () => {
      // Guards against a future tightening that would reject the whole dataset.
      const everyQuestionLacksType = raw.quizzes.every((q: any) =>
        (q.questions ?? []).every((qn: any) => qn.type === undefined)
      );
      expect(everyQuestionLacksType).toBe(true);
      expect(validateQuizData(raw).problems).toEqual([]);
    });
  });

  describe('malformed input is rejected safely', () => {
    it('never throws on garbage roots', () => {
      const garbage: unknown[] = [null, undefined, 0, 'nope', true, [], NaN];
      for (const g of garbage) {
        expect(() => validateQuizData(g)).not.toThrow();
        expect(validateQuizData(g).quizzes).toEqual([]);
      }
    });

    it('refuses a non-array "quizzes" instead of passing it downstream', () => {
      // This is the concrete hole the guard closes: `data?.quizzes ?? []` let a
      // truthy non-array through to structuredClone()/.find(), which then threw.
      const { quizzes, problems } = validateQuizData({ quizzes: { evil: true } });
      expect(quizzes).toEqual([]);
      expect(problems.join(' ')).toContain('"quizzes" is not an array');
    });

    it('drops malformed quizzes but keeps the valid ones', () => {
      const good = {
        quizId: 'good',
        questions: [
          { questionText: 'Q?', explanation: 'because', options: [{ text: 'a', correct: true }] }
        ]
      };
      const { quizzes } = validateQuizData({
        quizzes: [null, { noQuizId: true }, good, 'string-not-object']
      });

      expect(quizzes.length).toBe(1);
      expect(quizzes[0].quizId).toBe('good');
    });

    it('drops duplicate quizIds, keeping the first', () => {
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          { quizId: 'dup', milestone: 'first' },
          { quizId: 'dup', milestone: 'second' }
        ]
      });
      expect(quizzes.length).toBe(1);
      expect(quizzes[0].milestone).toBe('first');
      expect(problems.join(' ')).toContain('duplicate quizId');
    });

    it('drops questions missing questionText, explanation, or options', () => {
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          {
            quizId: 'q',
            questions: [
              { explanation: 'x', options: [{ text: 'a' }] },                      // no questionText
              { questionText: 'Q?', options: [{ text: 'a' }] },                    // no explanation
              { questionText: 'Q?', explanation: 'x' },                            // no options
              { questionText: 'Q?', explanation: 'x', options: [] },               // empty options
              { questionText: 'ok', explanation: 'x', options: [{ text: 'a', correct: true }] }
            ]
          }
        ]
      });

      expect(quizzes[0].questions!.length).toBe(1);
      expect(quizzes[0].questions![0].questionText).toBe('ok');
      expect(problems.length).toBe(4);
    });

    it('drops options whose "correct" is not a boolean', () => {
      // "false" as a STRING is truthy — silently corrupts scoring if trusted.
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          {
            quizId: 'q',
            questions: [
              {
                questionText: 'Q?',
                explanation: 'x',
                options: [{ text: 'a', correct: true }, { text: 'b', correct: 'false' }]
              }
            ]
          }
        ]
      });

      expect(quizzes[0].questions![0].options.length).toBe(1);
      expect(problems.join(' ')).toContain('"correct" is not a boolean');
    });
  });

  describe('non-destructive reporting', () => {
    it('reports a question with no correct option but KEEPS it', () => {
      // Dropping it would change the quiz length and the user-visible flow.
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          {
            quizId: 'q',
            questions: [{ questionText: 'Q?', explanation: 'x', options: [{ text: 'a' }] }]
          }
        ]
      });

      expect(quizzes[0].questions!.length).toBe(1);
      expect(problems.join(' ')).toContain('no option is marked correct');
    });

    it('reports active content but does NOT rewrite the authored HTML', () => {
      // Angular's DomSanitizer is the enforcement point at render time; stripping
      // here would change what legitimate <code>/<strong> authoring renders.
      const evil = 'Pick one <script>alert(1)</script>';
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          {
            quizId: 'q',
            questions: [
              { questionText: evil, explanation: 'x', options: [{ text: 'a', correct: true }] }
            ]
          }
        ]
      });

      expect(quizzes[0].questions![0].questionText).toBe(evil);   // untouched
      expect(problems.join(' ')).toContain('active content');
    });

    it('preserves authored formatting markup without flagging it', () => {
      const formatted = 'What does <code>@Input()</code> do? <strong>Pick one.</strong>';
      const { quizzes, problems } = validateQuizData({
        quizzes: [
          {
            quizId: 'q',
            questions: [
              { questionText: formatted, explanation: 'x', options: [{ text: 'a', correct: true }] }
            ]
          }
        ]
      });

      expect(quizzes[0].questions![0].questionText).toBe(formatted);
      expect(problems).toEqual([]);
    });
  });
});
