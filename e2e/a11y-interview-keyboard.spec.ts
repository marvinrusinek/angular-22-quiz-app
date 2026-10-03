import { test, expect, Page } from '@playwright/test';
import { quizData, findQuestionIn, isCorrect, norm } from './helpers';

/**
 * Full keyboard-only Interview flow: Builder -> Session -> Results -> Export
 * Report, with no .click() anywhere.
 *
 * An earlier attempt at this test pressed Enter on every focused control,
 * including the Quick Setup / Difficulty chips. Those chips are REAL native
 * `<input type="radio">` elements inside a `<form (submit)="...startInterview()">`
 * (see build-your-interview.component.html's own comment: "The native event
 * keeps Enter-to-submit working"). Pressing Enter while a radio has focus
 * submits the nearest form in every browser — it triggered startInterview()
 * before Topics/Count were configured, which is what actually broke that
 * attempt. It was a test-script defect, not a product one: fixed here by
 * using the correct native keys per control —
 *   - radio chips (Quick Setup, Difficulty): Tab enters the group ONCE
 *     (landing on whichever is checked, or the first if none is); ArrowRight
 *     moves AND selects within the group. Enter is never sent to a radio.
 *   - checkboxes (Topics): each is its own Tab stop; Space toggles it.
 *   - real `<button type="button">` (Select All, count chips, io-option,
 *     pg-next, show-results-btn): Enter/Space both safely activate them.
 *   - the actual `<button type="submit" class="start-interview-btn">`:
 *     Enter here is the intended submit action.
 */

/**
 * Assessment Integrity Mode (a separate, pre-existing feature — see
 * assessment-integrity.service.ts) can pop its "Assessment focus lost" dialog
 * if the page's window blurs, which can happen running headless under heavy
 * background automation even with no real external focus change. It is
 * unrelated to this a11y fix; dismiss it the same way a real keyboard user
 * would (its "Return to Assessment" button is `cdkFocusInitial`, so Enter
 * dismisses it the instant it opens) rather than let it block the flow.
 * Checked on every tabUntil iteration since it can appear unpredictably
 * between any two keystrokes, not just at fixed call sites.
 */
async function dismissIntegrityDialogIfPresent(page: Page): Promise<boolean> {
  const dialog = page.getByRole('heading', { name: 'Assessment focus lost' });
  // Target the dialog's own button directly (`.press('Enter')` focuses it
  // first) rather than blindly sending Enter to "whatever currently has
  // focus": MatDialog's cdkFocusInitial trap can lag its DOM insertion by a
  // tick, and a blind Enter in that gap can land on the PAGE's own focused
  // control instead (observed: it hit the session's "Enter Full Screen"
  // button, which then caused repeated fullscreen enter/exit cycles — each
  // one its own integrity event — compounding the problem instead of
  // clearing it). Not asserting it stays closed: under heavy background
  // load the window blur/visibilitychange that opens it can repeat — the
  // caller (tabUntil) does not count a dismiss against its own retry budget
  // so a flurry of these never by itself exhausts a Tab search.
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Return to Assessment' }).press('Enter');
    await page.waitForTimeout(100);
    return true;
  }
  return false;
}

async function tabUntil(page: Page, predicate: () => Promise<boolean>, maxPresses = 60): Promise<void> {
  let presses = 0;
  // A dialog dismiss doesn't advance Tab order and isn't a failed search
  // attempt, so it's retried without spending the Tab-press budget — a
  // flurry of reopens (observed under heavy background load) would
  // otherwise exhaust maxPresses without this search ever truly failing.
  let dismissals = 0;
  const maxDismissals = maxPresses * 3;
  while (presses < maxPresses) {
    if (await dismissIntegrityDialogIfPresent(page)) {
      dismissals++;
      if (dismissals > maxDismissals) {
        throw new Error(`Assessment Integrity dialog reopened ${dismissals} times without this Tab search ever proceeding`);
      }
      continue;
    }
    if (await predicate()) return;
    await page.keyboard.press('Tab');
    presses++;
  }
  const diag = await page.evaluate(() => ({
    url: location.href,
    progress: document.querySelector('.interview-progress')?.textContent?.trim(),
    answered: document.querySelector('.ai-answered-count, [class*="answered"]')?.textContent?.trim(),
    activeTag: document.activeElement?.tagName,
    activeText: (document.activeElement?.textContent || '').trim().slice(0, 80),
    activeAria: document.activeElement?.getAttribute('aria-label'),
  }));
  console.log('TABUNTIL TIMEOUT DIAG:', JSON.stringify(diag));
  throw new Error(`Condition not met within ${maxPresses} Tab presses`);
}

