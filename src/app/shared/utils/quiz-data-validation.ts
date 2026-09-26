import { Option, Quiz, QuizQuestion, QuizResource } from '@shared/models';

/**
 * Runtime validation for the quiz dataset (assets/data/quiz.json).
 *
 * The dataset is fetched over HTTP at bootstrap (main.ts), so it is INPUT — even
 * though it currently ships as a same-origin static asset. Before this guard the
 * bootstrap did `setQuizDataCache(data?.quizzes ?? [], ...)`, which passes any
 * truthy non-array straight through to consumers that immediately call
 * `structuredClone(...)`, `.find(...)` and `.map(...)` on it — a malformed (but
 * valid-JSON) payload would throw inside a field initializer and break the view.
 *
 * DESIGN — deliberately non-destructive:
 *  - Valid entries are passed through BY REFERENCE, never rebuilt, so no field is
 *    lost and object identity is preserved. On well-formed data this function is
 *    a pure no-op that returns the same objects it was given.
 *  - Only genuinely malformed entries are dropped, and each drop is reported.
 *  - It never throws. Catastrophic input degrades to an empty catalog, which the
 *    app already handles (that is the existing network-failure path).
 *
 * VALIDATION MATCHES THE DATA AS AUTHORED, not the widest TypeScript model:
 *  - `type` is absent from every question in the dataset (it is defaulted at
 *    runtime by quiz-question-resolver), so it is NOT required here. Requiring it
 *    would reject all 185 questions.
 *  - On an Option only `text` is required; `correct` is present only on correct
 *    options and is optional.
 *
 * HTML CONTENT: `questionText` and `explanation` are authored HTML (they contain
 * <code>/<strong> by design). This module deliberately does NOT rewrite or strip
 * them — doing so would change rendering. Angular's DomSanitizer remains the
 * enforcement point at render time; active-content patterns are only REPORTED so
 * bad authoring surfaces in review instead of silently shipping.
 */

export interface QuizDataValidationResult {
  quizzes: Quiz[];
  resources: QuizResource[];
  /** Human-readable descriptions of everything rejected or worth attention. */
  problems: string[];
}

const DIFFICULTIES: readonly string[] = ['beginner', 'intermediate', 'advanced'];

/** Report-only: markup that Angular's sanitizer will strip at render time. */
const ACTIVE_CONTENT = /<\s*script\b|<\s*iframe\b|<\s*object\b|<\s*embed\b|\son\w+\s*=|javascript\s*:/i;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

function validateOptions(
  raws: readonly unknown[],
  label: string,
  problems: string[]
): Option[] {
  const out: Option[] = [];

  for (const [i, raw] of raws.entries()) {
    if (!raw || typeof raw !== 'object') {
      problems.push(`${label} option[${i}]: not an object`);
      continue;
    }
    const o = raw as Record<string, unknown>;

    if (typeof o['text'] !== 'string') {
      problems.push(`${label} option[${i}]: "text" is missing or not a string`);
      continue;
    }
    // `correct` is optional, but when present it decides scoring — a non-boolean
    // (e.g. the string "false", which is truthy) would silently corrupt results.
    if (o['correct'] !== undefined && typeof o['correct'] !== 'boolean') {
      problems.push(`${label} option[${i}]: "correct" is not a boolean`);
      continue;
    }

    out.push(raw as Option);   // pass through by reference
  }

  return out;
}

