import { test, expect, Page, request } from '@playwright/test';
import { SPRING_HEALTH_URL } from './support/e2e-backends';

/**
 * Interview Report — the print-friendly record of the CURRENT finalized attempt.
 *
 * Drives a REAL Interview through the isolated backends the harness starts (a
 * disposable `e2e_*` database). Nothing here opens the native print dialog:
 * `window.print` is replaced in the page and print styling is checked with
 * `page.emulateMedia({ media: 'print' })`.
 */

const RESULTS_URL = /\/interview\/results\/[^/?#]+/;
const REPORT_URL = /\/interview\/report\/([^/?#]+)/;
const SESSION_URL = /\/interview\/session\/([^/?#]+)/;

test.beforeAll(async () => {
  const context = await request.newContext();
  try {
    const response = await context.get(SPRING_HEALTH_URL, { timeout: 5000 });
    expect(response.ok(), `The controlled Spring backend at ${SPRING_HEALTH_URL} is not healthy — Playwright should have started it`).toBe(true);
  } finally {
    await context.dispose();
  }
});

/** Builder → a Custom Interview, ready on the session page (nothing answered). */
async function startCustomInterview(page: Page, count = 10): Promise<void> {
  await page.goto('/interview');
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  await page.locator('.topics-toolbar button:has-text("Select All")').click();
  await expect(boxes.first()).toBeChecked();
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL(SESSION_URL);
}

/** Answer every question (first option) and submit, ending on Results. */
async function answerAndSubmit(page: Page, count = 10): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const option = page.locator('.io-option').first();
    await option.click();
    await expect(option).toHaveClass(/io-selected/);
    if (i < count) {
      await page.locator('.pg-next').first().click();
      await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
    }
  }
  await page.locator('.show-results-btn').click();
  await expect(page.getByText('Submit Assessment?')).toBeVisible();
  await page.locator('button:has-text("Submit Assessment")').last().click();
  await page.waitForURL(RESULTS_URL);
}

const luminance = (rgb: string): number => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test.describe('Interview Report', () => {
  test('a finalized Interview: Results → Export Report → report → Back, with a clean print sheet', async ({ page }) => {
    test.setTimeout(180_000);
    await startCustomInterview(page);
    await answerAndSubmit(page);
    const sessionId = /\/interview\/results\/([^/?#]+)/.exec(page.url())![1];

    // ── Results offers the export (and the print wording is NOT on this page) ──
    const exportLink = page.getByRole('link', { name: 'Export Report' });
    await expect(exportLink).toBeVisible();
    await expect(page.getByRole('button', { name: /Print \/ Save as PDF/ })).toHaveCount(0);
    const resultsPercent = (await page.locator('.score-pct').innerText()).trim();

    await exportLink.click();
    await expect(page).toHaveURL(REPORT_URL);
    expect(REPORT_URL.exec(page.url())![1]).toBe(sessionId);
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeFocused();

    // ── Header + summary ──
    await expect(page.locator('.rp__kind')).toHaveText('Custom Interview');
    await expect(page.locator('.rp__difficulty')).toHaveText('Beginner');
    await expect(page.locator('.rp__date')).toContainText(String(new Date().getFullYear()));
    const summary = await page.locator('.rp-summary > div').evaluateAll((els) =>
      Object.fromEntries(els.map((e) => [e.querySelector('dt')!.textContent!.trim(), e.querySelector('dd')!.textContent!.trim()])));
    expect(Object.keys(summary)).toEqual(['Score', 'Percentage', 'Correct', 'Incorrect', 'Unanswered', 'Total duration', 'Time used']);
    expect(summary['Percentage']).toBe(resultsPercent);                       // same finalized value Results shows
    expect(summary['Score']).toMatch(/^\d+ \/ 10$/);
    expect(Number(summary['Correct']) + Number(summary['Incorrect']) + Number(summary['Unanswered'])).toBe(10);

    // ── Performance by Topic (accessible table) ──
    await expect(page.getByRole('heading', { level: 2, name: 'Performance by Topic' })).toBeVisible();
    const topicRows = page.locator('table.rp-topics tbody tr');
    expect(await topicRows.count()).toBeGreaterThan(0);
    await expect(page.locator('table.rp-topics thead th')).toHaveCount(6);
    const topicTotal = await topicRows.evaluateAll((rows) => rows.reduce((s, r) => s + Number(r.children[4].textContent), 0));
    expect(topicTotal).toBe(10);                                              // topic totals cover every question

    // ── Question Review: every question, with TEXT indicators and no filter control ──
    await expect(page.getByRole('heading', { level: 2, name: 'Question Review' })).toBeVisible();
    const items = page.locator('article.rv-item');
    await expect(items).toHaveCount(10);
    const statuses = await items.evaluateAll((els) =>
      els.map((e) => /You did not answer|Incorrect|Correct/.exec((e.textContent ?? '').replace(/\s+/g, ' '))?.[0] ?? 'NONE'));
    expect(statuses.every((s) => s !== 'NONE')).toBe(true);
    await expect(page.locator('.interview-review .rv-explanation').first()).toBeVisible();
    await expect(page.locator('.rv-filters-toolbar')).toBeHidden();           // report shows the whole record
    await expect(page.locator('.interview-review .rv-summary')).toBeHidden(); // no duplicate summary

    // ── Nothing internal is visible ──
    const visible = await page.evaluate(() => document.body.innerText);
    for (const secret of [sessionId, 'Bearer', 'localhost', '/api/', 'Focus changes']) expect(visible).not.toContain(secret);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /report|answer|review/i.test(k)))).toEqual([]);

    // ── Print action: native print is stubbed; the title is a safe file-name suggestion, then restored ──
    const before = await page.title();
    await page.evaluate(() => { (window as unknown as { __printTitle?: string }).__printTitle = undefined; window.print = () => { (window as unknown as { __printTitle?: string }).__printTitle = document.title; }; });
    await page.getByRole('button', { name: 'Print / Save as PDF' }).click();
    const duringPrint = await page.evaluate(() => (window as unknown as { __printTitle?: string }).__printTitle);
    expect(duringPrint).toMatch(/^Angular-Interview-Report-Custom-\d{4}-\d{2}-\d{2}$/);
    expect(duringPrint).not.toContain(sessionId);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await page.title()).toBe(before);

    // ── Print media: controls hidden, LIGHT and readable even when the app is in dark mode ──
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Back to Results' })).toBeHidden();
    await expect(page.locator('.rv-filters-toolbar')).toBeHidden();
    const paper = await page.evaluate(() => {
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      return {
        pageBg: cs('.rp').backgroundColor, pageText: cs('.rp').color,
        questionText: cs('.rv-question').color, itemBg: cs('article.rv-item').backgroundColor,
        headingText: cs('.rp__title').color
      };
    });
    expect(luminance(paper.pageBg)).toBeGreaterThan(0.9);                     // white page
    for (const dark of [paper.pageText, paper.questionText, paper.headingText]) expect(luminance(dark)).toBeLessThan(0.1);
    expect(luminance(paper.itemBg)).toBeGreaterThan(0.85);                    // light review cards, not the dark theme's
    const pdf = await page.pdf({ format: 'A4' });                             // a real print render, no dialog
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5_000);

    // ── Back on screen: controls return; the saved theme is untouched ──
    await page.emulateMedia({ media: 'screen' });
    await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeVisible();

    // ── Back to Results keeps the finalized result alive (no session ending) ──
    await page.getByRole('link', { name: 'Back to Results' }).click();
    await expect(page).toHaveURL(RESULTS_URL);
    await expect(page.locator('.score-pct')).toHaveText(resultsPercent);
    await expect(page.getByRole('link', { name: 'Export Report' })).toBeVisible();

    // ── Refresh on the report reloads through the same authorized path ──
    await page.getByRole('link', { name: 'Export Report' }).click();
    await expect(page).toHaveURL(REPORT_URL);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('article.rv-item')).toHaveCount(10);
  });

  test('direct navigation with no session token fails closed to the builder', async ({ page }) => {
    await page.goto('/interview/report/does-not-exist');
    await expect(page).toHaveURL(/\/interview$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toHaveCount(0);
    await expect(page.locator('article.rv-item')).toHaveCount(0);
  });

  test('an UNFINISHED Interview cannot open the report or expose any review data', async ({ page }) => {
    test.setTimeout(120_000);
    await startCustomInterview(page);
    const sessionId = SESSION_URL.exec(page.url())![1];
    await page.locator('.io-option').first().click();                         // one answer saved, not submitted

    const resultResponses: number[] = [];
    page.on('response', (r) => { if (/\/interview-sessions\/[^/]+\/result$/.test(r.url())) resultResponses.push(r.status()); });

    await page.goto(`/interview/report/${sessionId}`);                        // full load, token still in this tab
    await expect(page).toHaveURL(new RegExp(`/interview/session/${sessionId}`));   // sent back to the live session
    await expect(page.getByRole('heading', { level: 1, name: 'Interview Report' })).toHaveCount(0);
    await expect(page.locator('article.rv-item')).toHaveCount(0);
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).not.toMatch(/Correct answers:|Explanation/);
    expect(resultResponses.length).toBeGreaterThan(0);
    expect(resultResponses.every((s) => s === 409)).toBe(true);               // the backend refused: "not submitted"
  });
});
