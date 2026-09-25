import { Routes } from '@angular/router';

import { QuizResolverService } from '@shared/services/flow/quiz-resolver.service';

import { IntroductionComponent } from
    '../containers/introduction/introduction.component';
import { QuizComponent } from '../containers/quiz/quiz.component';
import { QuizSelectionComponent } from
    '../containers/quiz-selection/quiz-selection.component';
import { ResultsComponent } from '../containers/results/results.component';
import { BuildYourInterviewComponent } from
    '../containers/interview/build-your-interview/build-your-interview.component';
import { InterviewSessionComponent } from
    '../containers/interview/interview-session/interview-session.component';
import { BackendInterviewSessionGuard } from './guards/backend-interview-session-guard';
import { InterviewResultsComponent } from
    '../containers/interview/interview-results/interview-results.component';
import { InterviewHistoryComponent } from
    '../containers/interview/interview-history/interview-history.component';
import { InterviewHistoryDetailComponent } from
    '../containers/interview/interview-history-detail/interview-history-detail.component';
import { InterviewCertificateComponent } from
    '../containers/interview/interview-certificate/interview-certificate.component';

import { QuizGuard } from './guards/quiz-guard';
import { PracticeSessionGuard } from './guards/practice-session-guard';
import { PracticeResultGuard } from './guards/practice-result-guard';
import { WeakAreasPracticeComponent } from '../containers/practice/weak-areas-practice/weak-areas-practice.component';
import { WeakAreasPracticeResultsComponent } from '../containers/practice/weak-areas-practice-results/weak-areas-practice-results.component';
import { BackendInterviewResultGuard } from './guards/backend-interview-result-guard';
import { ProgressPageComponent } from '../containers/progress/progress-page.component';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'quiz',
    pathMatch: 'full'
  },
  {
    path: 'quiz',
    component: QuizSelectionComponent
  },
  {
    path: 'quiz/intro/:quizId',
    component: IntroductionComponent
  },
  {
    path: 'quiz/question/:quizId/:questionIndex',
    component: QuizComponent,
    canActivate: [QuizGuard],
    resolve: { quizData: QuizResolverService },
    runGuardsAndResolvers: 'always'
  },
  {
    path: 'quiz/results/:quizId',
    component: ResultsComponent
  },

  // Interview Mode — Build Your Interview configuration page.
  {
    path: 'interview',
    component: BuildYourInterviewComponent
  },
  // Backend-backed Interview session. The builder creates the assessment on the
  // server and navigates here with the (non-secret) session id; the bearer
  // token stays in sessionStorage. BackendInterviewSessionGuard is the SINGLE
  // hydration path — it resumes once and routes on the outcome.
  {
    path: 'interview/session/:sessionId',
    component: InterviewSessionComponent,
    canActivate: [BackendInterviewSessionGuard]
  },
  // Legacy id-less path: send anyone holding an old link back to the builder.
  { path: 'interview/session', redirectTo: 'interview', pathMatch: 'full' },
  // Interview Results ("Assessment Complete"). The path carries the NON-SECRET
  // session id and nothing else — no token, score, percentage or answers in the
  // URL, query, fragment or router state. The guard loads the frozen backend
  // result through the one shared pipeline the page then renders.
  {
    path: 'interview/results/:sessionId',
    component: InterviewResultsComponent,
    canActivate: [BackendInterviewResultGuard]
  },
  // Id-less legacy path: nothing identifies which attempt to show.
  { path: 'interview/results', redirectTo: 'interview', pathMatch: 'full' },
  // Interview History — read-only record of past attempts. Deep-linkable (reads
  // the durable history store); no session/result required. `:id` reopens ONE
  // attempt's read-only summary. More specific path is listed first.
  {
    path: 'interview/history',
    component: InterviewHistoryComponent
  },
  {
    path: 'interview/history/:id',
    component: InterviewHistoryDetailComponent
  },
  // Angular Interview Master Certificate — the certificate view. Read-only and
  // deep-linkable; shows a friendly locked state until it has been unlocked.
  {
    path: 'interview/certificate',
    component: InterviewCertificateComponent
  },

  // Weak Areas Practice — untimed learning session generated from the user's
  // calculated weak topics. Guarded: the session is created by the Practice
  // action, never by navigating to the URL; direct/stale access redirects to
  // Quiz Selection. A refresh passes because the session rehydrates from
  // sessionStorage before the guard runs.
  {
    path: 'practice/weak-areas',
    component: WeakAreasPracticeComponent,
    canActivate: [PracticeSessionGuard]
  },
  // Practice Results. Guarded: requires a SUBMITTED session with a scored
  // result. The result is persisted with the session snapshot, so a refresh
  // re-renders the same score instead of recomputing it.
  {
    path: 'practice/results',
    component: WeakAreasPracticeResultsComponent,
    canActivate: [PracticeResultGuard]
  },

  // Your Progress — aggregate performance across attempts and modes (Results is
  // ONE attempt; Interview History is individual Interview attempts). Top-level
  // rather than under results/, where `results/:quizId` would capture it as a quiz
  // id. Deliberately UNGUARDED: a user with no history gets an empty state, not a
  // redirect, so the URL always works.
  {
    path: 'progress',
    component: ProgressPageComponent
  },
  // Backward compatibility redirects
  { path: 'select', redirectTo: 'quiz', pathMatch: 'full' },
  { path: 'intro/:quizId', redirectTo: 'quiz/intro/:quizId', pathMatch: 'full' },
  { path: 'question/:quizId/:questionIndex', redirectTo: 'quiz/question/:quizId/:questionIndex', pathMatch: 'full' },
  { path: 'results/:quizId', redirectTo: 'quiz/results/:quizId', pathMatch: 'full' }
];
