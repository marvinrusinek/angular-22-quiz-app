import { expect, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/** Shared helpers for the e2e specs: quiz data lookup + common selectors. */

// S6p (Angular Stage 14): src/assets/data/quiz.json — the Angular client
// asset this used to read — is deleted; the app no longer fetches, caches,
// or bundles any answer-bearing bank.
//
// Stage 15: the REAL backend bank (backend/data/quiz.json) is also gone. E2E
// runs against the real backend (see playwright.config.ts's webServer), whose
// throwaway database is seeded from a deterministic SYNTHETIC bank —
// backend/test/helpers/synthetic-quiz-bank.json — by
// e2e/support/ensure-e2e-database.js on every run (see the "[import] wrote N
// quizzes..." webServer startup log). That synthetic file is therefore the
// actual ground truth for what the running app will serve during E2E; it is
// never real quiz content, and it is the SAME fixture the backend's own unit
// tests use, so a schema change only needs to stay correct in one place.
export const quizData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'backend/test/helpers/synthetic-quiz-bank.json'), 'utf8')
).quizzes;

// Synthetic-bank equivalents of the old real-quiz fixtures — same STRUCTURAL
// role (single-answer-heavy / multi-answer-heavy / has-a-multi-answer-question
// / timeout-test quiz), never real content. See synthetic-quiz-bank.json's own
// doc comment for exactly which question in each carries which shape (e.g.
// fixture-gadgets' 3rd question has EXACTLY three correct options).
export const tsQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-widgets');
export const formsQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-gizmos');
export const diQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-gadgets');

export const HEADING = 'codelab-quiz-content h3';
export const FEEDBACK = 'codelab-quiz-feedback';
export const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
export const PREV_BTN = '.nav-btn[aria-label="Previous Question"]';
export const RESULTS_BTN = '.show-results-btn';

export const norm = (s: string) =>
  (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The question heading is rendered via innerHTML, so any `<...>` in the
// text (e.g. "Array<number>") is parsed as an HTML tag and dropped by the
// browser. Strip tag-like sequences from both sides before comparing.
const stripTags = (s: string) => (s || '').replace(/<[^>]*>/g, ' ');

export function isCorrect(o: any): boolean {
  return o?.correct === true || o?.correct === 'true' || o?.correct === 1;
}

export function correctIndices(q: any): number[] {
  return (q?.options ?? [])
    .map((o: any, i: number) => (isCorrect(o) ? i : -1))
    .filter((i: number) => i >= 0);
}

/**
 * Resolve, within a given quiz, the question whose text the heading begins
 * with. The heading is rendered via innerHTML, so tag-like sequences are
 * stripped from both sides before comparing.
 */
export function findQuestionIn(quiz: any, headingText: string): any {
  const qt = norm(stripTags(headingText));
  return (quiz?.questions ?? []).find((qq: any) =>
    qt.startsWith(norm(stripTags(qq.questionText)))
  );
}

/** ALL correct option indices for the question shown in the heading (multi-answer aware). */
export function correctIndicesForHeading(quiz: any, headingText: string): number[] {
  const q = findQuestionIn(quiz, headingText);
  return q ? correctIndices(q) : [];
}

/**
 * The first multi-answer question (>= 2 correct) in a quiz — resolved from the
 * data so specs don't hardcode a position/count that drifts when the quiz
 * changes. Returns its 1-based question index and how many options are correct.
 */
export function findMultiAnswerQuestion(quiz: any): { index: number; correctCount: number } {
  const questions = quiz?.questions ?? [];
  for (let i = 0; i < questions.length; i++) {
    const count = correctIndices(questions[i]).length;
    if (count >= 2) return { index: i + 1, correctCount: count };
  }
  return { index: -1, correctCount: 0 };
}

// ─── fixture-widgets (single-answer quiz) convenience wrappers ──────────────

/** Resolve the fixture-widgets question whose text the heading begins with. */
export function findTsQuestion(headingText: string): any {
  return findQuestionIn(tsQuiz, headingText);
}

/** The single correct option index for the fixture-widgets question shown in the heading. */
export function correctIndexForHeading(headingText: string): number {
  const q = findTsQuestion(headingText);
  return q ? correctIndices(q)[0] ?? -1 : -1;
}

// ─── shuffle-immune option resolution (by visible text, not index) ──────────
// Option ORDER is randomized at runtime when shuffle is on (prepareShuffle
// defaults shuffleOptions:true), so resolving the correct row by its JSON index
// clicks the wrong option. These resolve the DOM rows by matching the visible
// option text against the quiz data instead, which holds in both modes.

/** Drop the rendered "N. " numbering prefix from an option's visible text. */
const stripLeadNumber = (s: string) => (s || '').replace(/^\s*\d+\.\s*/, '');

/** Normalized correct option texts for the question shown in the heading. */
export function correctTextsForHeading(quiz: any, headingText: string): string[] {
  const q = findQuestionIn(quiz, headingText);
  return (q?.options ?? []).filter(isCorrect).map((o: any) => norm(o.text));
}

/**
 * Resolve the DOM `.option-row` indices for the correct options by matching each
 * row's visible text to the quiz data. Shuffle-immune (order-independent).
 */
export async function correctRowsForHeading(
  rows: Locator,
  quiz: any,
  headingText: string
): Promise<number[]> {
  const wanted = correctTextsForHeading(quiz, headingText);
  const count = await rows.count();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = (await rows.nth(i).locator('.option-text').textContent()) ?? '';
    const text = norm(stripLeadNumber(raw));
    if (wanted.some((w) => w !== '' && (text === w || text.startsWith(w)))) {
      out.push(i);
    }
  }
  return out;
}

