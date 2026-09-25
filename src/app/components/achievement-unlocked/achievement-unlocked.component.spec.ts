import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementUnlockedComponent } from './achievement-unlocked.component';
import { AchievementDefinition } from '@shared/models/achievement.model';

const PERFECT: AchievementDefinition = {
  id: 'perfect-score', name: 'Perfect Score', description: 'Earn a 100% score on any quiz.'
};
const EXPLORER: AchievementDefinition = {
  id: 'angular-explorer', name: 'Angular Explorer', description: 'Complete every available quiz.'
};

describe('AchievementUnlockedComponent', () => {
  let fixture: ComponentFixture<AchievementUnlockedComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AchievementUnlockedComponent] });
    fixture = TestBed.createComponent(AchievementUnlockedComponent);
  });

  const setAchievements = (list: AchievementDefinition[]): void => {
    fixture.componentRef.setInput('achievements', list);
    fixture.detectChanges();
  };
  const root = (): HTMLElement | null => fixture.nativeElement.querySelector('.achievement-unlocked');
  const items = (): NodeListOf<HTMLElement> =>
    fixture.nativeElement.querySelectorAll('.achievement-unlocked__item');

  it('renders one earned achievement with its name and description', () => {
    setAchievements([PERFECT]);
    expect(items().length).toBe(1);
    expect(root()?.textContent).toContain('Perfect Score');
    expect(root()?.textContent).toContain('Earn a 100% score on any quiz.');
  });

  it('renders multiple earned achievements', () => {
    setAchievements([PERFECT, EXPLORER]);
    expect(items().length).toBe(2);
    expect(root()?.textContent).toContain('Perfect Score');
    expect(root()?.textContent).toContain('Angular Explorer');
  });

  it('renders nothing when there are no newly-earned achievements', () => {
    setAchievements([]);
    expect(root()).toBeNull();
  });

  it('renders nothing by default (no input set)', () => {
    fixture.detectChanges();
    expect(root()).toBeNull();
  });

  it('exposes accessible text (heading + polite live region, not color-only)', () => {
    setAchievements([PERFECT]);
    const section = root() as HTMLElement;
    expect(section.getAttribute('role')).toBe('status');
    expect(section.getAttribute('aria-live')).toBe('polite');
    // Meaning is carried by text, readable without the icon.
    expect(section.querySelector('h3')?.textContent).toContain('Achievement Unlocked');
  });
});
