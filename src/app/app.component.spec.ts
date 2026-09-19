import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { of } from 'rxjs';

import { AppComponent } from './app.component';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';
import { BuildYourInterviewComponent } from './containers/interview/build-your-interview/build-your-interview.component';
import { InterviewApiService } from './shared/services/api/interview-api.service';
import { InterviewWarmupCoordinatorService } from './shared/services/interview/interview-warmup-coordinator.service';
import { ThemeService } from './shared/services/ui/theme.service';
import { INTERVIEW_API_BASE_URL } from './shared/tokens/api-base-url.token';

const KEY = 'quiz-app-theme';

/**
 * ThemeService is `providedIn: 'root'`, and Angular builds a root service only
 * when something injects it. Its constructor effect is what sets `data-theme`
 * on <html>, so before AppComponent injected it, a route with no
 * ThemeToggleComponent (Build Your Interview has none) could load or refresh
 * with the persisted theme never applied — every `[data-theme='dark']` rule in
 * the app silently not matching.
 */
describe('AppComponent — ThemeService is constructed at the application root', () => {
  let fixture: ComponentFixture<AppComponent>;

  const dataTheme = () => document.documentElement.getAttribute('data-theme');
  const hasToggle = () => fixture.nativeElement.querySelector('codelab-theme-toggle') !== null;

  /** `data-theme` writes and persisted-theme writes made since the spies were installed. */
  let attrWrites: jest.SpyInstance;
  let storageWrites: jest.SpyInstance;
  const themeAttrWrites = () => attrWrites.mock.calls.filter(([name]) => name === 'data-theme').length;
  const themeStorageWrites = () => storageWrites.mock.calls.filter(([key]) => key === KEY).length;

  async function configure(): Promise<void> {
    window.matchMedia = jest.fn().mockReturnValue({ matches: false } as MediaQueryList);
    attrWrites = jest.spyOn(document.documentElement, 'setAttribute');
    storageWrites = jest.spyOn(Storage.prototype, 'setItem');

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([{ path: 'interview', component: BuildYourInterviewComponent }]),
        { provide: SwUpdate, useValue: { isEnabled: false } },
        // Builder collaborators (as in its own spec) — no real requests are made.
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: INTERVIEW_API_BASE_URL, useValue: 'http://test.local/api' },
        {
          provide: InterviewApiService,
          useValue: { getQuizMetadata: () => of([]), createSession: jest.fn(), warmUp: jest.fn(() => of(undefined)) }
        },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
      ]
    }).compileComponents();
  }

  beforeEach(() => {
    localStorage.removeItem(KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.removeItem(KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies a saved DARK theme on startup, before any ThemeToggleComponent is created', async () => {
    localStorage.setItem(KEY, 'dark');
    await configure();
    expect(dataTheme()).toBeNull();          // nothing has run yet

    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    TestBed.tick();

    expect(hasToggle()).toBe(false);         // no toggle anywhere on this page
    expect(dataTheme()).toBe('dark');
  });

  it('keeps a saved LIGHT theme correct on startup', async () => {
    localStorage.setItem(KEY, 'light');
    await configure();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    TestBed.tick();

    expect(hasToggle()).toBe(false);
    expect(dataTheme()).toBe('light');
  });

  it('defaults to light when nothing is saved and the OS has no dark preference', async () => {
    await configure();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    TestBed.tick();

    expect(dataTheme()).toBe('light');
  });

  it('applies the saved DARK theme on the real Interview Builder route, which renders no theme toggle', async () => {
    localStorage.setItem(KEY, 'dark');
    await configure();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();

    await TestBed.inject(Router).navigateByUrl('/interview');
    await new Promise((resolve) => setTimeout(resolve, 10));   // AppComponent re-creates its outlet on NavigationEnd
    fixture.detectChanges();
    TestBed.tick();

    expect(fixture.nativeElement.querySelector('codelab-build-your-interview')).not.toBeNull();   // Builder really rendered
    expect(hasToggle()).toBe(false);                                                                // …with no toggle on it
    expect(dataTheme()).toBe('dark');
  });

  describe('no duplicate state, listeners or effects', () => {
    it('is ONE ThemeService instance shared by AppComponent and every toggle', async () => {
      await configure();
      fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();

      const root = TestBed.inject(ThemeService);
      const toggleA = TestBed.createComponent(ThemeToggleComponent);
      const toggleB = TestBed.createComponent(ThemeToggleComponent);
      expect(toggleA.componentInstance.themeService).toBe(root);
      expect(toggleB.componentInstance.themeService).toBe(root);
    });

    it('applies and persists the theme exactly once at startup — adding toggles registers no second effect', async () => {
      localStorage.setItem(KEY, 'dark');
      await configure();
      fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      TestBed.tick();

      expect(themeAttrWrites()).toBe(1);
      expect(themeStorageWrites()).toBe(1);

      // Two toggles (Assessment Results renders two) must not add effects.
      TestBed.createComponent(ThemeToggleComponent).detectChanges();
      TestBed.createComponent(ThemeToggleComponent).detectChanges();
      TestBed.tick();

      expect(themeAttrWrites()).toBe(1);
      expect(themeStorageWrites()).toBe(1);
    });

    it('one toggle produces exactly one further write per change, not one per instance', async () => {
      localStorage.setItem(KEY, 'dark');
      await configure();
      fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      TestBed.tick();

      const a = TestBed.createComponent(ThemeToggleComponent);
      const b = TestBed.createComponent(ThemeToggleComponent);
      a.detectChanges();
      b.detectChanges();

      (a.nativeElement.querySelector('button') as HTMLButtonElement).click();
      TestBed.tick();

      expect(themeAttrWrites()).toBe(2);      // startup + this one toggle
      expect(themeStorageWrites()).toBe(2);
      expect(dataTheme()).toBe('light');
    });
  });

  it('the existing toggle still switches and persists the theme with AppComponent mounted', async () => {
    localStorage.setItem(KEY, 'dark');
    await configure();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    TestBed.tick();

    const toggle = TestBed.createComponent(ThemeToggleComponent);
    toggle.detectChanges();
    const button = toggle.nativeElement.querySelector('button') as HTMLButtonElement;

    button.click();
    TestBed.tick();
    expect(dataTheme()).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');

    button.click();
    TestBed.tick();
    expect(dataTheme()).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
  });
});
