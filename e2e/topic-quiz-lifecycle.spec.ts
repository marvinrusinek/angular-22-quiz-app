import { test, expect, Page } from '@playwright/test';

import { HEADING, NEXT_BTN, PREV_BTN, correctIndexForHeading, quizData, correctIndicesForHeading } from './helpers';

/**
 * TOPIC QUIZ LIFECYCLE BOUNDARIES.
 *
 * The base app has regressed several times at TRANSITIONS while every
 * eventual-state assertion stayed green. This covers the boundaries that had no
 * spec of their own:
 *
 *   fresh start · new question · different quiz · timeout (visible) ·
 *   timeout (hidden/frozen)
 *
 * Deliberately NOT duplicated here, because they already have dedicated specs:
 *
 *   pending verdict paint    pending-verdict-paint.spec.ts
 *   multi-answer counting    multi-answer-remaining-count.spec.ts
 *   revisit restore          ma-revisit-completion / revisit-disable
 *   Results → Restart Quiz   restart-quiz-lifecycle.spec.ts
 *   timeout FET per question cd-timeout-fet.spec.ts
 *
 * ── Two instrumentation lessons are baked in ──────────────────────
 *
 * 1. Sample the surface the bug can actually appear on. A red flash lived in an
 *    inline background while `className` stayed correct; explanation text
 *    appeared in the projected heading while the feedback banner stayed empty.
 *    So these capture heading, banner, timer text AND timer colour.
 *
 * 2. Sample the FIRST PAINT, not just the settled state. "0:29 → 0:26" proves a
 *    timer ends up healthy; it says nothing about a 0:00 flash one frame in.
 */

test.describe.configure({ timeout: 420_000 });

const ROW = '.option-row';
const TIMER = '.scoreboard-timer .scoreboard';
const MSG = '.instructions-message';
const FEEDBACK = 'codelab-quiz-feedback';
const TILE = '.quiz-tile';
const ANSWERED = 'Answered ✓ Click Next to continue...';

const routerQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'fixture-thingamajigs');

/** Everything a stale-state bug could surface through, in one snapshot. */
async function surfaces(page: Page) {
  return page.evaluate(() => {
    const h3 = document.querySelector('codelab-quiz-content h3') as HTMLElement | null;
    const fb = document.querySelector('codelab-quiz-feedback') as HTMLElement | null;
    const t = document.querySelector('.scoreboard-timer .scoreboard') as HTMLElement | null;
    const msg = document.querySelector('.instructions-message') as HTMLElement | null;
    const dirty = [...document.querySelectorAll('.option-row')]
      .map((el, i) => ({ i, c: el.className || '' }))
      .filter((r) => /\bselected\b|correct-option|incorrect-option|disabled-option|highlighted/.test(r.c))
      .map((r) => String(r.i));
    return {
      heading: (h3?.textContent ?? '').trim(),
      banner: (fb?.textContent ?? '').trim(),
      timer: (t?.textContent ?? '').trim(),
      message: (msg?.textContent ?? '').trim(),
      dirty
    };
  });
}

/**
 * Records the timer on EVERY frame, for the whole session.
 *
 * Installed ONCE, before the first navigation. It used to be armed per-switch
 * via `addInitScript`, which only runs on a new document — so arming it forced
 * a reload, and a reload destroys the root TimerService. That is exactly the
 * state this file exists to catch, and contract G passed all the way through
 * the cross-quiz leak because of it.
 */
