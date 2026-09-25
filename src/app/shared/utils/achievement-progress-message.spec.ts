import { AchievementId } from '@shared/models/achievement.model';
import { achievementCompletionMessage } from './achievement-progress-message';

const set = (...ids: AchievementId[]) => new Set<AchievementId>(ids);

// The 4/6 state: every quiz achievement earned, but Interview Master + Explorer not.
const FOUR_OF_SIX = set(
  'perfect-score', 'beginner-complete', 'intermediate-complete', 'advanced-complete'
);

describe('achievementCompletionMessage', () => {
  it('at 4/6 (Interview Master locked) guides to Interview Mode — never claims all done', () => {
    const msg = achievementCompletionMessage(FOUR_OF_SIX);
    expect(msg).toBe(
      'All topic quizzes completed!\nUnlock the remaining achievements in Interview Mode.'
    );
    expect(msg).not.toMatch(/every achievement/i);   // not a "finished" claim
  });

  it('once Interview Master is earned (but Explorer not) nudges toward Angular Explorer', () => {
    const msg = achievementCompletionMessage(set(...FOUR_OF_SIX, 'interview-master'));
    expect(msg).toContain('Interview Master earned');
    expect(msg).toContain('Angular Explorer');
    expect(msg).not.toMatch(/Every achievement unlocked/);
  });

  it('when all six are earned shows the true final message', () => {
    const msg = achievementCompletionMessage(set(...FOUR_OF_SIX, 'interview-master', 'angular-explorer'));
    expect(msg).toBe('Every achievement unlocked! You are an Angular Explorer.');
  });

  it('never uses the retired "Angular master" wording in any state', () => {
    const states = [
      set(),
      FOUR_OF_SIX,
      set(...FOUR_OF_SIX, 'interview-master'),
      set(...FOUR_OF_SIX, 'interview-master', 'angular-explorer')
    ];
    for (const s of states) {
      expect(achievementCompletionMessage(s)).not.toMatch(/angular master/i);
    }
  });
});
