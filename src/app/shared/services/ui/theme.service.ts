import { computed, effect, Service, signal } from '@angular/core';
import { swallow } from '@shared/utils/error-logging';
import { THEME_ICON_DARK_MODE, THEME_ICON_LIGHT_MODE } from '../../../components/theme-toggle/theme-icons';

export type Theme = 'light' | 'dark';

@Service()
export class ThemeService {
  // ── signals ─────────────────────────────────────────────────────
  readonly theme = signal<Theme>(this.loadInitialTheme());

  // ── computed ────────────────────────────────────────────────────
  readonly isDark = computed(() => this.theme() === 'dark');
  // Locally bundled SVG icon ids (see theme-icons.ts), NOT Material Icons
  // ligature names — `dark_mode`/`light_mode` are absent from the self-hosted
  // subsetted font, confirmed by direct glyph-coverage measurement.
  readonly icon = computed(() => this.isDark() ? THEME_ICON_LIGHT_MODE : THEME_ICON_DARK_MODE);
  readonly tooltip = computed(() => this.isDark() ? 'Switch to light mode' : 'Switch to dark mode');

  // ── properties ──────────────────────────────────────────────────
  private static readonly STORAGE_KEY = 'quiz-app-theme';

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      try {
        localStorage.setItem(ThemeService.STORAGE_KEY, t);
      } catch (err: unknown) { swallow('theme.service.ts', err); }
    });
  }

  // ── public methods ──────────────────────────────────────────────
  toggle(): void {
    this.theme.update(t => t === 'light' ? 'dark' : 'light');
  }

  // ── private methods ─────────────────────────────────────────────
  private loadInitialTheme(): Theme {
    try {
      const stored = localStorage.getItem(ThemeService.STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (err: unknown) { swallow('theme.service.ts', err); }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
}