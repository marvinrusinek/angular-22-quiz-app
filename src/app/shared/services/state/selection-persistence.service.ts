import { Service } from '@angular/core';

import { SK_DOT_CONFIRMED, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP } from '@shared/constants/session-keys';

import { SelectedOption } from '@shared/models';

import { norm } from '@shared/utils/text-norm';
import { swallow } from '@shared/utils/error-logging';

/**
 * The subset of SelectedOptionService state that the persistence layer
 * needs to read/write. Passing this interface avoids a circular dependency.
 */
export interface SelectionStateContext {
  rawSelectionsMap: Map<number, { optionId: number; text: string }[]>;
  selectedOptionsMap: Map<number, SelectedOption[]>;
  selectedOptionsMapSig: { set(v: Map<number, SelectedOption[]>): void };
  clickConfirmedDotStatus: Map<number, 'correct' | 'wrong'>;
  _selectionHistory: Map<number, SelectedOption[]>;
  _refreshBackup: Map<number, SelectedOption[]>;
}

@Service()
export class SelectionPersistenceService {
  // ── public methods ──────────────────────────────────────────────

  // ── Load from sessionStorage ───────────────────────────────

  loadState(ctx: SelectionStateContext): void {
    try {
      const raw = sessionStorage.getItem('rawSelectionsMap');
      if (raw) {
        const parsed = JSON.parse(raw);
        ctx.rawSelectionsMap = new Map(Object.entries(parsed).map(([k, v]) => [Number(k), v as any]));
      }

      const selected = sessionStorage.getItem(SK_SELECTED_OPTIONS_MAP);
      if (selected) {
        const parsed = JSON.parse(selected);
        const entries: Array<[number, SelectedOption[]]> = [];
        for (const [k, v] of Object.entries(parsed)) {
          const arr = Array.isArray(v) ? (v as any[]) : [];
          const userClicks = arr.filter(
            (o: any) => o && o.highlight === true && o.showIcon === true
          ) as SelectedOption[];
          if (userClicks.length > 0) entries.push([Number(k), userClicks]);          
        }
        ctx.selectedOptionsMap = new Map(entries);
        ctx.selectedOptionsMapSig.set(new Map(ctx.selectedOptionsMap));
      }

      try {
        const histRaw = sessionStorage.getItem('selectionHistory');
        if (histRaw) {
          const histParsed = JSON.parse(histRaw);
          for (const [k, v] of Object.entries(histParsed)) {
            const arr = Array.isArray(v) ? (v as any[]) : [];
            if (arr.length > 0) {
              ctx._selectionHistory.set(Number(k), arr.map((o: any) => ({ ...o })) as any);
            }
          }
        }
      } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }

      if (ctx.selectedOptionsMap.size > 0) {
        ctx._refreshBackup = new Map(ctx.selectedOptionsMap);
      }

      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      let isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
      if (!isPageRefresh && navEntries.length === 0) {
        for (let i = 0; i < 100; i++) {
          if (sessionStorage.getItem(SK_SEL_Q + i)) {
            isPageRefresh = true;
            break;
          }
        }
      }

      if (isPageRefresh) {
        this.restoreFromRefresh(ctx);
      } else {
        this.clearStaleSessionData(ctx);
      }

    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); }
  }

  private restoreFromRefresh(ctx: SelectionStateContext): void {
    for (let i = 0; i < 100; i++) {
      const val = sessionStorage.getItem(SK_DOT_CONFIRMED + i);
      if (val === 'correct' || val === 'wrong') {
        ctx.clickConfirmedDotStatus.set(i, val);
      }
    }
    for (let i = 0; i < 100; i++) {
      const sel = sessionStorage.getItem(SK_SEL_Q + i);
      if (sel) {
        try {
          const opts = JSON.parse(sel);
          if (Array.isArray(opts) && opts.length > 0) {
            // Exclude auto-revealed-only entries (autoreveal sets
            // highlight + showIcon on the correct option even when the
            // user didn't click it, which would otherwise get persisted
            // as a "userClick" and pollute selectedOptionsMap on rehydrate).
            const userClicks = opts.filter(
              (o: any) => o && o.highlight === true && o.showIcon === true &&
                !(o._autoRevealedCorrect === true && o.selected !== true)
            );
            if (userClicks.length > 0) {
              ctx.selectedOptionsMap.set(i, userClicks);
              ctx._selectionHistory.set(i, userClicks.map((o: any) => ({ ...o })));
              if (userClicks.length !== opts.length) {
                sessionStorage.setItem(SK_SEL_Q + i, JSON.stringify(userClicks));
              }
            } else {
              ctx.selectedOptionsMap.delete(i);
              sessionStorage.removeItem(SK_SEL_Q + i);
            }
          }
        } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }
      }
    }
    if (ctx.selectedOptionsMap.size > 0) {
      ctx.selectedOptionsMapSig.set(new Map(ctx.selectedOptionsMap));
      ctx._refreshBackup = new Map(ctx.selectedOptionsMap);
    }
  }

  private clearStaleSessionData(ctx: SelectionStateContext): void {
    for (let i = 0; i < 100; i++) {
      sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
      sessionStorage.removeItem(SK_SEL_Q + i);
    }
    sessionStorage.removeItem('rawSelectionsMap');
    sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
    sessionStorage.removeItem('selectionHistory');
    ctx._refreshBackup.clear();
    ctx.selectedOptionsMap.clear();
    ctx.rawSelectionsMap.clear();
  }

  // ── Save to sessionStorage ─────────────────────────────────

  saveState(ctx: SelectionStateContext): void {
    try {
      const rawObj = Object.fromEntries(ctx.rawSelectionsMap);
      sessionStorage.setItem('rawSelectionsMap', JSON.stringify(rawObj));

      const selectedObj = Object.fromEntries(ctx.selectedOptionsMap);
      sessionStorage.setItem(SK_SELECTED_OPTIONS_MAP, JSON.stringify(selectedObj));

      if (ctx._selectionHistory.size > 0) {
        const historyObj = Object.fromEntries(ctx._selectionHistory);
        sessionStorage.setItem('selectionHistory', JSON.stringify(historyObj));
      } else {
        sessionStorage.removeItem('selectionHistory');
      }

      const durableIndices = new Set<number>([
        ...ctx.selectedOptionsMap.keys(),
        ...ctx._selectionHistory.keys()
      ]);
      for (const idx of durableIndices) this.mergeAndPersistQuestion(ctx, idx);
    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); }
  }

  private mergeAndPersistQuestion(ctx: SelectionStateContext, idx: number): void {
    const fromMap = ctx.selectedOptionsMap.get(idx) ?? [];
    const fromHistory = ctx._selectionHistory.get(idx) ?? [];

    let fromPrior: any[] = [];
    try {
      const priorRaw = sessionStorage.getItem(SK_SEL_Q + idx);
      if (priorRaw) {
        const parsed = JSON.parse(priorRaw);
        if (Array.isArray(parsed)) fromPrior = parsed;
      }
    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }

    const merged = new Map<string, any>();

    for (const s of fromPrior) {
      if (s == null || s.optionId == null) continue;
      if (s.highlight !== true || s.showIcon !== true) {
        continue;
      }
      const key = this.buildMergeKey(s);
      merged.set(key, { ...s });
    }

    for (const s of fromHistory) {
      if (s == null || s.optionId == null) continue;
      if (s.highlight !== true || s.showIcon !== true) {
        continue;
      }
      const key = this.buildMergeKey(s);
      const existing = merged.get(key);
      if (existing && existing.selected === true) continue;
      merged.set(key, { ...s, selected: false });
    }

    for (const s of fromMap) {
      if (s == null || s.optionId == null) continue;
      if (s.selected === false) continue;
      const key = this.buildMergeKey(s);
      merged.set(key, { ...s, highlight: true, showIcon: true });
    }

    const normalized = Array.from(merged.values());
    if (normalized.length > 0) {
      sessionStorage.setItem(SK_SEL_Q + idx, JSON.stringify(normalized));
    } else {
      sessionStorage.removeItem(SK_SEL_Q + idx);
    }
  }

  private buildMergeKey(s: any): string {
    const sKeyText = norm(s.text);
    return sKeyText
      ? `t:${s.optionId}|${sKeyText}`
      : `i:${s.optionId}|${s.displayIndex ?? s.index ?? -1}`;
  }

  // ── Durable answer persistence (localStorage) ──────────────

  persistAnswerForResults(questionIndex: number, selections: { optionId: number; text: string }[]): void {
    try {
      const key = 'quizAnswersForResults';
      const existing = JSON.parse(localStorage.getItem(key) || '{}');
      existing[questionIndex] = selections;
      localStorage.setItem(key, JSON.stringify(existing));
    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }
  }

  recoverAnswersForResults(rawSelectionsMap: Map<number, { optionId: number; text: string }[]>): void {
    try {
      const key = 'quizAnswersForResults';
      const stored = localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      for (const [k, v] of Object.entries(parsed)) {
        const idx = Number(k);
        if (Number.isFinite(idx) && Array.isArray(v) && v.length > 0) {
          if (!rawSelectionsMap.has(idx) || rawSelectionsMap.get(idx)!.length === 0) {
            rawSelectionsMap.set(idx, v as any);
          }
        }
      }
    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }
  }

  clearAnswersForResults(): void {
    try {
      localStorage.removeItem('quizAnswersForResults');
    } catch (err: unknown) { swallow('selection-persistence.service.ts', err); /* ignore */ }
  }

  // ── Session key cleanup ────────────────────────────────────

  clearSessionKeys(): void {
    sessionStorage.removeItem('rawSelectionsMap');
    sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
    sessionStorage.removeItem('selectionHistory');
    sessionStorage.removeItem('answeredMap');
    sessionStorage.removeItem('currentQuestionIndex');
  }

  clearPerQuestionSessionKey(questionIndex: number): void {
    sessionStorage.removeItem(SK_SEL_Q + questionIndex);
  }
}