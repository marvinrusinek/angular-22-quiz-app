import { DifficultyDistribution, isValidDistribution } from '@shared/utils/difficulty-quota';

/**
 * Role-Based Interview Presets — the SINGLE authoritative definition.
 *
 * Nothing else in the app may hard-code a preset name, duration, question count
 * or difficulty split; every surface reads these objects. Ids are the runtime
 * identity (display text never is), and `topicIds` are real quizIds from
 * quiz.json so there is no fragile title matching.
 *
 * DATA NOTE: difficulty in this app is a property of a TOPIC (quiz), not of an
 * individual question. A "60% beginner" split therefore means 60% of questions
 * drawn from beginner-difficulty topics.
 */

/** Stable runtime identity for a role preset. */
export type InterviewPresetId = 'junior' | 'mid-level' | 'senior';

/** What the builder is currently configured to produce. */
export type InterviewConfigKind = 'custom' | 'preset';

export interface InterviewPreset {
  readonly id: InterviewPresetId;
  readonly name: string;
  /** Compact label for the Quick Setup chips (the full name goes in the preview). */
  readonly shortLabel: string;
  readonly description: string;
  readonly questionCount: number;
  readonly durationMinutes: number;
  readonly difficultyDistribution: DifficultyDistribution;
  readonly topicIds: readonly string[];
}

/** Shown wherever a preset mix is displayed, so the mixes aren't over-claimed. */
export const PRESET_DISCLAIMER =
  'Preset mixes are representative; real interview requirements vary by employer.';

/** Label used for non-preset interviews in Results and History. */
export const CUSTOM_INTERVIEW_LABEL = 'Custom Interview';

/**
 * Topic mappings use real quizIds. Two requested topics DO NOT EXIST in the
 * question bank and are deliberately omitted rather than faked:
 *   - "Security fundamentals" (Mid-Level)
 *   - "Angular Security"      (Senior)
 * There is no security quiz in quiz.json, and this feature must not add one.
 */
export const INTERVIEW_PRESETS: readonly InterviewPreset[] = Object.freeze([
  Object.freeze({
    id: 'junior',
    name: 'Junior Angular Developer',
    shortLabel: 'Junior',
    description: 'Fundamentals-focused practice for entry-level Angular interviews.',
    questionCount: 15,
    durationMinutes: 20,
    difficultyDistribution: Object.freeze({ beginner: 60, intermediate: 40, advanced: 0 }),
    topicIds: Object.freeze([
      // beginner
      'typescript', 'create-first-app', 'templates', 'directives', 'pipes', 'angular-cli',
      // intermediate
      'component-tree', 'dependency-injection', 'router', 'forms'
    ])
  }),
  Object.freeze({
    id: 'mid-level',
    name: 'Mid-Level Angular Developer',
    shortLabel: 'Mid-Level',
    description: 'Balanced practice covering day-to-day Angular application development.',
    questionCount: 20,
    durationMinutes: 30,
    difficultyDistribution: Object.freeze({ beginner: 20, intermediate: 60, advanced: 20 }),
    topicIds: Object.freeze([
      // beginner
      'typescript', 'templates',
      // intermediate
      'component-tree', 'forms', 'router', 'http', 'testing', 'dependency-injection', 'material',
      // advanced
      'change-detection', 'rxjs', 'signals'
    ])
  }),
  Object.freeze({
    id: 'senior',
    name: 'Senior Angular Developer',
    shortLabel: 'Senior',
    description:
      'Advanced practice emphasizing architecture, performance, and technical decision-making.',
    questionCount: 25,
    durationMinutes: 40,
    difficultyDistribution: Object.freeze({ beginner: 10, intermediate: 40, advanced: 50 }),
    topicIds: Object.freeze([
      // intermediate
      'performance', 'testing', 'http',
      // advanced
      'rxjs', 'signals', 'change-detection', 'component-architecture',
      'dependency-injection-advanced', 'design-patterns'
    ])
  })
] as const);

/** Lookup by stable id. Returns undefined for an unknown/legacy id. */
export function findInterviewPreset(id: string | null | undefined): InterviewPreset | undefined {
  return INTERVIEW_PRESETS.find((preset) => preset.id === id);
}

/** Display label for a completed interview — preset name, else "Custom Interview". */
export function interviewConfigLabel(
  kind: InterviewConfigKind | undefined,
  presetId: string | undefined,
  presetNameSnapshot?: string
): string {
  if (kind !== 'preset') return CUSTOM_INTERVIEW_LABEL;
  // Prefer the snapshot taken at completion so a historical entry keeps the name
  // it was earned under even if a preset is later renamed; fall back to the live
  // definition, and finally to Custom for an unrecognisable record.
  return presetNameSnapshot || findInterviewPreset(presetId)?.name || CUSTOM_INTERVIEW_LABEL;
}

export interface PresetValidationIssue {
  presetId: string;
  problem: string;
}

/**
 * Validate the preset table against the live catalog. Pure and dependency-free
 * (the caller passes the catalog) so it runs in tests and at startup alike.
 *
 * Checks: unique ids; nonnegative shares totalling 100; positive counts and
 * durations; at least one topic; every topicId exists; and — because difficulty
 * lives on the topic — that each nonzero-weighted difficulty actually has a
 * topic of that difficulty to draw from.
 */
export function validateInterviewPresets(
  catalog: readonly { quizId: string; difficulty?: string }[],
  presets: readonly InterviewPreset[] = INTERVIEW_PRESETS
): PresetValidationIssue[] {
  const issues: PresetValidationIssue[] = [];
  const seen = new Set<string>();
  const difficultyById = new Map(catalog.map((q) => [q.quizId, q.difficulty]));

  for (const preset of presets) {
    if (seen.has(preset.id)) issues.push({ presetId: preset.id, problem: 'duplicate preset id' });
    seen.add(preset.id);

    if (!isValidDistribution(preset.difficultyDistribution)) {
      issues.push({ presetId: preset.id, problem: 'difficulty distribution must be nonnegative and total 100' });
    }
    if (!Number.isInteger(preset.questionCount) || preset.questionCount <= 0) {
      issues.push({ presetId: preset.id, problem: 'questionCount must be a positive integer' });
    }
    if (!Number.isFinite(preset.durationMinutes) || preset.durationMinutes <= 0) {
      issues.push({ presetId: preset.id, problem: 'durationMinutes must be positive' });
    }
    if (preset.topicIds.length === 0) {
      issues.push({ presetId: preset.id, problem: 'at least one topic is required' });
    }

    for (const topicId of preset.topicIds) {
      if (!difficultyById.has(topicId)) {
        issues.push({ presetId: preset.id, problem: `unknown topic id "${topicId}"` });
      }
    }

    // A nonzero weight with no topic of that difficulty can never be filled from
    // the preset's own topics; the builder redistributes it, so surface it here.
    for (const [difficulty, share] of Object.entries(preset.difficultyDistribution)) {
      if (share <= 0) continue;
      const hasTopic = preset.topicIds.some((id) => difficultyById.get(id) === difficulty);
      if (!hasTopic) {
        issues.push({
          presetId: preset.id,
          problem: `${share}% weighted to "${difficulty}" but no ${difficulty} topic is configured`
        });
      }
    }
  }

  return issues;
}
