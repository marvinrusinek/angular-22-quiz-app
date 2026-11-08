/**
 * Capitalize the first letter of the first word of an explanation that is shown on its own.
 *
 * The bank stores explanations so they read naturally after "Option N is correct because ...", which means
 * many open in lowercase. The topic-quiz formatter lowercases the lead word to compose that sentence
 * (ExplanationFormatterService.lowercaseLead); Weak Areas Practice shows the stored text directly, so this
 * is the counterpart for that standalone display.
 *
 * Only the first letter changes; every other character, including leading whitespace, is returned as is.
 * A leading word is left alone when it is a name rather than prose, which keeps code and identifiers intact
 * (the same reasoning lowercaseLead uses for internal capitals):
 *  - it is not purely lowercase letters followed by whitespace, end of text or sentence punctuation, so
 *    `number[]`, `inject(HttpClient)`, `this.value`, `mat-form-field`, `async/await`, `ngClass` and `switchMap`
 *    (camelCase) stay as written, and text that opens with markup or a symbol (`@if`, `<b>`, `` ` ``) is untouched;
 *  - it is a known lowercase command word (`ng`, `npm`, `npx`), as in "ng serve ...".
 * Already-capitalized text, empty text and text with no leading word are returned unchanged.
 */
const LOWERCASE_COMMAND_WORDS = new Set(['ng', 'npm', 'npx']);

export function capitalizeLead(text: string): string {
  const m = (text ?? '').match(/^(\s*)([a-z]+)(?=$|[\s,;:!?—–])([\s\S]*)$/);
  if (!m) return text;
  const [, ws, word, tail] = m;
  if (LOWERCASE_COMMAND_WORDS.has(word)) return text;
  return ws + word.charAt(0).toUpperCase() + word.slice(1) + tail;
}
