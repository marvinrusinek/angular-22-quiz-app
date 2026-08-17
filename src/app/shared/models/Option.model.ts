import { Answer } from './Answer.type';

export interface Option {
  optionId?: number;
  displayOrder?: number;
  text: string;
  correct?: boolean;
  // Runtime reality: the local pipeline assigns the option TEXT here
  // (quiz-shuffle.assignOptionIds: `o.value ?? o.text ?? id`) and casts past
  // this type. Widened so the declaration matches what is actually stored.
  value?: string | number;
  answer?: Answer;
  selected?: boolean;
  active?: boolean;
  highlight?: boolean;
  showIcon?: boolean;
  feedback?: string;
  showFeedback?: boolean;
  styleClass?: string;
  _autoRevealedCorrect?: boolean;
}
