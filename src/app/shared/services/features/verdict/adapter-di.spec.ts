import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { ApiTopicQuizVerdictAdapter } from './api-verdict.adapter';
import { LocalTopicQuizVerdictAdapter } from './local-verdict.adapter.service';
import {
  TOPIC_QUIZ_VERDICT_ADAPTER,
  provideApiTopicQuizVerdictAdapter
} from './verdict-adapter';

/**
 * WHICH ADAPTER THE APPLICATION SELECTS.
 *
 * The token defaults to the LOCAL adapter so ~1700 unit tests need no HTTP
 * mock. Production overrides that at bootstrap. This is a one-line decision
 * with a large blast radius — if the override were ever dropped, the app would
 * quietly go back to reading `option.correct` from the bundled bank and every
 * test would still pass. So it gets its own test.
 */

function configure(providers: unknown[] = []) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ...(providers as never[])
    ]
  });
}

describe('adapter selection', () => {
  it('defaults to the LOCAL adapter when nothing overrides it', () => {
    configure();
    expect(TestBed.inject(TOPIC_QUIZ_VERDICT_ADAPTER))
      .toBeInstanceOf(LocalTopicQuizVerdictAdapter);
  });

  it('provideApiTopicQuizVerdictAdapter() selects the API adapter', () => {
    configure([provideApiTopicQuizVerdictAdapter()]);

    const adapter = TestBed.inject(TOPIC_QUIZ_VERDICT_ADAPTER);
    expect(adapter).toBeInstanceOf(ApiTopicQuizVerdictAdapter);
    expect(adapter).not.toBeInstanceOf(LocalTopicQuizVerdictAdapter);
  });

  it('resolves to the SAME instance the injector holds', () => {
    configure([provideApiTopicQuizVerdictAdapter()]);

    // useExisting, not useClass — one adapter, so its in-memory receipt cache
    // is shared rather than duplicated per injection site.
    expect(TestBed.inject(TOPIC_QUIZ_VERDICT_ADAPTER))
      .toBe(TestBed.inject(ApiTopicQuizVerdictAdapter));
  });
});

describe('the application bootstrap opts in', () => {
  /**
   * Asserts the WIRING DECISION, not behaviour.
   *
   * Bootstrap cannot be executed in a unit test, but dropping this one line
   * from main.ts is the exact regression that would send production back to
   * the local answer key with the whole suite still green. Reading the source
   * is crude; leaving the decision untested is worse.
   */
  it('main.ts selects the API adapter', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs') as typeof import('fs');
    const source = readFileSync(
      require('path').resolve(__dirname, '../../../../../main.ts'),
      'utf8'
    );

    expect(source).toContain('provideApiTopicQuizVerdictAdapter()');
    // …and it must not have been commented out.
    expect(source).not.toMatch(/\/\/\s*provideApiTopicQuizVerdictAdapter\(\)/);
  });
});
