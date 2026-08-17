import { Service } from '@angular/core';
import { Observable, of } from 'rxjs';
import {
  catchError, distinctUntilChanged, filter, map, take
} from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizShuffleService } from '../flow/quiz-shuffle.service';

import { isOptionCorrect } from '../../utils/is-option-correct';

@Service()
export class QuizQuestionResolverService {

  getQuestionByIndex(
    index: number,
    resolveShuffleQuizId: () => string | null,
    resolveCanonicalQuestion: (idx: number, q: QuizQuestion | null) => QuizQuestion | null,
    isShuffleEnabled: () => boolean,
    shuffledQuestions: QuizQuestion[],
    questions$: Observable<QuizQuestion[]>
  ): Observable<QuizQuestion | null> {
    const quizId = resolveShuffleQuizId();
    if (!quizId) return of(null);

    const resolvedQuestion = resolveCanonicalQuestion(index, null);

    if (resolvedQuestion) {
      if (isShuffleEnabled() && shuffledQuestions && shuffledQuestions.length > index) {
        const strictShuffled = shuffledQuestions[index];
        if (strictShuffled && strictShuffled.questionText !== resolvedQuestion.questionText) {
          return of({
            ...strictShuffled,
            options: (strictShuffled.options ?? []).map((o) => ({ ...o }))
          });
        }
      }

      return of({
        ...resolvedQuestion,
        options: (resolvedQuestion.options ?? []).map((o) => ({ ...o }))
      });
    }

    return questions$.pipe(
      filter((questions) => Array.isArray(questions) && questions.length > 0),
      take(1),
      map((questions: QuizQuestion[] | null) => {
        if (!Array.isArray(questions) || !questions[index]) return null;
        const q = questions[index];
        return {
          ...q,
          options: (q.options ?? []).map((o) => ({ ...o }))
        };
      })
    );
  }

  getCurrentQuestion(
    questionIndex: number,
    questions: QuizQuestion[]
  ): Observable<QuizQuestion | null> {
    return of(null).pipe(
      map(() => {
        if (!Array.isArray(questions) || questions.length === 0) return null;
        if (questionIndex < 0 || questionIndex >= questions.length) return null;

        return questions[questionIndex];
      }),
      distinctUntilChanged(),
      catchError(() => {
        return of(null);
      })
    );
  }

  resolveCanonicalQuestion(
    index: number,
    currentQuestion: QuizQuestion | null | undefined,
    quizId: string | null,
    isShuffleEnabled: () => boolean,
    shouldShuffle: () => boolean,
    shuffledQuestions: QuizQuestion[],
    canonicalQuestionsByQuiz: Map<string, QuizQuestion[]>,
    canonicalQuestionIndexByText: Map<string, Map<string, number>>,
    questions: QuizQuestion[],
    cloneQuestionForSession: (q: QuizQuestion, idx?: number) => QuizQuestion | null,
    normalizeQuestionText: (text: string | null | undefined) => string,
    quizShuffleService: QuizShuffleService
  ): QuizQuestion | null {
    if (!quizId) return null;

    // Strict Shuffle Priority
    if (isShuffleEnabled() && shuffledQuestions && shuffledQuestions.length > 0) {
      if (index >= 0 && index < shuffledQuestions.length) {
        return shuffledQuestions[index];
      }
    }

    const canonical = canonicalQuestionsByQuiz.get(quizId) ?? [];
    const source = Array.isArray(questions) ? questions : [];
    const hasCanonical = canonical.length > 0;
    const shuffleActive = shouldShuffle();

    const cloneCandidate = (
      question: QuizQuestion | null | undefined,
      reason: string
    ): QuizQuestion | null => {
      if (!question) return null;

      const clone = cloneQuestionForSession(question);
      if (!clone) return null;

      if (!clone.type) clone.type = question.type ?? QuestionType.SingleAnswer;


      return clone;
    };

    if (shuffleActive) {
      if (Array.isArray(shuffledQuestions) && shuffledQuestions.length > index && shuffledQuestions[index]) {
        return shuffledQuestions[index];
      }

      const base = hasCanonical ? canonical : source;
      if (!Array.isArray(base) || base.length === 0) {
        return cloneCandidate(currentQuestion, 'shuffle-no-base');
      }

      if (hasCanonical) {
        const originalIndex = quizShuffleService.toOriginalIndex(quizId, index);

        if (
          typeof originalIndex === 'number' &&
          Number.isInteger(originalIndex) &&
          originalIndex >= 0 &&
          originalIndex < canonical.length
        ) {
          const canonicalClone = cloneCandidate(canonical[originalIndex], 'canonical-original-index');
          if (canonicalClone) return canonicalClone;
        }
      }

      const fromShuffle = quizShuffleService.getQuestionAtDisplayIndex(quizId, index, base);
      const shuffleClone = cloneCandidate(fromShuffle, 'shuffle-display-index');
      if (shuffleClone) return shuffleClone;

      const baseClone = cloneCandidate(base[index], 'shuffle-base-index');
      if (baseClone) return baseClone;

      if (hasCanonical) {
        const canonicalClone = cloneCandidate(canonical[index], 'canonical-index');
        if (canonicalClone) return canonicalClone;
      }

      if (currentQuestion) {
        const currentKey = normalizeQuestionText(currentQuestion.questionText);
        if (currentKey) {
          const textIndexMap = canonicalQuestionIndexByText.get(quizId);
          const mappedIndex = textIndexMap?.get(currentKey);
          if (
            Number.isInteger(mappedIndex) &&
            mappedIndex! >= 0 &&
            mappedIndex! < canonical.length
          ) {
            const mappedClone = cloneCandidate(canonical[mappedIndex!], 'canonical-text-index');
            if (mappedClone) return mappedClone;
          }

          const fallbackMatch = canonical.find(
            (q) => normalizeQuestionText(q?.questionText) === currentKey
          );
          const fallbackClone = cloneCandidate(fallbackMatch, 'canonical-text-scan');
          if (fallbackClone) return fallbackClone;
        }
      }

      return cloneCandidate(currentQuestion ?? source[index] ?? null, 'current-fallback');
    }

    // Non-shuffle path
    const sourceClone = cloneCandidate(source[index], 'source-index');
    return sourceClone ?? null;
  }

