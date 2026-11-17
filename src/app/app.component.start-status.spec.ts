import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';

import { AppComponent } from './app.component';
import { QuizStartSpinnerService } from '@shared/services/ui/quiz-start-spinner.service';

/**
 * The spoken "Preparing quiz…" message is ONE persistent, exposed, initially EMPTY polite status region whose
 * text is written when preparation starts and cleared when it ends — a real content change (not a CSS reveal of
 * pre-populated text). The overlay is purely visual (aria-hidden), so the label is never exposed twice.
 */
describe('AppComponent — start-quiz status announcement', () => {
  let fixture: ComponentFixture<AppComponent>;
  let spinner: QuizStartSpinnerService;

  const root = (): HTMLElement => fixture.nativeElement;
  const status = (): HTMLElement => root().querySelector('.start-announcer')!;
  const settle = (): void => {
    fixture.detectChanges();
    TestBed.tick();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    window.matchMedia = jest.fn().mockReturnValue({ matches: false } as MediaQueryList);
    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([]), { provide: SwUpdate, useValue: { isEnabled: false } }]
    });
    fixture = TestBed.createComponent(AppComponent);
    spinner = TestBed.inject(QuizStartSpinnerService);
    settle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('has one persistent polite live region (no explicit role) that is initially EMPTY and exposed', () => {
    expect(root().querySelectorAll('.start-announcer')).toHaveLength(1);
    // No role="status": Narrator appended "Status" after the message. aria-live/aria-atomic alone keep it live.
    expect(status().hasAttribute('role')).toBe(false);
    expect(status().getAttribute('aria-atomic')).toBe('true');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('');
    // exposed (clip-based visually hidden, never display:none / visibility:hidden / aria-hidden / hidden)
    expect(status().hasAttribute('aria-hidden')).toBe(false);
    expect(status().hasAttribute('hidden')).toBe(false);
    expect(status().closest('[aria-hidden="true"]')).toBeNull();
    expect(status().hasAttribute('tabindex')).toBe(false);
  });

  it('is the LAST element in the document: after <main> and the router outlet, never inside the route content', () => {
    const main = root().querySelector('main')!;
    const outlet = root().querySelector('router-outlet')!;
    expect(main.contains(status())).toBe(false);
    expect(main.compareDocumentPosition(status()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(outlet.compareDocumentPosition(status()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // nothing in the app shell comes after it
    expect(status().nextElementSibling).toBeNull();
    expect(root().lastElementChild).toBe(status());
  });

  it('never uses role="alert", assertive, or a second live region', () => {
    spinner.showForStart();
    settle();
    expect(root().querySelector('[role="alert"], [aria-live="assertive"]')).toBeNull();
    expect(root().querySelectorAll('[aria-live], [role="status"]')).toHaveLength(1);
    expect(root().querySelector('[role="status"]')).toBeNull(); // the loading announcer is the only live region and has no role
  });

  it('writes "Preparing quiz…" when preparation begins, once, as one text node', () => {
    spinner.showForStart();
    settle();
    expect(status().textContent).toBe('Preparing quiz…');
    expect(status().childNodes).toHaveLength(1);
    // further change detection does not rewrite it
    const node = status().firstChild;
    settle();
    settle();
    expect(status().firstChild).toBe(node);
    expect(status().textContent).toBe('Preparing quiz…');
  });

  it('keeps the visual overlay (spinner + label) but hides it from assistive technology', () => {
    spinner.showForStart();
    settle();
    const overlay = root().querySelector('.start-spinner') as HTMLElement;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.hasAttribute('role')).toBe(false);
    expect(overlay.hasAttribute('aria-live')).toBe(false);
    expect(overlay.classList.contains('is-visible')).toBe(true);
    expect(overlay.textContent).toContain('Preparing quiz…');
    expect(overlay.querySelector('app-google-spinner')).not.toBeNull();
    // the label is exposed exactly once: only the status region is outside aria-hidden
    const exposed = Array.from(root().querySelectorAll('*')).filter(
      (el) => !el.closest('[aria-hidden="true"]') && el.children.length === 0 && (el.textContent ?? '').includes('Preparing quiz')
    );
    expect(exposed).toEqual([status()]);
  });

  it('clears the status on success once the minimum has elapsed and the work is done', async () => {
    const h = spinner.showForStart();
    h.hide();
    settle();
    expect(status().textContent).toBe('Preparing quiz…'); // still up: the 1600ms floor has not elapsed
    jest.advanceTimersByTime(1600);
    await Promise.resolve();
    settle();
    expect(status().textContent).toBe('');
    expect(root().querySelector('.start-spinner')!.classList.contains('is-visible')).toBe(false);
  });

  it('clears the status on failure (the caller hides in its finally) and on cancel', () => {
    const failed = spinner.showForStart();
    jest.advanceTimersByTime(1600);
    failed.hide(); // failure path: finally -> hide()
    settle();
    expect(status().textContent).toBe('');

    const cancelled = spinner.showForStart();
    settle();
    expect(status().textContent).toBe('Preparing quiz…');
    cancelled.forceCancel();
    settle();
    expect(status().textContent).toBe('');
  });

  it('a newer attempt supersedes an older one: a stale hide cannot clear the newer message', () => {
    const older = spinner.showForStart();
    const newer = spinner.showForStart('Preparing Interview…');
    settle();
    expect(status().textContent).toBe('Preparing Interview…');
    jest.advanceTimersByTime(1600);
    older.hide();
    settle();
    expect(status().textContent).toBe('Preparing Interview…');
    newer.hide();
    settle();
    expect(status().textContent).toBe('');
  });

  it('does not move focus', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    spinner.showForStart();
    settle();
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
