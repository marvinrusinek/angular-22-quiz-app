import { test, expect, Page } from '@playwright/test';
import { quizData, startQuizViaUi, advanceToQuestion, HEADING, NEXT_BTN, PREV_BTN } from './helpers';

/**
 * Regression coverage for the NAVIGATION-arrival announcement — see
 * SharedOptionComponent.announceQuestionArrival /
 * AnswerAnnouncementCoordinatorService.composeQuestionArrivalAnnouncement /
 * QuizComponent's route-focus effect.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * A real Narrator retest found that moving focus to the question heading
 * alone (the prior fix) does not reliably interrupt speech Narrator had
 * already queued from Quiz Selection/Introduction, or from the previous
 * question's own feedback/FET. This writes the current question's own
 * text through the SAME persistent announcer already field-verified to
 * reliably reach Narrator for answer feedback, on every actual
 * question-index change (initial arrival AND every Next/Previous).
 *
 * ── What this suite proves ──────────────────────────────────────────────
 * The announcer carries the CURRENT question's own text (with its
 * multi-answer banner) after arrival, Next, and Previous; it is correctly
 * superseded by a subsequent answer-outcome announcement; a genuine
 * revisit announces the question text, never a stale outcome; rapid
 * repeated navigation lands on the FINAL question only; and destruction
 * mid-flight produces no errors.
 *
 * ── What this suite does NOT and cannot prove ───────────────────────────
 * That Narrator actually speaks this, or that it interrupts speech already
 * underway. This is a CANDIDATE mitigation — DOM/application-state
 * assertions prove the right text reaches the right (already-reliable)
 * channel at the right time; only a manual Narrator retest proves the
 * actual spoken behavior. See this task's final report for the retest
 * checklist.
 *
 * Navigation uses startQuizViaUi + advanceToQuestion (real progression),
 * never a direct page.goto to a non-first question — QuizGuard redirects
 * that back to Q1 on a fresh attempt.
 */

const ANNOUNCER_SELECTOR = '.visually-hidden[role="status"]';
const doohickeys = quizData.find((q: any) => (q.quizId || q.id) === 'fixture-doohickeys');

const SINGLE_ANSWER_IDX = [0, 2, 3, 4].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length === 1
);
const MULTI_ANSWER_IDX = [1, 5].filter((i) =>
  doohickeys.questions[i].options.filter((o: any) => o.correct === true || o.correct === 'true').length > 1
);

async function announcerText(page: Page): Promise<string> {
  return ((await page.locator(ANNOUNCER_SELECTOR).textContent()) ?? '').trim();
}

