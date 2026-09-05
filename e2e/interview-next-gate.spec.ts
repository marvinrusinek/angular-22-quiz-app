import { test, expect, Page } from '@playwright/test';

/**
 * Forward-navigation gate for Interview Mode.
 *
 * Next (the paginator button AND the ArrowRight key) is enabled only once the
 * current question has an answer. Both read ONE condition —
 * InterviewSessionService#canNavigateNext — so they can never disagree.
 *
 * The rule is deliberately "at least one option selected", for every question
 * type. It must NOT require a multi-select's selection count to match the number
 * of correct answers: a user could then probe Next to discover the hidden
 * correct-answer count, which the assessment never reveals before submission.
 *
 * Previous and direct numeric page jumps stay OPEN so users can skip, review and
 * come back.
 */

const NEXT = '.pg-next';
const PREV = '.pg-prev';
const OPTION = '.io-input';
const PROGRESS = '.interview-progress';

async function configureAndStart(page: Page, difficulty = 'Beginner', count = '10') {
  await page.goto('/interview');
  await page.locator(`.chip:has-text("${difficulty}")`).first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  // Use the builder's own Select All rather than ticking each box: choosing a
  // difficulty re-renders the topic list, so a loop over a captured count can
  // click an element that has just been replaced.
  await page.locator('.topics-toolbar button:has-text("Select All")').click();
  await expect(boxes.first()).toBeChecked();
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  // The session route carries the backend session id.
  await page.waitForURL(/\/interview\/session\/[^/?#]+/);
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

/** Arrow keys only navigate when focus is OUTSIDE a form control. */
async function pressArrow(page: Page, key: 'ArrowRight' | 'ArrowLeft') {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
}

const position = (page: Page) =>
  page.locator(PROGRESS).textContent().then((t) => (t ?? '').replace(/\s+/g, ' ').trim());

test.describe('Interview Mode — Next gating', () => {
  test('1. Next button and ArrowRight are both blocked on an untouched question', async ({ page }) => {
    await configureAndStart(page);
    const start = await position(page);

    await expect(page.locator(NEXT)).toBeDisabled();

    await pressArrow(page, 'ArrowRight');
    expect(await position(page)).toBe(start);
  });

  test('2. selecting one option enables both the button and ArrowRight', async ({ page }) => {
    await configureAndStart(page);
    const start = await position(page);

    await page.locator(OPTION).first().check({ force: true });
    await expect(page.locator(NEXT)).toBeEnabled();

    await pressArrow(page, 'ArrowRight');
    await expect(page.locator(PROGRESS)).toContainText('Question 2');
    expect(await position(page)).not.toBe(start);

    // and the button works too, from the next question
    await page.locator(OPTION).first().check({ force: true });
    await page.locator(NEXT).click();
    await expect(page.locator(PROGRESS)).toContainText('Question 3');
  });

  test('3. a multi-select question enables Next after ONE selection (count never exposed)', async ({ page }) => {
    // Advanced quizzes carry the multi-answer questions. The synthetic E2E bank's
    // entire Advanced pool is 20 questions (fixture-gizmos + fixture-thingamajigs),
    // so requesting all 20 guarantees every Advanced question — including its two
    // multi-answer ones — is included, rather than sampling toward one.
    await configureAndStart(page, 'Advanced', '20');

    let found = false;
    for (let i = 0; i < 20; i++) {
      const isMulti = await page.locator('.io-input[type="checkbox"]').count() > 0;

      if (isMulti) {
        found = true;
        const optionCount = await page.locator(OPTION).count();
        const before = await position(page);

        await expect(page.locator(NEXT)).toBeDisabled();

        // ONE selection is enough — no need to match the correct-answer count.
        await page.locator(OPTION).first().check({ force: true });
        await expect(page.locator(NEXT)).toBeEnabled();

        // Nothing on screen may reveal how many answers are correct.
        const boxText = ((await page.locator('.interview-question-box').textContent()) ?? '')
          .replace(/\s+/g, ' ');
        expect(boxText).not.toMatch(/\d+\s+(answers?|correct)/i);
        expect(boxText).toMatch(/Select all that apply/i);

        // still only one box ticked, and Next really does advance
        const checked = await page.locator(`${OPTION}:checked`).count();
        expect(checked).toBe(1);
        expect(checked).toBeLessThan(optionCount);

        const nextNumber = Number((before.match(/Question (\d+)/) ?? [])[1]) + 1;
        await page.locator(NEXT).click();
        // auto-retrying: the index updates via a signal, not synchronously
        await expect(page.locator(PROGRESS)).toContainText(`Question ${nextNumber}`);
        break;
      }

      await page.locator(OPTION).first().check({ force: true });
      await page.locator(NEXT).click();
      await page.waitForTimeout(150);
    }

    expect(found).toBe(true);
  });

  test('4. direct numeric page navigation still works while Next is gated', async ({ page }) => {
    await configureAndStart(page);

    // Untouched question: Next is gated, but jumping is not.
    await expect(page.locator(NEXT)).toBeDisabled();

    // The paginator renders a WINDOW (first, last, ±2 around current), so at Q1
    // only 1–3 and the last page exist. Jump to the last page directly.
    const lastPage = page.locator('.pg-page').last();
    await expect(lastPage).toBeEnabled();
    await lastPage.click();
    await expect(page.locator(PROGRESS)).toContainText('Question 10');

    // ...and back to the first, still without answering anything.
    await page.locator('.pg-page').first().click();
    await expect(page.locator(PROGRESS)).toContainText('Question 1');
  });

  test('5. Previous navigation remains available on an unanswered question', async ({ page }) => {
    await configureAndStart(page);

    // Move forward via a page jump (no answers given), then come back.
    // Target by aria-label: the numeric buttons carry surrounding whitespace, so
    // a /^3$/ text match doesn't hit them.
    await page.getByRole('button', { name: /^Go to question 3,/ }).click();
    await expect(page.locator(PROGRESS)).toContainText('Question 3');

    await expect(page.locator(NEXT)).toBeDisabled();   // still unanswered
    await expect(page.locator(PREV)).toBeEnabled();    // but Prev is open

    await page.locator(PREV).click();
    await expect(page.locator(PROGRESS)).toContainText('Question 2');

    // ArrowLeft works too — a mis-press can never trap you.
    await pressArrow(page, 'ArrowLeft');
    await expect(page.locator(PROGRESS)).toContainText('Question 1');
  });
});
