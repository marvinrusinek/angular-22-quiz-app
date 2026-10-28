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

  it('keeps the full visible description (with its period) in each row', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const desc = items()[1].querySelector('.achievements-catalog__desc')?.textContent ?? '';
    expect(desc.trim()).toBe('Complete every available quiz.');
    expect(items()[1].textContent).toContain('Locked');
  });

  it('names the toggle with ONE complete label "Achievements, <earned> of <total>" and keeps its disclosure semantics', () => {
    setAchievements(VIEW);
    const btn = toggleBtn()!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('Achievements, 1 of 3');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('achievements-catalog-list');
    // The visible label and count are unchanged.
    expect(btn.textContent?.replace(/\s+/g, ' ')).toContain('Achievements');
    expect(btn.textContent?.replace(/\s+/g, ' ')).toContain('1 / 3');
    setAchievements(VIEW.map((a) => ({ ...a, earned: true })));
    expect(toggleBtn()!.getAttribute('aria-label')).toBe('Achievements, 3 of 3');
  });

  it('has no list semantics (no item positions); every row is ONE named graphic in order', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const ul = fixture.nativeElement.querySelector('#achievements-catalog-list') as HTMLElement;
    expect(ul.getAttribute('role')).toBe('none');
    expect(ul.querySelector('[aria-posinset],[aria-setsize]')).toBeNull();
    const rows = items();
    expect(rows.length).toBe(3);
    // EXPERIMENT: the first row is plain text (role none); the others stay named graphics.
    expect(rows[0].getAttribute('role')).toBe('none');
    Array.from(rows)
      .slice(1)
      .forEach((li) => expect(li.getAttribute('role')).toBe('img'));
    expect(
      Array.from(rows)
        .slice(1)
        .map((li) => li.getAttribute('aria-label'))
    ).toEqual([
      'Angular Explorer. Complete every available quiz. Locked.',
      'Beginner Complete. Complete every Beginner quiz. Locked.'
    ]);
  });

  it('hides every row visual name, description, status and icons from assistive technology', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    for (const li of Array.from(items()).slice(1)) {
      expect(
        li.querySelector('.achievements-catalog__state-icon')?.getAttribute('aria-hidden')
      ).toBe('true');
      expect(li.querySelector('.achievements-catalog__body')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
      expect(li.querySelector('.achievements-catalog__badge')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
      // Nothing interactive or live inside a named graphic.
      expect(li.querySelector('a,button,input,select,textarea,[tabindex],[aria-live]')).toBeNull();
    }
    // The visible name, description and status text are all still rendered.
    expect(items()[2].textContent).toContain('Beginner Complete');
    expect(items()[2].textContent).toContain('Complete every Beginner quiz.');
    expect(items()[2].textContent).toContain('Locked');
  });

  it('EXPERIMENT: the first row is ONE paragraph with ONE text node and no role/aria-label/hidden duplicate text', () => {
    setAchievements(VIEW);
    toggleBtn()?.click();
    fixture.detectChanges();
    const row = items()[0];
    expect(row.getAttribute('role')).toBe('none');
    expect(row.hasAttribute('aria-label')).toBe(false);
    const p = row.querySelector('p.achievements-catalog__exp-text') as HTMLElement;
    expect(p.textContent).toBe('Perfect Score. Earn a 100% score on any quiz. Earned.');
    expect([...p.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)).toHaveLength(1);
    expect(p.children.length).toBe(0);
    expect(
      row.querySelector('.achievements-catalog__state-icon')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(
      row.querySelector('.achievements-catalog__body, .achievements-catalog__badge')
    ).toBeNull();
    expect(row.querySelector('[role="img"],[aria-label],[aria-live]')).toBeNull();
    expect(row.classList.contains('is-earned')).toBe(true);
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
