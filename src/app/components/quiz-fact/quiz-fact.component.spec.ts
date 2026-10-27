import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizFactComponent } from './quiz-fact.component';

describe('QuizFactComponent', () => {
  let fixture: ComponentFixture<QuizFactComponent>;
  let component: QuizFactComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [QuizFactComponent] });
    fixture = TestBed.createComponent(QuizFactComponent);
    component = fixture.componentInstance;
  });

  const setFacts = (facts?: string[]): void => {
    fixture.componentRef.setInput('facts', facts);
    fixture.detectChanges();
  };
  const factSection = (): HTMLElement | null => fixture.nativeElement.querySelector('.quiz-fact');
  const factText = (): string =>
    (fixture.nativeElement.querySelector('.quiz-fact__text')?.textContent ?? '').trim();

  it('shows the single fact when the quiz has exactly one fact', () => {
    setFacts(['HttpClient parses JSON by default.']);
    expect(factSection()).toBeTruthy();
    expect(factText()).toBe('HttpClient parses JSON by default.');
  });

  it('shows exactly ONE of the facts when the quiz has multiple', () => {
    const facts = ['Fact A', 'Fact B', 'Fact C'];
    setFacts(facts);
    expect(fixture.nativeElement.querySelectorAll('.quiz-fact__text').length).toBe(1);
    expect(facts).toContain(factText());
  });

  it('renders nothing when the quiz has an empty facts array', () => {
    setFacts([]);
    expect(factSection()).toBeNull();
    expect(component.fact()).toBeNull();
  });

  it('renders nothing when facts is undefined', () => {
    setFacts(undefined);
    expect(factSection()).toBeNull();
    expect(component.fact()).toBeNull();
  });

  it('maps Math.random to the corresponding fact index', () => {
    const facts = ['first', 'second', 'third'];
    const rnd = jest.spyOn(Math, 'random');
    const pickWith = (r: number): string | null => {
      rnd.mockReturnValue(r);
      const f = TestBed.createComponent(QuizFactComponent);
      f.componentRef.setInput('facts', facts);
      f.detectChanges();
      return f.componentInstance.fact();
    };
    expect(pickWith(0)).toBe('first'); // floor(0 * 3) = 0
    expect(pickWith(0.5)).toBe('second'); // floor(0.5 * 3) = 1
    expect(pickWith(0.99)).toBe('third'); // floor(0.99 * 3) = 2
    rnd.mockRestore();
  });

  it('picks the fact once and does not change it on later change detection', () => {
    setFacts(['a', 'b', 'c', 'd', 'e']);
    const first = component.fact();
    for (let i = 0; i < 5; i++) fixture.detectChanges();
    expect(component.fact()).toBe(first);
  });

  it('exposes the note as ONE named graphic; the visible label, icon and paragraph are hidden from AT', () => {
    setFacts(['Some fact']);
    const sec = factSection()!;
    expect(sec.getAttribute('role')).toBe('img');
    expect(sec.getAttribute('aria-label')).toBe('Angular Fact. Some fact');
    // Visible content is unchanged but hidden from assistive technology.
    const label = sec.querySelector('.quiz-fact__heading') as HTMLElement;
    expect(label.textContent).toContain('Angular Fact');
    expect(label.getAttribute('aria-hidden')).toBe('true');
    expect(label.querySelector('.quiz-fact__icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(sec.querySelector('p.quiz-fact__text')?.getAttribute('aria-hidden')).toBe('true');
    expect(factText()).toBe('Some fact');
    // No separate heading, nothing interactive hidden inside, no live region.
    expect(sec.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    expect(sec.querySelector('a,button,input,select,textarea,[tabindex]')).toBeNull();
    expect(sec.querySelector('[aria-live]')).toBeNull();
  });

  it('names the graphic with exactly the fact being displayed (no second random pick)', () => {
    setFacts(['Fact A', 'Fact B', 'Fact C', 'Fact D', 'Fact E']);
    for (let i = 0; i < 5; i++) fixture.detectChanges();
    expect(factSection()!.getAttribute('aria-label')).toBe('Angular Fact. ' + factText());
    expect(component.ariaLabel()).toBe('Angular Fact. ' + component.fact());
  });
});
