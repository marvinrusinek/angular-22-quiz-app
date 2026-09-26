import { AchievementDefinition } from '@shared/models';

/**
 * Single source of truth for achievement display metadata. Referenced by the
 * evaluation service and the presentation components — never duplicated.
 */
// Order defines the achievement PROGRESSION shown in the catalog: quiz mastery
// first, then interview proficiency, then the capstone Explorer (which unlocks
// once every other achievement is earned).
export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  { id: 'perfect-score', icon: '🏆', name: 'Perfect Score', description: 'Earn a 100% score on any quiz.' },
  { id: 'beginner-complete', icon: '🌱', name: 'Beginner Complete', description: 'Complete every Beginner quiz.' },
  { id: 'intermediate-complete', icon: '🚀', name: 'Intermediate Complete', description: 'Complete every Intermediate quiz.' },
  { id: 'advanced-complete', icon: '🎓', name: 'Advanced Complete', description: 'Complete every Advanced quiz.' },
  { id: 'interview-master', icon: '💼', name: 'Interview Master', description: 'Achieve the highest Interview Readiness tier and score at least 90% in Interview Mode.' },
  { id: 'angular-explorer', icon: '🌍', name: 'Angular Explorer', description: 'Unlock every other achievement.' }
] as const;