/** Every real key-activation goes through here: dismiss the (unrelated, load-dependent) integrity dialog first if it reopened right before this exact keystroke. */
async function pressKey(page: Page, key: string): Promise<void> {
  await dismissIntegrityDialogIfPresent(page);
  await page.keyboard.press(key);
}

test.describe('Full keyboard-only Interview flow', () => {
  test('Builder -> Session -> Results -> Export Report, keyboard only', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/interview');
    await page.locator('.chip:has-text("Beginner")').first().waitFor({ state: 'visible' });

    // Quick Setup radiogroup: Tab lands on "Custom" (already checked, the
    // default) — confirmed via the input's own checked state, no key sent.
    await tabUntil(page, async () =>
      page.evaluate(() => (document.activeElement as HTMLInputElement)?.closest('label.chip')?.textContent?.includes('Custom') ?? false),
    );
    const customChecked = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.checked);
    expect(customChecked).toBe(true);

    // Difficulty radiogroup: Tab lands on "Beginner" focused but, since
    // nothing in this native radiogroup is checked by default, NOT selected.
    // ArrowRight both moves to AND selects "Intermediate" — this is what
    // actually makes a real selection here, not an optional extra proof.
    // No Enter involved (a radio's own activation key is Space/Arrow).
    await pressKey(page, 'Tab');
    const landedOnDifficulty = await page.evaluate(() =>
      (document.activeElement as HTMLInputElement)?.closest('.option-row[role="radiogroup"]')?.getAttribute('aria-label'),
    );
    expect(landedOnDifficulty).toBe('Difficulty');
    await pressKey(page, 'ArrowRight');
    const afterArrow = await page.evaluate(() => ({
      checked: (document.activeElement as HTMLInputElement)?.checked,
      label: (document.activeElement as HTMLInputElement)?.closest('label.chip')?.textContent?.trim(),
    }));
    expect(afterArrow.checked).toBe(true);
    expect(afterArrow.label).toBe('Intermediate');

    // Topics: reach "Select All" (a real button, Enter is safe) via Tab.
    const boxes = page.locator('.topic-check input[type="checkbox"]');
    await expect(boxes.first()).toBeVisible();
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Select All'));
    await pressKey(page, 'Enter');
    await expect(boxes.first()).toBeChecked();

    // Question count: a real <button>, Enter is safe.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === '10'));
    await pressKey(page, 'Enter');

    // Start Interview: the actual submit button — Enter is the intended action.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('start-interview-btn')));
    await expect(page.locator('.start-interview-btn')).toBeEnabled();
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/session\/[^/?#]+/, { timeout: 20_000 });
    await expect(page.locator('.interview-question-box')).toBeVisible();

    // Answer all 10 questions via keyboard only (Tab to the option, Space,
    // Tab to Next, Enter — io-option/pg-next are real buttons).
    for (let i = 1; i <= 10; i++) {
      await dismissIntegrityDialogIfPresent(page);
      await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.closest('.io-option') !== null));
      const optionOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      expect(optionOutline).not.toBe('none'); // visible focus on the option itself
      await pressKey(page, 'Space');
      await expect(page.locator('.io-option').first()).toHaveClass(/io-selected/);
      if (i < 10) {
        await dismissIntegrityDialogIfPresent(page);
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('pg-next')));
        await pressKey(page, 'Enter');
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    // Submit: Show Results -> confirmation dialog -> Submit Assessment, all
    // real buttons, Enter is safe throughout.
    await dismissIntegrityDialogIfPresent(page);
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('show-results-btn')));
    await pressKey(page, 'Enter');
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    // Two elements share this text now: the page's own (disabled-looking)
    // button behind the dialog, and the dialog's real confirm button — the
    // same ambiguity interview-report.spec.ts's helper disambiguates with
    // `.last()`. `.press('Enter')` focuses this exact element first, so it's
    // still a real keyboard activation, just an unambiguous one.
    await dismissIntegrityDialogIfPresent(page);
    await page.locator('button:has-text("Submit Assessment")').last().press('Enter');
    await page.waitForURL(/\/interview\/results\/[^/?#]+/, { timeout: 20_000 });

    // Results: Export Report reachable, visible focus, Enter opens it.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Export Report'));
    const exportOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(exportOutline).not.toBe('none');
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/report\/[^/?#]+/, { timeout: 20_000 });

    // Export Report: heading receives focus automatically on route arrival
    // (already covered by interview-report.spec.ts's click-driven flow; this
    // confirms it's also true for a keyboard-only arrival).
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeFocused();
    await expect(page.locator('article.rv-item')).toHaveCount(10);

    // Back to Results via keyboard, closing the loop.
    await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Back to Results'));
    await pressKey(page, 'Enter');
    await page.waitForURL(/\/interview\/results\/[^/?#]+/, { timeout: 20_000 });

    console.log('FULL KEYBOARD-ONLY INTERVIEW FLOW: Builder -> Session -> Results -> Export Report -> Results, no mouse used');
  });
});

/**
 * Review Answers (embedded in Results, toggled open by the "Review Answers"
 * button — see interview-results.component.html — not a separate route) with
 * all three outcomes: correct, incorrect, and unanswered. Interview options
 * are shuffled at render (see array-utils.ts's one shared shuffleArray, used
 * by both Topic Quiz and Interview Mode), so the correct/incorrect option for
 * each question is resolved by matching the rendered option TEXT against the
 * same synthetic bank the backend serves — never a hardcoded index.
 */
function findQuestionAcrossTopics(headingText: string): any {
  for (const quiz of quizData) {
    const q = findQuestionIn(quiz, headingText);
    if (q) return q;
  }
  return null;
}

/**
 * Answers (or adds to) the CURRENT question via keyboard, picking an option
 * whose visible text matches a correct (wantCorrect=true) or incorrect
 * (false) option from the bank. For a correct pick on a multi-select
 * question every correct option is selected; for incorrect, one wrong pick
 * is enough to miss the exact required set.
 */
/** Reads the text + checked state of the .io-option containing the CURRENTLY focused .io-input, or null if focus isn't on one. */
async function focusedOptionState(page: Page): Promise<{ text: string; checked: boolean } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.classList.contains('io-input')) return null;
    const option = el.closest('.io-option');
    const input = option?.querySelector('.io-input') as HTMLInputElement | null;
    const text = (option?.querySelector('.io-text')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return { text, checked: !!input?.checked };
  });
}

