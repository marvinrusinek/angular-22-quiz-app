import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AchievementsSummaryComponent } from './achievements-summary.component';

describe('AchievementsSummaryComponent', () => {
  let fixture: ComponentFixture<AchievementsSummaryComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AchievementsSummaryComponent] });
    fixture = TestBed.createComponent(AchievementsSummaryComponent);
  });

  const setCounts = (earned: number, total: number): void => {
    fixture.componentRef.setInput('earned', earned);
    fixture.componentRef.setInput('total', total);
    fixture.detectChanges();
  };
  const root = (): HTMLElement | null =>
    fixture.nativeElement.querySelector('.achievements-summary');

  it('renders the "X / N" progress when there is a positive total', () => {
    setCounts(3, 6);
    expect(root()).toBeTruthy();
    expect(root()?.textContent?.replace(/\s+/g, ' ')).toContain('3 / 6');
  });

  it('renders nothing when the total is zero', () => {
    setCounts(0, 0);
    expect(root()).toBeNull();
  });

  it('exposes an accessible label describing the progress', () => {
    setCounts(2, 6);
    expect(root()?.getAttribute('aria-label')).toBe('Achievements: 2 of 6 earned');
  });
});
