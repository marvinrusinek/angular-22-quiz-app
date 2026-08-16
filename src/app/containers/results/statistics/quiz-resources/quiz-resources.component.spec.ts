import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizResourcesComponent } from './quiz-resources.component';
import type { Resource } from '../../../../shared/models/Resource.model';

/**
 * The "Brush up your knowledge" panel.
 *
 * Presentational only — it renders whatever list it is given, which since S3
 * comes from `GET /api/quizzes/:quizId/resources` instead of the `resources`
 * block of `assets/data/quiz.json`. The panel itself did not change; these
 * tests pin the contract the new source has to satisfy, most importantly that
 * ORDER IS THE LIST'S OWN and the panel never reorders it.
 */

const RESOURCES: Resource[] = [
  { title: 'Angular docs', url: 'https://angular.dev', host: 'Angular website' },
  { title: 'RxJS docs', url: 'https://rxjs.dev', host: 'RxJS website' },
  { title: 'A third link', url: 'https://example.test/three', host: '' }
];

let fixture: ComponentFixture<QuizResourcesComponent>;

function render(resources: Resource[], milestone = 'Angular Router') {
  fixture = TestBed.createComponent(QuizResourcesComponent);
  fixture.componentRef.setInput('resources', resources);
  fixture.componentRef.setInput('milestoneName', milestone);
  fixture.detectChanges();
  return fixture;
}

/** The panel starts collapsed, so open it before asserting on the list. */
function expand() {
  fixture.nativeElement.querySelector('.resources-header').click();
  fixture.detectChanges();
}

const items = (): HTMLElement[] =>
  Array.from(fixture.nativeElement.querySelectorAll('li'));

beforeEach(async () => {
  await TestBed.configureTestingModule({ imports: [QuizResourcesComponent] }).compileComponents();
});

describe('rendering API-sourced resources', () => {
  it('renders every resource it is given', () => {
    render(RESOURCES);
    expand();
    expect(items()).toHaveLength(3);
  });

  it('PRESERVES THE GIVEN ORDER', () => {
    render(RESOURCES);
    expand();
    expect(items().map((li) => li.querySelector('.resource-title')!.textContent!.trim()))
      .toEqual(['Angular docs', 'RxJS docs', 'A third link']);
  });

  it('links to the resource url and opens safely in a new tab', () => {
    render(RESOURCES);
    expand();
    const anchor = items()[0]!.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://angular.dev');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows the host attribution', () => {
    render(RESOURCES);
    expand();
    expect(items()[1]!.querySelector('.resource-host')!.textContent).toContain('RxJS website');
  });

  it('takes the milestone name from the quiz, not from the resource list', () => {
    // The API resources payload carries no milestone; the panel is given one by
    // its parent, from quiz metadata. Nothing here should need the API to
    // supply it.
    render(RESOURCES, 'Angular Forms');
    expect(fixture.nativeElement.textContent).toContain('Angular Forms');
  });
});

describe('a quiz with no resources', () => {
  it('renders no list items', () => {
    // The ordinary state for most quizzes, and also what the service yields
    // when the API is unreachable — the panel cannot tell the two apart, which
    // is the point.
    render([]);
    expand();
    expect(items()).toHaveLength(0);
  });

  it('does not throw when the list is empty', () => {
    expect(() => { render([]); expand(); }).not.toThrow();
  });
});