test.describe('Topic Quiz navigation-arrival announcement (fix candidate)', () => {
  test('Introduction -> Q1: the announcer carries Q1\'s own question text on arrival', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await page.waitForTimeout(600);

    const announced = await announcerText(page);
    const headingText = ((await page.locator(HEADING).first().textContent()) ?? '').trim();
    expect(announced.length).toBeGreaterThan(0);
    expect(announced).toBe(headingText);
    expect(announced).toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));
  });

  test('Introduction -> Q1 (cold start): the announcer is observed EMPTY before it is ever observed with content — never born pre-populated', async ({ page }) => {
    // Regression coverage for a reopened investigation: on a cold start the
    // announcer's host (SharedOptionComponent, created only once the dynamic
    // AnswerComponent's own async load chain resolves) mounts noticeably
    // later and slower than it does on Next, where the component tree
    // already exists. If that host ever mounted AFTER the coordinator's
    // 100ms clear-then-restore had already resolved, the live region would
    // be born with its final text already in place — a mutation-free
    // "initial render" that most screen readers, Narrator included, do not
    // reliably announce (same class of bug as the viewChild defect this
    // fix already found and corrected for Next). A live diagnostic on this
    // exact path confirmed the region is still always observed empty first;
    // this locks that ordering in.
    const qIdx = SINGLE_ANSWER_IDX[0];

    await page.addInitScript(() => {
      (window as any).__arrivalTrace = [];
      const SEL = '.visually-hidden[role="status"]';
      const recordIfFound = () => {
        const el = document.querySelector(SEL) as any;
        if (el && !el.__observed) {
          el.__observed = true;
          (window as any).__arrivalTrace.push({ event: 'mounted', text: el.textContent });
          new MutationObserver(() => {
            (window as any).__arrivalTrace.push({ event: 'mutated', text: el.textContent });
          }).observe(el, { characterData: true, childList: true, subtree: true });
        }
      };
      const start = () => {
        if (document.body) {
          new MutationObserver(recordIfFound).observe(document.body, { childList: true, subtree: true });
          recordIfFound();
        } else {
          requestAnimationFrame(start);
        }
      };
      start();
    });

    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await page.waitForTimeout(600);

    const trace = await page.evaluate(() => (window as any).__arrivalTrace as Array<{ event: string; text: string }>);

    expect(trace.length).toBeGreaterThan(0);
    // The region's very FIRST observed state must be empty — it must never
    // be observed already carrying its final text on first sight.
    expect(trace[0].text).toBe('');

    const firstNonEmpty = trace.find((entry) => entry.text.length > 0);
    expect(firstNonEmpty).toBeDefined();
    expect(firstNonEmpty!.text).toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));
  });

  test('Next: the announcer carries the NEW question\'s text, not the previous question\'s feedback/FET', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);
    const afterAnswer = await announcerText(page);
    expect(afterAnswer.length).toBeGreaterThan(0); // full-correctness feedback+FET

    await page.locator(NEXT_BTN).click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(600);

    const afterNext = await announcerText(page);
    expect(afterNext.length).toBeGreaterThan(0);
    expect(afterNext).toContain(doohickeys.questions[1].questionText.slice(0, 20));
    // Not still carrying Q1's verdict/explanation.
    expect(afterNext).not.toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));
  });

  test('multi-answer: the navigation announcement includes the "(N answers are correct)" banner', async ({ page }) => {
    const qIdx = MULTI_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await advanceToQuestion(page, doohickeys, qIdx + 1);
    await page.waitForTimeout(600);

    const announced = await announcerText(page);
    expect(announced).toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));
    expect(/\(\d+ answers? (is|are) correct\)/i.test(announced)).toBe(true);
  });

  test('a navigation announcement is correctly superseded by a subsequent answer-outcome announcement', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await page.waitForTimeout(600);
    const navAnnounced = await announcerText(page);
    expect(navAnnounced).toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));

    const correctIdx = doohickeys.questions[qIdx].options.findIndex(
      (o: any) => o.correct === true || o.correct === 'true'
    );
    await page.locator('.option-row').nth(correctIdx).click();
    await page.waitForTimeout(900);

    const outcomeAnnounced = await announcerText(page);
    expect(outcomeAnnounced.length).toBeGreaterThan(0);
    expect(outcomeAnnounced).not.toBe(navAnnounced);
    expect(/right|correct/i.test(outcomeAnnounced)).toBe(true);
  });

  test('Previous to an already-answered question: announces the QUESTION text, not a stale outcome from either question', async ({ page }) => {
    const qIdx = SINGLE_ANSWER_IDX[0];
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
    await page.waitForTimeout(600);

    const announced = await announcerText(page);
    expect(announced.length).toBeGreaterThan(0);
    expect(announced).toContain(doohickeys.questions[qIdx].questionText.slice(0, 20));
    expect(announced).not.toContain(doohickeys.questions[1].questionText.slice(0, 20));
  });

  test('rapid repeated Next clicks: the announcer lands on the FINAL question only, never a stale intermediate one', async ({ page }) => {
    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);

    for (let q = 0; q < 2; q++) {
      const correctIdxs: number[] = doohickeys.questions[q].options
        .map((o: any, i: number) => ((o.correct === true || o.correct === 'true') ? i : -1))
        .filter((i: number) => i >= 0);
      for (const idx of correctIdxs) {
        await page.locator('.option-row').nth(idx).click();
      }
      await expect(page.locator(NEXT_BTN)).toBeEnabled({ timeout: 10_000 });
      await page.locator(NEXT_BTN).click();
    }
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(800);

    const announced = await announcerText(page);
    expect(announced).toContain(doohickeys.questions[2].questionText.slice(0, 20));
    expect(announced).not.toContain(doohickeys.questions[0].questionText.slice(0, 20));
    expect(announced).not.toContain(doohickeys.questions[1].questionText.slice(0, 20));
  });

  test('navigating away entirely while a pending restore is in flight produces no console/page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (msg.text().includes('NG02955')) return; // pre-existing, unrelated
      errors.push(msg.text());
    });

    await startQuizViaUi(page, 'fixture-doohickeys', /fixture doohickeys/i);
    await page.goto('/quiz');
    await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(400);

    expect(errors).toEqual([]);
  });
});
