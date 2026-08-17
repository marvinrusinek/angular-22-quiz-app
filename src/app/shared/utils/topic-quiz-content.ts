import { QuestionType } from '../models/question-type.enum';
import type { Option } from '../models/Option.model';
import type { QuizQuestion } from '../models/QuizQuestion.model';
import type {
  TopicQuizQuestionType,
  TopicQuizQuestionView
} from '../services/api/topic-quiz-questions.service';

/**
 * Turning API question CONTENT into the app's `QuizQuestion` shape.
 *
 * ── What this deliberately does not produce ────────────────────────
 *
 * No `correct` on any option, no `explanation`, no `answer`. Those are not
 * omitted for tidiness — they are the answer key, and the endpoint does not
 * carry them. Inventing `correct: false` would be a CLAIM that an option is
 * wrong, and `explanation: ''` a claim that a question has none; both would
 * read as data to every consumer downstream.
 *
 * That is why `QuizQuestion.explanation` became optional in this slice. A
 * consumer that still requires it now fails to compile rather than silently
 * rendering an empty string it mistook for content.
 *
 * ── Option ids ─────────────────────────────────────────────────────
 *
 * The wire carries no identifiers; a question is addressed by its exact text
 * and an option by its exact text within it. Ids are assigned POSITIONALLY
 * here purely because the rendering layer wants a stable key per option within
 * the currently displayed list. They are local render ids and mean nothing to
 * the server — every request back to it is text-based.
 */

/** The server's vocabulary → the app's enum. `trueFalse` stays distinct. */
export function questionTypeFromApi(type: TopicQuizQuestionType): QuestionType {
  switch (type) {
    case 'multiple': return QuestionType.MultipleAnswer;
    case 'trueFalse': return QuestionType.TrueFalse;
    default: return QuestionType.SingleAnswer;
  }
}

/**
 * One API question view → one `QuizQuestion`.
 *
 * `questionIndex` seeds the option ids using the same
 * `(qIdx + 1) * 100 + (oIdx + 1)` scheme the local pipeline used, so anything
 * still keyed on an option id keeps working across the cutover.
 */
export function questionFromApiView(
  view: TopicQuizQuestionView,
  questionIndex: number
): QuizQuestion {
  const options: Option[] = view.options.map((option, optionIndex) => ({
    optionId: (questionIndex + 1) * 100 + (optionIndex + 1),
    text: option.text,
    // `value` IS THE TEXT, matching what the local pipeline produced.
    //
    // `quiz-shuffle.assignOptionIds` sets `value: o.value ?? o.text ?? id`, and
    // bank options carry no `value` — so every option's value has always been
    // its text. Several resolvers match selections on it
    // (`qqc-display-state-manager` does `answerValues.includes(option.value)`,
    // `option-id-resolver` and `selection-message` normalize it as a string).
    // Emitting a positional NUMBER here instead broke that matching, and the
    // symptom was a CORRECT click coming back "Not this one, try again!" —
    // the selection never matched, so the wrong texts were submitted to /check.
    value: option.text,
    displayOrder: optionIndex
    // NO `correct`. Absence is the honest representation of "the server did
    // not say", and the verdict is the only thing entitled to answer it.
  }));

  return {
    questionText: view.questionText,
    type: questionTypeFromApi(view.type),
    options
    // NO `explanation`. The FET body is authorized by /check (S1).
    // NO `answer`. That array is the answer key by another name.
  };
}

/** A whole quiz's questions, in the order the server returned them. */
export function questionsFromApiViews(
  views: readonly TopicQuizQuestionView[]
): QuizQuestion[] {
  return views.map((view, index) => questionFromApiView(view, index));
}