async function installTimerWatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__timerFrames = [];
    let last = '';
    const sample = () => {
      const el = document.querySelector('.scoreboard-timer .scoreboard') as HTMLElement | null;
      if (el) {
        const txt = (el.textContent ?? '').trim();
        if (txt) {
          const c = getComputedStyle(el).color;
          const key = txt + '|' + c + '|' + location.pathname;
          if (key !== last) {
            last = key;
            w.__timerFrames.push({ t: txt, c, url: location.pathname });
          }
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const clearTimerFrames = (page: Page): Promise<void> =>
  page.evaluate(() => { (window as any).__timerFrames = []; });

/**
 * Back to the selection page WITHOUT reloading — the header logo, as a user
 * clicks it. `page.goto` would tear down every root service and hide any state
 * that leaked from the quiz being left.
 */
async function backToSelectionInSpa(page: Page): Promise<void> {
  // Two exits, depending on where the quiz was left: the Results page has its
  // own "select quiz" control, every in-quiz page has the header logo.
  const fromResults = page.locator('[title="select quiz"]').first();
  const link = (await fromResults.count()) > 0
    ? fromResults
    : page.locator('mat-card-header a[href="/select"]').first();

  await link.waitFor({ state: 'visible', timeout: 30_000 });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Picks a quiz from the selection page and starts it. Already on it. */
async function pickQuiz(page: Page, needle: RegExp): Promise<void> {
  const tile = page.locator(TILE).filter({ hasText: needle }).first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(1200);
  const start = page.locator('.start-btn').first();
  if (await start.count() > 0) await start.click().catch(() => {});
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
}

const timerFrames = (page: Page): Promise<{ t: string; c: string }[]> =>
  page.evaluate(() => (window as any).__timerFrames ?? []);

/** Start a quiz the way a user does: tile → intro → "Start the Quiz!". */
async function startViaUi(page: Page, needle: RegExp): Promise<void> {
  await page.goto('/quiz');
  await page.locator(TILE).first().waitFor({ state: 'visible', timeout: 30_000 });
  const tile = page.locator(TILE).filter({ hasText: needle }).first();
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForTimeout(1200);
  const start = page.locator('.start-btn').first();
  if (await start.count() > 0) await start.click().catch(() => {});
  await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 30_000 });
}

const seconds = (raw: string): number => {
  const m = raw.match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

// ─── A. A FRESH QUIZ STARTS CLEAN ──────────────────────────────────

test('A: a freshly started quiz has no state of any kind on question 1', async ({ page }) => {
  await startViaUi(page, /fixture thingamajigs/i);
  const s = await surfaces(page);

  expect(s.dirty, 'no option carries selection or verdict styling').toEqual([]);
  expect(s.banner, 'no explanation banner').toBe('');
  expect(s.message, 'not claiming the question is answered').not.toBe(ANSWERED);
  expect(seconds(s.timer), 'a full, fresh timer').toBeGreaterThan(20);

  // Options must be usable, not left disabled by anything prior.
  await expect(page.locator(ROW).first()).toBeEnabled();
});

// ─── E. A NEW QUESTION STARTS CLEAN ────────────────────────────────

test('E: advancing to an unanswered question leaves the previous one behind', async ({ page }) => {
  await startViaUi(page, /fixture thingamajigs/i);

  const heading1 = (await page.locator(HEADING).first().textContent()) ?? '';
  const correct = correctIndicesForHeading(routerQuiz, heading1);
  await page.locator(ROW).nth(correct.length ? correct[0] : 0).click();
  await page.waitForTimeout(2500);

  const answered = await surfaces(page);
  expect(answered.dirty.length, 'q1 really was answered').toBeGreaterThan(0);

  await page.locator(NEXT_BTN).click();
  await page.locator(ROW).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(1800);

  const q2 = await surfaces(page);
  expect(q2.dirty, 'no styling carried over from q1').toEqual([]);
  expect(q2.banner, 'no explanation carried over from q1').toBe('');
  expect(q2.message, 'q2 is not reported as answered').not.toBe(ANSWERED);
  expect(q2.heading, 'q2 shows its own question').not.toBe(answered.heading);
  expect(seconds(q2.timer), 'q2 gets its own fresh timer').toBeGreaterThan(20);
});

// ─── G. A DIFFERENT QUIZ STARTS CLEAN — INCLUDING FIRST PAINT ──────

/**
 * TimerService is provided at the root, so it survives the quiz switch that
 * destroys and recreates QuizComponent. Everything it remembers is keyed by
 * QUESTION INDEX, and Quiz B's first question is index 0 exactly as Quiz A's
 * was — so the switch has to happen IN THE SPA for any of this to be tested.
 * An earlier version of this contract navigated with `page.goto`, which
 * reloads the document and rebuilds the service from scratch; it passed
 * throughout the leak it was written to catch.
 */
test('G: starting a different quiz shows no 0:00 flash and no prior-quiz state', async ({ page }) => {
  await installTimerWatch(page);

  // Quiz A: answer something so there is real state that could leak.
  await startViaUi(page, /fixture widgets/i);
  const hA = (await page.locator(HEADING).first().textContent()) ?? '';
  await page.locator(ROW).nth(correctIndexForHeading(hA)).click();
  await page.waitForTimeout(2500);

  // Leave through the normal UI — no reload — then start Quiz B.
  await backToSelectionInSpa(page);
  await clearTimerFrames(page);
  await pickQuiz(page, /fixture gadgets/i);
  await page.waitForTimeout(1500);

  const frames = await timerFrames(page);
  const zeroFrames = frames.filter((f) => /^0:0?0$/.test(f.t));
  console.log('LIFECYCLE G: ' + frames.length + ' timer frames, ' +
    zeroFrames.length + ' at zero, first=' + JSON.stringify(frames[0] ?? null));

  // THE REGRESSION: a visible red 0:00 before the real timer appeared. The
  // earlier "0:29 → 0:26" assertion could not see it.
  expect(zeroFrames, 'the timer never paints 0:00 while starting a new quiz').toEqual([]);

  // EVERY question of EVERY quiz begins at the full 30 seconds. Quiz B used to
  // inherit Quiz A's running countdown and open partway through it — no zero
  // frame, no red, and still wrong.
  expect(seconds(frames[0]?.t ?? ''), 'Quiz B opens on a full timer').toBeGreaterThan(27);

  const s = await surfaces(page);
  expect(s.dirty, 'no options carry Quiz A state').toEqual([]);
  expect(s.banner, 'no Quiz A explanation').toBe('');
  expect(s.message, 'no Quiz A completion message').not.toBe(ANSWERED);
  expect(seconds(s.timer), 'Quiz B starts on a full timer').toBeGreaterThan(20);

  // ...and it is actually running, not merely displaying a number.
  const before = seconds((await surfaces(page)).timer);
  await page.waitForTimeout(3000);
  expect(seconds((await surfaces(page)).timer), 'Quiz B timer counts down').toBeLessThan(before);
});

// ─── M. A DIFFERENT QUIZ AFTER THE PREVIOUS ONE TIMED OUT ──────────

/**
 * The worst form of the leak, and the reason this contract is separate from G.
 *
 * Quiz A's question 1 expiring set `hasExpiredForRun`, `elapsedTimeSig = 30`
 * and `expiredForQuestionIndexSig = 0`. Quiz B's question 1 is also index 0,
 * so `restartForQuestion` returned at its guards and never started anything:
 * the timer stayed a permanent red 0:00 — not a flash — and the heading, which
 * reads `expiredForQuestionIndexSig === idx` as "timed out", rendered QUIZ A's
 * correct answer and explanation over Quiz B's first question.
 */
test('M: a quiz started after a timeout is not born expired', async ({ page }) => {
  test.setTimeout(180_000);
  await installTimerWatch(page);

  // Quiz A: let question 1 genuinely run out.
  await startViaUi(page, /fixture thingamajigs/i);
  await page.waitForTimeout(36_000);
  const expired = await surfaces(page);
  // No expiry-specific wrapper any more: a genuine timeout reveals through the
  // ordinary FET (composed explanation prose), same as any other reveal.
  expect(expired.heading, 'Quiz A really did time out').toMatch(/correct because/i);

  await backToSelectionInSpa(page);
  await clearTimerFrames(page);
  await pickQuiz(page, /fixture widgets/i);
  await page.waitForTimeout(2500);

  const frames = await timerFrames(page);
  console.log('LIFECYCLE M: ' + frames.length + ' frames, first=' +
    JSON.stringify(frames[0] ?? null));

  expect(frames.filter((f) => /^0:0?0$/.test(f.t)),
    'Quiz B never paints 0:00 after Quiz A timed out').toEqual([]);
  expect(seconds(frames[0]?.t ?? ''), 'Quiz B opens on a full timer').toBeGreaterThan(27);

  const s = await surfaces(page);

  // THE ANSWER LEAK: Quiz A's reveal must not appear on Quiz B's question.
  expect(s.heading, 'Quiz B question 1 is not showing a leaked reveal').not.toMatch(/correct because/i);
  expect(s.heading, "no prior quiz's correct answer").not.toContain('Correct answer');
  expect(s.banner, 'no Quiz A explanation').toBe('');
  expect(s.dirty, 'no auto-revealed options').toEqual([]);

  // And the countdown is genuinely running, not frozen at a full-looking value.
  const before = seconds((await surfaces(page)).timer);
  await page.waitForTimeout(3000);
  expect(seconds((await surfaces(page)).timer), 'Quiz B timer counts down').toBeLessThan(before);
});

// ─── N. A DIFFERENT QUIZ AFTER FINISHING THE PREVIOUS ONE ──────────

/**
 * The completed-run variant. Finishing Quiz A leaves its last question expired
 * on arrival and its whole signed-deadline map populated; both outlived the
 * switch, so Quiz B's question 1 opened at a permanent red 0:00 even though
 * the stale expiry index (Quiz A's LAST question) did not collide with 0 and
 * the heading therefore looked fine. A heading-only assertion misses this.
 */
test('N: a quiz started after finishing another one gets its own clock', async ({ page }) => {
  test.setTimeout(240_000);
  await installTimerWatch(page);

  await startViaUi(page, /fixture thingamajigs/i);
  for (let q = 0; q < routerQuiz.questions.length; q++) {
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 15_000 });
    const heading = (await page.locator(HEADING).first().textContent()) ?? '';
    const correct = correctIndicesForHeading(routerQuiz, heading);
    for (const i of (correct.length ? correct : [0])) {
      await page.locator(ROW).nth(i).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(400);
    const results = page.locator('.show-results-btn').first();
    if (await results.isVisible().catch(() => false)) {
      await results.click();
      await page.waitForTimeout(3500);
      break;
    }
    await page.locator(NEXT_BTN).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
  }

  await backToSelectionInSpa(page);
  await clearTimerFrames(page);
  await pickQuiz(page, /fixture widgets/i);
  await page.waitForTimeout(2500);

  const frames = await timerFrames(page);
  console.log('LIFECYCLE N: ' + frames.length + ' frames, first=' +
    JSON.stringify(frames[0] ?? null));

  expect(frames.filter((f) => /^0:0?0$/.test(f.t)),
    'Quiz B never paints 0:00 after Quiz A was completed').toEqual([]);
  expect(seconds(frames[0]?.t ?? ''), 'Quiz B opens on a full timer').toBeGreaterThan(27);

  const s = await surfaces(page);
  expect(s.heading, 'Quiz B question 1 is not showing a leaked reveal').not.toMatch(/correct because/i);
  expect(s.dirty, 'no options carry Quiz A state').toEqual([]);

  const before = seconds((await surfaces(page)).timer);
  await page.waitForTimeout(3000);
  expect(seconds((await surfaces(page)).timer), 'Quiz B timer counts down').toBeLessThan(before);
});

// ─── I. TIMEOUT WHILE THE QUESTION IS VISIBLE ──────────────────────

test('I: a question that times out in view reveals through the ORDINARY FET — no expiry-specific presentation', async ({ page }) => {
  await startViaUi(page, /fixture thingamajigs/i);
  const before = await surfaces(page);
  expect(before.heading, 'starts on the question').not.toMatch(/correct because/i);

  // Let the real 30s deadline pass, untouched. No wrapper announces it — the
  // heading simply becomes the same composed explanation any other reveal
  // uses, once the authorized reveal lands.
  await expect(page.locator(HEADING)).toContainText(/correct because/i, { timeout: 90_000 });

  const after = await surfaces(page);
  console.log('LIFECYCLE I heading: ' + after.heading.slice(0, 110));

  // NO expiry-specific markers of any kind.
  expect(after.heading, 'no "Time\'s up" wrapper').not.toContain("Time's up");
  expect(after.heading, 'no separate "Correct answer:" line').not.toContain('Correct answer');

  expect(seconds(after.timer), 'the timer really did expire').toBe(0);
});

// ─── J. TIMEOUT WHILE HIDDEN / FROZEN ──────────────────────────────

/**
 * `Page.setWebLifecycleState: 'frozen'` (CDP) is the closest automatable
 * analogue of a minimised window: it drives Chrome's real frozen lifecycle, so
 * the app's own freeze/resume handling runs.
 *
 * It is NOT identical to an OS-level minimise — that cannot be automated — and
 * this test does not claim otherwise. What it does establish is that returning
 * from a frozen state neither creates the timeout state nor corrupts it.
 */
test('J: a deadline that passes while hidden is revealed on return, not caused by it', async ({ page }) => {
  await startViaUi(page, /fixture thingamajigs/i);

  const beforeHide = await surfaces(page);
  expect(beforeHide.heading, 'question is showing before we leave').not.toMatch(/correct because/i);

  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => {});

  await page.waitForTimeout(38_000);   // past the 30s deadline

  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });

  await page.waitForTimeout(1200);
  const onReturn = await surfaces(page);
  console.log('LIFECYCLE J on return: timer="' + onReturn.timer + '" heading=' +
    onReturn.heading.slice(0, 90));

  // The timeout is REVEALED through the ordinary FET — no expiry-specific
  // wrapper, just the same composed explanation any other reveal uses.
  expect(seconds(onReturn.timer), 'the deadline passed while away').toBe(0);
  expect(onReturn.heading, 'the reveal happened').toMatch(/correct because/i);
  expect(onReturn.heading, 'no expiry-specific wrapper').not.toContain("Time's up");

  // Resuming must not duplicate or corrupt it: same heading a few seconds later,
  // and no other question's content has bled in.
  await page.waitForTimeout(4000);
  const settled = await surfaces(page);
  expect(settled.heading, 'the state is stable across resume').toBe(onReturn.heading);
  expect((settled.heading.match(/correct because/gi) ?? []).length, 'stated once, not twice').toBe(1);
});

