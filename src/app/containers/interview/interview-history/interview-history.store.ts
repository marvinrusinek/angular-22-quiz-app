import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';

import { InterviewAttemptHistoryEntry } from '@shared/models';
import {
  filterAttempts,
  InterviewHistoryFilter,
  InterviewHistoryService
} from '@shared/services/features/interview/interview-history.service';

/** One rendered Interview History card. */
export interface HistoryCard {
  entry: InterviewAttemptHistoryEntry;
  number: number; // lifetime attempt number (falls back to chronological position for legacy records)
  topics: string[];
}

/**
 * The ONLY state this store owns: which filter chip is selected.
 *
 * The attempt history itself is deliberately NOT here. InterviewHistoryService stays the single owner of the persisted
 * history (loading, validation, retention, deduplication, trends); copying it into a second mutable state would create
 * two sources of truth that could drift apart.
 */
interface InterviewHistoryViewState {
  filter: InterviewHistoryFilter;
}

const initialState: InterviewHistoryViewState = { filter: 'all' };

/**
 * Component-scoped SignalStore for the Interview History page. Provide it in the component's `providers` (NOT
 * `providedIn: 'root'`), so every component instance gets its own store and the filter resets to "all" whenever the
 * page is created again.
 *
 * What each SignalStore feature is doing here:
 *  - `signalStore(...)`   builds an injectable class from the features listed below; it is a normal Angular provider.
 *  - `withState(...)`     declares the mutable state. Each key becomes a read-only signal on the store (`store.filter()`).
 *  - `withComputed(...)`  adds derived signals. They are ordinary `computed()`s, so they re-run when the signals they read
 *                         change. Here they read the SERVICE's history signal directly (no copy) plus this store's
 *                         `filter`, which makes them reactive to both. The factory runs in an injection context, so
 *                         `inject()` is allowed inside it.
 *  - `withMethods(...)`   adds the store's public operations. State is changed only through `patchState`, which is why
 *                         the state itself is read-only to consumers.
 */
export const InterviewHistoryStore = signalStore(
  withState(initialState),

  withComputed(({ filter }) => {
    // The service's own read-only signal: the single source of truth for the history. Read, never copied.
    const history = inject(InterviewHistoryService).history;

    // Per-filter counts for the filter chips, always over the FULL history (not the filtered list).
    const counts = computed<Record<InterviewHistoryFilter, number>>(() => {
      const all = history();
      return {
        all: all.length,
        submitted: all.filter((a) => a.completionReason === 'submitted').length,
        'time-expired': all.filter((a) => a.completionReason === 'time-expired').length
      };
    });

    // Cards, newest first. The number is the persisted lifetime attempt number (stable as older attempts age out);
    // it falls back to chronological position for any legacy record still missing one.
    const cards = computed<HistoryCard[]>(() => {
      const all = history();
      const positionById = new Map(all.map((e, i) => [e.id, i + 1]));
      return filterAttempts(all, filter())
        .slice()
        .reverse()
        .map((entry) => ({
          entry,
          number: entry.attemptNumber ?? positionById.get(entry.id) ?? 0,
          topics: topicsFor(entry)
        }));
    });

    return { counts, cards };
  }),

  withMethods((store) => ({
    /** Select a filter chip. */
    setFilter(id: InterviewHistoryFilter): void {
      patchState(store, { filter: id });
    }
  }))
);

/** Topic names from the attempt's own performance, else its selected topic ids. */
function topicsFor(entry: InterviewAttemptHistoryEntry): string[] {
  const fromPerf = entry.topicPerformance.map((t) => t.topicName).filter(Boolean);
  if (fromPerf.length > 0) return fromPerf;
  return [...(entry.selectedTopicIds ?? [])];
}
