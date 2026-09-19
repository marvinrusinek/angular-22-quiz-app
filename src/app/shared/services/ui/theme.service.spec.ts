import { TestBed } from '@angular/core/testing';

import { ThemeService } from './theme.service';
import { THEME_ICON_DARK_MODE, THEME_ICON_LIGHT_MODE } from '../../../components/theme-toggle/theme-icons';

describe('ThemeService', () => {
  const STORAGE_KEY = 'quiz-app-theme';

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    window.matchMedia = jest.fn().mockReturnValue({ matches: false } as MediaQueryList);
  });

  function create(): ThemeService {
    return TestBed.inject(ThemeService);
  }

  it('defaults to light when nothing is stored and the OS has no dark preference', () => {
    const service = create();
    expect(service.theme()).toBe('light');
    expect(service.isDark()).toBe(false);
  });

  it('honors a stored theme over the OS preference', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const service = create();
    expect(service.theme()).toBe('dark');
  });

  it('falls back to prefers-color-scheme when nothing is stored', () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true } as MediaQueryList);
    const service = create();
    expect(service.theme()).toBe('dark');
  });

  it('toggle() flips the theme and persists it', () => {
    const service = create();
    expect(service.theme()).toBe('light');

    service.toggle();
    TestBed.tick();
    expect(service.theme()).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    service.toggle();
    TestBed.tick();
    expect(service.theme()).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('sets data-theme on <html> as a side effect — this is the ONLY thing every [data-theme] CSS rule in the app depends on', () => {
    const service = create();
    service.toggle();
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    service.toggle();
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // Regression: dark_mode/light_mode are absent from the self-hosted,
  // subsetted material-icons.woff2 (confirmed by direct glyph-coverage
  // measurement against the font file — zero rendered ink for both
  // ligatures). The theme toggle must resolve to the locally bundled SVG
  // icon ids instead of those ligature names.
  describe('icon() resolves to a locally bundled SVG icon id, never a Material Icons ligature', () => {
    it('shows the moon (destination: dark) while light is active', () => {
      const service = create();
      expect(service.icon()).toBe(THEME_ICON_DARK_MODE);
      expect(service.icon()).not.toBe('dark_mode');
    });

    it('shows the sun (destination: light) while dark is active', () => {
      localStorage.setItem(STORAGE_KEY, 'dark');
      const service = create();
      expect(service.icon()).toBe(THEME_ICON_LIGHT_MODE);
      expect(service.icon()).not.toBe('light_mode');
    });
  });
});
