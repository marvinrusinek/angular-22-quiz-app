import { Service, inject } from '@angular/core';

import { Option } from '@shared/models/Option.model';
import { SelectedOption } from '@shared/models/SelectedOption.model';

import { OptionIdResolverService } from './option-id-resolver.service';
import { QuizService } from '@shared/services/data/quiz.service';
import type { SelectedOptionService } from './selectedoption.service';

import { norm } from '@shared/utils/text-norm';

type Host = SelectedOptionService;

/**
 * Handles selection CRUD operations (add, remove, set, update, commit).
 * Extracted from SelectedOptionService.
 */
@Service()
export class SelectionCrudService {
  // ── injects ─────────────────────────────────────────────────────
  private idResolver = inject(OptionIdResolverService);
  private quizService = inject(QuizService);

  // ── public methods ──────────────────────────────────────────────

  // ── syncSelectionState ──────────────────────────────────────

  // Helper to sync state from external components (like SharedOptionComponent)
  syncSelectionState(host: Host, questionIndex: number, options: SelectedOption[]): void {
    // Store RAW selections to a DURABLE location that survives clearState/resetAll.
    // clearState() wipes rawSelectionsMap, selectedOptionsMap, AND sessionStorage.
    // Only localStorage with a distinct key survives every reset path.
    if (Array.isArray(options) && options.length > 0) {
      const rawSelections = options
        .filter(o => o != null)
        .map(o => ({
          optionId: typeof o.optionId === 'number' ? o.optionId : -1,
          text: o.text || ''
        }))
        .filter(o => o.optionId >= 0 || o.text);
      if (rawSelections.length > 0) {
        host.rawSelectionsMap.set(questionIndex, rawSelections);
        // Persist to durable localStorage key that NO reset path touches
        host.persistAnswerForResults(questionIndex, rawSelections);
      }
    }

    const committed = host.commitSelections(questionIndex, options);

    // Accumulate selection history. syncSelectionState is invoked from the
    // click pipeline (option-interaction.service) for every user click;
    // without this push, single-answer mode wipes the map on each click and
    // the only durable record of prior wrong picks lives in _selectionHistory.
    // Skip the push on empty committed (deselect-all path).
    if (committed.length > 0) {
      const history = host._selectionHistory.get(questionIndex) ?? [];
      for (const c of committed) {
        if (!c || c.optionId == null) continue;
        const cText = norm((c as any).text);
        const dup = history.some((h: any) =>
          h.optionId === c.optionId &&
          (norm((h as any).text) === cText)
        );
        if (!dup) {
          history.push({
            ...c,
            selected: true,
            highlight: true,
            showIcon: true
          } as any);
        }
      }
      host._selectionHistory.set(questionIndex, history);
    }

    // VITAL: Update the map so that getSelectedOptionsForQuestion(index) returns the new state!
    host.selectedOptionsMap.set(questionIndex, committed);
    host.selectedOptionsMapSig.set(new Map(host.selectedOptionsMap));

    host.selectedOption = committed;
    host.selectedOptionSig.set(committed);
    host.isOptionSelectedSig.set(committed.length > 0);
    host.isAnsweredSig.set(true);

    // Persist to sessionStorage so data survives navigation
    host.saveState();
  }

  // ── addOption ───────────────────────────────────────────────

