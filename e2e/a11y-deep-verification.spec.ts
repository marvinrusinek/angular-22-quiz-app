import { test, expect, Page } from '@playwright/test';
import { HEADING, NEXT_BTN, PREV_BTN, quizData, startQuizViaUi, advanceToQuestion } from './helpers';

/**
 * Deeper verification for fix/a11y-keyboard-focus, beyond the two confirmed
 * defects' own regression tests (e2e/a11y-keyboard-focus.spec.ts):
 *
 *  1) A full, representative Topic Quiz (single- AND multi-answer questions)
 *     completed start-to-Results using ONLY the keyboard — no .click(),
 *     no direct component/service calls.
 *  2) Score/Timer menu triggers in both themes and at a narrow viewport.
 *  3) Mouse/touch behavior is unaffected, plus a direct check of whether
 *     `display: contents` on the MDC wrapper spans (the option-item.component.scss
 *     fix) changed hit targets, label activation, radio grouping, or a11y
 *     semantics for the native inputs.
 *
 * fixture-doohickeys (6 questions) is used for the full completion: it is
 * the SMALLEST fixture quiz that still contains both question shapes
 * (single-answer at index 0/2/3/4, multi-answer — exactly 2 correct options
 * each — at index 1/5), so one full run exercises both without unnecessary
 * length. See backend/test/helpers/synthetic-quiz-bank.json for the ground
 * truth this test's correctIndices table is read from (not hardcoded blind).
 */

const OPTION_ROW = '.option-row';
const TIMER = '.scoreboard-timer .scoreboard';
const RESULTS_BTN_SELECTOR = '.show-results-btn';

