import { test, expect, Page } from '@playwright/test';
import { quizData, correctRowsForHeading } from './helpers';

/**
 * Code snippet — end-to-end coverage (Topic Quiz + Interview Mode).
 *
 * A code snippet is question CONTENT, never an answer-key or scoring
 * mechanism: these specs prove it renders correctly across every surface,
 * behaves like any other question for answering/navigation/scoring, and
 * that HTML-shaped snippet content (including a deliberate `<script>`
 * payload) can never execute in the browser.
 *
 * Fixture: `fixture-whatsits` (backend/test/helpers/synthetic-quiz-bank.json)
 * carries two code-snippet questions and is otherwise referenced by NO other
 * e2e spec, so this file owns it exclusively:
 *   Q1 — TypeScript snippet, filename "code.ts", multiline, single-answer.
 *   Q2 — HTML snippet, no filename, contains the XSS sentinel payload, single-answer.
 *   Q3+ — no snippet (used to prove absence renders nothing extra).
 *
 * It has EXACTLY 10 questions — the smallest Interview question-count option
 * — so selecting only this topic with count '10' draws its entire pool
 * every time (no risk of either snippet question being sampled out). The
 * assessment builder still applies its own final shuffle to the drawn set
 * (see assessment.builder.ts), so a session's internal ORDER is not
 * predictable; the Interview specs below locate the snippet by walking the
 * paginator rather than assuming a fixed position.
 */

const codeQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-whatsits');

