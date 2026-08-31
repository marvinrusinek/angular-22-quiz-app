import { QuizQuestion } from './QuizQuestion.model';

export type QuizDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Quiz {
  quizId: string;
  milestone: string;
  summary: string;
  image: string;
  difficulty?: QuizDifficulty;
  facts?: string[];
  questions?: QuizQuestion[];
  shuffleOptions?: boolean;
  status?: string;
  // Metadata-only question count, for a catalog projection that has no
  // `questions` array (e.g. Quiz Selection, built from TopicQuizMetadataService).
  // Consumers that count questions should prefer this over `questions?.length`.
  questionCount?: number;
}
