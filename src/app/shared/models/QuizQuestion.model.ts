import { QuestionType } from './question-type.enum';

import { Option } from './Option.model';

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
}
