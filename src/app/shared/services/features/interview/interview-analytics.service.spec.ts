import { InterviewResult, InterviewTopicScore, TopicPerformance } from '@shared/models';
import { InterviewAnalyticsService } from './interview-analytics.service';

function topic(quizId: string, title: string, correct: number, total: number): InterviewTopicScore {
  return { quizId, title, correct, total, percentage: Math.round((correct / total) * 100) };
}

function result(perTopic: InterviewTopicScore[]): InterviewResult {
  return {
    total: perTopic.reduce((n, t) => n + t.total, 0),
    answered: 0,
    unanswered: 0,
    correct: perTopic.reduce((n, t) => n + t.correct, 0),
    incorrect: 0,
    percentage: 0,
    timeUsedSeconds: 0,
    timeRemainingSeconds: 0,
    difficulty: 'mixed',
    topicIds: perTopic.map((t) => t.quizId),
    perTopic,
    submittedByExpiry: false,
    focusChanges: 0
  };
}

describe('InterviewAnalyticsService', () => {
  let service: InterviewAnalyticsService;

  beforeEach(() => {
    service = new InterviewAnalyticsService();
  });

  const names = (list: readonly { topicName: string }[]) => list.map((t) => t.topicName);

  // The prompt's worked example.
  const EXAMPLE = [
    topic('templates', 'Templates', 3, 3),           // 100 strong
    topic('forms', 'Angular Forms', 4, 5),           // 80  strong
    topic('di', 'Dependency Injection', 2, 3),       // 67  moderate
    topic('http', 'Angular HTTP', 1, 2),             // 50  weak
    topic('signals', 'Angular Signals', 0, 2)        // 0   weak
  ];

  it('reuses perTopic and computes percentage + band per topic', () => {
    const a = service.analyze(result(EXAMPLE));
    const byId = new Map(a.topics.map((t) => [t.topicId, t]));
    expect(byId.get('templates')).toMatchObject({ correct: 3, total: 3, percentage: 100, band: 'strong' });
    expect(byId.get('di')).toMatchObject({ percentage: 67, band: 'moderate' });
    expect(byId.get('http')).toMatchObject({ percentage: 50, band: 'weak' });
  });

  it('sorts topics best → worst', () => {
    const a = service.analyze(result(EXAMPLE));
    expect(names(a.topics)).toEqual(['Templates', 'Angular Forms', 'Dependency Injection', 'Angular HTTP', 'Angular Signals']);
  });

  it('selects strongest and weakest (disjoint) matching the example', () => {
    const a = service.analyze(result(EXAMPLE));
    // 5 topics → up to min(3, floor(5/2)) = 2 each, no overlap.
    expect(names(a.strongestTopics)).toEqual(['Templates', 'Angular Forms']);
    expect(names(a.weakestTopics)).toEqual(['Angular Signals', 'Angular HTTP']);   // weakest first
    const overlap = a.strongestTopics.filter((s) => a.weakestTopics.some((w) => w.topicId === s.topicId));
    expect(overlap).toHaveLength(0);
  });

  it('handles a single-topic interview (no strongest/weakest ranking)', () => {
    const a = service.analyze(result([topic('http', 'Angular HTTP', 1, 2)]));
    expect(a.topics).toHaveLength(1);
    expect(a.strongestTopics).toHaveLength(0);
    expect(a.weakestTopics).toHaveLength(0);
  });

  it('handles a topic with a single question', () => {
    const a = service.analyze(result([topic('a', 'A', 1, 1), topic('b', 'B', 0, 1)]));
    expect(a.topics.find((t) => t.topicId === 'a')).toMatchObject({ percentage: 100, band: 'strong' });
    expect(a.topics.find((t) => t.topicId === 'b')).toMatchObject({ percentage: 0, band: 'weak' });
    expect(names(a.strongestTopics)).toEqual(['A']);
    expect(names(a.weakestTopics)).toEqual(['B']);
  });

  it('shows no strongest/weakest when every topic scores 100%', () => {
    const a = service.analyze(result([topic('a', 'A', 2, 2), topic('b', 'B', 3, 3), topic('c', 'C', 1, 1)]));
    expect(a.topics.every((t) => t.band === 'strong')).toBe(true);
    expect(a.strongestTopics).toHaveLength(0);
    expect(a.weakestTopics).toHaveLength(0);
  });

  it('shows no strongest/weakest when every topic scores 0%', () => {
    const a = service.analyze(result([topic('a', 'A', 0, 2), topic('b', 'B', 0, 3)]));
    expect(a.topics.every((t) => t.band === 'weak')).toBe(true);
    expect(a.strongestTopics).toHaveLength(0);
    expect(a.weakestTopics).toHaveLength(0);
  });

  it('breaks ties by question count then name (documented, deterministic)', () => {
    // Three topics all at 50%; more questions rank "better" in the best-first
    // list, and alphabetically for equal counts.
    const a = service.analyze(result([
      topic('z', 'Zebra', 2, 4),     // 50%, 4 q
      topic('a', 'Alpha', 1, 2),     // 50%, 2 q
      topic('m', 'Mango', 1, 2),     // 50%, 2 q
      topic('w', 'Wolf', 5, 5)       // 100%, keeps them from being all-equal
    ]));
    // best-first among the 50% trio: Zebra (4q) before Alpha/Mango (2q, A→Z)
    expect(names(a.topics)).toEqual(['Wolf', 'Zebra', 'Alpha', 'Mango']);
    // 4 topics → k=2. Needs-Review is the EXACT reverse of the canonical order,
    // guaranteeing no overlap with Strongest: reverse([Wolf,Zebra,Alpha,Mango]) =
    // [Mango,Alpha,Zebra,Wolf] → weakest = [Mango, Alpha].
    expect(names(a.strongestTopics)).toEqual(['Wolf', 'Zebra']);
    expect(names(a.weakestTopics)).toEqual(['Mango', 'Alpha']);
    const overlap = a.strongestTopics.filter((s) => a.weakestTopics.some((w) => w.topicId === s.topicId));
    expect(overlap).toHaveLength(0);
  });

  it('returns empty analytics for an empty / missing result', () => {
    expect(service.analyze(null).topics).toHaveLength(0);
    expect(service.analyze(result([])).topics).toHaveLength(0);
    expect(service.analyze(result([])).strongestTopics).toHaveLength(0);
  });

  it('ignores topics with zero questions', () => {
    const a = service.analyze(result([topic('a', 'A', 2, 2), { quizId: 'ghost', title: 'Ghost', correct: 0, total: 0, percentage: 0 }]));
    expect(a.topics.map((t) => t.topicId)).toEqual(['a']);
  });

  it('returns an immutable model (frozen arrays)', () => {
    const a = service.analyze(result(EXAMPLE));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.topics)).toBe(true);
    expect(() => (a.topics as TopicPerformance[]).push({} as never)).toThrow();
  });
});