const HEADING = 'codelab-quiz-content h3';
const FEEDBACK = 'codelab-quiz-feedback';
const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
const RESULTS_BTN = '.show-results-btn';
const SNIPPET = 'app-code-snippet';
const RESULTS_URL = /\/interview\/results\/[^/?#]+/;

async function gotoQuestion(page: Page, quiz: string, n: number) {
  await page.goto(`/quiz/question/${quiz}/${n}`);
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Complete the whole fixture-whatsits topic quiz and land on Results. */
async function completeCodeQuiz(page: Page) {
  await gotoQuestion(page, 'fixture-whatsits', 1);
  for (let i = 0; i < codeQuiz.questions.length; i++) {
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const rows = page.locator('.option-row');
    const corrects = await correctRowsForHeading(rows, codeQuiz, heading);
    for (const idx of corrects) {
      // A hover-cursor overlay can intercept the click momentarily right
      // after a preceding option's own overlay animates in — the same
      // known flakiness worked around elsewhere in this suite (see
      // cd-timeout-fet.spec.ts).
      await rows.nth(idx).click({ force: true });
    }
    const isLast = i === codeQuiz.questions.length - 1;
    if (isLast) {
      await expect(page.locator(RESULTS_BTN)).toBeVisible({ timeout: 15_000 });
      await page.locator(RESULTS_BTN).click();
      break;
    }
    await page.locator(NEXT_BTN).click();
    await page.locator(HEADING).first().waitFor({ state: 'visible' });
  }
}

/**
 * Build a Custom interview restricted to the "Fixture Whatsits" topic only
 * (Beginner difficulty), requesting exactly its full pool size (10) so
 * every question in the session comes from this quiz.
 */
async function configureCodeSnippetInterview(page: Page) {
  await page.goto('/interview');
  await page.locator('.chip:has-text("Beginner")').first().click();
  const topicCheck = page.locator('.topic-check', { hasText: 'Fixture Whatsits' });
  await expect(topicCheck).toBeVisible();
  await topicCheck.locator('input[type="checkbox"]').click();
  await expect(topicCheck.locator('input[type="checkbox"]')).toBeChecked();
  await page.locator('.chip--button:has-text("10")').first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

/**
 * Walk the paginator to find whichever question in the active session
 * carries a code snippet matching `hasFilename` (true = the TypeScript
 * snippet, false = the filename-less HTML snippet). The assessment's final
 * shuffle means neither question has a predictable position.
 */
async function goToQuestionWithSnippet(page: Page, hasFilename: boolean): Promise<number> {
  // NOT `.pg-page.count()`: the paginator is WINDOWED (first, last, and a ±2
  // range around the current question — see interview-paginator.component.ts),
  // so at question 1 only a handful of page buttons exist in the DOM at all.
  // The true total lives in the progress text ("Question 1 of 10").
  const progressText = (await page.locator('.interview-progress').textContent()) ?? '';
  const total = Number(progressText.match(/of\s+(\d+)/)?.[1] ?? 10);
  for (let i = 1; i <= total; i++) {
    await page.locator(`.pg-page[aria-label^="Go to question ${i},"]`).click();
    // Wait for the question to actually change before inspecting it — otherwise
    // a snippet check can race Angular's re-render and read the PREVIOUS question.
    await expect(page.locator('.interview-progress')).toContainText(`Question ${i} of`);
    if ((await page.locator(SNIPPET).count()) > 0) {
      const filenamePresent = (await page.locator('.code-snippet__filename').count()) > 0;
      if (filenamePresent === hasFilename) return i;
    }
  }
  throw new Error(`No code-snippet question found in this session matching hasFilename=${hasFilename}`);
}

test.describe('Code snippet — Topic Quiz', () => {
  test('renders question text, position, language, filename, and preserves multiline formatting; options render normally', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 1);
    await expect(page.locator(HEADING)).toContainText('Which whatsit code unlocks feature 1');

    const snippet = page.locator(SNIPPET);
    await expect(snippet).toBeVisible();

    // Positioned between the question heading and the options list.
    const headingBox = await page.locator(HEADING).boundingBox();
    const snippetBox = await snippet.boundingBox();
    const optionsBox = await page.locator('.option-row').first().boundingBox();
    expect(headingBox!.y).toBeLessThan(snippetBox!.y);
    expect(snippetBox!.y).toBeLessThan(optionsBox!.y);

    await expect(snippet.locator('.code-snippet__filename')).toHaveText('code.ts');
    await expect(snippet.locator('.code-snippet__language')).toHaveText('TypeScript');

    const codeText = (await snippet.locator('.code-snippet__code').textContent()) ?? '';
    expect(codeText).toContain('const codeSignal = signal(1);');
    expect(codeText).toContain('const codeLabel = computed(');
    expect(codeText.split('\n').length).toBeGreaterThanOrEqual(2);

    // Options render exactly as any other question — no special treatment.
    await expect(page.locator('.option-row')).toHaveCount(3);
  });

  test('a question with no code snippet renders no code-snippet element', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 3);
    await expect(page.locator(HEADING)).toContainText('feature 3');
    await expect(page.locator(SNIPPET)).toHaveCount(0);
  });

  /**
   * Structural containment, not merely visual adjacency. A CSS-only fix (e.g.
   * `h3 + app-code-snippet { border-color: ... }`) can make the snippet LOOK
   * attached to the question box while remaining a plain sibling in the DOM —
   * bounding-box Y-ordering checks (see the test above) cannot tell the
   * difference. This test asserts real DOM containment via `Node.contains()`,
   * which only a genuine `<div class="question-box"><h3/><app-code-snippet/>
   * </div>` structure can satisfy.
   */
  test('the question box structurally CONTAINS the heading and the code snippet as real DOM children', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 1);
    await expect(page.locator(SNIPPET)).toBeVisible();

    const withSnippet = await page.evaluate(() => {
      const box = document.querySelector('.question-box');
      const heading = box?.querySelector('h3') ?? null;
      const snippet = box?.querySelector('app-code-snippet') ?? null;
      const optionRows = Array.from(document.querySelectorAll('.option-row'));
      return {
        boxExists: !!box,
        headingIsDescendantOfBox: !!box && !!heading && box.contains(heading),
        snippetIsDescendantOfBox: !!box && !!snippet && box.contains(snippet),
        snippetCountInDocument: document.querySelectorAll('app-code-snippet').length,
        anyOptionRowInsideBox: !!box && optionRows.some((row) => box.contains(row)),
        optionRowCount: optionRows.length
      };
    });

    expect(withSnippet.boxExists).toBe(true);
    expect(withSnippet.headingIsDescendantOfBox).toBe(true);
    expect(withSnippet.snippetIsDescendantOfBox).toBe(true);
    // Never rendered twice, and answer options stay OUTSIDE the question box.
    expect(withSnippet.snippetCountInDocument).toBe(1);
    expect(withSnippet.anyOptionRowInsideBox).toBe(false);
    expect(withSnippet.optionRowCount).toBeGreaterThan(0);

    // A question with NO snippet gets no empty snippet area inside its box.
    await gotoQuestion(page, 'fixture-whatsits', 3);
    const withoutSnippet = await page.evaluate(() => {
      const box = document.querySelector('.question-box');
      return {
        boxExists: !!box,
        headingExists: !!box?.querySelector('h3'),
        snippetExistsAnywhere: document.querySelectorAll('app-code-snippet').length
      };
    });
    expect(withoutSnippet.boxExists).toBe(true);
    expect(withoutSnippet.headingExists).toBe(true);
    expect(withoutSnippet.snippetExistsAnywhere).toBe(0);
  });

  test('a wrong click on a code question marks it incorrect; the snippet is unaffected', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 1);
    await expect(page.locator(SNIPPET)).toBeVisible();

    const rows = page.locator('.option-row');
    await rows.nth(1).click(); // 'code-000' is wrong

    await expect(rows.nth(1)).toHaveClass(/incorrect-option/);
    await expect(page.locator(SNIPPET)).toBeVisible();
    await expect(page.locator(SNIPPET).locator('.code-snippet__filename')).toHaveText('code.ts');
  });

  test('a correct click on a code question highlights it and shows the explanation; the snippet stays visible — no special scoring logic', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 1);
    await expect(page.locator(SNIPPET)).toBeVisible();

    const rows = page.locator('.option-row');
    await rows.nth(0).click(); // 'code-1' is correct

    await expect(rows.nth(0)).toHaveClass(/correct-option/);
    await expect(page.locator(FEEDBACK)).toContainText(/right/i);
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);
    await expect(page.locator(NEXT_BTN)).toBeVisible();
    await expect(page.locator(SNIPPET)).toBeVisible();
  });

  test('Results accordion shows the original question text, the code snippet with highlighting, and the explanation', async ({ page }) => {
    await completeCodeQuiz(page);

    // The accordion lives under the "Quiz Review" menu section, not the
    // default landing section.
    await page.locator('.hamburger-btn').click();
    await page.locator('.nav-item', { hasText: 'Quiz Review' }).click();
    await expect(page.locator('.summary-header')).toBeVisible({ timeout: 15_000 });

    const firstHeader = page.locator('mat-expansion-panel-header').first();
    await expect(firstHeader).toContainText('Which whatsit code unlocks feature 1');
    await firstHeader.click();

    const firstPanel = page.locator('mat-expansion-panel').first();
    await expect(firstPanel.locator(SNIPPET)).toBeVisible();
    await expect(firstPanel.locator('.code-snippet__filename')).toHaveText('code.ts');
    await expect(firstPanel.locator('.code-snippet__code')).toContainText('codeSignal');
    await expect(firstPanel).toContainText(/Explanation:/i);
    // NOT specific explanation prose: Topic Quiz question objects carry NO
    // `explanation` field anywhere in this app by design (see
    // topic-quiz-content.ts's questionFromApiView — "the FET body is
    // authorized by /check (S1)"), so the accordion's Explanation row is
    // structurally present but always empty here — pre-existing and
    // unrelated to code snippets. The Correct Answer(s) row IS populated.
    await expect(firstPanel).toContainText(/Correct Answer\(s\):.*code-1/i);
  });
});

