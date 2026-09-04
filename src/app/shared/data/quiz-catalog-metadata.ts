/**
 * SAFE, METADATA-ONLY quiz catalog snapshot — quiz-tile display data ONLY.
 *
 * Exists to solve one problem: the authoritative GET /api/quizzes call can
 * take 10-15+ seconds on a cold Render free-tier backend (confirmed via
 * direct TTFB measurement: ~12.4s cold vs ~0.2-0.4s warm), during which the
 * Topic Quiz tile grid would otherwise render nothing — `quizzes` in
 * QuizSelectionComponent is a pure computed() over TopicQuizMetadataService's
 * signals, which stay empty until that response lands.
 *
 * This snapshot seeds those signals SYNCHRONOUSLY on service construction so
 * tiles paint immediately, and TopicQuizMetadataService.load() OVERWRITES
 * every field the moment the real response arrives — this is a first-paint
 * placeholder, never a fallback source of truth, and it is never consulted
 * again once the network response lands.
 *
 * ── Why this does NOT reintroduce the removed client answer bank ──────
 *
 * This is NOT the deleted src/assets/data/quiz.json (removed in the Stage 14
 * security migration) and must never become it again. It carries ONLY the
 * exact fields GET /api/quizzes already serves PUBLICLY to any anonymous
 * request — quizId, title, summary, image, difficulty, fact trivia, and a
 * question COUNT. It contains zero question text, zero options, zero
 * correctness, zero explanations, and zero answer-bank content of any kind.
 * Actual quiz content stays exclusively backend-authoritative and continues
 * to fail closed if the backend is unavailable — this file cannot answer a
 * single question.
 *
 * Captured from the live GET /api/quizzes response. May drift slightly
 * stale (e.g. a newly-added quiz) until the real response overwrites it,
 * which is an accepted, explicitly-authorized tradeoff for instant tiles.
 */

export interface QuizCatalogMetadataEntry {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string | null;
  readonly facts: readonly string[];
  readonly questionCount: number | null;
}

