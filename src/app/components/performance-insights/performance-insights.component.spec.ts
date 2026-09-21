import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { PerformanceInsights } from '../../shared/models/performance-insights.model';
import {
  buildPerformanceInsights,
  PerformanceInsightsInput,
  TopicRecordLike
} from '../../shared/utils/performance-insights';
import { calculateWeakTopics, TopicAttemptLike } from '../../shared/utils/weak-areas';
import { PerformanceInsightsComponent, TOPICS_COLLAPSED_COUNT } from './performance-insights.component';

// ── factories ───────────────────────────────────────────────────────

const day = (n: number): string => new Date(Date.UTC(2026, 6, n, 10, 0, 0)).toISOString();

const rec = (
  attemptId: string,
  source: TopicRecordLike['source'],
  n: number,
  correct: number,
  total: number
): TopicRecordLike => ({ attemptId, source, completedAt: day(n), correct, total });

type TopicSpec = [topicId: string, correct: number, total: number];

const att = (n: number, topics: TopicSpec[]): TopicAttemptLike => ({
  completedAt: day(n),
  topicPerformance: topics.map(([topicId, correct, total]) => ({
    topicId,
    topicName: topicId.toUpperCase(),
    correct,
    total,
    percentage: total > 0 ? (correct / total) * 100 : 0
  }))
});

function insightsFrom(over: Partial<PerformanceInsightsInput> = {}): PerformanceInsights {
  const attempts = over.attempts ?? [];
  return buildPerformanceInsights({
    topicRecords: [],
    interviewAttempts: [],
    attempts,
    needsReview: calculateWeakTopics(attempts),
    ...over
  });
}

/** Four Topic Quiz attempts: previous two at 78%, recent two at 84% → +6 pts. */
const quizRecords = (recentCorrect = 84, previousCorrect = 78): TopicRecordLike[] => [
  rec('q1', 'topic-quiz', 1, previousCorrect, 100),
  rec('q2', 'topic-quiz', 2, previousCorrect, 100),
  rec('q3', 'topic-quiz', 3, recentCorrect, 100),
  rec('q4', 'topic-quiz', 4, recentCorrect, 100)
];

