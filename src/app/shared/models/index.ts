/**
 * Public surface of the shared models: the top-level model, type and enum files only.
 *
 * Consumers OUTSIDE shared/models may import from '@shared/models'. Rules that keep
 * this barrel from becoming a source of cycles:
 *
 *  - Files inside shared/models/** must NOT import this barrel; they keep direct
 *    relative imports of the sibling model files they need.
 *  - These modules also keep DIRECT model-file imports (never this barrel), because
 *    routing them through it forms a (type-level) cycle:
 *      shared/utils/difficulty-quota, shared/utils/weak-areas,
 *      shared/utils/interview-topic-history, directives/highlight-option.directive
 *  - Deliberately NOT exported: models/api/** (wire DTOs), models/interview/**
 *    (session-reference and view models), spec files, and anything that is not a
 *    top-level model file (services, components, directives, utils).
 */
export * from './achievement.model';
export * from './AnimationState.type';
export * from './Answer.type';
export * from './AssessmentConfig.model';
export * from './AssessmentIntegrityState.model';
export * from './CombinedQuestionDataType.model';
export * from './difficulty-recommendation.model';
export * from './FeedbackConfig.model';
export * from './FeedbackProps.model';
export * from './Final-Result.model';
export * from './FormattedExplanation.model';
export * from './GeneratedAssessment.model';
export * from './interview-analytics.model';
export * from './interview-certificate.model';
export * from './interview-history.model';
export * from './interview-preset.model';
export * from './interview-readiness.model';
export * from './interview-topic-trends.model';
export * from './InterviewResult.model';
export * from './InterviewSession.model';
export * from './learning-path.model';
export * from './Option.model';
export * from './OptionBindings.model';
export * from './OptionClickedPayload.model';
export * from './performance-insights.model';
export * from './PracticeResult.model';
export * from './progress.model';
export * from './QAPayload.model';
export * from './question-type.enum';
export * from './QuestionPayload.model';
export * from './QuestionState.model';
export * from './quiz-routes.enum';
export * from './quiz-status.enum';
export * from './Quiz.model';
export * from './QuizFilter.type';
export * from './QuizMetadata.model';
export * from './QuizQuestion.model';
export * from './QuizQuestionEvent.type';
export * from './QuizResource.model';
export * from './QuizScore.model';
export * from './QuizSelectionParams.model';
export * from './QuizSort.type';
export * from './Resource.model';
export * from './Result.model';
export * from './SelectedOption.model';
export * from './SharedOptionConfig.model';
export * from './ShuffleState.model';
export * from './topic-performance-history.model';
