import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SummaryIconsComponent } from './summary-icons.component';

describe('SummaryIconsComponent', () => {
  let fixture: ComponentFixture<SummaryIconsComponent>;

  beforeEach(() => {
    fixture = TestBed.createComponent(SummaryIconsComponent);
    fixture.detectChanges();
  });

  it('keeps the three sharing links focusable and named', () => {
    const links = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Print', 'E-mail', 'Share on Twitter']);
    links.forEach((a) => expect(a.hasAttribute('href')).toBe(true));
  });

  it('hides the icon-font glyph text ("print", "email", "share") from assistive technology', () => {
    const glyphs = Array.from(fixture.nativeElement.querySelectorAll('a i.material-icons')) as HTMLElement[];
    expect(glyphs.map((g) => g.textContent?.trim())).toEqual(['print', 'email', 'share']);
    glyphs.forEach((g) => expect(g.getAttribute('aria-hidden')).toBe('true'));
  });
});