test.describe('Code snippet — Interview Mode', () => {
  test('an active code question renders the snippet; options stay neutral, no explanation/correctness UI, Mark for Review and navigation still work', async ({ page }) => {
    await configureCodeSnippetInterview(page);
    await goToQuestionWithSnippet(page, true);

    await expect(page.locator(SNIPPET)).toBeVisible();
    await expect(page.locator('.code-snippet__filename')).toHaveText('code.ts');
    await expect(page.locator('.code-snippet__language')).toHaveText('TypeScript');

    // Deferred feedback: no correctness UI, no explanation, on an active question.
    await expect(page.locator('.correct-option, .incorrect-option')).toHaveCount(0);
    await expect(page.locator('.rv-correct, .rv-wrong')).toHaveCount(0);
    await expect(page.locator('.interview-question-box')).not.toContainText(/Explanation/i);

    const firstOption = page.locator('.io-option').first();
    await firstOption.click();
    await expect(firstOption).toHaveClass(/io-selected/);
    await expect(firstOption).not.toHaveClass(/io-correct|io-incorrect/);

    // Mark for Review still works alongside the snippet.
    await page.locator('.ai-mark-review-btn').click();
    await expect(page.locator('.ai-mark-review-btn')).toHaveAttribute('aria-pressed', 'true');

    // Navigation still works, and the second (HTML, filename-less) snippet renders too.
    await goToQuestionWithSnippet(page, false);
    await expect(page.locator(SNIPPET)).toBeVisible();
    await expect(page.locator('.code-snippet__header--language-only')).toBeVisible();
    await expect(page.locator('.code-snippet__language')).toHaveText('HTML');
  });

  test('the snippet survives a refresh — rendering does not depend on transient frontend-only state', async ({ page }) => {
    await configureCodeSnippetInterview(page);
    await goToQuestionWithSnippet(page, true);
    await expect(page.locator(SNIPPET)).toBeVisible();

    await page.reload();
    await expect(page.locator('.interview-question-box')).toBeVisible();
    await expect(page.locator(SNIPPET)).toBeVisible();
    await expect(page.locator('.code-snippet__filename')).toHaveText('code.ts');
    await expect(page.locator('.code-snippet__code')).toContainText('codeSignal');
  });

  test('post-submission Review shows the same snippet, correct filename/language, with the explanation now visible', async ({ page }) => {
    await configureCodeSnippetInterview(page);

    for (let i = 1; i <= 10; i++) {
      await page.locator('.io-option').first().click();
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    await page.locator('button:has-text("Submit Assessment")').last().click();
    await page.waitForURL(RESULTS_URL);

    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('app-interview-review')).toHaveCount(1, { timeout: 30_000 });

    const tsItem = page.locator('.rv-item').filter({ has: page.locator('.code-snippet__filename') });
    await expect(tsItem).toHaveCount(1);
    await expect(tsItem.locator(SNIPPET)).toBeVisible();
    await expect(tsItem.locator('.code-snippet__filename')).toHaveText('code.ts');
    await expect(tsItem.locator('.code-snippet__language')).toHaveText('TypeScript');
    await expect(tsItem.locator('.rv-explanation')).toContainText(/code-1 unlocks whatsit feature 1/i);
  });

  test('an HTML snippet containing a <script> payload never executes it — proven at the browser level', async ({ page }) => {
    await page.goto('about:blank');
    expect(await page.evaluate(() => (window as any).__CODE_SNIPPET_E2E_XSS__)).toBeUndefined();

    await gotoQuestion(page, 'fixture-whatsits', 2);
    await expect(page.locator(SNIPPET)).toBeVisible();

    await expect(page.locator(`${SNIPPET} .code-snippet__code`)).toContainText(
      '<script>window.__CODE_SNIPPET_E2E_XSS__ = true;</script>'
    );
    expect(await page.locator(`${SNIPPET} script`).count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__CODE_SNIPPET_E2E_XSS__)).toBeUndefined();
  });
});

