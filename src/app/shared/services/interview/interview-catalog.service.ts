import { computed, inject, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { InterviewApiService } from '@shared/services/api/interview-api.service';
import type { QuizMetadataDto } from '@shared/models/api/interview-api.dto';

/**
 * Interview Mode's topic catalogue, sourced from the BACKEND.
 *
 * The builder needs to know which topics exist, what they are called, and how
 * many questions each holds — nothing more. That is public metadata, and it now
 * comes from `GET /api/quizzes` rather than the bundled quiz bank.
 *
 * There is deliberately NO fallback to `assets/data/quiz.json`. Falling back
 * would let the builder offer topics the server cannot actually build an
 * assessment from, and would quietly reintroduce the local quiz bank as an
 * Interview dependency. When the backend is unreachable the builder says so.
 *
 * Topic Quizzes and Weak Areas Practice still read the local asset; they are
 * separate modes and are not migrated.
 */

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** What the builder needs about one topic. */
export interface InterviewTopic {
  readonly id: string;
  readonly name: string;
  readonly difficulty: string;
  readonly questionCount: number;
}

@Service()
export class InterviewCatalogService {
  private readonly api = inject(InterviewApiService);

  private readonly _topics = signal<readonly InterviewTopic[]>([]);
  private readonly _status = signal<CatalogStatus>('idle');

  readonly topics = this._topics.asReadonly();
  readonly status = this._status.asReadonly();
  readonly loading = computed(() => this._status() === 'loading');
  readonly unavailable = computed(() => this._status() === 'unavailable');

  /**
   * Load once. Repeat calls while ready are a no-op so navigating back to the
   * builder does not re-fetch; `reload()` is the explicit retry.
   */
  async load(): Promise<void> {
    if (this._status() === 'ready' || this._status() === 'loading') return;
    await this.fetch();
  }

  async reload(): Promise<void> {
    await this.fetch();
  }

  private async fetch(): Promise<void> {
    this._status.set('loading');
    try {
      const metadata = await firstValueFrom(this.api.getQuizMetadata());
      this._topics.set(metadata.filter(isUsable).map(toTopic));
      // An empty catalogue is not "ready" — the builder would show no topics
      // at all, which reads as breakage rather than as a backend problem.
      this._status.set(this._topics().length > 0 ? 'ready' : 'unavailable');
    } catch {
      this._topics.set([]);
      this._status.set('unavailable');
    }
  }

  /**
   * Topics selectable at a difficulty. `mixed` spans everything, matching how
   * the backend builds a mixed assessment.
   */
  topicsFor(difficulty: string | null): readonly InterviewTopic[] {
    if (!difficulty) return [];
    if (difficulty === 'mixed') return this._topics();
    return this._topics().filter((topic) => topic.difficulty === difficulty);
  }

  /**
   * How many questions the selected topics can supply — the builder's capacity
   * preview and its "not enough questions" rule.
   */
  availableQuestions(topicIds: readonly string[]): number {
    const wanted = new Set(topicIds);
    return this._topics()
      .filter((topic) => wanted.has(topic.id))
      .reduce((sum, topic) => sum + topic.questionCount, 0);
  }

  /**
   * Questions per difficulty across the given topics.
   *
   * A role preset draws a fixed mix, so its capacity depends on how many
   * questions exist at each difficulty — not just the total. Duplicated topic
   * ids are counted once.
   */
  questionsByDifficulty(topicIds: readonly string[]): Record<string, number> {
    const wanted = new Set(topicIds);
    const counted = new Set<string>();
    const byDifficulty: Record<string, number> = {
      beginner: 0, intermediate: 0, advanced: 0
    };

    for (const topic of this._topics()) {
      if (!wanted.has(topic.id) || counted.has(topic.id)) continue;
      counted.add(topic.id);
      if (topic.difficulty in byDifficulty) {
        byDifficulty[topic.difficulty] += topic.questionCount;
      }
    }
    return byDifficulty;
  }
}

/** A topic with no questions can never be assessed, so it is never offered. */
function isUsable(metadata: QuizMetadataDto): boolean {
  return (
    typeof metadata.quizId === 'string' &&
    metadata.quizId.length > 0 &&
    Number.isFinite(metadata.questionCount) &&
    metadata.questionCount > 0
  );
}

function toTopic(metadata: QuizMetadataDto): InterviewTopic {
  return {
    id: metadata.quizId,
    // `milestone` is the human title the catalogue already uses.
    name: metadata.milestone || metadata.quizId,
    difficulty: metadata.difficulty,
    questionCount: Math.floor(metadata.questionCount)
  };
}
