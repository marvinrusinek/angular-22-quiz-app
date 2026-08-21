import {
  toActiveInterviewQuestionDto,
  toInterviewReviewQuestionDto,
  toQuizMetadataDto,
  toQuizMetadataListDto
} from '../src/quiz/quiz.dto';
import { findPolicyViolation } from '../src/api/response-policy';
import { fixtureRepository } from './helpers/fixtures';

const repo = () => fixtureRepository();

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    out.push(key);
    keysDeep(nested, out);
  }
  return out;
}

describe('quiz metadata mapper', () => {
  it('maps exactly the safe fields', () => {
    const metadata = repo().getQuizMetadata()[0]!;
    const dto = toQuizMetadataDto(metadata);
    expect(Object.keys(dto).sort()).toEqual([
      'difficulty', 'facts', 'image', 'milestone', 'questionCount', 'quizId', 'summary'
    ]);
    expect(dto.quizId).toBe('rxjs');
    expect(dto.questionCount).toBe(2);
  });

  it('never carries questions, options, explanations or correctness', () => {
    const dtos = toQuizMetadataListDto(repo().getQuizMetadata());
    expect(findPolicyViolation({ quizzes: dtos }, 'PUBLIC_METADATA')).toBeNull();
    expect(keysDeep(dtos)).not.toContain('questions');
    expect(keysDeep(dtos)).not.toContain('options');
  });

  it('preserves source order', () => {
    expect(toQuizMetadataListDto(repo().getQuizMetadata()).map((q) => q.quizId))
      .toEqual(['rxjs', 'signals']);
  });
});

describe('ACTIVE interview question mapper', () => {
  const question = () => repo().getQuestionById('rxjs:q:0')!;

  it('excludes correctness entirely', () => {
    const dto = toActiveInterviewQuestionDto(question());
    expect(keysDeep(dto)).not.toContain('isCorrect');
    expect(keysDeep(dto)).not.toContain('correct');
    expect(JSON.stringify(dto)).not.toContain('isCorrect');
  });

  it('excludes the explanation', () => {
    const dto = toActiveInterviewQuestionDto(question());
    expect(keysDeep(dto)).not.toContain('explanation');
    expect(JSON.stringify(dto)).not.toContain('PRIVATE-EXPLANATION-RXJS');
  });

  it('excludes private source indexes', () => {
    const dto = toActiveInterviewQuestionDto(question());
    expect(keysDeep(dto)).not.toContain('sourceQuestionIndex');
    expect(keysDeep(dto)).not.toContain('sourceOptionIndex');
  });

  it('emits EXACTLY the allowed key set', () => {
    const dto = toActiveInterviewQuestionDto(question());
    expect(Object.keys(dto).sort()).toEqual([
      'options', 'questionId', 'questionText', 'sourceQuizId', 'type'
    ]);
    expect(Object.keys(dto.options[0]!).sort()).toEqual(['optionId', 'text']);
  });

  it('preserves question id, type, option ids and their order', () => {
    const source = question();
    const dto = toActiveInterviewQuestionDto(source);
    expect(dto.questionId).toBe('rxjs:q:0');
    expect(dto.type).toBe('single');
    expect(dto.options.map((o) => o.optionId)).toEqual(source.options.map((o) => o.optionId));
    expect(dto.options.map((o) => o.text)).toEqual(source.options.map((o) => o.text));
  });

  it('carries the derived type for multiple and trueFalse questions', () => {
    const r = repo();
    expect(toActiveInterviewQuestionDto(r.getQuestionById('rxjs:q:1')!).type).toBe('multiple');
    expect(toActiveInterviewQuestionDto(r.getQuestionById('signals:q:0')!).type).toBe('trueFalse');
  });

  it('passes the ACTIVE_ASSESSMENT policy', () => {
    const r = repo();
    const body = {
      questions: r.getEligibleQuestions().map(toActiveInterviewQuestionDto)
    };
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).toBeNull();
  });

  it('returns NEWLY CONSTRUCTED objects — not the private model', () => {
    const source = question();
    const dto = toActiveInterviewQuestionDto(source);
    expect(dto).not.toBe(source as unknown);
    expect(dto.options[0]).not.toBe(source.options[0] as unknown);
  });

  it('mutating the DTO does not touch the repository', () => {
    const r = repo();
    const dto = toActiveInterviewQuestionDto(r.getQuestionById('rxjs:q:0')!);
    (dto as { questionText: string }).questionText = 'TAMPERED';
    (dto.options as unknown as { optionId: number }[])[0]!.optionId = -1;

    const fresh = r.getQuestionById('rxjs:q:0')!;
    expect(fresh.questionText).toBe('Which answer is correct?');
    expect(fresh.options[0]!.optionId).toBe(101);
  });

  it('an absent source `correct` never surfaces as a DTO field', () => {
    // Option 2 of rxjs:q:0 omits `correct` in the fixture; privately it is
    // false, publicly it must not exist at all.
    const source = repo().getQuestionById('rxjs:q:0')!;
    expect(source.options[1]!.isCorrect).toBe(false);

    const dto = toActiveInterviewQuestionDto(source);
    expect('isCorrect' in dto.options[1]!).toBe(false);
    expect('correct' in dto.options[1]!).toBe(false);
  });
});

describe('SUBMITTED review mapper', () => {
  const question = () => repo().getQuestionById('rxjs:q:1')!;   // multiple-answer

  it('includes only the authorized correctness fields', () => {
    const dto = toInterviewReviewQuestionDto(question(), [301]);
    expect(Object.keys(dto).sort()).toEqual([
      'correctOptionIds', 'explanation', 'options', 'questionId',
      'questionText', 'selectedOptionIds', 'sourceQuizId', 'type'
    ]);
  });

  it('expresses correctness as an ID LIST, never per-option booleans', () => {
    const dto = toInterviewReviewQuestionDto(question(), []);
    expect(dto.correctOptionIds).toEqual([201, 202]);
    expect(keysDeep(dto)).not.toContain('isCorrect');
    expect(keysDeep(dto)).not.toContain('correct');
  });

  it('includes the explanation', () => {
    expect(toInterviewReviewQuestionDto(question(), []).explanation)
      .toBe('PRIVATE-EXPLANATION-MULTI');
  });

  it('does not expose private source indexes', () => {
    const keys = keysDeep(toInterviewReviewQuestionDto(question(), [201]));
    expect(keys).not.toContain('sourceQuestionIndex');
    expect(keys).not.toContain('sourceOptionIndex');
  });

  it('echoes the submitted selection without trusting it for correctness', () => {
    const dto = toInterviewReviewQuestionDto(question(), [999]);
    expect(dto.selectedOptionIds).toEqual([999]);
    expect(dto.correctOptionIds).toEqual([201, 202]);   // from the private bank
  });

  it('passes SUBMITTED_REVIEW but is BLOCKED under ACTIVE_ASSESSMENT', () => {
    const body = { review: [toInterviewReviewQuestionDto(question(), [201])] };
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')).toBeNull();
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).not.toBeNull();
  });

  it('copies the selection array rather than aliasing the caller', () => {
    const selected = [201];
    const dto = toInterviewReviewQuestionDto(question(), selected);
    selected.push(202);
    expect(dto.selectedOptionIds).toEqual([201]);
  });
});
