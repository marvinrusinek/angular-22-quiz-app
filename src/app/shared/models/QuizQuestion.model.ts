import { QuestionType } from './question-type.enum';

import { Option } from './Option.model';

/** A read-only code snippet shown alongside a question's text. Question CONTENT, never answer-key material. */
export interface CodeSnippet {
  language: 'typescript' | 'html' | 'css' | 'json';
  code: string;
  filename?: string;
}

export interface QuizQuestion {
  questionText: string;
  options: Option[];
  explanation?: string;
  selectedOptions?: Option[];
  answer?: Option[];
  selectedOptionIds?: number[];
  type?: QuestionType;
  maxSelections?: number;
  // Set by the Assessment Builder on questions cloned into a generated
  // (Interview Mode) assessment, so Review + per-topic breakdown can attribute
  // each question to its source topic quiz. Never present on catalog questions.
  sourceQuizId?: string;
  // Absent on every question that predates this feature.
  codeSnippet?: CodeSnippet;
}
