import { test, expect } from '@playwright/test';
import { HEADING, FEEDBACK, correctIndexForHeading, tsQuiz, diQuiz, correctRowsForHeading, findMultiAnswerQuestion } from './helpers';

/**
 * COLD-START PRELOAD — scoreboard/congratulations font + sound cues.
 *
 * THE BUG: `span.scoreboard`'s custom font (DjbUpOnTheScoreboard) and the
 * correct/incorrect cues (sound.service.ts) are fetched from externally
 * hosted CDNs (raw.githubusercontent.com, cdn.jsdelivr.net) with no preload
 * hint. On a genuinely cold first visit, the browser only starts fetching
 * them once the scoreboard first renders / the first cue is due, so the
 * scoreboard visibly used the fallback font and the first cue played late,
 * for that first attempt only — a warm second attempt already had both
 * cached. Proven live: `document.fonts.check()` + actual canvas text-metrics
 * comparison read false/fallback on a cold first render even against the
 * real localhost dev server, and true again on an in-app "Restart Quiz".
 *
 * THE FIX adds `<link rel="preload">` hints in index.html for both remote
 * font files and both sound files — the exact pattern already used for the
 * self-hosted Material Icons font in the same file (see its comment). This
 * starts the fetch at document-load time, in parallel with the Angular
 * bundle, well before the scoreboard or SoundService is ever constructed.
 * No SoundService/Howler architecture change — `preload: true` there was
 * already correct; the only thing that changed is WHEN the browser could
 * start the network fetch.
 *
 * These specs deliberately avoid asserting on a fixed millisecond threshold
 * against the real remote CDNs (that would be flaky) — they assert the
 * application's *preload/request behavior* instead: the hint tags exist,
 * and the requests are observed to begin at document load, before the user
 * has done anything that could plausibly trigger a fetch on its own.
 */

const FONT_URLS = [
  'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/fonts/DjbUpOnTheScoreboard.ttf',
  'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/fonts/LucidaUnicodeCalligraphy.ttf',
];
const SOUND_URLS = [
  'https://cdn.jsdelivr.net/gh/marvinrusinek/angular-22-quiz-app@main/src/assets/sounds/correct.mp3',
  'https://cdn.jsdelivr.net/gh/marvinrusinek/angular-22-quiz-app@main/src/assets/sounds/incorrect.mp3',
];

test.describe('cold-start preload — scoreboard font + sound cues', () => {
  test('the document declares preload hints for both remote fonts and both sound cues', async ({ page }) => {
    await page.goto('/');

    for (const url of [...FONT_URLS, ...SOUND_URLS]) {
      const link = page.locator(`link[rel="preload"][href="${url}"]`);
      await expect(link, `missing <link rel="preload"> for ${url}`).toHaveCount(1);
    }

    const fontAs = await page.locator(`link[rel="preload"][href="${FONT_URLS[0]}"]`).getAttribute('as');
    expect(fontAs).toBe('font');
    const soundAs = await page.locator(`link[rel="preload"][href="${SOUND_URLS[0]}"]`).getAttribute('as');
    // Howler decodes these via XHR/fetch into a Web Audio buffer, not an
    // <audio> element — "fetch" is the correct destination (and the one
    // Chromium accepts without an "unsupported as value" warning).
    expect(soundAs).toBe('fetch');
  });

  test('all four preload requests begin at initial document load, before the user starts a quiz', async ({ page }) => {
    const seenBeforeAnyInteraction = new Set<string>();
    page.on('request', (req) => {
      const url = req.url();
      if (FONT_URLS.includes(url) || SOUND_URLS.includes(url)) seenBeforeAnyInteraction.add(url);
    });

    await page.goto('/');
    // Give the browser's preload scanner a moment to issue the requests —
    // no quiz interaction has happened yet at this point.
    await page.waitForTimeout(500);

    for (const url of [...FONT_URLS, ...SOUND_URLS]) {
      expect(seenBeforeAnyInteraction.has(url), `expected ${url} to have been requested by document load`).toBe(true);
    }
  });

  test('the scoreboard font is available on the very first Topic Quiz attempt, not only after a second one', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('.start-btn').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20000 });

    // No console/CORS/preload warnings should accompany the fix.
    const badMessages: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') badMessages.push(msg.text());
    });

    // Generous timeout tolerant of real (non-mocked) CDN latency — this
    // is an eventual-availability check, not a speed assertion.
    await page.waitForFunction(
      () => {
        try { return document.fonts.check("30px 'DjbUpOnTheScoreboard'"); } catch { return false; }
      },
      { timeout: 15000 }
    );

    expect(badMessages.filter((m) => /preload|CORS|cross-origin/i.test(m))).toEqual([]);
  });

  test('no regression: single-answer correctness, timer-stop and FET remain correct on this same first attempt', async ({ page }) => {
    await page.goto('/quiz/intro/fixture-widgets');
    await page.locator('.start-btn').click();
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20000 });

    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(heading);
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    await page.locator('.option-row').nth(correctIdx).click();
    await expect(page.locator(FEEDBACK)).toBeVisible({ timeout: 10000 });

    const timerText = () => page.locator('.scoreboard-timer .scoreboard').textContent();
    const t1 = await timerText();
    await page.waitForTimeout(1200);
    const t2 = await timerText();
    expect(t2, 'a correct single-answer pick must still stop the timer').toBe(t1);
  });

  test('no regression: multi-answer incremental highlighting, completion and timer-stop remain correct on this same first attempt', async ({ page }) => {
    const MULTI = findMultiAnswerQuestion(diQuiz);
    await page.goto(`/quiz/question/fixture-gadgets/${MULTI.index}`);
    await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20000 });

    const rows = page.locator('.option-row');
    const heading = (await page.locator(HEADING).textContent()) ?? '';
    const corrects = await correctRowsForHeading(rows, diQuiz, heading);
    expect(corrects.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < corrects.length - 1; i++) {
      await rows.nth(corrects[i]).click();
      await page.waitForTimeout(300);
      await expect(rows.nth(corrects[i])).toHaveClass(/correct-option/);
    }

    await rows.nth(corrects[corrects.length - 1]).click();
    await expect(rows.nth(corrects[corrects.length - 1])).toHaveClass(/correct-option/);
    await expect(page.locator(FEEDBACK)).toBeVisible({ timeout: 10000 });

    const timerText = () => page.locator('.scoreboard-timer .scoreboard').textContent();
    const t1 = await timerText();
    await page.waitForTimeout(1200);
    const t2 = await timerText();
    expect(t2, 'completing the multi-answer question must still stop the timer').toBe(t1);
  });
});
