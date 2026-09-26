import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsCatalogComponent } from './achievements-catalog.component';
import { AchievementView } from '@shared/models';

const VIEW: AchievementView[] = [
  { id: 'perfect-score', name: 'Perfect Score', description: 'Earn a 100% score on any quiz.', earned: true },
  { id: 'angular-explorer', name: 'Angular Explorer', description: 'Complete every available quiz.', earned: false },
  { id: 'beginner-complete', name: 'Beginner Complete', description: 'Complete every Beginner quiz.', earned: false }
];

describe('AchievementsCatalogComponent', () => {
  let fixture: ComponentFixture<AchievementsCatalogComponent>;
  let component: AchievementsCatalogComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AchievementsCatalogComponent] });
    fixture = TestBed.createComponent(AchievementsCatalogComponent);
    component = fixture.componentInstance;
  });

  const setAchievements = (list: AchievementView[]): void => {
    fixture.componentRef.setInput('achievements', list);
    fixture.detectChanges();
  };
  const toggleBtn = (): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector('.achievements-catalog__toggle');
  const items = (): NodeListOf<HTMLElement> =>
    fixture.nativeElement.querySelectorAll('.achievements-catalog__item');

  it('renders nothing when the list is empty', () => {
    setAchievements([]);
    expect(fixture.nativeElement.querySelector('.achievements-catalog')).toBeNull();
  });

  it('shows the earned count in the collapsed header (X / N)', () => {
    setAchievements(VIEW);
    expect(toggleBtn()?.textContent?.replace(/\s+/g, ' ')).toContain('1 / 3');
  });

  it('is collapsed by default — the list is not rendered', () => {
    setAchievements(VIEW);
    expect(items().length).toBe(0);
    expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands on click to show ALL achievements', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(items().length).toBe(3);
    expect(toggleBtn()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('distinguishes earned vs locked with state class + text (not color only)', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const rows = items();
    expect(rows[0].classList.contains('is-earned')).toBe(true);
    expect(rows[0].textContent).toContain('Earned');
    expect(rows[1].classList.contains('is-locked')).toBe(true);
    expect(rows[1].textContent).toContain('Locked');
  });

  it('toggles back to collapsed on a second click', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(component.expanded()).toBe(false);
    expect(items().length).toBe(0);
  });
});