  cloneQuestionForSession(question: QuizQuestion, qIndex?: number): QuizQuestion | null {
    if (!question) return null;

    const deepClone = JSON.parse(JSON.stringify(question)) as QuizQuestion;

    const normalize = (val: unknown): string =>
      String(val ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\u00A0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');

    // Phase 1: Normalize Options and enforce stable, unique numeric IDs
    const normalizedOptions = Array.isArray(deepClone.options)
      ? deepClone.options.map((option, optionIdx) => {
        const rawOId = (option as any).optionId;
        const oId = (typeof qIndex === 'number')
          ? (qIndex + 1) * 100 + (optionIdx + 1)
          : (!isNaN(Number(rawOId)) && Number(rawOId) > 0 ? Number(rawOId) : optionIdx + 1);

        return {
          ...option,
          optionId: oId,
          displayOrder: typeof option.displayOrder === 'number' ? option.displayOrder : optionIdx,
          selected: option.selected === true || (option as any).selected === 'true',
          highlight: option.highlight ?? false,
          showIcon: option.showIcon ?? false
        };
      })
      : [];

    // Phase 2: Build authoritative 'answer' array
    const finalAnswers: Option[] = [];
    if (Array.isArray(deepClone.answer)) {
      for (const rawAns of deepClone.answer) {
        if (!rawAns) continue;
        const normAnsText = normalize(rawAns.text);
        const ansId = Number(rawAns.optionId);

        // TEXT WINS, ID IS THE FALLBACK.
        //
        // These were one `find` with an OR, which let a STALE id match beat a
        // correct text match. Phase 1 above renumbers `optionId` by display
        // position, so after a shuffle the id an answer carries belongs to
        // whichever option now sits in that slot — a different option. The OR
        // matched that one first (it appears earlier in the array), so the
        // wrong option was recorded as correct and the right one as incorrect.
        //
        // Option text is the identity the server itself uses, and it survives
        // reordering; the id does not. Only fall back to the id when no text
        // matches at all.
        const match =
          normalizedOptions.find(o => {
            const normOptText = normalize(o.text);
            return !!normOptText && !!normAnsText && normOptText === normAnsText;
          }) ??
          normalizedOptions.find(o => !isNaN(ansId) && Number(o.optionId) === ansId);

        if (match) {
          finalAnswers.push({
            ...rawAns,
            optionId: match.optionId,
            text: match.text,
            correct: true
          });
        }
      }
    }

    // Fallback Phase 2
    if (finalAnswers.length === 0) {
      for (const o of normalizedOptions) {
        if (isOptionCorrect(o)) {
          finalAnswers.push({
            optionId: o.optionId,
            text: o.text,
            correct: true
          } as Option);
        }
      }
    }

    // Phase 3: Synchronize 'correct' flag
    //
    // NO ANSWER KEY, NO CLAIM. Synchronizing against an empty `finalAnswers`
    // stamps `correct: false` on every option and returns `answer: []` — which
    // asserts that each option is WRONG and that the question has no correct
    // answer at all. Questions from `GET /questions` carry neither, so this
    // manufactured an answer key out of the absence of one, on the very array
    // the view renders.
    //
    // Presence is still synchronized exactly as before; only absence is left
    // alone, so the bank-sourced paths (Weak Areas, pristine lookups) are
    // unaffected.
    const hasCorrectness = Array.isArray(deepClone.answer) && deepClone.answer.length > 0
      || normalizedOptions.some(o => (o as any).correct !== undefined);

    if (!hasCorrectness) {
      return { ...deepClone, options: normalizedOptions, answer: undefined };
    }

    const correctIds = new Set(finalAnswers.map(a => Number(a.optionId)));
    const finalOptions = normalizedOptions.map(o => ({
      ...o,
      correct: correctIds.has(Number(o.optionId))
    }));

    return {
      ...deepClone,
      options: finalOptions,
      answer: finalAnswers
    };
  }
}