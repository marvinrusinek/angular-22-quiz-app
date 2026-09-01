import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import {
  ErrorHandler,
  inject,
  isDevMode,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app/router/quiz-routing.routes';
import { AppComponent } from './app/app.component';
import { AnswerComponent } from './app/components/question/answer/answer-component/answer.component';
import { ANSWER_COMPONENT } from './app/shared/tokens/answer-component.token';
import { PwaUpdateService } from './app/shared/services/pwa-update.service';
import { GlobalErrorHandler, installGlobalErrorLogging } from './app/shared/utils/error-logging';
import { provideApiBaseUrl } from './app/shared/tokens/api-base-url.token';
import { provideApiTopicQuizVerdictAdapter } from './app/shared/services/features/verdict/verdict-adapter';
import { InterviewSessionReferenceStorage } from './app/shared/services/interview/interview-session-reference.storage';

installGlobalErrorLogging();

bootstrapApplication(AppComponent, {
  providers: [
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideZonelessChangeDetection(),
    // Provide AnswerComponent eagerly (imported here at the bootstrap entry,
    // outside the cyclic graph) so DynamicComponentService creates it without a
    // lazy import() — no separate chunk to fetch (fixes StackBlitz cold-load
    // "Failed to fetch dynamically imported module"), no circular dependency.
    { provide: ANSWER_COMPONENT, useValue: AnswerComponent },
    // NOTE: no provideClientHydration() here. This app is client-only (static
    // GitHub Pages build, no SSR), so there is never serialized server state to
    // hydrate from. Angular 22 warns about exactly that combination (NG0505),
    // and the provider did nothing for us, so it is gone rather than silenced.
    provideHttpClient(withFetch()),
    // Base URL for the private quiz API. Provided centrally so no service or
    // component hard-codes a host.
    provideApiBaseUrl(),
    // Topic Quiz correctness comes from POST /check, not from option.correct.
    // The token defaults to the LOCAL adapter so the unit suite needs no HTTP
    // mock; the running application opts into the API here, and there is no
    // fallback to the local answer key if the API is unreachable.
    provideApiTopicQuizVerdictAdapter(),
    provideRouter(routes),
    provideAnimations(),
    // S6p: the client-bank fetch that used to run here (an APP_INITIALIZER
    // GET of assets/data/quiz.json, populating the quiz-data-cache module for
    // QuizService.quizInitialState et al.) is removed along with the asset
    // and every remaining production consumer of that cache — see the Stage
    // 14 S6p final report. quiz-data-cache.ts's module state now simply
    // stays at its own empty defaults for the app's whole lifetime.
    /**
     * Purge Interview storage keys that must no longer exist on disk.
     *
     * `interviewSession` (v1) held a full generated assessment INCLUDING the
     * answer key; `interviewResultRefs:v1` briefly held read-only bearer
     * tokens. Removing them from the code is not enough — a returning user
     * still has the values in their browser, so they are deleted on startup.
     * Idempotent, and scoped to an explicit key list.
     */
    provideAppInitializer(() => {
      const removed = inject(InterviewSessionReferenceStorage).purgeLegacyKeys();
      if (removed.length > 0) {
        console.log(`[bootstrap] purged legacy Interview keys: ${removed.join(', ')}`);
      }
    }),
    // Prompt deployed users to reload onto a freshly-deployed bundle.
    provideAppInitializer(() => inject(PwaUpdateService).init()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
}).catch((err: any) => console.error(err));
