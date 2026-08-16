import { Service, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { API_BASE_URL } from '../../tokens/api-base-url.token';

/**
 * Topic Quiz question loading from the private API.
 *
 * ── The point of this service ──────────────────────────────────────
 *
 * Topic Quizzes have always read their questions from the bundled
 * `assets/data/quiz.json`, which carries the answer key with them. This loads
 * the same questions from `GET /api/quizzes/:quizId/questions`, whose response
 * contains no correctness, no explanations and no identifiers — only what a
 * player is entitled to see before answering.
 *
 * ── Why a separate view model ──────────────────────────────────────
 *
 * The shared `QuizQuestion`/`Option` models carry `correct`, `explanation` and
 * `optionId`, because the local bank populates them and Interview Mode and
 * Weak Areas Practice still rely on them. Mapping API data into those models
 * would mean inventing values for fields the server deliberately withheld —
 * and `correct: false` is not "unknown", it is a claim that the option is
 * wrong. Absence is the only honest representation, so this returns its own
 * type where those fields simply do not exist.
 *
 * That also makes the guarantee structural rather than a matter of discipline:
 * a consumer of `TopicQuizQuestionView` cannot read `option.correct`, because
 * TypeScript has no such property to offer.
 */

/** Wire shape. Mirrors `TopicQuizQuestionsDto` on the server exactly. */
interface TopicQuizOptionDto {
  readonly text: string;
}

interface TopicQuizQuestionDto {
  readonly questionText: string;
  readonly type: TopicQuizQuestionType;
  readonly difficulty: string | null;
  readonly correctCount: number;
  readonly options: readonly TopicQuizOptionDto[];
}

interface TopicQuizQuestionsDto {
  readonly quizId: string;
  readonly questions: readonly TopicQuizQuestionDto[];
}

/**
 * The server's vocabulary, kept verbatim.
 *
 * Deliberately NOT translated into the `QuestionType` enum
 * (`single_answer` / …). The option-rendering layer already speaks these exact
 * strings, and Interview Mode consumes them unmapped from its own endpoint, so
 * introducing a translation here would add a third vocabulary rather than
 * remove one. `trueFalse` is a label for a single-selection question, not a
 * distinct behaviour.
 */
export type TopicQuizQuestionType = 'single' | 'multiple' | 'trueFalse';

/** An option the player can see: its text, and nothing else. */
export interface TopicQuizOptionView {
  readonly text: string;
}

/** A question the player can see. No correctness, no explanation, no ids. */
export interface TopicQuizQuestionView {
  readonly questionText: string;
  readonly type: TopicQuizQuestionType;
  readonly difficulty: string | null;
  /**
   * HOW MANY options are correct — never which.
   *
   * The "(N answers are correct)" banner has always shown this number before
   * the user answers; it used to be counted from `option.correct` in the
   * bundled bank. Cardinality is not identity, and this view still has no
   * `correct` field for a consumer to read.
   *
   * NOT a type signal. `type` above is declared and authoritative.
   */
  readonly correctCount: number;
  readonly options: readonly TopicQuizOptionView[];
}

export class TopicQuizQuestionsError extends Error {
  public override readonly name = 'TopicQuizQuestionsError';
}

const VALID_TYPES: readonly TopicQuizQuestionType[] = ['single', 'multiple', 'trueFalse'];

@Service()
export class TopicQuizQuestionsService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  /**
   * Load one quiz's public questions.
   *
   * Fails CLOSED. There is no fallback to the local bank — a fallback would
   * work in every test and then fail silently the day the asset is deleted,
   * which is the whole failure mode this migration exists to remove.
   */
  loadQuestions(quizId: string): Observable<readonly TopicQuizQuestionView[]> {
    if (!quizId) {
      return throwError(() => new TopicQuizQuestionsError('Unknown quiz'));
    }

    const url = `${this.apiBaseUrl}/quizzes/${encodeURIComponent(quizId)}/questions`;

    return this.http.get<TopicQuizQuestionsDto>(url).pipe(
      map((body) => this.toViews(body)),
      catchError((err: unknown) =>
        throwError(() =>
          err instanceof TopicQuizQuestionsError
            ? err
            : new TopicQuizQuestionsError('Could not load questions')
        )
      )
    );
  }

  /**
   * Map the response, rejecting anything malformed.
   *
   * Built field by field rather than by spreading the DTO: a spread would
   * silently carry through any extra property the server ever added, which for
   * this endpoint is precisely the risk worth designing against. If a
   * `correct` field ever appeared in the response, it would not reach a
   * consumer.
   */
  private toViews(body: TopicQuizQuestionsDto): readonly TopicQuizQuestionView[] {
    if (!body || !Array.isArray(body.questions)) {
      throw new TopicQuizQuestionsError('Could not load questions');
    }

    return body.questions.map((question) => {
      if (!question || typeof question.questionText !== 'string' || !question.questionText) {
        throw new TopicQuizQuestionsError('Could not load questions');
      }
      if (!VALID_TYPES.includes(question.type)) {
        // The type is DECLARED by the server. Guessing it from the options is
        // what the local path did, and it needed the answer key to do so.
        throw new TopicQuizQuestionsError('Could not load questions');
      }
      if (!Array.isArray(question.options) || question.options.length === 0) {
        throw new TopicQuizQuestionsError('Could not load questions');
      }

      // A missing or malformed count is NOT reconstructed from anything local —
      // it becomes -1, which `correctCountOf` reports as unknown and the banner
      // treats as "do not show". Zero would be a claim ("no option is
      // correct"); -1 is the absence of a claim.
      const rawCount = (question as { correctCount?: unknown }).correctCount;
      const correctCount =
        typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
          ? rawCount
          : -1;

      return {
        questionText: question.questionText,
        type: question.type,
        difficulty: typeof question.difficulty === 'string' ? question.difficulty : null,
        correctCount,
        options: question.options.map((option: TopicQuizOptionDto) => {
          if (!option || typeof option.text !== 'string' || !option.text) {
            throw new TopicQuizQuestionsError('Could not load questions');
          }
          return { text: option.text };
        })
      };
    });
  }
}
