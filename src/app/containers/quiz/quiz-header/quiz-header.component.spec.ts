import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';

import { CodelabQuizHeaderComponent } from './quiz-header.component';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';

/**
 * S6i — the header no longer reads QuizDataService.quizzesSig() (the
 * bundled bank's full Quiz array). `currentQuiz` now carries only the one
 * field the template uses (`milestone`), sourced from
 * TopicQuizMetadataService — the same service the S6h Guard and S6f
 * resolver already depend on for this route.
 */
describe('CodelabQuizHeaderComponent', () => {
  let metadataApi: any;
  let quizService: any;

  function configure(quizId: string) {
    TestBed.resetTestingModule();
    metadataApi = {
      questionCountByQuiz: jest.fn().mockReturnValue(new Map()),
      milestoneFor: jest.fn().mockReturnValue('')
    };
    quizService = { quizId };

    TestBed.configureTestingModule({
      imports: [CodelabQuizHeaderComponent],
      providers: [
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: QuizService, useValue: quizService },
        { provide: MatDialog, useValue: { open: jest.fn() } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {},
            params: { subscribe: () => ({ unsubscribe: () => undefined }) }
          }
        }
      ]
    });
  }

  it('shows the milestone from TopicQuizMetadataService for the current quizId', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()?.milestone).toBe('RxJS');
    expect(metadataApi.milestoneFor).toHaveBeenCalledWith('rxjs');
  });

  it('tracks quizService.quizId as the current quiz id', () => {
    configure('typescript');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['typescript', 5]]));
    metadataApi.milestoneFor.mockReturnValue('TypeScript');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()?.milestone).toBe('TypeScript');
  });

  it('focuses the existing logo link without adding another focus stop', () => {
    configure('rxjs');
    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();
    fixture.componentInstance.focusLogo();
    const link = fixture.nativeElement.querySelector('a');
    expect(document.activeElement).toBe(link);
    expect(link.querySelector('img')?.getAttribute('alt'))
      .toBe('Angular Quiz Platform');
    expect(link.hasAttribute('tabindex')).toBe(false);
  });

  it('names the shortcuts button once without a redundant tooltip description', () => {
    configure('rxjs');
    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();
    TestBed.tick();

    const control = fixture.debugElement.query(
      By.css('button.keyboard-shortcuts-btn')
    );
    const button = control.nativeElement as HTMLButtonElement;
    const tooltip = control.injector.get(MatTooltip);
    expect(button.getAttribute('aria-label')).toBe('Open keyboard shortcuts');
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(tooltip.message).toBe('Open keyboard shortcuts');
    expect(tooltip.disabled).toBe(false);

    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(TestBed.inject(MatDialog).open).toHaveBeenCalledTimes(1);
  });

  it('each quiz id resolves its own milestone (cross-quiz SPA navigation verified separately by E2E)', () => {
    // quizService.quizId is a plain (non-signal) field — computed() has no way
    // to react to a raw mutation of it, exactly as the pre-S6i computed()
    // (which also read the plain field) could not either. This proves the
    // per-id resolution is correct; the live cross-quiz-navigation case is
    // covered by e2e/topic-quiz-lifecycle.spec.ts (tests G and N), which
    // exercise a real router-driven quiz switch end to end.
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');
    const rxjsFixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    rxjsFixture.detectChanges();
    expect(rxjsFixture.componentInstance.currentQuiz()?.milestone).toBe('RxJS');

    configure('signals');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['signals', 6]]));
    metadataApi.milestoneFor.mockReturnValue('Signals');
    const signalsFixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    signalsFixture.detectChanges();
    expect(signalsFixture.componentInstance.currentQuiz()?.milestone).toBe('Signals');
  });

  // The title and subtitle are native headings that keep the Material card styling classes, each holding ONE complete text node.
  // Narrator speech for the headings is verified by hand.
  it('renders the title as a native h1 and the subtitle as a native h2, each one complete text node', () => {
    configure('typescript');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['typescript', 5]]));
    metadataApi.milestoneFor.mockReturnValue('TypeScript');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const h1 = root.querySelector('.header-titles > h1') as HTMLElement;
    const h2 = root.querySelector('.header-titles > h2') as HTMLElement;
    expect(h1.classList.contains('mat-mdc-card-title')).toBe(true);
    expect(h2.classList.contains('mat-mdc-card-subtitle')).toBe(true);
    expect(root.querySelector('mat-card-title, mat-card-subtitle')).toBeNull();
    for (const [el, text] of [
      [h1, 'TypeScript Quiz'],
      [h2, 'Assess your knowledge of TypeScript']
    ] as const) {
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(el.children).toHaveLength(0);
      expect(el.textContent).toBe(text);
      expect(el.hasAttribute('aria-label') || el.hasAttribute('role') || el.hasAttribute('aria-hidden')).toBe(false);
    }
  });

  // The logo link carries its own class (it owns the logo's spacing) and still wraps the unchanged image and route.
  it('keeps the logo link, route, image, alt text and dimensions, with the link marked quiz-header__logo', () => {
    configure('typescript');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['typescript', 5]]));
    metadataApi.milestoneFor.mockReturnValue('TypeScript');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    const link = (fixture.nativeElement as HTMLElement).querySelector('mat-card-header > a') as HTMLAnchorElement;
    expect(link.classList.contains('quiz-header__logo')).toBe(true);
    expect(link.getAttribute('href')).toBe('/select');
    const img = link.querySelector('img') as HTMLImageElement;
    expect(img.classList.contains('header-image')).toBe(true);
    expect(img.getAttribute('alt')).toBe('Angular Quiz Platform');
    expect(img.getAttribute('width')).toBe('495');
    expect(img.getAttribute('height')).toBe('144');
    expect(img.getAttribute('src') ?? '').toContain('angular-quiz-platform-logo.webp');
    expect(link.hasAttribute('aria-label') || link.hasAttribute('role') || link.hasAttribute('tabindex')).toBe(false);
  });

  it('renders nothing (null) on a cold quiz — metadata not yet loaded', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map()); // empty — not loaded yet

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
  });

  it('renders nothing (null) when the quiz is unknown to metadata', () => {
    configure('nope');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]])); // 'nope' absent

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
  });

  it('renders nothing (null) when quizService.quizId is empty', () => {
    configure('');
    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentQuiz()).toBeNull();
    expect(metadataApi.milestoneFor).not.toHaveBeenCalled();
  });

  it('requires no QuizDataService and no quizzesSig() bank lookup', () => {
    configure('rxjs');
    metadataApi.questionCountByQuiz.mockReturnValue(new Map([['rxjs', 10]]));
    metadataApi.milestoneFor.mockReturnValue('RxJS');

    const fixture = TestBed.createComponent(CodelabQuizHeaderComponent);
    fixture.detectChanges();

    // Structural proof: the component's only quiz-data dependency is the
    // injected TopicQuizMetadataService mock — no QuizDataService provider
    // was registered above, and TestBed would throw NullInjectorError on
    // creation if the component still tried to inject it.
    expect(fixture.componentInstance).toBeTruthy();
    expect(metadataApi.questionCountByQuiz).toHaveBeenCalled();
  });
});