/**
 * Answers (or adds to) the CURRENT question via keyboard, picking option(s)
 * whose visible text match a correct (wantCorrect=true) or incorrect
 * (false) entry from the bank. Single-select questions render native
 * `<input type="radio" name="interview-answer">` — ALL sharing that one
 * name, so (same native-grouping behavior as the Topic Quiz and the
 * builder's Difficulty/Quick-Setup chips) Tab enters the group only ONCE,
 * landing on whichever is checked or the first if none is; ArrowDown both
 * moves AND selects within it. Multi-select renders independent checkboxes,
 * each its own Tab stop, Space toggles. The type is read off the first
 * reached input rather than assumed.
 */
async function answerQuestionViaKeyboard(page: Page, wantCorrect: boolean): Promise<void> {
  const headingText = (await page.locator('.interview-question-box h3').first().textContent()) ?? '';
  const q = findQuestionAcrossTopics(headingText);
  if (!q) throw new Error(`No synthetic-bank match for interview question heading: "${headingText}"`);
  const wantedTexts = (q.options as any[]).filter((o) => isCorrect(o) === wantCorrect).map((o: any) => norm(o.text));
  if (wantedTexts.length === 0) {
    throw new Error(`Question has no ${wantCorrect ? 'correct' : 'incorrect'} option to pick: "${headingText}"`);
  }

  await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('io-input') ?? false));
  const inputType = await page.evaluate(() => (document.activeElement as HTMLInputElement)?.type);

  if (inputType === 'radio') {
    // One Tab stop total for the whole group — cycle with ArrowDown, which
    // selects as it moves, until the focused option's text is wanted.
    for (let i = 0; i < 10; i++) {
      const state = await focusedOptionState(page);
      if (state && wantedTexts.includes(state.text)) {
        if (!state.checked) await pressKey(page, 'Space'); // select the focused-but-not-yet-selected match
        await page.waitForTimeout(150); // let the answer-save settle (Next stays disabled, hence untabbable, until it does)
        return;
      }
      await pressKey(page, 'ArrowDown'); // moves AND selects the next option — re-checked against wantedTexts next loop
    }
    throw new Error(`Could not reach a wanted (${wantCorrect ? 'correct' : 'incorrect'}) radio option for: "${headingText}"`);
  }

  // Checkbox group: each option is its own independent Tab stop.
  const picksNeeded = wantCorrect ? wantedTexts.length : 1;
  for (let picked = 0; picked < picksNeeded; picked++) {
    await tabUntil(page, async () => {
      const state = await focusedOptionState(page);
      return !!state && !state.checked && wantedTexts.includes(state.text);
    });
    await pressKey(page, 'Space');
    await page.waitForTimeout(150); // let the answer-save settle before the next pick/Tab search
  }
}

