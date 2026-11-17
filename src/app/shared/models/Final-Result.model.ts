export interface ScoreAnalysisItem {
  questionIndex: number;
  questionText: string;
  wasCorrect: boolean;
  selectedOptionIds: string[];
  correctOptionIds: string[];
  /**
   * AUTHORIZED terminal data, from the verdict history.
   *
   * Text-based because that is the public contract: the reveal a user earned is
   * a set of option strings and an explanation, never ids. The `*OptionIds`
   * fields above are retained so snapshots persisted by earlier builds still
   * render, but new consumers should read these.
   *
   * Optional because a question that never reached a terminal state has no
   * authorized reveal — the honest representation of that is absence, not an
   * empty array filled in from the local bank.
   */
  selectedOptionTexts?: string[];
  correctOptionTexts?: string[];
  explanation?: string | null;
}

/**
 * Strip authorized ANSWER DETAIL before a result is written to browser storage.
 *
 * `correctOptionTexts`, `explanation` and the legacy `correctOptionIds` are the
 * reveal a user earned during the attempt. Keeping them in memory for the
 * current Results/Review session is fine — they are already on screen. Writing
 * them to storage is different: it turns the browser into a durable answer
 * cache, which is the exact thing this migration removes from the bundle. A
 * stored answer key is no better than a shipped one.
 *
 * What survives is the user's OWN data plus their outcome: which options they
 * picked, and whether the question was right. Neither discloses the key.
 *
 * The saved result therefore stays stripped. So that a reload does not leave Quiz Review empty,
 * the reveal the player ALREADY earned in THIS completed attempt is kept separately by
 * CompletedReviewStoreService: scoped to one exact result (quizId + completedAt), bounded, validated
 * on read, cleared with this result, and restored without any request or receipt. It is not the
 * answer bank: only questions the player legitimately reached a reveal for are ever in it.
 */
export function toDurableFinalResult(result: FinalResult): FinalResult {
  return {
    ...result,
    analysis: (result.analysis ?? []).map(toDurableAnalysisItem)
  };
}

/** Also used when READING, so legacy entries stop carrying answer detail. */
export function toDurableAnalysisItem(item: ScoreAnalysisItem): ScoreAnalysisItem {
  return {
    questionIndex: item.questionIndex,
    questionText: item.questionText,
    wasCorrect: item.wasCorrect,
    // The user's own selection — not the answer key.
    selectedOptionIds: item.selectedOptionIds ?? [],
    selectedOptionTexts: item.selectedOptionTexts ?? [],
    // Deliberately emptied: this is the reveal.
    correctOptionIds: []
  };
}

export interface FinalResult {
  quizId: string;
  correct: number;
  total: number;
  percentage: number;
  analysis: ScoreAnalysisItem[];
  completedAt: number;
  /** Total elapsed time (seconds) captured at completion. Persisted so the
   *  Results page shows real elapsed time on revisit, when the live timer has
   *  been reset. Optional for backward compatibility with older snapshots. */
  completionTime?: number;
}