  // Adds an option to the selectedOptionsMap
  addOption(host: Host, questionIndex: number, option: SelectedOption): void {
    if (!option) return;  // option is undefined
    if (option.optionId == null) return;  // option.optionId is undefined

    // Trust: questionIndex is 0-based (QQC is the source of truth now)
    const idx = Number.isFinite(questionIndex) ? Math.trunc(questionIndex) : -1;
    if (idx < 0) return;  // invalid questionIndex

    // Get existing selections for this question
    const existing = host.selectedOptionsMap.get(idx) ?? [];

    // Canonicalize existing options
    const existingCanonical = this.idResolver.canonicalizeSelectionsForQuestion(
      idx,
      existing
    );

    const fallbackIdx = (option as any).index ?? (option as any).displayIndex ?? (option as any).idx;
    const newCanonical = this.idResolver.canonicalizeOptionForQuestion(idx, {
      ...option,
      displayIndex: fallbackIdx,          // preserve for syncService lookup
      questionIndex: idx,                 // keep stored option consistent
      selected: option.selected ?? true,
      highlight: true,
      showIcon: true
    }, option.text || fallbackIdx);

    if (newCanonical.optionId == null) return;  // canonical option missing ID

    // AUTHORITATIVE MERGE (REPLACE BY unique key: optionId + index)
    const merged = new Map<string, SelectedOption>();

    // Keep existing selections (as a base)
    for (const o of existingCanonical) {
      if (o.optionId != null) {
        const key = `${o.optionId}|${o.displayIndex ?? -1}`;
        merged.set(key, o);
      }
    }

    // Apply new selection (replace by unique key)
    if (newCanonical.optionId != null) {
      const key = `${newCanonical.optionId}|${newCanonical.displayIndex ?? -1}`;
      if (newCanonical.selected === false) {
        merged.delete(key);  // support unselect if needed
      } else {
        // Force insertion order update so this becomes the "most recent" selection
        merged.delete(key);
        merged.set(key, newCanonical);
      }
    }

    // Commit selections and store the result
    // IMPORTANT: commitSelections ensures object identities are preserved
    // and correctly applies the exclusive highlight logic.
    const mergedList = Array.from(merged.values());
    const committed = host.commitSelections(idx, mergedList);
    host.selectedOptionsMap.set(idx, committed);  // update the map!

    // Accumulate selection history for refresh restore (mirrors _wasSelected behavior)
    for (const sel of committed) {
      const history = host._selectionHistory.get(idx) ?? [];
      const alreadyInHistory = history.some((h: any) =>
        h.optionId === sel.optionId
        && h.displayIndex === sel.displayIndex
        && (h.text ?? '') === (sel.text ?? '')
      );
      if (!alreadyInHistory) {
        history.push(sel);
        host._selectionHistory.set(idx, history);
      }
    }

    // PROACTIVE SYNC: Ensure QuizService knows about this answer immediately.
    // This drives calculateAnsweredCount and progress persistence.
    if (this.quizService) {
      const ids = committed
        .map((o: any) => o.optionId)
        .filter((id: any): id is number => typeof id === 'number');
      this.quizService.updateUserAnswer(idx, ids);
    }

    host.saveState();

    // Emit observable updates
    host.selectedOption = committed;
    host.selectedOptionSig.set(committed);
    host.isOptionSelectedSig.set(committed.length > 0);
  }

  // ── removeOption ────────────────────────────────────────────

  // Removes an option from the selectedOptionsMap
  removeOption(host: Host, questionIndex: number, optionId: number | string, indexHint?: number): void {
    const canonicalId = this.idResolver.resolveCanonicalOptionId(questionIndex, optionId, indexHint);
    if (canonicalId == null && indexHint == null) return;

    const currentOptions = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      host.selectedOptionsMap.get(questionIndex) || []
    );
    const updatedOptions = currentOptions.filter(
      (o) => {
        const matchesId = (o.optionId === canonicalId || (canonicalId === null && o.optionId === -1));
        const matchesIndex = (indexHint != null) ?
          (o.displayIndex === indexHint || (o as any).index === indexHint) : true;
        return !(matchesId && matchesIndex);
      }
    );

