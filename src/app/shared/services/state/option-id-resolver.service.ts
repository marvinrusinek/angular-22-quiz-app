import { Service, inject } from '@angular/core';

import { Option, SelectedOption } from '@shared/models';

import { QuizService } from '@shared/services/data/quiz.service';

import { norm } from '@shared/utils/text-norm';

@Service()
export class OptionIdResolverService {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);

  // ── properties ──────────────────────────────────────────────────
  /**
   * Snapshot of options per question, used as fallback when
   * quizService.questions is not yet populated.
   */
  private optionSnapshotByQuestion = new Map<number, Option[]>();

  // ── public methods ──────────────────────────────────────────────

  // ── Public API ──────────────────────────────────────────────

  resolveCanonicalOptionId(
    questionIndex: number,
    rawId: number | string | null | undefined,
    fallbackIndexOrText?: number | string
  ): number | null {
    const toFiniteNumber = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value !== -1 ? value : null;
      }
      const parsed = Number(String(value));
      return (Number.isFinite(parsed) && parsed !== -1) ? parsed : null;
    };

    const parseFallbackNumber = (): number | null => {
      const rawNumeric = toFiniteNumber(rawId);
      if (rawNumeric !== null) {
        if (rawNumeric > 100) {
          const syntheticQIdx = Math.floor(rawNumeric / 100) - 1;
          if (syntheticQIdx === questionIndex) return null;
        }
        return rawNumeric;
      }
      if (typeof fallbackIndexOrText === 'number') {
        return fallbackIndexOrText >= 0 ? fallbackIndexOrText : null;
      }
      if (typeof fallbackIndexOrText === 'string') {
        return toFiniteNumber(fallbackIndexOrText);
      }
      return null;
    };

    const options = this.getKnownOptions(questionIndex);
    if (options.length === 0) return parseFallbackNumber();

    const normalize = this.buildNormalizer();
    const inBounds = (index: number | undefined) =>
      typeof index === 'number' && index >= 0 && index < options.length;

    const fallbackIndex =
      typeof fallbackIndexOrText === 'number' ? fallbackIndexOrText : undefined;
    const hintText =
      typeof fallbackIndexOrText === 'string' ? fallbackIndexOrText : undefined;
    const normalizedHint = hintText ? normalize(hintText) : null;

    const resolveFromIndex = (index: number): number => {
      const numericId = toFiniteNumber((options[index] as any)?.optionId);
      return (numericId !== null && numericId !== -1) ? numericId : index;
    };

    const aliasFields = this.getAliasFields();

    const lookupById = new Map<string | number, number>();
    const lookupByAlias = new Map<string, number>();

    const buildStableKey = (option: any): string => {
      const idPart = option?.optionId != null ? String(option.optionId) : '';
      const alias =
        aliasFields.map((field) => normalize(option?.[field])).find(Boolean) || '';
      return `${questionIndex}|${idPart}|${alias}`;
    };

    let index = 0;
    for (const option of options) {
      if (option?.optionId !== null && option?.optionId !== undefined && String(option.optionId) !== '-1') {
        lookupById.set(option.optionId, index);
        const numericId = toFiniteNumber(option.optionId);
        if (numericId !== null) lookupById.set(numericId, index);
        lookupById.set(String(option.optionId), index);
      }
      for (const field of aliasFields) {
        const key = normalize((option as unknown as Record<string, unknown>)?.[field]);
        if (key) lookupByAlias.set(key, index);
      }
      lookupByAlias.set(normalize(buildStableKey(option)), index);
      index++;
    }

    if (rawId !== undefined && rawId !== null) {
      const rawNumeric = toFiniteNumber(rawId);
      const candidates: Array<string | number> = [rawId, String(rawId)];
      if (rawNumeric !== null) candidates.push(rawNumeric);
      for (const candidate of candidates) {
        const match = lookupById.get(candidate as any);
        if (match !== undefined) return resolveFromIndex(match);
      }
      if (rawNumeric !== null) {
        if (inBounds(rawNumeric) && fallbackIndex === undefined) {
          return rawNumeric;
        }
        const zeroBased = rawNumeric - 1;
        if (inBounds(zeroBased)) return zeroBased;
      }
    }

    if (normalizedHint) {
      const match = lookupByAlias.get(normalizedHint);
      if (match !== undefined) return resolveFromIndex(match);
    }

    if (inBounds(fallbackIndex)) return resolveFromIndex(fallbackIndex!);

    return null;
  }

  canonicalizeOptionForQuestion(
    questionIndex: number,
    option: SelectedOption,
    fallbackIndex?: number | string
  ): SelectedOption {
    if (!option) return option;

    const canonicalId = this.resolveCanonicalOptionId(
      questionIndex,
      option.optionId,
      fallbackIndex
    );
    if (canonicalId === null || canonicalId === option.optionId) return option;
    
    return {
      ...option,
      optionId: canonicalId
    };
  }

  canonicalizeSelectionsForQuestion(
    questionIndex: number,
    selections: SelectedOption[]
  ): SelectedOption[] {
    const canonical: SelectedOption[] = [];
    const seenKeys = new Set<string>();

    for (const selection of selections ?? []) {
      if (!selection) continue;

      const canonicalSelection = this.canonicalizeOptionForQuestion(
        questionIndex,
        selection,
        selection.text || (selection as any).index || selection.displayIndex
      );
      if (
        canonicalSelection?.optionId === undefined ||
        canonicalSelection.optionId === null
      ) continue;
      
      const key = `${canonicalSelection.optionId}|${canonicalSelection.displayIndex ?? (selection as any).index ?? -1}`;
      if (seenKeys.has(key)) continue;

      seenKeys.add(key);
      canonical.push(canonicalSelection);
    }

    return canonical;
  }

  matchOptionFromSource(
    options: Option[],
    optionId: number | string | null | undefined,
    text: string,
    aliasFields?: string[]
  ): { option: Option; index: number } | null {
    if (!Array.isArray(options) || options.length === 0) return null;

    const fields = aliasFields ?? this.getAliasFields();
    const normalize = this.buildNormalizer();

    const targetId = optionId != null ? String(optionId) : null;
    const targetNumeric = optionId != null ? Number(optionId) : null;
    const targetText = normalize(text);

    for (let i = 0; i < options.length; i++) {
      const candidate: any = options[i];

      if (targetId !== null) {
        const candidateId =
          candidate?.optionId != null ? String(candidate.optionId) : null;
        if (candidateId !== null && candidateId === targetId) {
          return { option: candidate, index: i };
        }
      }

      if (targetNumeric !== null && Number.isFinite(targetNumeric)) {
        const candidateNumeric =
          candidate?.optionId != null ? Number(candidate.optionId) : null;
        if (
          candidateNumeric !== null &&
          Number.isFinite(candidateNumeric) &&
          candidateNumeric === targetNumeric
        ) {
          return { option: candidate, index: i };
        }
      }

      if (targetText) {
        for (const field of fields) {
          const candidateText = normalize(candidate?.[field]);
          if (candidateText && candidateText === targetText) {
            return { option: candidate, index: i };
          }
        }
      }
    }

    return null;
  }

  resolveOptionIndexFromSelection(
    options: Option[],
    selection: any
  ): number | null {
    const byId = new Map<number | string, number>();
    const byText = new Map<string, number>();
    const byValue = new Map<string, number>();

    for (let i = 0; i < options.length; i++) {
      const o: any = options[i];
      if (o.optionId !== null && o.optionId !== undefined) {
        byId.set(o.optionId, i);
      }
      if (o.id !== null && o.id !== undefined) {
        byId.set(o.id, i);
      }
      const t = this.normalizeStr(o.text);
      if (t) byText.set(t, i);

      const v = this.normalizeStr(o.value);
      if (v) byValue.set(v, i);
    }

    const explicitIndex = selection?.index ?? selection?.idx;
    if (explicitIndex !== undefined && explicitIndex !== null && Number.isFinite(explicitIndex)) {
      const n = Number(explicitIndex);
      if (n >= 0 && n < options.length) return n;
    }

    if (
      'optionId' in selection &&
      selection.optionId !== null &&
      selection.optionId !== undefined &&
      String(selection.optionId) !== '-1'
    ) {
      const hit = byId.get(selection.optionId);
      if (hit !== undefined) return hit;
    }
    if (
      'id' in selection &&
      selection.id !== null &&
      selection.id !== undefined &&
      String(selection.id) !== '-1'
    ) {
      const hit = byId.get(selection.id);
      if (hit !== undefined) return hit;
    }

    const sText = this.normalizeStr(selection?.text);
    if (sText) {
      const hit = byText.get(sText);
      if (hit !== undefined) return hit;
    }

    const sValue = this.normalizeStr(selection?.value);
    if (sValue) {
      const hit = byValue.get(sValue);
      if (hit !== undefined) return hit;
    }

    return null;
  }

  getKnownOptions(questionIndex: number): Option[] {
    const canonical = this.quizService.questions?.[questionIndex]?.options;
    if (Array.isArray(canonical) && canonical.length > 0) {
      this.optionSnapshotByQuestion.set(
        questionIndex,
        canonical.map((option) => ({ ...option }))
      );
      return canonical;
    }
    const snapshot = this.optionSnapshotByQuestion.get(questionIndex);
    return Array.isArray(snapshot) ? snapshot : [];
  }

  setOptionSnapshot(questionIndex: number, options: Option[]): void {
    this.optionSnapshotByQuestion.set(questionIndex, options.map(o => ({ ...o })));
  }

  getOptionSnapshot(questionIndex: number): Option[] | undefined {
    return this.optionSnapshotByQuestion.get(questionIndex);
  }

  deleteOptionSnapshot(questionIndex: number): void {
    this.optionSnapshotByQuestion.delete(questionIndex);
  }

  clearOptionSnapshots(): void {
    this.optionSnapshotByQuestion.clear();
  }

  normalizeOptionId(id: unknown): string | null {
    if (typeof id === 'number') return Number.isFinite(id) ? String(id) : null;

    if (typeof id === 'string') {
      const trimmed = id.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    
    return null;
  }

  extractNumericId(id: unknown): number | null {
    if (typeof id === 'number' && Number.isFinite(id)) return id;

    if (typeof id === 'string') {
      const parsed = Number(id);
      return Number.isFinite(parsed) ? parsed : null;
    }
    
    return null;
  }

  normalizeStr(x: unknown): string {
    return typeof x === 'string'
      ? x.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  }

  normalizeQuestionIndex(index: number | null | undefined): number {
    if (!Number.isFinite(index as number)) return -1;
    const normalized = Math.trunc(index as number);
    const questions = this.quizService?.questions;

    if (!Array.isArray(questions) || questions.length === 0) return normalized;
    if (questions[normalized] != null) return normalized;

    const potentialOneBased = normalized - 1;
    if (
      potentialOneBased >= 0 &&
      potentialOneBased < questions.length &&
      questions[potentialOneBased] != null
    ) return potentialOneBased;
    
    return Math.min(Math.max(normalized, 0), questions.length - 1);
  }

  normalizeIdx(idx: number): number {
    if (!Number.isFinite(idx)) return -1;

    const n = Math.trunc(idx);
    const qs = this.quizService?.questions;

    if (Array.isArray(qs) && qs.length > 0) {
      const len = qs.length;
      if (n >= len && n - 1 >= 0 && n - 1 < len) {
        return n - 1;
      }
      return n;
    }
    return n;
  }

  coerceToBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;

    if (typeof value === 'string') {
      const normalized = norm(value);
      if (normalized === 'true') return true;
      if (normalized === 'false' || normalized.length === 0) return false;
    }
    if (typeof value === 'number') return value !== 0;
    
    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────

  getAliasFields(): string[] {
    return [
      'text',
      'value',
      'label',
      'name',
      'title',
      'displayText',
      'description',
      'html'
    ];
  }

  // ── Identity matching helpers ────────────────────────────────

  normKey(x: unknown): string {
    if (x == null) return '';
    
    return String(x).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  forEachUiMatch(
    canonical: Option[],
    ui: Option[] | undefined,
    cb: (canonIndex: number, uiItem: Option) => void
  ): void {
    if (!Array.isArray(canonical) || canonical.length === 0) return;
    if (!Array.isArray(ui) || ui.length === 0) return;

    const idxByKey = new Map<string, number>();
    for (let i = 0; i < canonical.length; i++) {
      const c: any = canonical[i];
      const key = this.normKey(c.optionId ?? c.id ?? c.value ?? c.text ?? i);
      if (key) idxByKey.set(key, i);
    }

    for (const u of ui) {
      const uu: any = u;
      const key = this.normKey(uu.optionId ?? uu.id ?? uu.value ?? uu.text);
      const i = key ? idxByKey.get(key) : undefined;
      if (i !== undefined) cb(i, u);
    }
  }

  overlaySelectedByIdentity(
    canonical: Option[],
    ui: Option[]
  ): Option[] {
    if (!Array.isArray(canonical) || canonical.length === 0) return [];
    const out = canonical.map((o) => ({ ...o, selected: false }));

    this.forEachUiMatch(canonical, ui, (i, u) => {
      out[i].selected = !!(u as any).selected;
    });

    return out;
  }

  buildCanonicalSelectionSnapshot(
    questionIndex: number,
    selectedOptionsMap: Map<number, SelectedOption[]>,
    quizService: any
  ): Option[] {
    const canonicalOptions = this.getKnownOptions(questionIndex);

    const mapSelections = this.canonicalizeSelectionsForQuestion(
      questionIndex,
      selectedOptionsMap.get(questionIndex) || []
    );

    const overlaySelections = new Map<number, Option>();

    const recordSelection = (option: Option, fallbackIdx?: number): void => {
      if (!option) return;

      const resolvedIdx = this.resolveOptionIndexFromSelection(
        canonicalOptions,
        option
      );

      if (resolvedIdx != null && resolvedIdx >= 0) {
        overlaySelections.set(resolvedIdx, option);
      } else if (typeof fallbackIdx === 'number' && fallbackIdx >= 0) {
        overlaySelections.set(fallbackIdx, option);
      }
    };

    for (const opt of mapSelections) recordSelection(opt);

    const dataOptions = Array.isArray(quizService?.data?.currentOptions)
      ? quizService.data.currentOptions : [];

    const baseOptions =
      [
        canonicalOptions,
        dataOptions,
        mapSelections
      ].find((options) => Array.isArray(options) && options.length > 0) || [];

    return baseOptions.map((option: any, idx: number) => {
      const overlay = overlaySelections.get(idx);
      const mergedOption = {
        ...option,
        ...(overlay ?? {})
      } as Option;

      return {
        ...mergedOption,
        optionId: overlay?.optionId ?? option?.optionId ?? idx,
        correct: this.coerceToBoolean(
          (overlay as Option)?.correct ?? option?.correct
        ),
        selected: this.coerceToBoolean(
          (overlay as Option)?.selected ?? option?.selected
        )
      };
    });
  }

  /**
   * Resolves an option ID and its source Option from a set of source options.
   * Returns { canonicalOptionId, foundSourceOption } or null if unresolvable.
   */
  resolveOptionFromSource(
    questionIndex: number,
    optionId: number,
    text: string,
    source: Option[]
  ): { canonicalOptionId: number; foundSourceOption: Option | undefined } | null {
    const normalize = this.buildNormalizer();
    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(String(v));
      return Number.isFinite(n) ? n : null;
    };

    const key = normalize(text);
    const aliasFields = this.getAliasFields();

    const directMatch = this.matchOptionFromSource(
      source,
      optionId,
      text,
      aliasFields
    );

    let fallbackIndexFromText = -1;
    for (let i = 0; i < source.length && fallbackIndexFromText < 0; i++) {
      const o: any = source[i];
      for (const f of aliasFields) {
        if (normalize(o?.[f]) === key) {
          fallbackIndexFromText = i;
          break;
        }
      }
    }

    let indexFromId = -1;
    for (let i = 0; i < source.length && indexFromId < 0; i++) {
      const oid = (source[i] as any)?.optionId;
      if (
        oid === optionId ||
        String(oid) === String(optionId) ||
        toNum(oid) === toNum(optionId)
      ) indexFromId = i;
    }

    const resolverHint: number | string | undefined =
      indexFromId >= 0
        ? indexFromId
        : fallbackIndexFromText >= 0
          ? fallbackIndexFromText
          : (directMatch?.index ?? text);

    let canonicalOptionId = this.resolveCanonicalOptionId(
      questionIndex,
      optionId,
      resolverHint
    );

    if (canonicalOptionId == null) {
      if (indexFromId >= 0) {
        canonicalOptionId = indexFromId;
      } else if (fallbackIndexFromText >= 0) {
        canonicalOptionId = fallbackIndexFromText;
      } else if (directMatch?.option) {
        const resolved = toNum((directMatch.option as any)?.optionId);
        if (resolved !== null) {
          canonicalOptionId = resolved;
        } else {
          canonicalOptionId = directMatch.index;
        }
      }
    }

    if (canonicalOptionId == null) return null;

    let foundSourceOption: Option | undefined;

    if (
      typeof canonicalOptionId === 'number' &&
      canonicalOptionId >= 0 &&
      canonicalOptionId < source.length &&
      (source[canonicalOptionId]?.optionId === canonicalOptionId || source[canonicalOptionId]?.optionId === undefined)
    ) {
      foundSourceOption = source[canonicalOptionId];
    }

    if (!foundSourceOption) {
      if (indexFromId >= 0) {
        foundSourceOption = source[indexFromId];
      } else if (fallbackIndexFromText >= 0) {
        foundSourceOption = source[fallbackIndexFromText];
      } else if (directMatch?.option) {
        foundSourceOption = directMatch.option;
      }
    }

    if (!foundSourceOption) {
      foundSourceOption = source.find(o => String(o.optionId) === String(canonicalOptionId));
    }

    return { canonicalOptionId, foundSourceOption };
  }

  private buildNormalizer(): (value: unknown) => string {
    const decodeHtml = (s: string) =>
      s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ');

    return (value: unknown) =>
      typeof value === 'string'
        ? stripTags(decodeHtml(value)).trim().toLowerCase().replace(/\s+/g, ' ')
        : '';
  }
}