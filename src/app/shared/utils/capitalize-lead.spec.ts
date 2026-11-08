import { capitalizeLead } from './capitalize-lead';

/**
 * Cases are the real opening shapes found in the bank: prose that must be capitalized, and names / code that must not.
 */
describe('capitalizeLead', () => {
  it.each([
    ['a design pattern where a class receives its dependencies.', 'A design pattern where a class receives its dependencies.'],
    ['the async pipe subscribes for you.', 'The async pipe subscribes for you.'],
    ['standalone components (the default in new Angular apps) declare their own imports.', 'Standalone components (the default in new Angular apps) declare their own imports.'],
    ['dependency injection is a pattern.', 'Dependency injection is a pattern.'],
    ['reactive forms define their model in the class.', 'Reactive forms define their model in the class.'],
    ['to run the tests, use the CLI.', 'To run the tests, use the CLI.'],
    ['this project uses Jest, so jest.fn() creates assertable mocks.', 'This project uses Jest, so jest.fn() creates assertable mocks.'],
    ['you can pass options.', 'You can pass options.'],
    ['properties and methods can be added.', 'Properties and methods can be added.'],
    ['modern Angular generates standalone components by default.', 'Modern Angular generates standalone components by default.'],
    ['when a service has dependencies, get it from TestBed.', 'When a service has dependencies, get it from TestBed.'],
    ['using #name="ngModel" exposes the control.', 'Using #name="ngModel" exposes the control.']
  ])('capitalizes prose: %s', (input, expected) => {
    expect(capitalizeLead(input)).toBe(expected);
  });

  it('changes only the first letter and keeps the rest byte for byte', () => {
    const rest = ' is unchanged — including RxJS, HTTP, OnPush, `code`, <b>html</b>, **markdown**, and a trailing space ';
    expect(capitalizeLead('property' + rest)).toBe('Property' + rest);
  });

  it('keeps leading whitespace and capitalizes after it', () => {
    expect(capitalizeLead('  \n  the first word')).toBe('  \n  The first word');
  });

  it.each([
    'number[] is another way of writing Array<number>.',
    'inject(HttpClient) asks the injector.',
    'this.propertyName is the way to access a property.',
    'mat-form-field surrounds the input.',
    'async/await handles promise-based work.',
    'computed() creates a read-only signal.',
    'switchMap() unsubscribes from the previous request.',
    'ngClass is an attribute directive.',
    'useFactory runs a function.',
    'providedIn:\'root\' registers the service.',
    'forkJoin waits for every source.',
    'catchError() is an RxJS operator.',
    'tap() runs a side effect.',
    'from() turns an array into an Observable.',
    '@if conditionally includes a block.',
    '@Injectable({ providedIn: \'root\' }) registers the service.',
    'ng serve is the command that runs the app.',
    'npm install adds the dependencies.',
    '<b>bold</b> opening stays as written.',
    '`code` opening stays as written.',
    '**bold** opening stays as written.',
    '1 is a number.'
  ])('leaves identifiers, code and markup untouched: %s', (input) => {
    expect(capitalizeLead(input)).toBe(input);
  });

  it('leaves already-capitalized text, acronyms and empty input unchanged', () => {
    expect(capitalizeLead('The answer is B.')).toBe('The answer is B.');
    expect(capitalizeLead('HTTP requests are asynchronous.')).toBe('HTTP requests are asynchronous.');
    expect(capitalizeLead('RxJS is a library.')).toBe('RxJS is a library.');
    expect(capitalizeLead('OnPush limits checks.')).toBe('OnPush limits checks.');
    expect(capitalizeLead('')).toBe('');
    expect(capitalizeLead('   ')).toBe('   ');
  });

  it('is idempotent', () => {
    const once = capitalizeLead('the lead word');
    expect(capitalizeLead(once)).toBe(once);
  });
});