// ─── legitimate attempt/progression setup (direct-route bypass P1) ─────────
//
// The direct-route progression-bypass fix (QuizGuard + QuizProgressionService)
// made two long-standing E2E shortcuts obsolete:
//
//   Root Cause A (fixed in production, 2026-09-28): `page.goto` straight to
//   question 1 skips Introduction's Start button, the only thing (besides
//   in-quiz Restart) that mints a session's attemptId. QuizProgressionService
//   now lazily mints one on the first approved unlock, so this specific
//   shape is no longer required to be worked around in tests — but going
//   through the real Start button remains the more faithful simulation of an
//   actual user, and is what `startQuizViaUi` below does.
//
//   Root Cause B (unchanged, working as designed): `page.goto` straight to a
//   FUTURE question index — e.g. the shared multi-answer question at
//   `/fixture-gadgets/3` — with no prior progression is a direct-route
//   bypass attempt, and QuizGuard correctly redirects it. A test that wants
//   to reach that question must progress there legitimately, via
//   `advanceToQuestion` below.
//
// Neither helper writes to sessionStorage/localStorage, sets a hidden test
// flag, or reads any answer key from a browser API response — every step is
// a click a real user could make, and every "correct" option is resolved
// from the SAME synthetic fixture the seeded backend already serves.

/**
 * Starts a fresh attempt the way a real user does: quiz-selection tile →
 * Introduction → the same "Start the Quiz!" click every user makes. Ends on
 * question 1, with the quiz id and index verified against the URL.
 */
export async function startQuizViaUi(page: Page, quizId: string, tileMatcher: RegExp): Promise<void> {
  await page.goto('/quiz');
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 30_000 });

  const tile = page.locator('.quiz-tile').filter({ hasText: tileMatcher }).first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(1200); // Introduction's own settle — matches every existing spec's pattern

  const start = page.locator('.start-btn').first();
  if ((await start.count()) > 0) await start.click();

  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(page, `startQuizViaUi: expected to land on ${quizId}/1`).toHaveURL(
    new RegExp(`/quiz/question/${quizId}/1$`),
    { timeout: 15_000 }
  );
}

/** The 1-based question index from the current URL, or -1 if not on a question route. */
function questionIndexFromUrl(page: Page): number {
  const m = page.url().match(/\/quiz\/question\/[^/]+\/(\d+)/);
  return m ? Number(m[1]) : -1;
}

/**
 * Progresses sequentially from wherever the page is now — a legitimately
 * unlocked question, e.g. right after `startQuizViaUi` — up to `targetIndex`
 * (1-based). Answers every intermediate question with ALL of its correct
 * options (single- or multi-answer alike, resolved by visible option TEXT
 * against `quiz`, shuffle-immune), waits for the real backend-authoritative
 * verdict (Next actually becomes enabled) before each click, asserts the
 * resulting URL transition, and stops exactly at `targetIndex` — it never
 * jumps ahead of it. Throws a clear error if the target cannot be reached
 * (e.g. Next never enables, or no correct option resolves for a heading).
 */
export async function advanceToQuestion(page: Page, quiz: any, targetIndex: number): Promise<void> {
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  let current = questionIndexFromUrl(page);
  if (current < 1) {
    throw new Error(`advanceToQuestion: not on a question route (${page.url()})`);
  }
  if (current > targetIndex) {
    throw new Error(`advanceToQuestion: already past the target (at ${current}, target ${targetIndex})`);
  }

  while (current < targetIndex) {
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, quiz, heading);
    if (corrects.length === 0) {
      throw new Error(
        `advanceToQuestion: no correct option resolved for heading "${heading}" at question ${current} of ${quiz?.quizId ?? quiz?.id}`
      );
    }
    for (const idx of corrects) {
      await rows.nth(idx).click({ timeout: 10_000 });
      await page.waitForTimeout(300); // let each click's own verdict settle before the next
    }

    await expect(page.locator(NEXT_BTN), `advanceToQuestion: Next never enabled at question ${current}`).toBeEnabled({
      timeout: 20_000
    });
    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(new RegExp(`/${current + 1}$`), { timeout: 15_000 });
    current += 1;
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
  }
}
