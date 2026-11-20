import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { QuizQuestion } from '@shared/models';
import { QuizService } from '@shared/services/data/quiz.service';
import { ScoreComponent } from './score.component';

function mount(correct = 3, total = 10) {
  const correctAnswersCountSig = signal(correct);
  const questions$ = new BehaviorSubject<QuizQuestion[]>(
    Array.from({ length: total }, () => ({} as QuizQuestion))
  );
  TestBed.configureTestingModule({
    imports: [ScoreComponent],
    providers: [
      provideNoopAnimations(),
      {
        provide: QuizService,
        useValue: {
          correctAnswersCountSig,
          questions$,
          totalQuestions: signal(total)
        }
      }
    ]
  });
  const fixture = TestBed.createComponent(ScoreComponent);
  fixture.detectChanges();
  return { fixture, correctAnswersCountSig, questions$ };
}

function control(fixture: ComponentFixture<ScoreComponent>) {
  return fixture.nativeElement.querySelector(
    'button.scoreboard-control'
  ) as HTMLButtonElement;
}

describe('ScoreComponent — combined score menu control', () => {
  beforeEach(() => localStorage.clear());

  it('includes the visible label and value in one named native menu button', () => {
    const { fixture } = mount();
    const button = control(fixture);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-label')).toBe('Score 3 out of 10');
    expect(button.querySelector('.leader')?.textContent).toBe('Score▼');
    expect(button.querySelector('.scoreboard')?.textContent).toBe('3/10');
    expect(button.querySelector('.scoreboard-score')?.getAttribute(
      'aria-hidden'
    )).toBe('true');
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('keeps the displayed and spoken scores synchronized after scoring', async () => {
    const { fixture, correctAnswersCountSig } = mount();
    correctAnswersCountSig.set(4);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(control(fixture).getAttribute('aria-label')).toBe(
      'Score 4 out of 10'
    );
    expect(control(fixture).querySelector('.scoreboard')?.textContent)
      .toBe('4/10');
  });

  it('opens the existing menu from the value and changes display mode', async () => {
    const { fixture } = mount();
    (control(fixture).querySelector('.scoreboard') as HTMLElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const percentage = document.querySelector(
      'button[name="percentage"]'
    ) as HTMLButtonElement;
    expect(percentage).not.toBeNull();
    percentage.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(control(fixture).getAttribute('aria-label')).toBe('Score 30 percent');
    expect(control(fixture).querySelector('.scoreboard')?.textContent).toBe('30%');
    expect(localStorage.getItem('scoreDisplayType')).toBe('percentage');
  });

  it('restores the percentage preference with the matching accessible name', () => {
    localStorage.setItem('scoreDisplayType', 'percentage');
    const { fixture } = mount(1, 3);
    expect(control(fixture).getAttribute('aria-label')).toBe('Score 33 percent');
    expect(control(fixture).querySelector('.scoreboard')?.textContent).toBe('33%');
  });

  it.each([
    [0, 0, '0/0', 'Score 0 out of 0'],
    [-2, 10, '0/10', 'Score 0 out of 10'],
    [12, 10, '10/10', 'Score 10 out of 10']
  ])('preserves score normalization for %s of %s', (correct, total, text, name) => {
    const { fixture } = mount(correct, total);
    expect(control(fixture).getAttribute('aria-label')).toBe(name);
    expect(control(fixture).querySelector('.scoreboard')?.textContent).toBe(text);
  });
});