describe('PerformanceInsightsComponent', () => {
  let fixture: ComponentFixture<PerformanceInsightsComponent>;
  let el: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PerformanceInsightsComponent],
      providers: [provideRouter([])]
    });
    fixture = TestBed.createComponent(PerformanceInsightsComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  const show = (insights: PerformanceInsights | null): void => {
    fixture.componentRef.setInput('insights', insights);
    fixture.detectChanges();
  };

  const norm = (node: Element | null | undefined): string =>
    (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const q = (sel: string): HTMLElement | null => el.querySelector<HTMLElement>(sel);
  const qa = (sel: string): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(sel));
  const section = (headingId: string): HTMLElement | null =>
    el.querySelector<HTMLElement>(`section[aria-labelledby="${headingId}"]`);
  const overview = (source: string): HTMLElement | null =>
    q(`section[aria-labelledby="pi-overview-heading"] li[data-source="${source}"]`);
  const recent = (source: string): HTMLElement | null =>
    q(`section[aria-labelledby="pi-recent-heading"] li[data-source="${source}"]`);

  // ── empty and limited data ────────────────────────────────────────

  describe('empty and limited-data states', () => {
    it('renders nothing when there are no insights to show', () => {
      show(null);
      expect(el.querySelector('.pi')).toBeNull();
    });

    it('shows a neutral empty state with no history', () => {
      show(insightsFrom());
      expect(norm(q('.pi__empty'))).toBe('Complete quizzes or interviews to build your performance history.');
      expect(qa('.pi__item')).toHaveLength(0);
      expect(q('.pi__note')).toBeNull();
    });

    it('with ONLY Topic Quiz history, shows no Interview or Practice rows at all', () => {
      show(insightsFrom({ topicRecords: quizRecords() }));
      expect(overview('topic-quiz')).not.toBeNull();
      expect(overview('interview')).toBeNull();
      expect(overview('weak-areas-practice')).toBeNull();
      expect(q('a[href="/interview/history"]')).toBeNull();
      expect(norm(el)).not.toMatch(/Interview Mode|Weak Areas Practice/);
    });

    it('with ONLY Interview history, shows no Topic Quiz or Practice rows', () => {
      show(insightsFrom({
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }]
      }));
      expect(overview('interview')).not.toBeNull();
      expect(overview('topic-quiz')).toBeNull();
      expect(overview('weak-areas-practice')).toBeNull();
      expect(norm(overview('interview'))).toContain('70%');
      expect(norm(overview('interview'))).toContain('7 / 10 questions');
    });

    it('with ONLY Practice history, it is labelled Practice and never Topic Quiz', () => {
      show(insightsFrom({ topicRecords: [rec('p1', 'weak-areas-practice', 1, 2, 4)] }));
      expect(norm(overview('weak-areas-practice'))).toContain('Weak Areas Practice');
      expect(norm(overview('weak-areas-practice'))).toContain('drawn from your weaker topics');
      expect(overview('topic-quiz')).toBeNull();
      expect(norm(el)).not.toContain('Topic Quiz');
    });

    it('with ONE attempt, shows its accuracy and sample size but no comparison', () => {
      show(insightsFrom({ topicRecords: [rec('q1', 'topic-quiz', 1, 3, 4)] }));
      expect(norm(overview('topic-quiz'))).toContain('75%');
      expect(norm(overview('topic-quiz'))).toContain('3 / 4 questions · 1 attempt');
      expect(norm(recent('topic-quiz'))).toContain('Not enough history for a comparison yet.');
    });

    it('with insufficient comparison history, never displays a 0-point delta', () => {
      // 3 attempts: below the 4 needed for two windows of 2.
      show(insightsFrom({
        topicRecords: [rec('q1', 'topic-quiz', 1, 5, 10), rec('q2', 'topic-quiz', 2, 6, 10), rec('q3', 'topic-quiz', 3, 7, 10)]
      }));
      const text = norm(section('pi-recent-heading'));
      expect(text).toContain('Not enough history for a comparison yet.');
      expect(text).not.toMatch(/pts/);
      expect(text).not.toMatch(/Recent \d+%/);
    });
  });

  // ── overview: source separation ───────────────────────────────────

  describe('performance overview', () => {
    const mixed = (): PerformanceInsights =>
      insightsFrom({
        topicRecords: [
          ...quizRecords(),
          rec('p1', 'weak-areas-practice', 5, 1, 10)
        ],
        interviewAttempts: [
          { id: 'i1', completedAt: day(2), score: 6, totalQuestions: 10 },
          { id: 'i2', completedAt: day(6), score: 9, totalQuestions: 10 }
        ]
      });

    it('lists Topic Quiz, Interview Mode and Weak Areas Practice separately, in that order', () => {
      show(mixed());
      const rows = qa('section[aria-labelledby="pi-overview-heading"] li');
      expect(rows.map((r) => r.dataset['source'])).toEqual(['topic-quiz', 'interview', 'weak-areas-practice']);
      expect(norm(rows[0])).toContain('Topic Quiz');
      expect(norm(rows[1])).toContain('Interview Mode');
      expect(norm(rows[2])).toContain('Weak Areas Practice');
    });

    it('gives each source its own accuracy, question counts and attempt count', () => {
      show(mixed());
      expect(norm(overview('topic-quiz'))).toContain('81%');                 // (78+78+84+84)/400 = 324/400
      expect(norm(overview('topic-quiz'))).toContain('324 / 400 questions · 4 attempts');
      expect(norm(overview('interview'))).toContain('75%');
      expect(norm(overview('interview'))).toContain('15 / 20 questions · 2 attempts');
      expect(norm(overview('weak-areas-practice'))).toContain('10%');
      expect(norm(overview('weak-areas-practice'))).toContain('1 / 10 questions · 1 attempt');
    });

    it('states what each source measures, so they cannot be read as one thing', () => {
      show(mixed());
      expect(norm(overview('topic-quiz'))).toContain('Instant feedback, retries allowed.');
      expect(norm(overview('interview'))).toContain('One submission, no feedback until the end.');
      expect(norm(overview('weak-areas-practice'))).toContain('drawn from your weaker topics');
    });

    it('NEVER shows a combined Topic Quiz + Interview figure or a skill score', () => {
      show(mixed());
      const text = norm(el);
      // Blending all of it: (324 + 15 + 1) / (400 + 20 + 10) = 340/430 = 79%.
      expect(text).not.toContain('79%');
      expect(text).not.toMatch(/overall|combined|skill|rating/i);
    });

    it('never puts a percentage on screen without its question count', () => {
      show(mixed());
      for (const row of qa('section[aria-labelledby="pi-overview-heading"] li')) {
        expect(norm(row)).toMatch(/\d+%/);
        expect(norm(row)).toMatch(/\d+ \/ \d+ questions/);
      }
    });

    it('pluralises attempts correctly', () => {
      show(mixed());
      expect(norm(overview('weak-areas-practice'))).toContain('1 attempt');
      expect(norm(overview('weak-areas-practice'))).not.toContain('1 attempts');
    });
  });

  // ── recent vs previous ────────────────────────────────────────────

  describe('recent performance', () => {
    it('shows transparent percentages and a signed point delta', () => {
      show(insightsFrom({ topicRecords: quizRecords(84, 78) }));
      const row = recent('topic-quiz')!;
      expect(norm(row)).toContain('+6 pts');
      expect(norm(row)).toContain('Recent 84% · Previous 78%');
      expect(norm(row)).toContain('Latest 2 attempts (168 / 200 questions) compared with the 2 before (156 / 200)');
    });

    it('shows a decrease with a true minus sign', () => {
      show(insightsFrom({ topicRecords: quizRecords(60, 90) }));
      expect(norm(recent('topic-quiz'))).toContain('−30 pts');
      expect(norm(recent('topic-quiz'))).toContain('Recent 60% · Previous 90%');
    });

    it('shows a genuine no-change comparison as 0 pts', () => {
      show(insightsFrom({ topicRecords: quizRecords(80, 80) }));
      expect(norm(recent('topic-quiz'))).toContain('0 pts');
      expect(norm(recent('topic-quiz'))).not.toContain('Not enough history');
    });

    it('exposes the change to assistive tech in words', () => {
      show(insightsFrom({ topicRecords: quizRecords(84, 78) }));
      expect(recent('topic-quiz')!.querySelector('.pi__figure')!.getAttribute('aria-label')).toBe('up 6 percentage points');

      show(insightsFrom({ topicRecords: quizRecords(60, 90) }));
      expect(recent('topic-quiz')!.querySelector('.pi__figure')!.getAttribute('aria-label')).toBe('down 30 percentage points');

      show(insightsFrom({ topicRecords: quizRecords(80, 80) }));
      expect(recent('topic-quiz')!.querySelector('.pi__figure')!.getAttribute('aria-label')).toBe('no change, 0 percentage points');
    });

    it('never labels a change good, bad, improving or declining', () => {
      for (const records of [quizRecords(90, 50), quizRecords(50, 90), quizRecords(70, 70)]) {
        show(insightsFrom({ topicRecords: records }));
        expect(norm(section('pi-recent-heading'))).not.toMatch(/improv|declin|good|bad|better|worse|great|struggl/i);
      }
    });

    it('always lists Topic Quiz and Interview here, comparison or not', () => {
      show(insightsFrom({
        topicRecords: [rec('q1', 'topic-quiz', 1, 3, 4)],
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 5, totalQuestions: 10 }]
      }));
      expect(recent('topic-quiz')).not.toBeNull();
      expect(recent('interview')).not.toBeNull();
    });

    it('lists Practice here only once its comparison is real', () => {
      show(insightsFrom({ topicRecords: [rec('p1', 'weak-areas-practice', 1, 2, 4)] }));
      expect(recent('weak-areas-practice')).toBeNull();

      show(insightsFrom({
        topicRecords: [
          rec('p1', 'weak-areas-practice', 1, 2, 10), rec('p2', 'weak-areas-practice', 2, 2, 10),
          rec('p3', 'weak-areas-practice', 3, 6, 10), rec('p4', 'weak-areas-practice', 4, 6, 10)
        ]
      }));
      expect(norm(recent('weak-areas-practice'))).toContain('+40 pts');
    });
  });

  // ── topics ────────────────────────────────────────────────────────

  describe('performance by topic', () => {
    it('shows name, percentage and correct / total for each topic', () => {
      show(insightsFrom({ attempts: [att(1, [['signals', 22, 24]])] }));
      const row = q('section[aria-labelledby="pi-topics-heading"] li[data-topic="signals"]')!;
      expect(norm(row)).toContain('SIGNALS');
      expect(norm(row)).toContain('92%');
      expect(norm(row)).toContain('22 / 24 questions');
    });

    it('shows an under-sampled topic with its counts but does not rate it', () => {
      show(insightsFrom({ attempts: [att(1, [['http', 2, 2]])] }));
      const row = q('section[aria-labelledby="pi-topics-heading"] li[data-topic="http"]')!;
      expect(norm(row)).toContain('2 / 2 questions');
      expect(norm(row)).toContain('too few answers to rate yet');
      expect(norm(row)).not.toContain('100%');
    });

    it('collapses a long list and expands it on demand', () => {
      const many: TopicSpec[] = Array.from({ length: 8 }, (_, i) => [`t${i + 1}`, 4, 5 + i] as TopicSpec);
      show(insightsFrom({ attempts: [att(1, many)] }));

      const items = (): HTMLElement[] => qa('section[aria-labelledby="pi-topics-heading"] li');
      const toggle = q('.pi__toggle') as HTMLButtonElement;
      expect(items()).toHaveLength(TOPICS_COLLAPSED_COUNT);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(norm(toggle)).toBe('Show all 8 topics');

      toggle.click();
      fixture.detectChanges();
      expect(items()).toHaveLength(8);
      expect((q('.pi__toggle') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('true');
      expect(norm(q('.pi__toggle'))).toBe('Show fewer topics');

      (q('.pi__toggle') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(items()).toHaveLength(TOPICS_COLLAPSED_COUNT);
    });

    it('offers no toggle when the whole list already fits', () => {
      show(insightsFrom({ attempts: [att(1, [['a', 4, 5], ['b', 4, 5]])] }));
      expect(q('.pi__toggle')).toBeNull();
    });

    it('omits the topic sections when no topic has answers', () => {
      show(insightsFrom({ topicRecords: [rec('q1', 'topic-quiz', 1, 3, 4)] }));   // records but no topic attempts
      expect(section('pi-topics-heading')).toBeNull();
      expect(section('pi-strongest-heading')).toBeNull();
    });
  });

  // ── strongest / needs review ──────────────────────────────────────

  describe('Strongest Topics and Needs Review', () => {
    const attempts = [att(1, [['weak', 5, 10], ['solid', 9, 10], ['great', 10, 10], ['tiny', 2, 2]])];

    const topicIn = (headingId: string): string[] =>
      qa(`section[aria-labelledby="${headingId}"] li[data-topic]`).map((li) => li.dataset['topic']!);

    it('lists Strongest best-first with counts', () => {
      show(insightsFrom({ attempts }));
      expect(topicIn('pi-strongest-heading')).toEqual(['great', 'solid']);
      const row = q('section[aria-labelledby="pi-strongest-heading"] li[data-topic="great"]')!;
      expect(norm(row)).toContain('100%');
      expect(norm(row)).toContain('10 / 10 questions');
    });

    it('lists Needs Review with its counts, from the Weak Areas result', () => {
      show(insightsFrom({ attempts }));
      expect(topicIn('pi-review-heading')).toEqual(['weak']);
      const row = q('section[aria-labelledby="pi-review-heading"] li[data-topic="weak"]')!;
      expect(norm(row)).toContain('50%');
      expect(norm(row)).toContain('5 / 10 questions');
    });

    it('never shows one topic under BOTH Strongest and Needs Review', () => {
      show(insightsFrom({ attempts }));
      const strong = new Set(topicIn('pi-strongest-heading'));
      for (const id of topicIn('pi-review-heading')) expect(strong.has(id)).toBe(false);
    });

    describe('several topics render as separate rows', () => {
      // 3 weak (33%, 67%, 72%) and 3 strong (95%, 91%, 100%) — the most each list shows.
      const many = [att(1, [
        ['signals', 3, 9], ['http', 2, 3], ['di', 18, 25],
        ['router', 21, 22], ['forms', 10, 11], ['pipes', 10, 10]
      ])];

      const rows = (headingId: string): HTMLElement[] =>
        qa(`section[aria-labelledby="${headingId}"] ul > li`);

      it.each([
        ['pi-review-heading', ['signals', 'http', 'di'], ['SIGNALS', 'HTTP', 'DI'], ['33%', '67%', '72%']],
        ['pi-strongest-heading', ['pipes', 'router', 'forms'], ['PIPES', 'ROUTER', 'FORMS'], ['100%', '95%', '91%']]
      ])('%s: one <li> per topic inside one <ul>, each holding only its own name and figure',
        (headingId, ids, names, figures) => {
          show(insightsFrom({ attempts: many }));

          const list = q(`section[aria-labelledby="${headingId}"] ul`) as HTMLElement;
          expect(list.tagName).toBe('UL');
          expect(rows(headingId)).toHaveLength(3);
          expect(rows(headingId).map((li) => li.dataset['topic'])).toEqual(ids);

          rows(headingId).forEach((li, i) => {
            expect(li.tagName).toBe('LI');
            // Exactly one name and one figure per row — nothing shared with a neighbour.
            expect(li.querySelectorAll('.pi__name')).toHaveLength(1);
            expect(li.querySelectorAll('.pi__figure')).toHaveLength(1);
            expect(norm(li.querySelector('.pi__name'))).toBe(names[i]);
            expect(norm(li.querySelector('.pi__figure'))).toBe(figures[i]);
            // …and no other topic's name leaks into this row.
            for (const other of names.filter((_, j) => j !== i)) expect(norm(li)).not.toContain(other);
          });
        });

      it('keeps every row of both lists apart from the other list', () => {
        show(insightsFrom({ attempts: many }));
        const review = new Set(rows('pi-review-heading').map((li) => li.dataset['topic']));
        for (const li of rows('pi-strongest-heading')) expect(review.has(li.dataset['topic'])).toBe(false);
      });
    });

    it('does not rank an under-sampled topic as strongest', () => {
      show(insightsFrom({ attempts }));
      expect(topicIn('pi-strongest-heading')).not.toContain('tiny');
    });

    it('explains an empty Strongest list using the real Weak Areas thresholds', () => {
      show(insightsFrom({ attempts: [att(1, [['weak', 2, 10]])] }));
      expect(norm(section('pi-strongest-heading'))).toContain(
        'No topic qualifies yet. A topic needs at least 3 answered questions and 80% or better.'
      );
    });

    it('hides Needs Review entirely when nothing needs review', () => {
      show(insightsFrom({ attempts: [att(1, [['solid', 9, 10]])] }));
      expect(section('pi-review-heading')).toBeNull();
    });
  });

  // ── interview link and retention ──────────────────────────────────

  describe('interview trend reuse and retention disclosure', () => {
    it('links to the existing Interview History rather than rebuilding trends', () => {
      show(insightsFrom({
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }]
      }));
      const link = q('a.pi__link')!;
      expect(link.getAttribute('href')).toBe('/interview/history');
      expect(norm(link)).toBe('View interview history');
      // No embedded chart or duplicate trend widget.
      expect(q('svg')).toBeNull();
      expect(q('app-performance-trends')).toBeNull();
    });

    it('discloses that only recent activity is counted, for the sources present', () => {
      show(insightsFrom({
        topicRecords: quizRecords(),
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }]
      }));
      const note = norm(q('.pi__note'));
      expect(note).toBe(
        'Based on your saved recent activity only: your 200 most recent topic results and 20 most recent interviews. Older results are not included.'
      );
      expect(note).not.toMatch(/lifetime|all.?time/i);
    });

    it('mentions only the retention that applies to what is shown', () => {
      show(insightsFrom({
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }]
      }));
      expect(norm(q('.pi__note'))).toContain('20 most recent interviews');
      expect(norm(q('.pi__note'))).not.toContain('topic results');
    });

    it('states the topic-result window once even when Topic Quiz and Practice are both present', () => {
      show(insightsFrom({
        topicRecords: [rec('q1', 'topic-quiz', 1, 3, 4), rec('p1', 'weak-areas-practice', 2, 2, 4)]
      }));
      expect(norm(q('.pi__note')).match(/200 most recent topic results/g)).toHaveLength(1);
    });
  });

  // ── accessibility and layout ──────────────────────────────────────

  describe('accessibility and responsive-safe markup', () => {
    const full = (): PerformanceInsights =>
      insightsFrom({
        topicRecords: quizRecords(),
        interviewAttempts: [{ id: 'i1', completedAt: day(1), score: 7, totalQuestions: 10 }],
        attempts: [att(1, [['weak', 5, 10], ['solid', 9, 10]])]
      });

    it('labels every section by a heading that exists', () => {
      show(full());
      for (const s of qa('section[aria-labelledby]')) {
        const id = s.getAttribute('aria-labelledby')!;
        const heading = el.querySelector(`#${id}`);
        expect(heading).not.toBeNull();
        expect(norm(heading).length).toBeGreaterThan(0);
      }
    });

    it('uses a real heading hierarchy: one h3 with h4 sections beneath', () => {
      show(full());
      expect(qa('h3')).toHaveLength(1);
      expect(norm(q('h3'))).toBe('Performance Insights');
      expect(qa('h4').map((h) => norm(h))).toEqual([
        'Performance Overview', 'Recent Performance', 'Performance by Topic', 'Strongest Topics', 'Needs Review'
      ]);
    });

    it('is built from lists and stacked rows — no table, no fixed-size inline styles', () => {
      show(full());
      expect(q('table')).toBeNull();
      expect(qa('ul.pi__list').length).toBeGreaterThan(0);
      expect(qa('[style]')).toHaveLength(0);
    });

    it('makes the topic toggle a real button with aria-expanded', () => {
      const many: TopicSpec[] = Array.from({ length: 7 }, (_, i) => [`t${i}`, 4, 5] as TopicSpec);
      show(insightsFrom({ attempts: [att(1, many)] }));
      const toggle = q('.pi__toggle')!;
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('type')).toBe('button');
      expect(toggle.hasAttribute('aria-expanded')).toBe(true);
    });

    it('conveys every value as text, never by colour alone', () => {
      show(full());
      // Nothing is styled by a good/bad modifier class.
      expect(qa('[class*="--up"], [class*="--down"], [class*="--good"], [class*="--bad"]')).toHaveLength(0);
    });
  });
});
