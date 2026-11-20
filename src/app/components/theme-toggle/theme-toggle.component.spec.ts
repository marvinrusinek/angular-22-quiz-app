import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';

import { ThemeToggleComponent } from './theme-toggle.component';
import { ThemeService } from '@shared/services/ui/theme.service';
import { THEME_ICON_DARK_MODE, THEME_ICON_LIGHT_MODE } from './theme-icons';

describe('ThemeToggleComponent', () => {
  let fixture: ComponentFixture<ThemeToggleComponent>;
  let themeService: ThemeService;

  const button = () =>
    fixture.nativeElement.querySelector('button.theme-toggle-btn') as HTMLButtonElement;
  const icon = () => fixture.nativeElement.querySelector('mat-icon') as HTMLElement;

  async function create(storedTheme?: 'light' | 'dark'): Promise<void> {
    // The tooltip's breakpoint observer subscribes to this once timers run, so the mock needs the listener methods too.
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    } as unknown as MediaQueryList);
    localStorage.removeItem('quiz-app-theme');
    if (storedTheme) localStorage.setItem('quiz-app-theme', storedTheme);

    await TestBed.configureTestingModule({
      imports: [ThemeToggleComponent]
    }).compileComponents();

    themeService = TestBed.inject(ThemeService);
    fixture = TestBed.createComponent(ThemeToggleComponent);
    fixture.detectChanges();
  }

  it('creates', async () => {
    await create();
    expect(fixture.componentInstance).toBeTruthy();
  });

  // The bundled self-hosted Material Icons font has no `dark_mode` or
  // `light_mode` glyph (measured: zero rendered ink for both, including on the
  // deployed copy), so a ligature-text <mat-icon> renders blank however the
  // font loads. The toggle must draw an inline SVG instead.
  describe('icon rendering', () => {
    it('LIGHT theme renders the moon (dark-mode) SVG — inline <svg>, no ligature text', async () => {
      await create('light');
      expect(themeService.theme()).toBe('light');

      expect(icon().textContent!.trim()).toBe('');
      const svg = icon().querySelector('svg') as SVGElement;
      expect(svg).toBeTruthy();
      // Moon = one evenodd crescent path; none of the sun's disc/rays.
      expect(svg.querySelector('path[fill-rule="evenodd"]')).toBeTruthy();
      expect(svg.querySelector('circle')).toBeNull();
      expect(svg.querySelector('line')).toBeNull();
    });

    it('DARK theme renders the sun (light-mode) SVG — disc plus 8 rays, no ligature text', async () => {
      await create('dark');
      expect(themeService.theme()).toBe('dark');

      expect(icon().textContent!.trim()).toBe('');
      const svg = icon().querySelector('svg') as SVGElement;
      expect(svg).toBeTruthy();
      expect(svg.querySelectorAll('circle').length).toBe(1);
      expect(svg.querySelectorAll('line').length).toBe(8);
      expect(svg.querySelector('path')).toBeNull();
    });

    it('the icon swaps in the DOM when the theme toggles (moon -> sun -> moon)', async () => {
      await create('light');
      expect(icon().querySelector('path[fill-rule="evenodd"]')).toBeTruthy();

      button().click();
      fixture.detectChanges();
      expect(icon().querySelectorAll('line').length).toBe(8);
      expect(icon().querySelector('path')).toBeNull();

      button().click();
      fixture.detectChanges();
      expect(icon().querySelector('path[fill-rule="evenodd"]')).toBeTruthy();
      expect(icon().querySelector('line')).toBeNull();
    });
  });

  describe('icons are deterministic, local, and theme-colored', () => {
    async function svgMarkup(name: string): Promise<string> {
      await create();
      const svg = await firstValueFrom(TestBed.inject(MatIconRegistry).getNamedSvgIcon(name));
      return svg.outerHTML;
    }

    it.each([THEME_ICON_DARK_MODE, THEME_ICON_LIGHT_MODE])(
      '%s uses currentColor only — no hardcoded colors, so it follows the button color in both themes',
      async (name) => {
        const markup = await svgMarkup(name);
        expect(markup).toContain('currentColor');
        expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(markup).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
      }
    );

    it.each([THEME_ICON_DARK_MODE, THEME_ICON_LIGHT_MODE])(
      '%s depends on no remote font, image, stylesheet, or ligature text',
      async (name) => {
        const markup = await svgMarkup(name);
        expect(markup).not.toMatch(/<text|<image|<use|<style|<foreignObject/i);
        // The xmlns namespace declaration is an identifier, not a fetch.
        const withoutNamespace = markup.replace(/\sxmlns="[^"]*"/g, '');
        expect(withoutNamespace).not.toMatch(/https?:|url\(|href=|xlink:/i);
        expect(markup).not.toMatch(/font-family|fonts\.g/i);
        expect(markup).not.toMatch(/dark_mode|light_mode/);
      }
    );

    it('the toggle component resolves neither icon id to ligature text', async () => {
      await create();
      expect(themeService.icon()).not.toMatch(/^(dark|light)_mode$/);
    });
  });

  describe('behavior preserved', () => {
    it('clicking toggles the theme signal, persists it, and sets data-theme on <html>', async () => {
      await create('light');
      button().click();
      fixture.detectChanges();
      TestBed.tick();

      expect(themeService.theme()).toBe('dark');
      expect(localStorage.getItem('quiz-app-theme')).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      button().click();
      fixture.detectChanges();
      TestBed.tick();

      expect(themeService.theme()).toBe('light');
      expect(localStorage.getItem('quiz-app-theme')).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('keeps the icon hidden from assistive tech and the control a native button', async () => {
      await create();
      expect(button().tagName).toBe('BUTTON');
      expect(icon().getAttribute('aria-hidden')).toBe('true');
    });

    it('keeps the tooltip, and it still names the destination theme', async () => {
      await create('light');
      const tooltip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
      expect(tooltip.message).toBe('Switch to dark mode');

      button().click();
      fixture.detectChanges();
      expect(tooltip.message).toBe('Switch to light mode');
    });
  });

  // The button's accessible name is the same action text as its tooltip, so it names what the button DOES in the current
  // theme. Material's tooltip adds an aria-describedby for its message unless that message equals the host's aria-label
  // (it skips an identical description so a screen reader does not read the same text twice); these tests pin that no
  // redundant description remains, after rendering and after every toggle, without removing any Material-managed attribute.
  describe('accessible name follows the tooltip action text', () => {
    /** Material's tooltip registers its description in a microtask after the message changes: let it run. */
    async function settle(): Promise<void> {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const tooltipMessage = () =>
      fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip).message;
    const noRedundantDescription = () => {
      expect(button().hasAttribute('aria-describedby')).toBe(false);
      // and no description element for the tooltip message is left in the document either
      expect(document.querySelectorAll('.cdk-describedby-message-container [id^="cdk-describedby-message-"]')).toHaveLength(0);
    };

    it('LIGHT theme: the name and the tooltip both say "Switch to dark mode", with no redundant description', async () => {
      await create('light');
      await settle();
      expect(themeService.theme()).toBe('light');
      expect(button().getAttribute('aria-label')).toBe('Switch to dark mode');
      expect(tooltipMessage()).toBe('Switch to dark mode');
      noRedundantDescription();
    });

    it('DARK theme: the name and the tooltip both say "Switch to light mode", with no redundant description', async () => {
      await create('dark');
      await settle();
      expect(themeService.theme()).toBe('dark');
      expect(button().getAttribute('aria-label')).toBe('Switch to light mode');
      expect(tooltipMessage()).toBe('Switch to light mode');
      noRedundantDescription();
    });

    it('stays correct and redundancy-free after every toggle (light -> dark -> light)', async () => {
      await create('light');
      await settle();

      button().click();
      await settle();
      expect(themeService.theme()).toBe('dark');
      expect(button().getAttribute('aria-label')).toBe('Switch to light mode');
      expect(tooltipMessage()).toBe('Switch to light mode');
      noRedundantDescription();

      button().click();
      await settle();
      expect(themeService.theme()).toBe('light');
      expect(button().getAttribute('aria-label')).toBe('Switch to dark mode');
      expect(tooltipMessage()).toBe('Switch to dark mode');
      noRedundantDescription();
    });

    it('keeps the name and the tooltip identical to the service text (one source, no second copy)', async () => {
      await create('light');
      await settle();
      expect(button().getAttribute('aria-label')).toBe(themeService.tooltip());
      button().click();
      await settle();
      expect(button().getAttribute('aria-label')).toBe(themeService.tooltip());
    });

    it('keeps the 36px circular button and 20px icon box (touch target unchanged)', () => {
      // jsdom does not apply Angular's encapsulated component styles, so assert
      // against the component's own stylesheet text.
      const source = readFileSync(join(__dirname, 'theme-toggle.component.ts'), 'utf8');
      expect(source).toMatch(
        /\.theme-toggle-btn\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*border-radius:\s*50%/
      );
      expect(source).toMatch(
        /\.theme-toggle-btn mat-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/
      );
    });

    it('a second instance re-registering the same icon ids does not throw', async () => {
      // interview-results renders TWO toggles on one page.
      await create();
      expect(() => TestBed.createComponent(ThemeToggleComponent).detectChanges()).not.toThrow();
    });
  });
});
