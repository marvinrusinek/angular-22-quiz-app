import { AchievementId } from '@shared/models/achievement.model';

/**
 * Truthful completion message for the Quiz Selection banner, shown once every
 * topic quiz has been accessed. It reflects ACTUAL achievement state — it never
 * claims "all done" at 4 / 6 — and guides the user toward the remaining
 * achievements:
 *  - Interview Master still locked → point them at Interview Mode.
 *  - Interview Master earned, Angular Explorer not yet → nudge toward the final.
 *  - All six earned → the true final message.
 *
 * Pure + presentation-free so the wording is easy to test and can't drift from a
 * hard-coded "all quizzes accessed" condition.
 */
export function achievementCompletionMessage(earned: ReadonlySet<AchievementId>): string {
  if (earned.has('angular-explorer')) {
    return 'Every achievement unlocked! You are an Angular Explorer.';
  }
  if (earned.has('interview-master')) {
    return 'All topic quizzes completed and Interview Master earned! Finish the remaining achievements to become an Angular Explorer.';
  }
  // The '\n' renders as a line break in the banner (white-space: pre-line):
  //   All topic quizzes completed!
  //   Unlock the remaining achievements in Interview Mode.
  return 'All topic quizzes completed!\nUnlock the remaining achievements in Interview Mode.';
}