// ─── L. TIMEOUT UNDER PRODUCTION LATENCY ───────────────────────────

/**
 * THE AUTHORIZED REVEAL ARRIVES AFTER THE DEADLINE, AND MUST STILL WIN.
 *
 * A timed-out question on GitHub Pages read "Time&#39;s up. No explanation
 * available." while the identical flow locally showed the real explanation. The
 * placeholder was stored at the head of the source chain and shadowed the
 * authorized reveal that landed a round trip later; locally the backend was
 * fast enough that something overwrote it first.
 *
 * Localhost cannot reproduce that ordering on its own, so the reveal is held
 * deliberately — the same technique the pending-verdict spec uses for /check.
 */
test('L: a delayed timeout reveal still replaces the question with real content — no placeholder ever', async ({ page }) => {
  // Hold every /check — which is also the expired reveal — long enough that the
  // deadline passes first, reproducing the deployed ordering deterministically.
  let releaseReveal: (() => void) | null = null;
  const revealHeld = new Promise<void>((r) => { releaseReveal = r; });
  let held = 0;
  await page.route('**/check**', async (route) => {
    held++;
    await revealHeld;
    await route.continue();
  });

  await startViaUi(page, /fixture thingamajigs/i);

  // The deadline passes (timer hits 0:00) while the reveal is still in flight.
  // With no expiry-specific wrapper, the heading has nothing to say until the
  // reveal lands — it stays on the question, exactly like any other pending
  // FET-due-but-textless case.
  await expect(page.locator(TIMER)).toHaveText(/^0:0?0$/, { timeout: 90_000 });

  const duringLatency = await surfaces(page);
  console.log('LIFECYCLE L during-latency heading=' + duringLatency.heading.slice(0, 90));

  // THE REGRESSION: this window is where a placeholder used to be stored and
  // then stick permanently. Nothing may be fabricated here — the heading
  // stays on the question rather than showing invented text.
  expect(duringLatency.heading, 'no placeholder while the reveal is pending')
    .not.toContain('No explanation available');
  expect(duringLatency.heading, 'still the question — nothing fabricated yet')
    .not.toMatch(/because/i);

  // Now let the authorized reveal land.
  releaseReveal!();

  await expect
    .poll(async () => (await surfaces(page)).heading, { timeout: 30_000 })
    .toMatch(/because/i);   // the formatted explanation names its reasoning

  const afterReveal = await surfaces(page);
  console.log('LIFECYCLE L after-reveal heading=' + afterReveal.heading.slice(0, 110) +
    ' (checks held: ' + held + ')');

  expect(afterReveal.heading, 'the authorized explanation replaced the question')
    .toMatch(/because/i);
  expect(afterReveal.heading, 'and the placeholder never returns')
    .not.toContain('No explanation available');
  expect(afterReveal.heading, 'no expiry-specific wrapper').not.toContain("Time's up");
});
