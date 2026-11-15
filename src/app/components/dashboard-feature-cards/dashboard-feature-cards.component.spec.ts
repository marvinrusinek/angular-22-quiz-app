import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { DashboardFeatureCardsComponent } from './dashboard-feature-cards.component';

describe('DashboardFeatureCardsComponent', () => {
  let fixture: ComponentFixture<DashboardFeatureCardsComponent>;
  let comp: DashboardFeatureCardsComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DashboardFeatureCardsComponent],
      providers: [provideRouter([])]
    });
    fixture = TestBed.createComponent(DashboardFeatureCardsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const cards = (): HTMLElement[] =>
    Array.from(root().querySelectorAll<HTMLElement>('.dfc__card'));
  const titles = (): string[] =>
    Array.from(root().querySelectorAll('.dfc__title')).map((e) => e.textContent?.trim() ?? '');

  it('renders the four cards in order', () => {
    expect(cards()).toHaveLength(4);
    expect(titles()).toEqual([
      'Topic Quizzes',
      'Interview Mode',
      'Weak Areas Practice',
      'Certificate'
    ]);
  });

  it('links Interview Mode and Certificate to their routes', () => {
    const [, interview, , cert] = cards();
    expect(interview.tagName).toBe('A');
    expect(interview.getAttribute('href')).toBe('/interview');
    expect(cert.tagName).toBe('A');
    expect(cert.getAttribute('href')).toBe('/interview/certificate');
  });

  it('exposes Weak Areas as a button, never a bare link to the guarded route', () => {
    const weak = cards()[2];
    expect(weak.tagName).toBe('BUTTON');
    expect(weak.getAttribute('href')).toBeNull();
    expect(root().querySelector('a[href*="practice"]')).toBeNull();
  });

  it('emits browse and practiceWeakAreas from the two button cards', () => {
    const browse = jest.fn();
    const practice = jest.fn();
    comp.browse.subscribe(browse);
    comp.practiceWeakAreas.subscribe(practice);
    cards()[0].click();
    expect(browse).toHaveBeenCalledTimes(1);
    expect(practice).not.toHaveBeenCalled();
    cards()[2].click();
    expect(practice).toHaveBeenCalledTimes(1);
  });

  it('keeps Weak Areas clickable and changes its wording by readiness', () => {
    expect(cards()[2].textContent).toContain('Find the topics you need to improve');
    fixture.componentRef.setInput('weakAreasReady', true);
    fixture.detectChanges();
    expect(cards()[2].textContent).toContain('Focus on topics you need to improve');
    expect(cards()[2].hasAttribute('disabled')).toBe(false);
  });

  it('shows a busy state on the Weak Areas card only', () => {
    const weak = cards()[2];
    expect(weak.getAttribute('aria-busy')).toBeNull();
    fixture.componentRef.setInput('weakAreasBusy', true);
    fixture.detectChanges();
    expect(weak.getAttribute('aria-busy')).toBe('true');
    expect(weak.textContent).toContain('Preparing your practice session');
    expect(weak.hasAttribute('disabled')).toBe(false);
    expect(cards()[0].getAttribute('aria-busy')).toBeNull();
  });

  it('names each card from its visible text and hides decorative arrows', () => {
    cards().forEach((c) => {
      expect(c.hasAttribute('aria-label')).toBe(false);
      expect(c.querySelector('.dfc__title')?.textContent?.trim()).toBeTruthy();
      expect(c.querySelector('.dfc__arrow')?.getAttribute('aria-hidden')).toBe('true');
      expect(c.querySelector('.dfc__icon')?.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
