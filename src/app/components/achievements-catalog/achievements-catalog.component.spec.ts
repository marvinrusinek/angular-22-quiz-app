import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsCatalogComponent } from './achievements-catalog.component';
import { AchievementView } from '@shared/models';

// The catalog is an always-visible section (heading + group rows), with no disclosure button.
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
    TestBed.tick();
  };
  const root = (): HTMLElement => fixture.nativeElement;
  const items = (): NodeListOf<HTMLElement> => root().querySelectorAll('.achievements-catalog__item');
  const groups = (): HTMLElement[] =>
    Array.from(root().querySelectorAll<HTMLElement>('.achievements-catalog__row'));
  const exposed = (g: HTMLElement): HTMLElement => g.querySelector('.intro-exposed-text') as HTMLElement;

  it('renders nothing when the list is empty', () => {
    setAchievements([]);
    expect(root().querySelector('.achievements-catalog')).toBeNull();
  });

  it('keeps the heading with the earned count SEPARATE from the rows, with no disclosure control', () => {
    setAchievements(VIEW);
    const heading = root().querySelector('h3.achievements-catalog__heading') as HTMLElement;
    expect(heading.textContent?.replace(/\s+/g, ' ').trim()).toContain('Achievements, 1 of 3');
    // The heading is not inside any row group, and no group spans the whole section.
    expect(heading.closest('[role="group"]')).toBeNull();
    expect(items().length).toBe(3);
    expect(groups()).toHaveLength(3);
    expect(root().querySelectorAll('[role="group"]')).toHaveLength(3);
    expect(root().querySelector('button')).toBeNull();
    expect(root().querySelector('[aria-expanded]')).toBeNull();
    expect(root().querySelector('[tabindex]')).toBeNull();
  });

  it('each row is ONE group (not a graphic) exposing one text node: "<name>. <description>. <Earned|Locked>."', () => {
    setAchievements(VIEW);
    expect(groups().map((g) => g.getAttribute('role'))).toEqual(['group', 'group', 'group']);
    expect(root().querySelector('[role="img"]')).toBeNull();
    expect(groups().map((g) => g.hasAttribute('aria-label'))).toEqual([false, false, false]);
    for (const g of groups()) {
      expect(exposed(g).childNodes).toHaveLength(1);
      expect(exposed(g).firstChild?.nodeType).toBe(Node.TEXT_NODE);
    }
    expect(groups().map((g) => exposed(g).textContent)).toEqual([
      'Perfect Score. Earn a 100% score on any quiz. Earned.',
      'Angular Explorer. Complete every available quiz. Locked.',
      'Beginner Complete. Complete every Beginner quiz. Locked.'
    ]);
  });

  it('hides every visible part of a row from AT as one unit, and the exposed text is outside it', () => {
    setAchievements(VIEW);
    for (const g of groups()) {
      const visible = g.querySelector('[data-intro-visible]')!;
      expect(visible.getAttribute('aria-hidden')).toBe('true');
      expect(visible.querySelector('.achievements-catalog__state-icon')).not.toBeNull();
      expect(visible.querySelector('.achievements-catalog__body')).not.toBeNull();
      expect(visible.querySelector('.achievements-catalog__badge')).not.toBeNull();
      expect(exposed(g).closest('[aria-hidden="true"]')).toBeNull();
      expect(g.querySelectorAll('button, a, input, [tabindex]').length).toBe(0);
    }
  });

  it('shares the same text between the visible parts and the exposed text', () => {
    setAchievements(VIEW);
    const c = fixture.componentInstance;
    groups().forEach((g, i) => {
      const a = VIEW[i];
      expect(g.querySelector('.achievements-catalog__name')?.textContent?.trim()).toBe(a.name);
      expect(g.querySelector('.achievements-catalog__desc')?.textContent?.trim()).toBe(a.description);
      // The visible badge and the exposed text use the SAME status label.
      expect(g.querySelector('.achievements-catalog__badge')?.textContent?.trim()).toBe(c.statusLabel(a));
      expect(exposed(g).textContent).toBe(c.rowLabel(a));
      expect(exposed(g).textContent!.endsWith(`${c.statusLabel(a)}.`)).toBe(true);
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

  it('follows a change in state: a locked row that becomes earned reads "Earned" in both places', () => {
    setAchievements(VIEW);
    setAchievements([VIEW[0], { ...VIEW[1], earned: true }, VIEW[2]]);
    const g = groups()[1];
    expect(exposed(g).textContent).toBe('Angular Explorer. Complete every available quiz. Earned.');
    expect(g.querySelector('.achievements-catalog__badge')?.textContent?.trim()).toBe('Earned');
    expect(exposed(g).childNodes).toHaveLength(1);
    expect(root().querySelector('h3')?.textContent).toContain('Achievements, 2 of 3');
  });

  it('shows the actual count in the heading for any state (0 of 3, 3 of 3)', () => {
    setAchievements(VIEW.map((a) => ({ ...a, earned: false })));
    expect(root().querySelector('h3')?.textContent?.replace(/\s+/g, ' ')).toContain('Achievements, 0 of 3');
    setAchievements(VIEW.map((a) => ({ ...a, earned: true })));
    expect(root().querySelector('h3')?.textContent?.replace(/\s+/g, ' ')).toContain('Achievements, 3 of 3');
  });

  it('rowLabel drops only a terminal period', () => {
    setAchievements(VIEW);
    const c = fixture.componentInstance;
    expect(c.rowLabel({ ...VIEW[0], description: 'Earn it.' })).toBe('Perfect Score. Earn it. Earned.');
    expect(c.rowLabel({ ...VIEW[1], description: 'Do it... now.' })).toBe('Angular Explorer. Do it... now. Locked.');
  });
});
