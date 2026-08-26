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

const routerQuiz = (quizData as any[]).find((q) => (q.quizId || q.id) === 'router');

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

/** Records the timer on EVERY frame from before navigation, to catch a flash. */
async function watchTimerFromFirstPaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__timerFrames = [];
    const sample = () => {
      const el = document.querySelector('.scoreboard-timer .scoreboard') as HTMLElement | null;
      if (el) {
        const txt = (el.textContent ?? '').trim();
        if (txt) w.__timerFrames.push({ t: txt, c: getComputedStyle(el).color });
      }
      if (w.__timerFrames.length < 400) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
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
  await startViaUi(page, /router/i);
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
  await startViaUi(page, /router/i);

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

test('G: starting a different quiz shows no 0:00 flash and no prior-quiz state', async ({ page }) => {
  // Quiz A: answer something so there is real state that could leak.
  await startViaUi(page, /typescript/i);
  const hA = (await page.locator(HEADING).first().textContent()) ?? '';
  await page.locator(ROW).nth(correctIndexForHeading(hA)).click();
  await page.waitForTimeout(2500);

  // Leave through the normal UI, then start Quiz B — watching from first paint.
  await watchTimerFromFirstPaint(page);
  await startViaUi(page, /dependency injection/i);
  await page.waitForTimeout(1500);

  const frames = await timerFrames(page);
  const zeroFrames = frames.filter((f) => /^0:0?0$/.test(f.t));
  console.log('LIFECYCLE G: ' + frames.length + ' timer frames, ' +
    zeroFrames.length + ' at zero, first=' + JSON.stringify(frames[0] ?? null));

  // THE REGRESSION: a visible red 0:00 before the real timer appeared. The
  // earlier "0:29 → 0:26" assertion could not see it.
  expect(zeroFrames, 'the timer never paints 0:00 while starting a new quiz').toEqual([]);

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

// ─── I. TIMEOUT WHILE THE QUESTION IS VISIBLE ──────────────────────

test('I: a question that times out in view says so, and explains why', async ({ page }) => {
  await startViaUi(page, /router/i);
  const before = await surfaces(page);
  expect(before.heading, 'starts on the question').not.toContain("Time's up");

  // Let the real 30s deadline pass, untouched.
  await expect(page.locator(HEADING)).toContainText(/Time's up/i, { timeout: 90_000 });

  const after = await surfaces(page);
  console.log('LIFECYCLE I heading: ' + after.heading.slice(0, 110));

  // The notice explains the state change rather than silently swapping in an
  // explanation — which is what made this look like a defect when it happened
  // out of sight.
  expect(after.heading, 'states the reason').toMatch(/Time's up/i);
  expect(after.heading.length, 'and still carries the explanation')
    .toBeGreaterThan("Time's up.".length + 10);
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
test('J: a deadline that passes while hidden is reported on return, not caused by it', async ({ page }) => {
  await startViaUi(page, /router/i);

  const beforeHide = await surfaces(page);
  expect(beforeHide.heading, 'question is showing before we leave').not.toMatch(/Time's up/i);

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

  // The timeout is REPORTED, with its reason — not an unexplained explanation.
  expect(seconds(onReturn.timer), 'the deadline passed while away').toBe(0);
  expect(onReturn.heading, 'the timeout state explains itself').toMatch(/Time's up/i);

  // Resuming must not duplicate or corrupt it: same heading a few seconds later,
  // and no other question's content has bled in.
  await page.waitForTimeout(4000);
  const settled = await surfaces(page);
  expect(settled.heading, 'the state is stable across resume').toBe(onReturn.heading);
  expect((settled.heading.match(/Time's up/gi) ?? []).length, 'stated once, not twice').toBe(1);
});
