import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SummaryIconsComponent } from './summary-icons.component';

describe('SummaryIconsComponent', () => {
  let fixture: ComponentFixture<SummaryIconsComponent>;

  beforeEach(() => {
    fixture = TestBed.createComponent(SummaryIconsComponent);
    fixture.detectChanges();
  });

  it('keeps the three sharing links focusable and named by aria-label', () => {
    const links = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Print', 'E-mail', 'Share on Twitter']);
    links.forEach((a) => expect(a.hasAttribute('href')).toBe(true));
  });

  it('renders each icon as a visible Material Icons ligature (one glyph per link)', () => {
    const glyphs = Array.from(fixture.nativeElement.querySelectorAll('a i.material-icons')) as HTMLElement[];
    expect(glyphs.map((g) => g.textContent?.trim())).toEqual(['print', 'email', 'share']);
    glyphs.forEach((g) => expect(g.getAttribute('aria-hidden')).toBeNull());
  });

  it('tags a link with the keyboard-focus class only when focus follows a keyboard event, not programmatic focus', async () => {
    await fixture.whenStable();
    const [print, email] = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    document.body.appendChild(fixture.nativeElement);

    print.focus();
    expect(print.classList.contains('cdk-program-focused')).toBe(true);
    expect(print.classList.contains('cdk-keyboard-focused')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    email.focus();
    expect(email.classList.contains('cdk-keyboard-focused')).toBe(true);
    fixture.nativeElement.remove();
  });
});