test.describe('Interview Review — all three outcomes, keyboard only', () => {
  for (const vp of [
    { width: 1280, height: 900, label: 'desktop' },
    { width: 375, height: 667, label: '375w' },
  ]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`Builder -> Session -> Results -> Review -> Results -> Export Report, keyboard only (${theme}, ${vp.label})`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/interview');
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.locator('.chip:has-text("Beginner")').first().waitFor({ state: 'visible' });

        await tabUntil(page, async () =>
          page.evaluate(() => (document.activeElement as HTMLInputElement)?.closest('label.chip')?.textContent?.includes('Custom') ?? false),
        );
        // Into Difficulty: Tab lands on "Beginner" focused but, since nothing
        // in this native radiogroup is checked yet, NOT selected (confirmed
        // via screenshot while drafting this test — the Topics section stays
        // disabled, "Select a difficulty to choose topics", until one really
        // is). Space selects the focused one.
        await pressKey(page, 'Tab');
        await pressKey(page, 'Space');
        expect(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.checked)).toBe(true);

        const boxes = page.locator('.topic-check input[type="checkbox"]');
        await expect(boxes.first()).toBeVisible();
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Select All'));
        await pressKey(page, 'Enter');
        await expect(boxes.first()).toBeChecked();

        await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === '10'));
        await pressKey(page, 'Enter');

        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('start-interview-btn')));
        await pressKey(page, 'Enter');
        await page.waitForURL(/\/interview\/session\/[^/?#]+/, { timeout: 20_000 });
        await expect(page.locator('.interview-question-box')).toBeVisible();

        // Q1: flag it ("Mark for Review" — a real button, Enter is safe, and
        // per the component's own doc comment never answers/scores anything),
        // then answer correctly. Its textContent also carries the mat-icon's
        // own ligature text ("outlined_flag") before the visible label, so
        // this matches by tag + substring rather than an exact string.
        await tabUntil(page, async () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.tagName === 'BUTTON' && (el.textContent || '').includes('Mark for Review');
          }),
        );
        await pressKey(page, 'Enter');
        await answerQuestionViaKeyboard(page, true);
        await expect(page.locator('.pg-next')).toBeEnabled({ timeout: 10_000 });
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('pg-next')));
        await pressKey(page, 'Enter');
        await expect(page.locator('.interview-progress')).toContainText('Question 2');

        // Q2 correct, Q3-4 incorrect, Q5 left unanswered (skipped via the
        // paginator, since Next is gated on the CURRENT question having an
        // answer), Q6 correct, Q7 incorrect, Q8 correct, Q9 incorrect, Q10
        // (last question, no Next button) left unanswered.
        const plan: Array<'correct' | 'incorrect' | 'skip'> = [
          'correct', 'incorrect', 'incorrect', 'skip', 'correct', 'incorrect', 'correct', 'incorrect', 'skip',
        ];
        for (let i = 0; i < plan.length; i++) {
          const questionNum = i + 2; // plan[0] is Q2
          const step = plan[i];
          if (step !== 'skip') {
            await answerQuestionViaKeyboard(page, step === 'correct');
          }
          const isLast = questionNum === 10;
          if (!isLast) {
            if (step === 'skip') {
              // Jump past the unanswered question via its own precise,
              // unambiguous paginator button (Next stays disabled here).
              await dismissIntegrityDialogIfPresent(page);
              await page.getByRole('button', { name: new RegExp(`^Go to question ${questionNum + 1},`) }).press('Enter');
            } else {
              // Next stays disabled (hence untabbable) until the just-saved
              // answer registers — wait for that explicitly rather than a
              // fixed delay, which a differently-themed render's extra
              // repaint cost can occasionally outrun.
              await expect(page.locator('.pg-next')).toBeEnabled({ timeout: 10_000 });
              await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('pg-next')));
              await pressKey(page, 'Enter');
            }
            await expect(page.locator('.interview-progress')).toContainText(`Question ${questionNum + 1}`);
          }
        }

        // Submit with 2 unanswered — the confirmation dialog permits it.
        await dismissIntegrityDialogIfPresent(page);
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('show-results-btn')));
        await pressKey(page, 'Enter');
        await expect(page.getByText('Submit Assessment?')).toBeVisible();
        await expect(page.getByText('Unanswered')).toBeVisible();
        await dismissIntegrityDialogIfPresent(page);
        await page.locator('button:has-text("Submit Assessment")').last().press('Enter');
        await page.waitForURL(/\/interview\/results\/[^/?#]+/, { timeout: 20_000 });

        const resultsScore = (await page.locator('.score-pct').innerText()).trim();

        // ── Enter Review from Results, via keyboard ──────────────────────
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Review Answers'));
        const reviewToggleOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
        expect(reviewToggleOutline).not.toBe('none'); // visible focus before activating it
        await pressKey(page, 'Enter');
        await expect(page.locator('app-interview-review')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Hide Review' })).toBeVisible();

        // Logical focus order: toggleReview() does no focus management
        // (checked in source — interview-results.component.ts), and the
        // template swaps the trigger for a DIFFERENT button element across
        // an @if/@else (not the same element with changing text) — so
        // activating "Review Answers" destroys that button and creates a
        // new "Hide Review" one, and the browser drops focus to <body> when
        // a focused element is removed from the DOM. Confirmed via this
        // test, not assumed: this is a real, minor rough edge (reported
        // separately — it does not BLOCK keyboard access, since Tab from
        // body still reaches the revealed content next, exercised
        // immediately below), not something to redesign here.
        const postToggleFocusTag = await page.evaluate(() => document.activeElement?.tagName);
        expect(postToggleFocusTag).toBe('BODY');

        // ── Filter toolbar: Angular Aria's ngToolbar (@angular/aria/toolbar,
        // a framework primitive, not a native radiogroup). Tab enters it
        // ONCE, landing on whichever is selected ("All" by default).
        // ArrowRight/ArrowLeft only MOVE focus (roving tabindex) — selection
        // is reported "on click/Enter/Space" per the component's own doc
        // comment on onFilterToolbarChange, so each move needs a following
        // Enter to actually activate it. Getting this wrong (assuming arrow
        // alone selects, like a native radiogroup) was caught by this test's
        // own aria-checked assertion staying false. DOM order (REVIEW_FILTERS):
        // All, Incorrect, Unanswered, Correct, Flagged — asserted explicitly
        // at each step rather than assumed. ──
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement as HTMLElement)?.classList?.contains('rv-filter')));
        const allFilterOutline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
        expect(allFilterOutline).not.toBe('none');
        let activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('All')).toBe(true);
        await expect(page.locator('article.rv-item')).toHaveCount(10);

        await pressKey(page, 'ArrowRight'); // -> focus Incorrect (not yet selected)
        activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('Incorrect')).toBe(true);
        await pressKey(page, 'Enter'); // -> select it
        await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-checked'))).toBe('true');
        await expect(page.locator('article.rv-item')).toHaveCount(4);

        await pressKey(page, 'ArrowRight'); // -> focus Unanswered
        await pressKey(page, 'Enter'); // -> select it
        activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('Unanswered')).toBe(true);
        await expect(page.locator('article.rv-item')).toHaveCount(2);
        await expect(page.locator('.rv-unanswered')).toHaveCount(2);

        await pressKey(page, 'ArrowRight'); // -> focus Correct
        await pressKey(page, 'Enter'); // -> select it
        activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('Correct')).toBe(true);
        await expect(page.locator('article.rv-item')).toHaveCount(4);

        await pressKey(page, 'ArrowRight'); // -> focus Flagged — exactly Q1, which this run flagged
        await pressKey(page, 'Enter'); // -> select it
        activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('Flagged')).toBe(true);
        await expect(page.locator('article.rv-item')).toHaveCount(1);
        await expect(page.locator('.rv-flag-badge')).toHaveCount(1);

        // ArrowLeft navigates backward through the same order (Space selects
        // here instead of Enter, to prove both activation keys work), landing
        // back on "All": question text, submitted answers, correct answers,
        // and explanations are present without any mouse interaction —
        // confirmed across every item, not just one.
        await pressKey(page, 'ArrowLeft'); // -> focus Correct
        await pressKey(page, 'ArrowLeft'); // -> focus Unanswered
        await pressKey(page, 'ArrowLeft'); // -> focus Incorrect
        await pressKey(page, 'ArrowLeft'); // -> focus All
        await pressKey(page, 'Space'); // -> select it
        activeFilterLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
        expect(activeFilterLabel.startsWith('All')).toBe(true);

        const items = page.locator('article.rv-item');
        await expect(items).toHaveCount(10);
        // Each article carries its status as a class directly
        // ([class]="'rv-status-' + item.status" in the component's own
        // template) — read that rather than pattern-match the rendered text.
        const statuses = await items.evaluateAll((els) =>
          els.map((e) => {
            if (e.classList.contains('rv-status-correct')) return 'correct';
            if (e.classList.contains('rv-status-incorrect')) return 'incorrect';
            return 'unanswered';
          }),
        );
        expect(statuses.filter((s) => s === 'correct').length).toBe(4);
        expect(statuses.filter((s) => s === 'incorrect').length).toBe(4);
        expect(statuses.filter((s) => s === 'unanswered').length).toBe(2);
        await expect(page.locator('.rv-explanation').first()).toBeVisible();
        await expect(page.locator('.rv-correct-summary').first()).toBeVisible();

        // ── Light/dark + narrow-viewport checks on the opened review ──────
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(2); // no horizontal overflow from the review content/filters
        const filterToolbarClip = await page.evaluate(() => {
          const el = document.querySelector('.rv-filters-toolbar');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { right: r.right, left: r.left, viewportWidth: window.innerWidth };
        });
        expect(filterToolbarClip).not.toBeNull();
        expect(filterToolbarClip!.right).toBeLessThanOrEqual(filterToolbarClip!.viewportWidth + 2);
        // The floating scroll-down "elevator" is a fixed element on this long
        // page — confirm it doesn't sit on top of the filter toolbar.
        const elevatorOverlap = await page.evaluate(() => {
          const toolbar = document.querySelector('.rv-filters-toolbar')?.getBoundingClientRect();
          const elevator = document.querySelector('app-scroll-down-indicator')?.getBoundingClientRect();
          if (!toolbar || !elevator) return false;
          return !(elevator.left > toolbar.right || elevator.right < toolbar.left || elevator.top > toolbar.bottom || elevator.bottom < toolbar.top);
        });
        expect(elevatorOverlap).toBe(false);

        // ── Review navigation must not change the submitted result ───────
        await expect(page.locator('.rv-summary__correct')).toHaveText('4');
        await expect(page.locator('.rv-summary__incorrect')).toHaveText('4');
        await expect(page.locator('.rv-summary__unanswered')).toHaveText('2');

        // ── Hide Review (back to the base Results view), via keyboard ─────
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Hide Review'));
        await pressKey(page, 'Enter');
        await expect(page.locator('app-interview-review')).toBeHidden();
        await expect(page.locator('.score-pct')).toHaveText(resultsScore); // unchanged by opening/filtering/closing review

        // ── Reach Export Report from here, via keyboard ───────────────────
        await tabUntil(page, async () => page.evaluate(() => (document.activeElement?.textContent || '').trim() === 'Export Report'));
        const exportOutline2 = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
        expect(exportOutline2).not.toBe('none');
        await pressKey(page, 'Enter');
        await page.waitForURL(/\/interview\/report\/[^/?#]+/, { timeout: 20_000 });
        await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeFocused();
        // The report shows the SAME finalized result Review/Results computed.
        const reportSummary = await page.locator('.rp-summary > div').evaluateAll((els) =>
          Object.fromEntries(els.map((e) => [e.querySelector('dt')!.textContent!.trim(), e.querySelector('dd')!.textContent!.trim()])),
        );
        expect(reportSummary['Correct']).toBe('4');
        expect(reportSummary['Incorrect']).toBe('4');
        expect(reportSummary['Unanswered']).toBe('2');

        console.log(`REVIEW KEYBOARD FLOW (${theme}, ${vp.label}): COMPLETE — all three outcomes verified, no mouse used`);
      });
    }
  }
});
