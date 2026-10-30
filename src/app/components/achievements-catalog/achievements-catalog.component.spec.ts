import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsCatalogComponent } from './achievements-catalog.component';
import { AchievementView } from '@shared/models';

const VIEW: AchievementView[] = [
  {
    id: 'perfect-score',
    name: 'Perfect Score',
    description: 'Earn a 100% score on any quiz.',
    earned: true
  },
  {
    id: 'angular-explorer',
    name: 'Angular Explorer',
    description: 'Complete every available quiz.',
    earned: false
  },
  {
    id: 'beginner-complete',
    name: 'Beginner Complete',
    description: 'Complete every Beginner quiz.',
    earned: false
  }
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

  it('keeps the description text and ends it with a non-breaking space before the status', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const desc = items()[0].querySelector('.achievements-catalog__desc')?.textContent ?? '';
    expect(desc).toBe('Earn a 100% score on any quiz.\u00a0');
    expect(items()[0].textContent).toContain('Earned');
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

  it('suppresses native list semantics (no list/listitem, no "N of M") while keeping every row text', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const ul = fixture.nativeElement.querySelector('ul') as HTMLElement;
    expect(ul.getAttribute('role')).toBe('none');
    expect(ul.querySelector('[aria-posinset],[aria-setsize]')).toBeNull();
    items().forEach((li) => expect(li.getAttribute('role')).toBe('none'));
    expect(items()[0].textContent).toContain('Perfect Score');
    expect(items()[0].textContent).toContain('Earned');
    expect(items()[1].textContent).toContain('Locked');
  });
});
