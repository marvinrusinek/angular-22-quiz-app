import {
  buildInterviewSessionRequest,
  InterviewBuilderRequestError
} from './interview-builder-request.mapper';
import {
  DEV_API_BASE_URL,
  isApiConfigured,
  normalizeBaseUrl,
  PROD_API_BASE_URL,
  resolveApiBaseUrl
} from '../../tokens/api-base-url.token';

const custom = {
  presetId: null,
  difficulty: 'mixed',
  topicIds: ['rxjs', 'signals'],
  questionCount: 20
};

describe('preset mapping', () => {
  it('sends EXACTLY mode and presetId', () => {
    const request = buildInterviewSessionRequest({ ...custom, presetId: 'junior' });
    expect(request).toEqual({ mode: 'preset', presetId: 'junior' });
    expect(Object.keys(request).sort()).toEqual(['mode', 'presetId']);
  });

  it('ignores the Custom controls entirely when a preset is selected', () => {
    const request = buildInterviewSessionRequest({
      presetId: 'senior', difficulty: 'beginner', topicIds: ['http'], questionCount: 10
    });
    const serialized = JSON.stringify(request);
    for (const leaked of ['difficulty', 'topicIds', 'questionCount', 'http', 'beginner']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it.each(['junior', 'mid-level', 'senior'])('accepts the real preset id %s', (presetId) => {
    expect(buildInterviewSessionRequest({ ...custom, presetId }))
      .toEqual({ mode: 'preset', presetId });
  });

  it.each(['', '  ', 'Junior!', 'a'.repeat(40), '../etc'])('rejects malformed preset id %p', (presetId) => {
    expect(() => buildInterviewSessionRequest({ ...custom, presetId }))
      .toThrow(InterviewBuilderRequestError);
  });
});

describe('custom mapping', () => {
  it('sends EXACTLY the four permitted fields', () => {
    const request = buildInterviewSessionRequest(custom);
    expect(request).toEqual({
      mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs', 'signals'], questionCount: 20
    });
    expect(Object.keys(request).sort())
      .toEqual(['difficulty', 'mode', 'questionCount', 'topicIds']);
  });

  it('never sends duration, ids, ordering or correctness', () => {
    const serialized = JSON.stringify(buildInterviewSessionRequest(custom));
    for (const banned of [
      'duration', 'questionIds', 'optionIds', 'questions', 'options',
      'correct', 'correctOptionIds', 'score', 'expiresAt', 'sessionToken'
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('preserves topic ORDER', () => {
    const request = buildInterviewSessionRequest({ ...custom, topicIds: ['signals', 'rxjs', 'http'] });
    expect((request as unknown as { topicIds: string[] }).topicIds).toEqual(['signals', 'rxjs', 'http']);
  });

  it('trims topic ids and drops blanks', () => {
    const request = buildInterviewSessionRequest({ ...custom, topicIds: [' rxjs ', '', 'signals'] });
    expect((request as unknown as { topicIds: string[] }).topicIds).toEqual(['rxjs', 'signals']);
  });

  it.each([
    ['no difficulty', { ...custom, difficulty: null }],
    ['blank difficulty', { ...custom, difficulty: '   ' }],
    ['no topics', { ...custom, topicIds: [] }],
    ['blank topics only', { ...custom, topicIds: ['  '] }],
    ['duplicate topics', { ...custom, topicIds: ['rxjs', 'rxjs'] }],
    ['no question count', { ...custom, questionCount: null }],
    ['float question count', { ...custom, questionCount: 10.5 }]
  ])('rejects %s', (_label, state) => {
    expect(() => buildInterviewSessionRequest(state)).toThrow(InterviewBuilderRequestError);
  });

  it.each([10, 20, 30])('accepts the real question count %i', (questionCount) => {
    expect(buildInterviewSessionRequest({ ...custom, questionCount }))
      .toMatchObject({ questionCount });
  });
});

describe('API configuration resolver', () => {
  it('development is configured and resolves the local URL', () => {
    expect(isApiConfigured(true)).toBe(true);
    expect(resolveApiBaseUrl(true)).toBe(DEV_API_BASE_URL);
  });

  /**
   * Resolution must be TOTAL: it runs in an injection factory, and throwing
   * here took down every component injecting InterviewApiService — the
   * /interview route rendered nothing at all on GitHub Pages. The fail-closed
   * decision belongs to isApiConfigured() at the call site.
   */
  it('production resolves the configured origin, and isApiConfigured tracks it', () => {
    // Written against the constant, so it holds whether or not a host is
    // currently configured — the RELATIONSHIP is what matters.
    expect(() => resolveApiBaseUrl(false)).not.toThrow();
    expect(resolveApiBaseUrl(false)).toBe(PROD_API_BASE_URL);
    expect(isApiConfigured(false)).toBe(PROD_API_BASE_URL.trim().length > 0);
  });

  it('normalizes trailing slashes deterministically', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});