    if (updatedOptions.length > 0) {
      const committed = host.commitSelections(questionIndex, updatedOptions);
      host.selectedOptionsMap.set(questionIndex, committed);

      if (this.quizService) {
        const ids = committed
          .map((o: any) => o.optionId)
          .filter((id: any): id is number => typeof id === 'number');
        this.quizService.updateUserAnswer(questionIndex, ids);
      }

      host.selectedOption = committed;
      host.selectedOptionSig.set(committed);
      host.isOptionSelectedSig.set(committed.length > 0);
      host.updateAnsweredState(committed, questionIndex);
    } else {
      host.selectedOptionsMap.delete(questionIndex);

      if (this.quizService) {
        this.quizService.updateUserAnswer(questionIndex, []);
      }

      host.selectedOption = [];
      host.selectedOptionSig.set([]);
      host.isOptionSelectedSig.set(false);
      host.setAnswered(false, true);  // update answered state
      host.setNextButtonEnabled(false);  // explicitly disable next button
    }
    host.saveState();
  }

  // ── setSelectedOption ───────────────────────────────────────

  setSelectedOption(
    host: Host,
    option: SelectedOption | null,
    questionIndex?: number,
    optionsSnapshot?: Option[],
    isMultipleAnswer?: boolean
  ): void {
    if (!option) {
      if (questionIndex == null) return;
      host.selectedOptionsMap.delete(questionIndex);
      host.selectedOptionSig.set([]);
      host.isOptionSelectedSig.set(false);
      host.updateAnsweredState();
      return;
    }

    const qIndex = questionIndex ?? option.questionIndex;
    if (qIndex == null) return;  // missing questionIndex

    // Populate snapshot if provided
    if (optionsSnapshot && optionsSnapshot.length > 0) {
      host.optionSnapshotByQuestion.set(qIndex, optionsSnapshot);
    }

    const enriched: SelectedOption = this.idResolver.canonicalizeOptionForQuestion(
      qIndex,
      {
        ...option,
        questionIndex: qIndex,
        selected: true,
        highlight: true,
        showIcon: true
      },
      option.text || (option as any).index
    );

    // HARD RULE: Single-answer questions may never accumulate selections
    if (isMultipleAnswer === false) host.selectedOptionsMap.set(qIndex, []);

    const current = host.selectedOptionsMap.get(qIndex) || [];
    let canonicalCurrent = this.idResolver.canonicalizeSelectionsForQuestion(
      qIndex,
      current
    );

    // If single answer, clear previous selections
    if (isMultipleAnswer === false) canonicalCurrent = [];

    const exists = canonicalCurrent.find(
      (sel) => sel.optionId === enriched.optionId &&
        (sel.displayIndex === enriched.displayIndex || (sel as any).index === (enriched as any).index)
    );

    if (isMultipleAnswer) {
      if (exists) {
        // Toggle OFF
        canonicalCurrent = canonicalCurrent.filter(
          (sel) => !(sel.optionId === enriched.optionId &&
            (sel.displayIndex === enriched.displayIndex || (sel as any).index === (enriched as any).index))
        );
      } else {
        // Toggle ON
        canonicalCurrent.push(enriched);
      }
    } else {
      // Single answer
      canonicalCurrent = [enriched];
    }

    // Accumulate selection history for refresh restore (mirrors _wasSelected behavior)
    const history = host._selectionHistory.get(qIndex) ?? [];
    const alreadyInHistory = history.some((h: any) =>
      h.optionId === enriched.optionId
      && h.displayIndex === enriched.displayIndex
      && (h.text ?? '') === (enriched.text ?? '')
    );
    if (!alreadyInHistory) {
      history.push(enriched);
      host._selectionHistory.set(qIndex, history);
    }

    const committed = host.commitSelections(qIndex, canonicalCurrent);
    host.selectedOptionsMap.set(qIndex, committed); // VITAL: Update the map!
    host.saveState();

    // Sync to QuizService for persistence & scoring
    if (this.quizService) {
      const ids = committed
        .map((o: any) => o.optionId)
        .filter((id: any): id is number => typeof id === 'number');
      this.quizService.updateUserAnswer(qIndex, ids);
    }

    // Track the clicked option for per-click dot color in multi-answer
    host.lastClickedOption = enriched;

    // Synchronously emit the full updated list
    host.selectedOption = committed;
    host.selectedOptionSig.set(committed);
    host.isOptionSelectedSig.set(true);
  }

  // ── setSelectedOptions ──────────────────────────────────────
  setSelectedOptions(host: Host, options: SelectedOption[]): void {
    const normalizedOptions = Array.isArray(options)
      ? options.filter(Boolean) : [];

    if (normalizedOptions.length === 0) {
      host.selectedOption = [];
      host.selectedOptionSig.set([]);
      host.isOptionSelectedSig.set(false);
      host.updateAnsweredState([], host.getFallbackQuestionIndex());
      return;
    }

    const groupedSelections = new Map<number, SelectedOption[]>();

    for (const option of normalizedOptions) {
      const qIndex = option?.questionIndex;

      if (qIndex === undefined || qIndex === null) continue;

      const enrichedOption: SelectedOption = this.idResolver.canonicalizeOptionForQuestion(
        qIndex,
        {
          ...option,
          questionIndex: qIndex,
          selected: true,
          highlight: true,
          showIcon: true
        },
        option.text || (option as any).index
      );

      if (
        enrichedOption?.optionId === undefined ||
        enrichedOption.optionId === null
      ) continue;

      const existing = groupedSelections.get(qIndex) ?? [];
      existing.push(enrichedOption);
      groupedSelections.set(qIndex, existing);
    }

    const combinedSelections: SelectedOption[] = [];

    for (const [questionIndex, selections] of groupedSelections) {
      // Commit selections for this question
      const committed = host.commitSelections(questionIndex, selections);

      // Always overwrite the map entry with ALL committed selections
      host.selectedOptionsMap.set(questionIndex, committed);
      host.saveState();

      // Aggregate globally
      if (committed.length > 0) combinedSelections.push(...committed);

      // Update answered state
      host.updateAnsweredState(committed, questionIndex);
    }

    if (combinedSelections.length === 0) {
      host.updateAnsweredState([], host.getFallbackQuestionIndex());
    }

    host.selectedOption = combinedSelections;
    host.selectedOptionSig.set(combinedSelections);
    host.isOptionSelectedSig.set(combinedSelections.length > 0);
  }

  // ── setSelectedOptionsForQuestion ───────────────────────────

  setSelectedOptionsForQuestion(
    host: Host,
    questionIndex: number,
    newSelections: SelectedOption[]
  ): void {
    // Use a composite key to handle options with duplicate IDs but different indices
    const merged = new Map<string, SelectedOption>();

    for (const opt of newSelections ?? []) {
      const optId = opt.optionId;
      const optIdx = opt.displayIndex ?? (opt as any).index ?? -1;
      const key = `${optId}|${optIdx}`;

      if (optId != null) {
        // Respect an explicit selected:false on the input so restore / re-sync
        // paths that pass previously-clicked entries (selected:false, kept for
        // prior-click rendering on refresh) are not silently escalated to
        // currently-selected. Default to true only when the flag is absent,
        // preserving behavior for callers that omit it.
        merged.set(key, {
          ...opt,
          questionIndex,
          selected: opt.selected === false ? false : true
        });
      }
    }

    // Single-answer semantics: only the most recent selection is currently
    // selected. Prior entries in newSelections (e.g. from click-path sync
    // that mass-forwards selectedOptionHistory in option-ui-sync.service.ts)
    // represent previously-clicked options that are no longer the active
    // selection. Demote them to selected:false so saveState persists them as
    // "previously clicked" (dark gray prior-click styling on refresh) rather
    // than as currently-selected (white highlight). Multi-answer keeps the
    // input behavior — all accumulated selections remain selected:true.
    if (!host.isMultiAnswerQuestion(questionIndex) && merged.size > 1) {
      const keys = Array.from(merged.keys());
      const lastKey = keys[keys.length - 1];
      for (const k of keys) {
        if (k === lastKey) continue;
        const entry = merged.get(k);
        if (entry) merged.set(k, { ...entry, selected: false });
      }
    }

    // Accumulate selection history for refresh restore (mirrors _wasSelected behavior)
    for (const sel of merged.values()) {
      const history = host._selectionHistory.get(questionIndex) ?? [];
      const alreadyInHistory = history.some((h: any) =>
        h.optionId === sel.optionId
        && h.displayIndex === sel.displayIndex
        && (h.text ?? '') === (sel.text ?? '')
      );
      if (!alreadyInHistory) {
        history.push(sel);
        host._selectionHistory.set(questionIndex, history);
      }
    }

    const committed = host.commitSelections(questionIndex, Array.from(merged.values()));

    // VITAL: Update the live map so getSelectedOptionsForQuestion can see it
    // and saveState can persist it to sessionStorage. Without this, the map
    // stays stale and refresh restore sees M=0.
    if (committed.length > 0) {
      host.selectedOptionsMap.set(questionIndex, committed);
      host.selectedOptionsMapSig.set(new Map(host.selectedOptionsMap));
    }

    // Also store in rawSelectionsMap for results display
    if (committed.length > 0) {
      const rawSelections = committed
        .filter((s: any) => s)
        .map((s: any) => ({
          optionId: typeof s.optionId === 'number' ? s.optionId : -1,
          text: s.text || ''
        }))
        .filter((s: any) => s.optionId >= 0 || s.text);

      host.rawSelectionsMap.set(questionIndex, rawSelections);
    } else {
      host.rawSelectionsMap.delete(questionIndex);
    }
    host.saveState();

    // Sync to QuizService for localStorage persistence
    const ids = committed
      .map((o: any) => o.optionId)
      .filter((id: any): id is number => typeof id === 'number');
    this.quizService.updateUserAnswer(questionIndex, ids);

    // Emit only current question selections
    host.selectedOptionSig.set(committed);

    host.isOptionSelectedSig.set(committed.length > 0);
  }

  // ── setSelectionsForQuestion ────────────────────────────────

  setSelectionsForQuestion(host: Host, qIndex: number, selections: SelectedOption[]): void {
    const committed = host.commitSelections(qIndex, selections);
    host.selectedOptionSig.set(committed);
  }

  // ── selectOption ────────────────────────────────────────────

  // Method to update the selected option state
  public async selectOption(
    host: Host,
    optionId: number,
    questionIndex: number,
    text: string,
    isMultiSelect: boolean,
    optionsSnapshot?: Option[]
  ): Promise<void> {
    if (optionId == null || questionIndex == null || !text) {
      return;  // invalid data — early return
    }

    // Resolve a best-effort index from the incoming text across common aliases.
    const q = this.quizService.questions?.[questionIndex];
    const options = Array.isArray(q?.options) ? q!.options : [];

    // Prefer the caller-provided snapshot (fresh UI state) if available
    const source: Option[] =
      Array.isArray(optionsSnapshot) && optionsSnapshot.length > 0
        ? optionsSnapshot : options;

    if (Array.isArray(source) && source.length > 0) {
      host.optionSnapshotByQuestion.set(
        questionIndex,
        source.map((option) => ({ ...option }))
      );
    }

    const resolved = this.idResolver.resolveOptionFromSource(
      questionIndex,
      optionId,
      text,
      source
    );

    if (!resolved) return;  // canonicalOptionId is null — early return

    const canonicalOptionId = resolved.canonicalOptionId;
    const foundSourceOption = resolved.foundSourceOption;

    const newSelection: SelectedOption = {
      optionId: canonicalOptionId,  // numeric id if available, else index
      questionIndex,
      text,
      correct: this.idResolver.coerceToBoolean(foundSourceOption?.correct),
      selected: true,
      highlight: true,
      showIcon: true
    };

    const currentSelections = host.selectedOptionsMap.get(questionIndex) || [];
    const canonicalCurrent = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      currentSelections
    );
    const filteredSelections = canonicalCurrent.filter(
      (s) =>
        !(
          s.optionId === canonicalOptionId && s.questionIndex === questionIndex
        )
    );
    const updatedSelections = [...filteredSelections, newSelection];
    const committedSelections = host.commitSelections(
      questionIndex,
      updatedSelections
    );

    if (!Array.isArray(host.selectedOptionIndices[questionIndex])) {
      host.selectedOptionIndices[questionIndex] = [];
    }
    if (
      !host.selectedOptionIndices[questionIndex].includes(canonicalOptionId)
    ) {
      host.selectedOptionIndices[questionIndex].push(canonicalOptionId);
    }

    host.selectedOptionSig.set(committedSelections);

    // Emit to isAnsweredSubject so NextButtonStateService enables the button
    host.isAnsweredSig.set(true);

    if (!isMultiSelect) {
      host.isOptionSelectedSig.set(true);
      host.setNextButtonEnabled(true);
    } else {
      const selectedOptions = host.selectedOptionsMap.get(questionIndex) || [];

      // Multi-select: Next button is controlled elsewhere (QQC / QuizComponent)
      if (selectedOptions.length === 0) host.setNextButtonEnabled(false);      
    }
  }

  // ── addSelectedOptionIndex ───────────────────────────────────

  addSelectedOptionIndex(host: Host, questionIndex: number, optionIndex: number): void {
    const options = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      host.selectedOptionsMap.get(questionIndex) || []
    );
    const canonicalId = this.idResolver.resolveCanonicalOptionId(
      questionIndex,
      optionIndex
    );
    const existingOption = options.find((o: any) => o.optionId === canonicalId);

    if (!existingOption) {
      const canonicalOptions = this.idResolver.getKnownOptions(questionIndex);
      const resolvedIndex =
        typeof canonicalId === 'number' && canonicalId >= 0
          ? canonicalId : optionIndex;

      const canonicalOption =
        Array.isArray(canonicalOptions) &&
          resolvedIndex >= 0 &&
          resolvedIndex < canonicalOptions.length
          ? canonicalOptions[resolvedIndex] : undefined;

      const baseOption: SelectedOption = canonicalOption
        ? { ...canonicalOption }
        : {
          optionId: canonicalId ?? optionIndex,
          text: `Option ${optionIndex + 1}`
        };

      const newOption: SelectedOption = {
        ...baseOption,
        optionId: canonicalId ?? baseOption.optionId ?? optionIndex,
        questionIndex,
        selected: true
      };

      options.push(newOption);
      host.commitSelections(questionIndex, options);
    }
  }

  // ── removeSelectedOptionIndex ──────────────────────────────

  removeSelectedOptionIndex(host: Host, questionIndex: number, optionIndex: number): void {
    if (Array.isArray(host.selectedOptionIndices[questionIndex])) {
      const optionPos =
        host.selectedOptionIndices[questionIndex].indexOf(optionIndex);
      if (optionPos > -1) {
        host.selectedOptionIndices[questionIndex].splice(optionPos, 1);
      }
    }

    const canonicalId = this.idResolver.resolveCanonicalOptionId(
      questionIndex,
      optionIndex
    );
    if (canonicalId == null) return;

    const currentOptions = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      host.selectedOptionsMap.get(questionIndex) || []
    );

    const updatedOptions = currentOptions.filter(
      (option: any) => option.optionId !== canonicalId
    );
    if (updatedOptions.length === currentOptions.length) return;

    host.commitSelections(questionIndex, updatedOptions);
  }

  // ── addSelection ────────────────────────────────────────────

  // Add (and persist) one option for a question
  public addSelection(host: Host, questionIndex: number, option: SelectedOption): void {
    // Get or initialize the list for this question
    const list = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      host.selectedOptionsMap.get(questionIndex) || []
    );
    const canonicalOption = this.idResolver.canonicalizeOptionForQuestion(
      questionIndex,
      option
    );

    if (
      canonicalOption?.optionId === undefined ||
      canonicalOption.optionId === null
    ) return;

    // If this optionId is already in the list, skip
    if (list.some((sel) => sel.optionId === canonicalOption.optionId)) return;

    // Enrich the option object with flags
    const enriched: SelectedOption = {
      ...canonicalOption,
      selected: true,
      showIcon: true,
      highlight: true,
      questionIndex
    };

    // Append and persist
    list.push(enriched);
    host.commitSelections(questionIndex, list);
  }

  // ── updateSelectionState ────────────────────────────────────

  // Method to add or remove a selected option for a question
  public updateSelectionState(
    host: Host,
    questionIndex: number,
    selectedOption: SelectedOption,
    isMultiSelect: boolean
  ): void {
    let idx = Number(questionIndex);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;  // pure numeric key

    const prevSelections = host.ensureBucket(idx).map((o: any) => ({ ...o }));  // clone
    const canonicalSelected = this.idResolver.canonicalizeOptionForQuestion(
      idx,
      selectedOption
    );

    if (canonicalSelected?.optionId == null) return;

    let updatedSelections: SelectedOption[];
    if (isMultiSelect) {
      const already = prevSelections.find(
        (opt: any) => opt.optionId === canonicalSelected.optionId
      );
      updatedSelections = already ? prevSelections
        : [...prevSelections, { ...canonicalSelected }];
    } else {
      updatedSelections = [{ ...canonicalSelected }];  // single-answer: replace
    }

    host.commitSelections(idx, updatedSelections);
  }

  // ── updateSelectedOptions ───────────────────────────────────

  updateSelectedOptions(
    host: Host,
    questionIndex: number,
    optionIndex: number,
    action: 'add' | 'remove'
  ): void {
    const canonicalId = this.idResolver.resolveCanonicalOptionId(
      questionIndex,
      optionIndex
    );
    if (canonicalId == null) return;

    const options = this.idResolver.canonicalizeSelectionsForQuestion(
      questionIndex,
      host.selectedOptionsMap.get(questionIndex) || []
    );

    const option = options.find((opt) => opt.optionId === canonicalId);
    if (!option) return;

    if (action === 'add') {
      if (!options.some((opt) => opt.optionId === canonicalId)) {
        options.push(option);
      }
      option.selected = true;
    } else if (action === 'remove') {
      const idx = options.findIndex((opt) => opt.optionId === canonicalId);
      if (idx !== -1) options.splice(idx, 1);
    }

    const committed = host.commitSelections(questionIndex, options);

    if (committed && committed.length > 0) {
      host.updateAnsweredState(committed, questionIndex);
    }
  }
}