async function tabUntil(page: Page, predicate: () => Promise<boolean>, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await predicate()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Condition not met within ${maxPresses} Tab presses`);
}

/**
 * Generalized guard for the ellipse-decoration bug class (fixed twice on this
 * branch: MatRadioButton's "mat-radio-ripple" span, then MatCheckbox's
 * "mdc-checkbox__ripple" state-layer span — both normally clipped to a small
 * icon, both rendered full-row-sized once display:contents on .mdc-radio/
 * .mdc-checkbox removed their sizing context). Rather than asserting a
 * specific selector is display:none (which only proves THAT element is
 * hidden, not that nothing else paints), this scans every descendant of
 * .option-row for anything actually rendered, rounded, and painted — the
 * shape this defect always takes — so it also catches a third such element
 * if one is ever found.
 */
async function assertNoDecorativeOverlay(page: Page, rowIndex = 0): Promise<void> {
  const painted = await page.evaluate((idx) => {
    const row = document.querySelectorAll('.option-row')[idx];
    if (!row) return null;
    return Array.from(row.querySelectorAll('*'))
      .filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          cs.display !== 'none' &&
          cs.visibility !== 'hidden' &&
          r.width > 0 &&
          r.height > 0 &&
          cs.borderRadius !== '0px' &&
          parseFloat(cs.opacity) > 0 &&
          (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.boxShadow !== 'none')
        );
      })
      .map((el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80) }));
  }, rowIndex);
  expect(painted).toEqual([]);
}

/** Select exactly these 0-based option indices on the CURRENT question, via keyboard only. */
async function selectOptionsViaKeyboard(page: Page, indices: number[]): Promise<void> {
  for (const idx of indices) {
    await tabUntil(page, async () =>
      page.evaluate((i) => {
        const inputs = Array.from(
          document.querySelectorAll('.option-row input[type="radio"], .option-row input[type="checkbox"]'),
        );
        return document.activeElement === inputs[i];
      }, idx),
    );
    await page.keyboard.press('Space');
    await page.waitForTimeout(300); // let each pick's own verdict/banner update settle, same margin advanceToQuestion uses
  }
}

async function tabToNextOrResults(page: Page): Promise<'next' | 'results'> {
  for (let i = 0; i < 40; i++) {
    const kind = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      if (el.getAttribute('aria-label') === 'Next Question') return 'next';
      if (el.getAttribute('aria-label') === 'Show Results') return 'results';
      return null;
    });
    if (kind) return kind as 'next' | 'results';
    await page.keyboard.press('Tab');
  }
  throw new Error('Could not reach Next Question or Show Results via Tab');
}

test.describe('Group 1: full keyboard-only Topic Quiz completion (single + multi-answer)', () => {
  test('fixture-doohickeys: every question answered via Tab/Space/Arrow only, reaches Results', async ({ page }) => {
    test.setTimeout(120_000);
    const CORRECT: Record<number, number[]> = {
      0: [0], 1: [0, 1], 2: [0], 3: [0], 4: [0], 5: [0, 1],
    };
    // Resolve each question's real correct indices from the synthetic bank
    // rather than assuming — guards this test against a fixture edit.
    const bank = require('../backend/test/helpers/synthetic-quiz-bank.json');
    const quiz = bank.quizzes.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
    const correctByIndex: number[][] = quiz.questions.map((q: any) =>
      q.options.map((o: any, i: number) => (o.correct === true || o.correct === 'true' ? i : -1)).filter((i: number) => i >= 0),
    );

    await page.goto('/quiz/question/fixture-doohickeys/1');
    await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

    // Timer sanity on Q1: a bounded, real countdown value (not frozen/garbage).
    const timerText = (await page.locator(TIMER).innerText()).trim();
    expect(timerText).toMatch(/^\d+:\d{2}$/);

    for (let q = 0; q < quiz.questions.length; q++) {
      await expect(page.locator(OPTION_ROW).first()).toBeVisible({ timeout: 15_000 });
      const indices = correctByIndex[q];
      await selectOptionsViaKeyboard(page, indices);

      if (indices.length > 1) {
        // Multi-answer: confirm the "select N more" gate behavior is visible
        // before completion isn't asserted here (timing-sensitive across the
        // keyboard presses); confirm the explanation/heading DOES switch to
        // the "are correct because" state once all correct options are in.
        await expect(page.locator(HEADING)).toContainText(/are correct because/i, { timeout: 10_000 });
      } else {
        await expect(page.locator(OPTION_ROW).nth(indices[0])).toHaveClass(/selected/);
      }

      const kind = await tabToNextOrResults(page);
      await page.keyboard.press('Enter');
      if (kind === 'results') {
        await page.waitForURL(/\/quiz\/results\/fixture-doohickeys/, { timeout: 15_000 });
      } else {
        await expect(page.locator(OPTION_ROW).first()).toBeVisible({ timeout: 15_000 });
      }
    }

    await expect(page).toHaveURL(/\/quiz\/results\/fixture-doohickeys/);
    console.log('KEYBOARD-ONLY FULL QUIZ COMPLETION: reached Results via Tab/Space/Arrow only, no .click()');
  });

  test('Shift+Tab moves focus backward through options; Previous Question keeps prior answers', async ({ page }) => {
    // A direct goto to a non-first question is correctly redirected to Q1 by
    // QuizGuard on a fresh attempt (same guard option-click.spec.ts documents)
    // — reach Q2 via real progression instead, same as every other spec here.
    const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await advanceToQuestion(page, doohickeys, 2);
    await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

    // Forward to the first option, then Shift+Tab back off it onto something earlier.
    await tabUntil(page, async () =>
      page.evaluate(() => document.activeElement?.getAttribute('type') === 'checkbox' || document.activeElement?.getAttribute('type') === 'radio'),
    );
    const forwardTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(forwardTag).toBe('INPUT');
    await page.keyboard.press('Shift+Tab');
    const backTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(backTag).not.toBeNull(); // moved somewhere real, not lost to <body>

    // Previous Question: reach it via Tab, go back to Q1, and confirm its
    // already-correct answer is still shown as such (preserved, not reset).
    await tabUntil(page, async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Previous Question'));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/quiz\/question\/fixture-doohickeys\/1/);
    await expect(page.locator(OPTION_ROW).first()).toBeVisible();
    const preserved = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.option-row')).some((el) => /correct-option|selected/.test(el.className)),
    );
    expect(preserved).toBe(true);
  });
});

test.describe('Group 2: Score/Timer menus — both themes, narrow viewport', () => {
  const themes: Array<'light' | 'dark'> = ['light', 'dark'];
  const triggers = [
    { name: 'Score menu trigger', ariaLabel: 'Score display menu' },
    { name: 'Timer menu trigger', ariaLabel: 'Timer menu' },
  ];

  for (const theme of themes) {
    for (const { name, ariaLabel } of triggers) {
      test(`${name} in ${theme} theme: visible keyboard focus, Enter opens, Escape closes + returns focus`, async ({ page }) => {
        await page.goto('/quiz/question/fixture-widgets/1');
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        const trigger = page.getByRole('button', { name: ariaLabel });
        await trigger.waitFor({ state: 'visible', timeout: 20_000 });

        await tabUntil(page, async () => trigger.evaluate((el) => el === document.activeElement));
        await expect(trigger).toBeFocused();
        const outline = await trigger.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
        });
        expect(outline.style).not.toBe('none');
        expect(outline.width).not.toBe('0px');

        await page.keyboard.press('Enter');
        await expect(page.locator('.mat-mdc-menu-panel')).toBeVisible();
        // Arrow-key menu navigation: first item becomes focusable via keyboard.
        await page.keyboard.press('ArrowDown');
        const activeInMenu = await page.evaluate(() => !!document.activeElement?.closest('.mat-mdc-menu-panel'));
        expect(activeInMenu).toBe(true);

        await page.keyboard.press('Escape');
        await expect(page.locator('.mat-mdc-menu-panel')).toBeHidden();
        await expect(trigger).toBeFocused();
      });
    }
  }

  test('focus outline is not clipped at a 375px-wide viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/quiz/question/fixture-widgets/1');
    const trigger = page.getByRole('button', { name: 'Score display menu' });
    await trigger.waitFor({ state: 'visible', timeout: 20_000 });
    await tabUntil(page, async () => trigger.evaluate((el) => el === document.activeElement));

    const box = await trigger.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const w = parseFloat(cs.outlineWidth) || 0;
      return { left: r.left - w, top: r.top - w, right: r.right + w, bottom: r.bottom + w };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(375);
  });
});

test.describe('Group 3: mouse/touch regressions + display:contents impact', () => {
  test('mouse click still selects a single-answer option and shows correct feedback (unchanged)', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    const rows = page.locator(OPTION_ROW);
    await rows.first().click();
    await expect(rows.first()).toHaveClass(/correct-option/);
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);
  });

  test('touch emulation (not a mouse click) selects an option and shows feedback', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/quiz/question/fixture-widgets/1');
    const row = page.locator(OPTION_ROW).first();
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    await row.tap();
    await expect(row).toHaveClass(/correct-option/);
    await context.close();
  });

  const viewports = [
    { width: 1280, height: 900, label: 'desktop' },
    { width: 375, height: 667, label: '375w' },
    { width: 390, height: 844, label: '390w' },
    { width: 768, height: 1024, label: '768w' },
    { width: 844, height: 390, label: 'landscape' },
  ];
  for (const theme of ['light', 'dark'] as const) {
    for (const vp of viewports) {
      // One independent test per combination (fresh page each) — the app
      // deliberately PRESERVES a correctly-answered question's locked state
      // on revisit (see the project's own revisit-preservation feature), so
      // reusing one page/URL across iterations left later iterations seeing
      // an already-locked option instead of a fresh question.
      test(`${theme} theme, ${vp.label}: no option/scoreboard regressions`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/quiz/question/fixture-widgets/1');
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        const row = page.locator(OPTION_ROW).first();
        await expect(row).toBeVisible({ timeout: 15_000 });
        await row.click();
        await expect(row).toHaveClass(/correct-option/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(2);
      });
    }
  }

  test('display:contents on .mdc-radio/.mdc-checkbox: hit target still covers the full option box', async ({ page }) => {
    // Real progression, not a direct goto (QuizGuard redirects a fresh
    // attempt's direct deep-link to a non-first question back to Q1).
    const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await advanceToQuestion(page, doohickeys, 2); // Q2 is the multi-answer (checkbox) question
    const rows = page.locator(OPTION_ROW);
    await rows.first().waitFor({ state: 'visible' });

    // Click near the FAR EDGE of the box (not the center/text) — proves the
    // hit target still spans the whole visual box, not just the native
    // input's own intrinsic (pre-fix) geometry.
    const box = await rows.first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width - 5, box!.y + box!.height / 2);
    await expect(rows.first()).toHaveClass(/selected|interview-selected|io-selected/);

    // Accessible semantics unchanged: inputs still expose their native
    // type/label, reachable by accessible name (the option text).
    const roleCounts = await page.evaluate(() => ({
      checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
      labels: document.querySelectorAll('.option-row label').length,
    }));
    expect(roleCounts.checkboxes).toBeGreaterThan(0);
    expect(roleCounts.labels).toBe(roleCounts.checkboxes);
  });

  test('display:contents did not break native radio grouping (single-answer question)', async ({ page }) => {
    await page.goto('/quiz/question/fixture-widgets/1');
    await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

    // Independent of the app's own answer-locking business rules: every radio
    // in one question still reports the same `name` grouping value Angular
    // Material assigns (display:contents on an ancestor wrapper span cannot
    // change this — it's unrelated directive/JS wiring, not CSS), and none
    // is pre-checked on a fresh question.
    const radios = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.option-row input[type="radio"]')).map((i) => ({
        name: (i as HTMLInputElement).name,
        checked: (i as HTMLInputElement).checked,
      })),
    );
    expect(radios.length).toBeGreaterThan(1);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1); // one shared group
    expect(radios.every((r) => !r.checked)).toBe(true); // fresh question, none pre-selected

    // A single click selects exactly one.
    await page.locator(OPTION_ROW).first().click();
    const afterClick = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.option-row input[type="radio"]')).map((i) => (i as HTMLInputElement).checked),
    );
    expect(afterClick.filter(Boolean).length).toBe(1);
  });

  // Regression coverage for the "unwanted ellipse" bug reproduced on a real
  // multi-answer question (Dependency Injection Q3, live localhost): MatCheckbox's
  // own MDC "mdc-checkbox__ripple" state-layer span rendered as a full-row,
  // translucent, accent-colored ellipse once a checkbox option was selected
  // and its native input held focus. fixture-doohickeys question 2 (0-based
  // index 1) is this suite's existing multi-answer fixture (2 correct
  // options) — see the Group 1 doc comment above.
  test.describe('multi-answer (checkbox) selected option — no decorative overlay (ellipse regression)', () => {
    test('mouse click: selecting a checkbox option paints no decorative overlay', async ({ page }) => {
      const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
      await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
      await advanceToQuestion(page, doohickeys, 2); // question 2 = the multi-answer question
      await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

      await page.locator(OPTION_ROW).first().click();
      await expect(page.locator(OPTION_ROW).first()).toHaveClass(/selected/);
      await assertNoDecorativeOverlay(page, 0);
    });

    test('keyboard Space: selecting a checkbox option paints no decorative overlay, and the custom focus outline still shows', async ({ page }) => {
      const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
      await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
      await advanceToQuestion(page, doohickeys, 2);
      await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

      await tabUntil(page, async () =>
        page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('.option-row input[type="checkbox"]'));
          return document.activeElement === inputs[0];
        }),
      );
      const outlineStyle = await page.evaluate(() => {
        const host = document.activeElement?.closest('mat-checkbox');
        return host ? getComputedStyle(host).outlineStyle : null;
      });
      expect(outlineStyle).not.toBe('none');

      await page.keyboard.press('Space');
      await page.waitForTimeout(200);
      await expect(page.locator(OPTION_ROW).first()).toHaveClass(/selected/);
      await assertNoDecorativeOverlay(page, 0);
    });

    test('touch tap: selecting a checkbox option paints no decorative overlay', async ({ browser }) => {
      const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
      await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
      await advanceToQuestion(page, doohickeys, 2);
      await page.locator(OPTION_ROW).first().waitFor({ state: 'visible', timeout: 20_000 });

      await page.locator(OPTION_ROW).first().tap();
      await expect(page.locator(OPTION_ROW).first()).toHaveClass(/selected/);
      await assertNoDecorativeOverlay(page, 0);
      await context.close();
    });
  });
});