test.describe('Code snippet — accessibility & responsive', () => {
  test('exposes pre/code semantics, a focusable scroll region, a non-interactive header, and selectable code', async ({ page }) => {
    await gotoQuestion(page, 'fixture-whatsits', 1);
    const snippet = page.locator(SNIPPET);

    await expect(snippet.locator('pre.code-snippet__pre')).toHaveCount(1);
    await expect(snippet.locator('code.code-snippet__code')).toHaveCount(1);
    await expect(snippet.locator('pre.code-snippet__pre')).toHaveAttribute('tabindex', '0');

    const header = snippet.locator('.code-snippet__header');
    await expect(header.locator('button, a, [role="button"]')).toHaveCount(0);

    const userSelect = await snippet
      .locator('.code-snippet__code')
      .evaluate((el) => getComputedStyle(el).userSelect);
    expect(userSelect).not.toBe('none');
  });

  test('on a mobile viewport, the code block is contained: no page-level horizontal overflow, its own pre scrolls horizontally, and options stay usable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoQuestion(page, 'fixture-whatsits', 1);
    await expect(page.locator(SNIPPET)).toBeVisible();

    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);

    const preOverflowX = await page
      .locator('.code-snippet__pre')
      .evaluate((el) => getComputedStyle(el).overflowX);
    expect(preOverflowX).toBe('auto');

    const firstOption = page.locator('.option-row').first();
    await expect(firstOption).toBeVisible();
    await firstOption.click();
    await expect(firstOption).toHaveClass(/correct-option|incorrect-option/);
  });
});
