import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

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

  // Plain neutral containers, not a native list: the four cards must not be announced with a position such as "1 of 4".
  // This pins the structure only; whether it changes Narrator's speech is verified by hand.
  it('uses neutral containers: no list, no list items, and no roles or position attributes on the structure', () => {
    const container = root().querySelector('.dfc') as HTMLElement;
    expect(container.tagName).toBe('DIV');
    expect(root().querySelector('ul, ol, li')).toBeNull();
    expect(container.hasAttribute('role')).toBe(false);

    const items = Array.from(container.children) as HTMLElement[];
    expect(items).toHaveLength(4);
    items.forEach((item) => {
      expect(item.tagName).toBe('DIV');
      expect(item.className).toBe('dfc__item');
      expect(item.attributes).toHaveLength(1); // only its class: no role, aria-*, tabindex or position attributes
      expect(item.children).toHaveLength(1);
      expect(item.firstElementChild!.classList.contains('dfc__card')).toBe(true);
    });
    expect(root().querySelector('[aria-posinset], [aria-setsize]')).toBeNull();
  });

  it('makes all four cards native type=button buttons: no anchors, no role=button on anything', () => {
    expect(cards().map((c) => c.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON']);
    cards().forEach((c) => expect(c.getAttribute('type')).toBe('button'));
    expect(root().querySelector('a')).toBeNull();
    // no role=button anywhere, and no role on the structure or the cards (the Material icons carry their own aria-hidden role=img)
    expect(root().querySelector('[role="button"]')).toBeNull();
    expect(root().querySelector('.dfc[role], .dfc__item[role], .dfc__card[role]')).toBeNull();
    expect(root().querySelector('[href], [routerLink]')).toBeNull();
  });

  it('opens Interview Mode and Certificate through the Router, once per click, at their routes', () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const [, interview, , cert] = cards();
    interview.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith('/interview');
    cert.click();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith('/interview/certificate');
  });

  it('does not navigate from the two cards that hand off to the parent (browse and Weak Areas)', () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    cards()[0].click();
    cards()[2].click();
    expect(navigate).not.toHaveBeenCalled();
  });

  // The Interview Mode description is part of the link's one accessible name through aria-labelledby; the description
  // itself is hidden from the tree so it is not ALSO exposed as separate text after the link. Speech is verified by hand.
  it('names the Interview Mode button from its title and description once, with the description hidden as separate text', () => {
    const interview = cards()[1];
    expect(interview.tagName).toBe('BUTTON');
    expect(interview.getAttribute('href')).toBeNull();
    expect(interview.hasAttribute('aria-label')).toBe(false);
    expect(interview.getAttribute('aria-hidden')).toBeNull();
    expect(interview.getAttribute('aria-labelledby')).toBe('dfc-interview-title dfc-interview-desc');

    const ids = ['dfc-interview-title', 'dfc-interview-desc'];
    ids.forEach((id) => expect(root().querySelectorAll('#' + id)).toHaveLength(1));
    const title = root().querySelector('#dfc-interview-title') as HTMLElement;
    const desc = root().querySelector('#dfc-interview-desc') as HTMLElement;
    expect(title.getAttribute('aria-hidden')).toBeNull(); // the title stays exposed
    expect(desc.getAttribute('aria-hidden')).toBe('true'); // the description is not exposed on its own
    expect(title.classList.contains('dfc__title')).toBe(true);
    expect(desc.classList.contains('dfc__desc')).toBe(true);

    const name = ids
      .map((id) => (root().querySelector('#' + id) as HTMLElement).textContent!.replace(/\s+/g, ' ').trim())
      .join(' ');
    expect(name).toBe('Interview Mode Mixed Angular questions like a real interview');
  });

  it('leaves the other three cards named from their own content (no aria-labelledby, no ids)', () => {
    [0, 2, 3].forEach((i) => {
      expect(cards()[i].hasAttribute('aria-labelledby')).toBe(false);
      expect(cards()[i].querySelector('[id]')).toBeNull();
    });
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