export const QUIZ_CATALOG_METADATA: readonly QuizCatalogMetadataEntry[] = [
  {
    quizId: "typescript",
    milestone: "TypeScript",
    summary: "TypeScript makes it easier to read and debug JavaScript code.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/ts.png",
    difficulty: "beginner",
    facts: ["TypeScript compiles down to plain JavaScript, so the types are erased at build time and the output runs anywhere JavaScript runs.","Type inference means TypeScript often knows a variable's type from its initial value, so you don't have to annotate everything.","Strict mode catches whole classes of bugs at compile time, such as using a value that might be null or undefined."],
    questionCount: 10,
  },
  {
    quizId: "create-first-app",
    milestone: "Creating your first app",
    summary: "Angular allows us to create an app that contains components and modules as well as a system for bootstrapping the app.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/first_app.png",
    difficulty: "beginner",
    facts: ["A modern Angular app bootstraps a single root standalone component with bootstrapApplication — no root NgModule required.","Every component pairs a TypeScript class for logic with a template for the view, wired together by the @Component decorator.","The Angular CLI scaffolds a runnable app in seconds, complete with a dev server, unit testing, and a production build."],
    questionCount: 10,
  },
  {
    quizId: "templates",
    milestone: "Templates",
    summary: "Angular has a very expressive template system, which takes HTML as a base, and extends it with custom elements.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/template.png",
    difficulty: "beginner",
    facts: ["Angular's built-in control flow — @if, @for, @switch — is part of the template syntax, so it needs no directive imports.","The three core bindings are property binding [x], event binding (x), and two-way binding [(x)] (the \"banana in a box\").","Template expressions are sandboxed from globals like window, which keeps templates safe, predictable, and easy to test."],
    questionCount: 10,
  },
  {
    quizId: "dependency-injection",
    milestone: "Dependency Injection",
    summary: "Dependency Injection is a way of providing dependencies in your code instead of hard-coding them.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/DIDiagram.png",
    difficulty: "intermediate",
    facts: ["Angular's injector is hierarchical — a dependency is resolved by walking up from the component toward the root injector.","providedIn: 'root' makes a service tree-shakable: if nothing injects it, it is dropped from the production bundle.","The inject() function retrieves dependencies outside a constructor, such as in field initializers or reusable functions."],
    questionCount: 7,
  },
  {
    quizId: "component-tree",
    milestone: "Component Trees",
    summary: "An Angular application can be thought of as a tree of reusable components.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/tree.png",
    difficulty: "intermediate",
    facts: ["Data flows down through inputs and events flow up through outputs — a one-way pattern that keeps interactions predictable.","Components that are not directly related usually communicate through a shared service holding a signal or a Subject.","Signal inputs (input()) and outputs (output()) are the modern, type-safe alternatives to the @Input and @Output decorators."],
    questionCount: 7,
  },
  {
    quizId: "router",
    milestone: "Angular Router",
    summary: "Angular Router helps developers build Single Page Applications with multiple views and allow navigation between those views.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/router.png",
    difficulty: "intermediate",
    facts: ["Lazy routes (loadComponent / loadChildren) put a feature in its own bundle that downloads only when the route is visited.","Route guards such as canActivate can allow, block, or redirect navigation — handy for auth and unsaved-changes checks.","withComponentInputBinding() binds route parameters directly to component inputs, so you can skip manual ActivatedRoute reads."],
    questionCount: 7,
  },
  {
    quizId: "material",
    milestone: "Angular Material",
    summary: "Angular Material provides a set of Material Design components that are consistent, versatile and look great on mobile devices.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/material.png",
    difficulty: "intermediate",
    facts: ["Angular Material is built on the CDK (Component Dev Kit), which also ships unstyled behaviors you can use on their own.","Material components include accessibility out of the box — ARIA roles, keyboard support, and focus management.","A single Material theme defines your color palette and typography and applies it consistently across every component."],
    questionCount: 7,
  },
  {
    quizId: "forms",
    milestone: "Angular Forms",
    summary: "Angular forms build upon standard HTML forms to help create custom form controls and support easy validation.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/forms.png",
    difficulty: "intermediate",
    facts: ["Angular has two form styles: template-driven (simple, ngModel-based) and reactive (an explicit form model in TypeScript).","Reactive forms expose value and validity as observables, which makes complex or dynamic forms easier to manage and test.","Angular ships built-in validators like required, minLength, email, and pattern, and lets you add custom validators."],
    questionCount: 11,
  },
  {
    quizId: "angular-cli",
    milestone: "Angular-CLI",
    summary: "The Angular CLI is a command-line interface tool used for initializing, developing, scaffolding and maintaining Angular applications.",
    image: "https://raw.githubusercontent.com/marvinrusinek/codelab-angular-10-quiz-app/quiz/codelab-master/apps/playground/src/assets/images/angular-cli.png",
    difficulty: "beginner",
    facts: ["ng build applies production optimizations by default — tree shaking, minification, and bundling — using esbuild-based tooling.","ng generate scaffolds standalone components, services, and directives following Angular's conventions automatically.","ng update migrates your app across Angular versions, running automated code migrations (schematics) where possible."],
    questionCount: 8,
  },
  {
    quizId: "change-detection",
    milestone: "Change Detection",
    summary: "Change detection keeps the view in sync with your data — learn how it runs, the OnPush strategy, and how to optimize it.",
    image: "assets/images/change-detection.svg",
    difficulty: "advanced",
    facts: ["Change detection runs top-down through the component tree, so smaller components let Angular skip untouched branches faster.","The async pipe marks its component for check when its observable emits, which is why it pairs well with OnPush.","Angular DevTools includes a profiler that visualizes change-detection cycles, helping you spot components that check too often."],
    questionCount: 8,
  },
  {
    quizId: "http",
    milestone: "Angular HTTP",
    summary: "Talk to servers the modern Angular way — provideHttpClient, typed requests, params and headers, error handling, functional interceptors, and cancellation.",
    image: "assets/images/http.svg",
    difficulty: "intermediate",
    facts: ["By default HttpClient parses the response body as JSON — set responseType to 'text', 'blob', or 'arraybuffer' when you need something else.","HttpParams and HttpHeaders are immutable — methods like set() and append() return a new instance instead of mutating the original.","The HttpClient testing tools (provideHttpClientTesting and HttpTestingController) let you unit-test HTTP calls without making real network requests."],
    questionCount: 10,
  },
  {
    quizId: "testing",
    milestone: "Angular Testing",
    summary: "Test Angular the modern way — TestBed and fixtures, change detection, injected services, spies and mocks, async, signals, HTTP, and choosing the right test level.",
    image: "assets/images/testing.svg",
    difficulty: "intermediate",
    facts: ["Playwright tests run through a real browser context, while Angular Jest unit tests run in a faster, more isolated jsdom environment.","Excessive mocking can make a test pass even when the real, integrated behavior is broken — so mock only what a test genuinely needs to isolate.","TestBed builds a dedicated testing module for each test, keeping tests isolated from the real application bootstrap and from each other."],
    questionCount: 10,
  },
  {
    quizId: "performance",
    milestone: "Angular Performance",
    summary: "Build faster Angular apps — change detection and OnPush, signals, @for track, lazy loading, @defer, image and template optimization, and smaller bundles.",
    image: "assets/images/performance.svg",
    difficulty: "intermediate",
    facts: ["Hydration lets a server-rendered Angular app become interactive without re-rendering the whole page, reducing flicker and work on load.","Zoneless change detection (dropping Zone.js) lets Angular schedule updates from signals, cutting the overhead of patched async APIs.","Standalone components with the modern esbuild-based builder produce smaller, faster builds than legacy NgModule setups."],
    questionCount: 10,
  },
  {
    quizId: "rxjs",
    milestone: "RxJS",
    summary: "Think reactively in Angular — Observables and operators, subjects, combining streams, error handling, and preventing memory leaks with the async pipe and takeUntil.",
    image: "assets/images/rxjs.svg",
    difficulty: "advanced",
    facts: ["Cold Observables (like HttpClient calls) start a fresh execution for each subscriber, while hot Observables (like a Subject) share one execution among all subscribers.","shareReplay() lets multiple subscribers share a single underlying execution and replays the last result, avoiding duplicate HTTP requests.","RxJS operators are pure, pipeable functions that return a new Observable, so unused operators are tree-shaken out of the production bundle."],
    questionCount: 10,
  },
  {
    quizId: "signals",
    milestone: "Angular Signals",
    summary: "Master reactive state in Angular — writable signals, computed derived state, effects, signals in templates, and when to reach for signals instead of RxJS.",
    image: "assets/images/signals.svg",
    difficulty: "advanced",
    facts: ["input() creates a signal-based component input that replaces the @Input decorator and is read like any other signal in templates and computed values.","toSignal() and toObservable() bridge RxJS and Signals, so you can adopt Signals incrementally alongside existing Observable code.","In a zoneless Angular app, signals are the primary way Angular knows when to update the view, replacing Zone.js-based change detection."],
    questionCount: 10,
  },
  {
    quizId: "component-architecture",
    milestone: "Component Architecture",
    summary: "Design scalable Angular apps with clean component structure and state patterns.",
    image: "assets/images/component-architecture.svg",
    difficulty: "advanced",
    facts: ["Smart (container) components own data and orchestration, while presentational components stay focused on rendering — a split that keeps UI pieces reusable and testable.","Content projection lets a component host arbitrary template content, often a cleaner design than adding another configurable @Input() for every variation.","Organizing a large codebase by feature rather than by file type keeps related components, services, and routes together and ready to lazy-load."],
    questionCount: 10,
  },
  {
    quizId: "dependency-injection-advanced",
    milestone: "Advanced DI",
    summary: "Master Angular's DI system: injectors, providers, and smart scoping choices.",
    image: "assets/images/dependency-injection-advanced.svg",
    difficulty: "advanced",
    facts: ["Angular has two parallel injector trees: the EnvironmentInjector hierarchy (platform to root to route) and the ElementInjector hierarchy that follows the component tree.","A class is its own DI token, which is why non-class dependencies (config objects, primitives, interfaces) need an InjectionToken to be injected.","providedIn: 'root' services are tree-shakable: if nothing injects a service, the bundler can drop it from the build."],
    questionCount: 10,
  },
  {
    quizId: "directives",
    milestone: "Directives",
    summary: "Use Angular directives and control flow to build clean, dynamic templates.",
    image: "assets/images/directives.svg",
    difficulty: "beginner",
    facts: ["Angular has three directive types: components (a directive with a template), structural directives that change DOM layout, and attribute directives that change an element's look or behavior.","The newer control-flow blocks (@if, @for, @switch) are built into the template syntax and replace the older *ngIf/*ngFor/*ngSwitch structural directives.","ng-container groups elements and hosts structural logic without rendering any element of its own, which keeps the DOM clean."],
    questionCount: 10,
  },
  {
    quizId: "pipes",
    milestone: "Pipes",
    summary: "Transform and format template data with Angular's built-in and custom pipes.",
    image: "assets/images/pipes.svg",
    difficulty: "beginner",
    facts: ["A pipe transforms a value for display using the | symbol in a template, without changing the original data.","The AsyncPipe subscribes to an Observable and unsubscribes automatically when the component is destroyed, preventing memory leaks.","Chained pipes run left to right, so {{ value | slice:0:5 | uppercase }} slices first, then uppercases the result."],
    questionCount: 10,
  },
  {
    quizId: "design-patterns",
    milestone: "Design Patterns",
    summary: "Apply proven design patterns to build scalable, maintainable Angular architecture.",
    image: "assets/images/design-patterns.svg",
    difficulty: "advanced",
    facts: ["Design patterns are shared, proven solutions to recurring problems; they give a team a common vocabulary and a maintainable structure, not a performance boost.","A Facade service coordinates several underlying services behind one simple API, so components depend on the facade instead of the tangle beneath it.","RxJS Observables and Subjects are Angular’s built-in expression of the Observer pattern: subscribers react to values emitted over time."],
    questionCount: 10,
  },
];
