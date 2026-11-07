import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsCatalogComponent } from './achievements-catalog.component';
import { AchievementView } from '@shared/models';

// The catalog is an always-visible section (heading + named rows), with no disclosure button.
const VIEW: AchievementView[] = [
  { id: 'perfect-score', name: 'Perfect Score', description: 'Earn a 100% score on any quiz.', earned: true },
  { id: 'angular-explorer', name: 'Angular Explorer', description: 'Complete every available quiz.', earned: false },
  { id: 'beginner-complete', name: 'Beginner Complete', description: 'Complete every Beginner quiz.', earned: false }
];

describe('AchievementsCatalogComponent (always visible)', () => {
  let fixture: ComponentFixture<AchievementsCatalogComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AchievementsCatalogComponent] });
    fixture = TestBed.createComponent(AchievementsCatalogComponent);
  });

  const setAchievements = (list: AchievementView[]): void => {
    fixture.componentRef.setInput('achievements', list);
    fixture.detectChanges();
  };
  const root = (): HTMLElement => fixture.nativeElement;
  const items = (): NodeListOf<HTMLElement> => root().querySelectorAll('.achievements-catalog__item');

  it('renders nothing when the list is empty', () => {
    setAchievements([]);
    expect(root().querySelector('.achievements-catalog')).toBeNull();
  });

  it('shows a heading with the earned count and ALL rows immediately, with no disclosure control', () => {
    setAchievements(VIEW);
    const heading = root().querySelector('h3.achievements-catalog__heading') as HTMLElement;
    expect(heading.textContent?.replace(/\s+/g, ' ').trim()).toContain('Achievements, 1 of 3');
    expect(items().length).toBe(3);
    expect(root().querySelector('button')).toBeNull();
    expect(root().querySelector('[aria-expanded]')).toBeNull();
    expect(root().querySelector('[tabindex]')).toBeNull();
  });

  it('each row is ONE named graphic: "<name>. <description>. <Earned|Locked>."; duplicate visual children hidden; nothing interactive', () => {
    setAchievements(VIEW);
    const rows = Array.from(items());
    expect(rows.map((li) => li.getAttribute('role'))).toEqual(['img', 'img', 'img']);
    expect(rows.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Perfect Score. Earn a 100% score on any quiz. Earned.',
      'Angular Explorer. Complete every available quiz. Locked.',
      'Beginner Complete. Complete every Beginner quiz. Locked.'
    ]);
    rows.forEach((li) => {
      expect(li.querySelector('.achievements-catalog__body')?.getAttribute('aria-hidden')).toBe('true');
      expect(li.querySelector('.achievements-catalog__badge')?.getAttribute('aria-hidden')).toBe('true');
      expect(li.querySelector('.achievements-catalog__state-icon')?.getAttribute('aria-hidden')).toBe('true');
      expect(li.querySelectorAll('button, a, input, [tabindex]').length).toBe(0);
    });
  });

  it('distinguishes earned vs locked with state class + text (not color only)', () => {
    setAchievements(VIEW);
    const rows = items();
    expect(rows[0].classList.contains('is-earned')).toBe(true);
    expect(rows[0].textContent).toContain('Earned');
    expect(rows[1].classList.contains('is-locked')).toBe(true);
    expect(rows[1].textContent).toContain('Locked');
  });

  it('rowLabel drops only a terminal period', () => {
    setAchievements(VIEW);
    const c = fixture.componentInstance;
    expect(c.rowLabel({ ...VIEW[0], description: 'Earn it.' })).toBe('Perfect Score. Earn it. Earned.');
    expect(c.rowLabel({ ...VIEW[1], description: 'Do it... now.' })).toBe('Angular Explorer. Do it... now. Locked.');
  });
});