function validateQuestions(
  raws: readonly unknown[],
  quizId: string,
  problems: string[]
): QuizQuestion[] {
  const out: QuizQuestion[] = [];

  for (const [i, raw] of raws.entries()) {
    const label = `quiz "${quizId}" Q${i + 1}`;

    if (!raw || typeof raw !== 'object') {
      problems.push(`${label}: not an object`);
      continue;
    }
    const q = raw as Record<string, unknown>;

    if (!isNonEmptyString(q['questionText'])) {
      problems.push(`${label}: "questionText" is missing or empty`);
      continue;
    }
    if (typeof q['explanation'] !== 'string') {
      problems.push(`${label}: "explanation" is missing or not a string`);
      continue;
    }

    const rawOptions = q['options'];
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      problems.push(`${label}: "options" is missing, not an array, or empty`);
      continue;
    }

    const options = validateOptions(rawOptions, label, problems);
    if (options.length === 0) {
      problems.push(`${label}: no valid options remain`);
      continue;
    }

    // Report-only checks — these never drop the question, because removing one
    // would change the quiz length and therefore the user-visible flow.
    if (!options.some((o) => o.correct === true)) {
      problems.push(`${label}: no option is marked correct`);
    }
    if (ACTIVE_CONTENT.test(q['questionText'] as string)) {
      problems.push(`${label}: "questionText" contains active content (sanitized at render)`);
    }
    if (ACTIVE_CONTENT.test(q['explanation'] as string)) {
      problems.push(`${label}: "explanation" contains active content (sanitized at render)`);
    }

    // Identity-preserving on the happy path; only clone when options were dropped.
    out.push(
      options.length === rawOptions.length
        ? (raw as QuizQuestion)
        : { ...(raw as QuizQuestion), options }
    );
  }

  return out;
}

export function validateQuizData(raw: unknown): QuizDataValidationResult {
  const problems: string[] = [];

  if (!raw || typeof raw !== 'object') {
    problems.push('quiz data root is not an object');
    return { quizzes: [], resources: [], problems };
  }

  const root = raw as Record<string, unknown>;
  const rawResources = root['resources'];
  const resources: QuizResource[] = Array.isArray(rawResources)
    ? (rawResources as QuizResource[])
    : [];
  if (rawResources !== undefined && !Array.isArray(rawResources)) {
    problems.push('"resources" is not an array — ignoring it');
  }

  const rawQuizzes = root['quizzes'];
  if (!Array.isArray(rawQuizzes)) {
    // The specific hole this guard exists to close: a truthy non-array here used
    // to reach structuredClone()/.find() downstream and throw.
    problems.push('"quizzes" is not an array — refusing to load the catalog');
    return { quizzes: [], resources, problems };
  }

  const quizzes: Quiz[] = [];
  const seenIds = new Set<string>();

  for (const [qi, raw2] of rawQuizzes.entries()) {
    if (!raw2 || typeof raw2 !== 'object') {
      problems.push(`quiz[${qi}]: not an object`);
      continue;
    }
    const q = raw2 as Record<string, unknown>;

    const quizId = q['quizId'];
    if (!isNonEmptyString(quizId)) {
      problems.push(`quiz[${qi}]: "quizId" is missing or empty`);
      continue;
    }
    if (seenIds.has(quizId)) {
      // Duplicate ids make quizId lookups ambiguous across scoring/progress.
      problems.push(`quiz "${quizId}": duplicate quizId — keeping the first`);
      continue;
    }
    seenIds.add(quizId);

    // Report-only: an unknown difficulty affects filtering, never correctness.
    const difficulty = q['difficulty'];
    if (difficulty !== undefined && !DIFFICULTIES.includes(difficulty as string)) {
      problems.push(`quiz "${quizId}": unknown difficulty "${String(difficulty)}"`);
    }

    const rawQuestions = q['questions'];
    if (rawQuestions !== undefined && !Array.isArray(rawQuestions)) {
      problems.push(`quiz "${quizId}": "questions" is not an array — dropping quiz`);
      continue;
    }

    if (Array.isArray(rawQuestions)) {
      const questions = validateQuestions(rawQuestions, quizId, problems);
      // Compare by IDENTITY, not just length: a question can be kept while some
      // of its options were dropped, in which case validateQuestions returned a
      // filtered copy. Checking length alone would discard that copy and pass the
      // original (unfiltered) quiz through.
      const unchanged =
        questions.length === rawQuestions.length &&
        questions.every((qn, i) => qn === rawQuestions[i]);
      if (!unchanged) {
        quizzes.push({ ...(raw2 as Quiz), questions });
        continue;
      }
    }

    quizzes.push(raw2 as Quiz);   // pass through by reference (no-op path)
  }

  return { quizzes, resources, problems };
}
