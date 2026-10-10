import { test, expect, Page } from '@playwright/test';
import { quizData, startQuizViaUi, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * Confirmed defect: a previously-selected incorrect single-answer radio
 * stays visually highlighted on revisit, but its NATIVE
 * `<input type="radio">.checked` — and therefore the accessibility tree's
 * reported checked state — read false. Narrator reports "unselected" for
 * an option the screen still shows as the user's (wrong) pick.
 *
 * Root cause (confirmed via live tracing, not assumed): `mat-radio-group`'s
 * own value-comparison mechanism (`formControlName="selectedOptionId"` +
 * each button's `[value]="index"`) depends on its own
 * `@ContentChildren(MatRadioButton)` query — confirmed, via
 * `ng.getDirectives()` on the live app, to NEVER populate at all in this
 * app (reads back empty even during an ordinary, currently-"working"
 * click), because these buttons are projected through
 * shared-option.component.html's `*ngTemplateOutlet="optionsList"`
 * indirection, which `@ContentChildren` does not see through. A fresh
 * click only ever looked correct because the browser's own native
 * same-`name` radio-group behaviour took over — Material's reactive-forms
 * sync never engaged at all, in either direction. On revisit there is no
 * new native click to rely on, so the native checked state simply never
 * got set.
 *
 * Fix: `option-item.component.ts`'s new `isNativelyChecked()` derives the
 * native `[checked]` binding from the SAME computed classes that already
 * determine the option's visible incorrect/correct/selected highlight
 * (`getOptionClasses()`) — one consistent source of truth — bound directly
 * on `mat-radio-button` (mirroring the exact pattern `mat-checkbox` already
 * uses for the multi-answer case), bypassing the broken `_radios` path
 * entirely. `MatRadioButton`'s own `checked` setter (Material's own
 * library source) still correctly updates its `radioGroup`'s value and
 * notifies its `UniqueSelectionDispatcher` to uncheck every sibling
 * sharing the same `name`, so mutual exclusivity stays correct regardless.
 *
 * These assertions check the REAL native `<input>.checked` DOM property
 * and the accessibility tree's own reported checked state — not CSS
 * classes or highlight colors, which were never broken and would pass
 * even without this fix.
 */

const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');
const SINGLE_ANSWER_IDX = [0, 2, 3, 4].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length === 1
);

async function nativeCheckedStates(page: Page): Promise<boolean[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.option-row.single-option input[type="radio"]')).map(
      (el) => (el as HTMLInputElement).checked
    )
  );
}

/** The accessibility tree's own reported checked state per radio, via CDP — not the DOM property. */
async function axCheckedStates(page: Page): Promise<(string | undefined)[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const tree = await cdp.send('Accessibility.getFullAXTree', {});
  const nodes = (tree as any).nodes as any[];
  return nodes
    .filter((n) => n.role?.value === 'radio')
    .map((n) => (n.properties ?? []).find((p: any) => p.name === 'checked')?.value?.value);
}

test.describe('Topic Quiz radio checked-state matches native/AX reality (fix regression)', () => {
  test('selecting an incorrect option sets native .checked AND the accessibility tree checked state, not just the visual highlight', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const wrongIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );
    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(900);

    const nativeChecked = await nativeCheckedStates(page);
    const axChecked = await axCheckedStates(page);

    expect(nativeChecked[wrongIdx]).toBe(true);
    expect(nativeChecked.filter(Boolean).length).toBe(1);
    expect(axChecked[wrongIdx]).toBe('true');
  });

  test('revisiting a question after answering incorrectly: native .checked and the AX tree still agree with the visual highlight (the confirmed defect)', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const wrongIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => !(o.correct === true || o.correct === 'true')
    );
    await page.locator('.option-row').nth(wrongIdx).click();
    await page.waitForTimeout(900);

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(600);

    await page.locator(PREV_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(800);

    // The visual highlight (already correct before this fix) must still hold.
    const bg = await page.locator('.option-row').nth(wrongIdx).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(255, 0, 0)');

    // The actual defect: native checked + AX checked must ALSO agree, not
    // just the color.
    const nativeChecked = await nativeCheckedStates(page);
    const axChecked = await axCheckedStates(page);
    expect(nativeChecked[wrongIdx]).toBe(true);
    expect(nativeChecked.filter(Boolean).length).toBe(1);
    expect(axChecked[wrongIdx]).toBe('true');
  });

  test('revisiting a question after answering CORRECTLY: native .checked and the AX tree still agree', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[1];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(600);

    await page.locator(PREV_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(800);

    const nativeChecked = await nativeCheckedStates(page);
    const axChecked = await axCheckedStates(page);
    expect(nativeChecked[correctIdx]).toBe(true);
    expect(nativeChecked.filter(Boolean).length).toBe(1);
    expect(axChecked[correctIdx]).toBe('true');
  });

  test('keyboard selection (Tab + arrow keys + Space) sets native .checked the same way a mouse click does', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    let tries = 0;
    while (tries < 15) {
      const onRadio = await page.evaluate(() => document.activeElement?.getAttribute('type') === 'radio');
      if (onRadio) break;
      await page.keyboard.press('Tab');
      tries++;
    }
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);

    const nativeChecked = await nativeCheckedStates(page);
    expect(nativeChecked.filter(Boolean).length).toBe(1);
    const checkedIdx = nativeChecked.findIndex(Boolean);
    const axChecked = await axCheckedStates(page);
    expect(axChecked[checkedIdx]).toBe('true');
  });

  test('multi-answer checkboxes are unaffected: native .checked still matches the selection, independent of the radio fix', async ({ page }) => {
    const multiIdx = [1, 5].find((i) =>
      doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length > 1
    );
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    for (let i = 0; i < multiIdx!; i++) {
      await page.locator('.option-row').first().click();
      await page.waitForTimeout(700);
      await page.locator(NEXT_BTN).click();
      await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(400);
    }

    const correctIdxs: number[] = doohickeys.questions[multiIdx!].options
      .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
      .filter((i: number) => i >= 0);

    await page.locator('.option-row').nth(correctIdxs[0]).click();
    await page.waitForTimeout(700);

    const checkboxChecked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.option-row.multiple-option input[type="checkbox"]')).map(
        (el) => (el as HTMLInputElement).checked
      )
    );
    expect(checkboxChecked[correctIdxs[0]]).toBe(true);
  });
});
