import { Service, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import {
  TopicQuizQuestionsService,
  type TopicQuizQuestionType
} from './topic-quiz-questions.service';
import { QuestionType } from '../../models/question-type.enum';
import type { QuizQuestion } from '../../models/QuizQuestion.model';

/**
 * Authorized question TYPE for the current Topic Quiz, from the API.
 *
 * ── Why this exists ────────────────────────────────────────────────
 *
 * The Topic Quiz runtime decides single-vs-multiple by COUNTING correct
 * options — `answer.component` does it three times, and three consumers of
 * `resolveCorrectIndices` do it via `correctIndices.length > 1`. That makes
 * question type an answer-key derivative, so it cannot survive the bank
 * leaving the browser.
 *
 * The local `quiz.json` carries no `type` field at all (verified: 0 of 185
 * questions have one), so there is nothing else to read. `GET /questions`
 * does supply it explicitly — `single | multiple | trueFalse` — which is why
 * the type migration has to come before the pristine-correctness one rather
 * than after.
 *
 * ── What this deliberately is NOT ──────────────────────────────────
 *
 * Not a question store, and not a correctness source. It holds ONLY the type,
 * keyed by canonical question text. Question content still comes from the
 * local bank during this transitional slice, and correctness still comes from
 * QuestionVerdictService. Mixing API content with local-bank correctness is
 * exactly the mixed authority this migration must not create, so this carries
 * no options, no correctness and no explanation.
 */
@Service()
export class TopicQuizTypeRegistry {
  private readonly questionsApi = inject(TopicQuizQuestionsService);

  /** Canonical question text → declared type, for the loaded quiz. */
  private readonly types = new Map<string, TopicQuizQuestionType>();

  /**
   * Canonical question text → HOW MANY options are correct.
   *
   * Held beside the type rather than in a second registry so both facts share
   * one question identity and one load — a parallel store would be a second
   * chance to key them to different questions.
   *
   * Kept SEPARATE from `types` in meaning, though: this number must never
   * decide single-vs-multiple. That inference is what the type-authority work
   * removed, and `isMultiAnswer` below deliberately reads `types`, not this.
   */
  private readonly correctCounts = new Map<string, number>();

  /** The quiz currently loaded. Switching quizzes discards the old types. */
  private loadedQuizId: string | null = null;

  /** In-flight load, shared so repeated entry does not refetch. */
  private inFlight: Observable<void> | null = null;

  /** Exposed so a caller can react once types become available. */
  readonly ready = signal<boolean>(false);

  /** Matches the canonicalization used elsewhere for question identity. */
  private key(questionText: string): string {
    return questionText.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /**
   * Load the declared types for a quiz, at most once per quiz.
   *
   * Never rejects. A failure leaves the registry empty, and callers fall back
   * to their existing behaviour — which is correct for a TRANSITIONAL slice:
   * type is not correctness, so an unavailable API must not break the quiz.
   * That fallback disappears with the question-source cutover, at which point
   * a failed load means no questions at all.
   */
  load(quizId: string): Observable<void> {
    if (!quizId) return of(undefined);

    if (this.loadedQuizId === quizId && this.inFlight) return this.inFlight;

    this.loadedQuizId = quizId;
    this.types.clear();
    this.correctCounts.clear();
    this.ready.set(false);

    this.inFlight = this.questionsApi.loadQuestions(quizId).pipe(
      tap((questions) => {
        for (const question of questions) {
          const key = this.key(question.questionText);
          this.types.set(key, question.type);
          // -1 is the service's "the server did not give us a usable count".
          // Not recorded at all, so `correctCountOf` reports unknown.
          if (question.correctCount >= 0) {
            this.correctCounts.set(key, question.correctCount);
          }
        }
        this.ready.set(true);
      }),
      map(() => undefined),
      catchError(() => {
        // Empty registry, not a thrown error. See the note above.
        this.ready.set(false);
        return of(undefined);
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    return this.inFlight;
  }

  /**
   * The DECLARED type for a question, or null when unknown.
   *
   * Null means "the API has not told us", never "single". Callers must keep
   * their own fallback rather than treating absence as a default, or a slow
   * load would silently turn multi-answer questions into single-answer ones.
   */
  typeOf(questionText: string | null | undefined): TopicQuizQuestionType | null {
    if (!questionText) return null;
    return this.types.get(this.key(questionText)) ?? null;
  }

  /**
   * HOW MANY options are correct, or null when the API has not said.
   *
   * Null is NOT zero. Zero would assert that no option is correct; null says
   * nobody has told us, and the banner's contract is to render nothing rather
   * than guess — never to count `option.correct` in the local bank, which is
   * the dependency this exists to remove.
   *
   * Cardinality only. There is no accessor here for WHICH options are correct,
   * because the endpoint this reads does not carry that and must not.
   */
  correctCountOf(questionText: string | null | undefined): number | null {
    if (!questionText) return null;
    return this.correctCounts.get(this.key(questionText)) ?? null;
  }

  /**
   * Is this a multiple-answer question, per the API?
   *
   * Null when unknown, so a caller can distinguish "the API says single" from
   * "we do not know yet" — the distinction that makes the fallback safe.
   */
  isMultiAnswer(questionText: string | null | undefined): boolean | null {
    const type = this.typeOf(questionText);
    if (type === null) return null;
    // trueFalse is a single-selection question wearing a label.
    return type === 'multiple';
  }

  /**
   * The declared type as the app's own `QuestionType`, or null when unknown.
   *
   * `trueFalse` stays DISTINCT here. Collapsing it into single-answer at this
   * boundary would destroy the only place the distinction survives — consumers
   * that genuinely only care about selection cardinality can ask
   * `isMultiAnswer` instead, which is a narrower question.
   */
  questionTypeOf(questionText: string | null | undefined): QuestionType | null {
    switch (this.typeOf(questionText)) {
      case 'multiple': return QuestionType.MultipleAnswer;
      case 'trueFalse': return QuestionType.TrueFalse;
      case 'single': return QuestionType.SingleAnswer;
      default: return null;
    }
  }

  /**
   * Stamp the declared type onto questions that came from the local bank.
   *
   * This is the leverage point for the whole slice. Roughly fifteen consumers
   * already ask `question.type === QuestionType.MultipleAnswer` and only fall
   * back to counting correct options when that is unset — and the local bank
   * sets it on none of its 185 questions, so the fallback always won. Filling
   * the field in at the source makes those consumers authoritative without
   * touching them.
   *
   * Matching is by question TEXT, never by index, so shuffling cannot hand a
   * question its neighbour's type. A question the registry does not know is
   * left alone rather than defaulted.
   */
  applyDeclaredTypes(questions: readonly QuizQuestion[] | null | undefined): void {
    if (!Array.isArray(questions) || this.types.size === 0) return;

    for (const question of questions) {
      const declared = this.questionTypeOf(question?.questionText);
      if (declared !== null) question.type = declared;
    }
  }

  /** Leaving the quiz. Types are per-quiz and must not leak across them. */
  clear(): void {
    this.types.clear();
    this.loadedQuizId = null;
    this.inFlight = null;
    this.ready.set(false);
  }
}
