import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { form, minLength, required, requiredError, validate } from '@angular/forms/signals';
import { Router } from '@angular/router';

import {
  AssessmentQuestionCount,
  DURATION_SECONDS_BY_COUNT,
  InterviewDifficulty
} from '../../../shared/models/AssessmentConfig.model';

import { InterviewApiService } from '../../../shared/services/api/interview-api.service';
import { InterviewApiError } from '../../../shared/services/api/interview-api.errors';
import { InterviewCatalogService } from '../../../shared/services/interview/interview-catalog.service';
import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';
import { AssessmentIntegrityService } from '../../../shared/services/features/interview/assessment-integrity.service';
import { buildInterviewSessionRequest } from '../../../shared/services/interview/interview-builder-request.mapper';
import { isApiConfigured } from '../../../shared/tokens/api-base-url.token';
import type { CreateInterviewSessionRequest } from '../../../shared/models/api/interview-api.dto';
import { QuizStartSpinnerHandle, QuizStartSpinnerService } from '../../../shared/services/ui/quiz-start-spinner.service';
import { swallow } from '../../../shared/utils/error-logging';
import {
  findInterviewPreset,
  INTERVIEW_PRESETS,
  InterviewPreset,
  InterviewPresetId,
  PRESET_DISCLAIMER
} from '../../../shared/models/interview-preset.model';
import { calculateDifficultyQuota } from '../../../shared/utils/difficulty-quota';
import {
  INTERVIEW_TOPIC_CATEGORIES,
  INTERVIEW_TOPIC_OTHER_CATEGORY
} from './interview-topic-categories';
import { InterviewCertificateCalloutComponent } from '../../../components/interview/interview-certificate-callout/interview-certificate-callout.component';

interface TopicOption {
  id: string;
  name: string;
  count: number;
}

interface TopicCategoryGroup {
  title: string;
  topics: TopicOption[];
}

interface DifficultyOption {
  value: InterviewDifficulty;
  label: string;
}

/**
 * The Custom builder's configuration, as ONE typed Signal Forms model rather
 * than three separately-managed pieces of state (a one-field reactive
 * FormControl plus two loose signals).
 *
 * `durationMinutes` is deliberately absent: it is DERIVED from questionCount
 * (DURATION_SECONDS_BY_COUNT) and is not user-editable, so modelling it as a
 * form field would misrepresent it as an input.
 */
export interface InterviewBuilderModel {
  difficulty: InterviewDifficulty | null;
  selectedTopicIds: string[];
  questionCount: AssessmentQuestionCount;
}

/**
 * "Build Your Interview" configuration page. Guides the user through
 * Difficulty → Topics → Question count → Preview → Start. Topics are conditional
 * on difficulty; validity is DERIVED from the configuration and the eligible
 * pool (no persisted canStartInterview flag). On Start it builds the assessment,
 * begins the session, shows the shared spinner, and navigates to the session.
 */
@Component({
  selector: 'codelab-build-your-interview',
  standalone: true,
  imports: [TitleCasePipe, InterviewCertificateCalloutComponent],
  templateUrl: './build-your-interview.component.html',
  styleUrls: ['./build-your-interview.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BuildYourInterviewComponent implements OnInit {
  private readonly catalog = inject(InterviewCatalogService);
  private readonly api = inject(InterviewApiService);
  private readonly backendSession = inject(BackendInterviewSessionService);
  private readonly integrity = inject(AssessmentIntegrityService);

  /** In-flight guard for session creation. Not derived from the disabled state. */
  private creating = false;
  private readonly _isCreating = signal(false);
  private readonly _createError = signal<string | null>(null);

  /** True while the backend session is being created and navigation is pending. */
  readonly isCreating = this._isCreating.asReadonly();
  /** Safe, user-facing message. Never a raw backend message. */
  readonly createError = this._createError.asReadonly();
  private readonly spinner = inject(QuizStartSpinnerService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  // The in-flight start attempt's OWN handle, retained immediately once
  // showForStart() is reached and cleared once that attempt completes
  // normally. The destroy hook cancels THIS handle specifically — never the
  // shared service globally — so destroying this component can never affect
  // some OTHER component's newer, still-active attempt on the same overlay.
  private currentSpinnerAttempt: QuizStartSpinnerHandle | null = null;

  constructor() {
    // Defensive safety net: if this component is destroyed while
    // startInterview()'s async flow is still pending (e.g. the user
    // navigated away some other way during a slow cold-backend create),
    // the overlay must not be left stuck. forceCancel() bypasses the
    // minimum-duration floor and is scoped to THIS attempt's handle: a no-op
    // if it never got assigned (createSession failed first), already
    // completed (currentSpinnerAttempt is null), or was superseded by a
    // newer attempt (forceCancel() checks generation ownership itself).
    this.destroyRef.onDestroy(() => this.currentSpinnerAttempt?.forceCancel());
  }

  readonly catalogLoading = this.catalog.loading;
  readonly catalogUnavailable = this.catalog.unavailable;

  readonly difficultyOptions: readonly DifficultyOption[] = [
    { value: 'beginner', label: 'Beginner' },
    { value: 'intermediate', label: 'Intermediate' },
    { value: 'advanced', label: 'Advanced' },
    { value: 'mixed', label: 'Mixed' }
  ];

  readonly countOptions: readonly AssessmentQuestionCount[] = [10, 20, 30];

  // ── Signal Forms model ──────────────────────────────────────────
  // One typed model is the single source of truth for the Custom builder.
  // `form()` treats it as the source of truth (it does not copy), so it
  // composes with the rest of the component's signal architecture.
  private readonly model = signal<InterviewBuilderModel>({
    difficulty: null,
    selectedTopicIds: [],
    questionCount: 20
  });

  /**
   * Structural validity lives in the schema; POOL-CAPACITY validity is also a
   * schema rule so `builderForm().valid()` is the whole truth and the Start
   * button never has to re-derive it. The user-facing shortfall wording stays
   * in `invalidReason()` — a boolean can't explain WHICH topic/count pairing
   * failed or what to do about it.
   */
  readonly builderForm = form(this.model, (path) => {
    required(path.difficulty);
    minLength(path.selectedTopicIds, 1);
    validate(path.questionCount, ({ value }) => {
      const { selectedTopicIds } = this.model();
      if (selectedTopicIds.length === 0) return null;   // topic rule reports this
      const available = this.catalog.availableQuestions(selectedTopicIds);
      return available >= value()
        ? null
        : requiredError({ message: 'Not enough questions for this selection.' });
    });
  });

  // Field reads, kept under their original names so the template and the
  // preset code are untouched by the migration.
  readonly difficulty = computed(() => this.builderForm.difficulty().value());
  readonly selectedTopicIds = computed(() => this.builderForm.selectedTopicIds().value());
  readonly questionCount = computed(() => this.builderForm.questionCount().value());

  // Topics eligible for the chosen difficulty (Mixed = all). Empty until a
  // difficulty is chosen, which hides the topics fieldset.
  readonly availableTopics = computed<TopicOption[]>(() => {
    const difficulty = this.difficulty();
    if (!difficulty) return [];
    // BACKEND metadata: ids, titles and counts. The catalogue service drops
    // topics with no questions, so nothing unbuildable is ever offered — and
    // no local quiz bank is consulted.
    return this.catalog.topicsFor(difficulty).map((topic) => ({
      id: topic.id,
      name: topic.name,
      count: topic.questionCount
    }));
  });

  // PRESENTATION ONLY: groups availableTopics() into categories for display.
  // Derived from availableTopics (already difficulty-filtered), so categories
  // with no visible topic are omitted automatically and no topic is ever
  // dropped — anything not mapped to a category lands in "Other". Selection,
  // filtering, and validation continue to read availableTopics/selectedTopicIds.
  readonly groupedTopics = computed<TopicCategoryGroup[]>(() => {
    const available = this.availableTopics();
    const byId = new Map(available.map((topic) => [topic.id, topic]));
    const used = new Set<string>();
    const groups: TopicCategoryGroup[] = [];

    for (const category of INTERVIEW_TOPIC_CATEGORIES) {
      const topics: TopicOption[] = [];
      for (const id of category.quizIds) {
        const topic = byId.get(id);
        if (topic) {
          topics.push(topic);
          used.add(id);
        }
      }
      if (topics.length > 0) {
        groups.push({ title: category.title, topics });
      }
    }

    // Never hide a topic: anything not categorised above goes to "Other".
    const others = available.filter((topic) => !used.has(topic.id));
    if (others.length > 0) {
      groups.push({ title: INTERVIEW_TOPIC_OTHER_CATEGORY, topics: others });
    }

    return groups;
  });

  // ── Quick Setup: role presets ───────────────────────────────────
  // 'custom' is the default so the existing Custom workflow is what users land
  // on and nothing about it changes. Selecting a preset only PREVIEWS it — the
  // existing Start button remains the single way to begin.
  readonly presets = INTERVIEW_PRESETS;
  readonly presetDisclaimer = PRESET_DISCLAIMER;
  readonly selectedPresetId = signal<InterviewPresetId | 'custom'>('custom');
  readonly isCustom = computed(() => this.selectedPresetId() === 'custom');

  readonly selectedPreset = computed<InterviewPreset | undefined>(() =>
    findInterviewPreset(this.selectedPresetId())
  );

  // Resolved question counts per difficulty — NOT the configured percentages.
  // Shown because difficulty here is a property of the TOPIC, so a weight can be
  // unfillable (Senior weights 10% beginner but configures no beginner topic);
  // displaying what will actually be generated keeps the preview honest.
  readonly presetQuota = computed(() => {
    const preset = this.selectedPreset();
    return preset
      ? calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution)
      : null;
  });

  /**
   * Whether a preset's topics can supply its full count, from BACKEND metadata.
   *
   * Only difficulties the preset actually draws on count toward usable
   * capacity — that is what keeps Advanced questions out of the Junior preset.
   */
  readonly presetCapacity = computed(() => {
    const preset = this.selectedPreset();
    if (!preset) return null;

    const byDifficulty = this.catalog.questionsByDifficulty(preset.topicIds);
    const distribution = preset.difficultyDistribution as unknown as Record<string, number>;

    // A difficulty the preset never draws on contributes nothing, which is what
    // keeps Advanced questions out of the Junior preset.
    const usable = Object.entries(byDifficulty).reduce(
      (sum, [difficulty, count]) => sum + ((distribution[difficulty] ?? 0) > 0 ? count : 0),
      0
    );
    return { byDifficulty, usable, required: preset.questionCount };
  });

  readonly presetTopicNames = computed<string[]>(() => {
    const preset = this.selectedPreset();
    if (!preset) return [];
    const byId = new Map(this.catalog.topics().map((t) => [t.id, t.name]));
    return preset.topicIds.map((id) => byId.get(id) ?? id);
  });

  // A preset can only start when its own topics can supply its full count.
  readonly presetStartDisabled = computed(() => {
    const capacity = this.presetCapacity();
    return !capacity || capacity.usable < capacity.required;
  });

  readonly presetInvalidReason = computed(() => {
    const capacity = this.presetCapacity();
    if (!capacity || capacity.usable >= capacity.required) return '';
    return `Only ${capacity.usable} of the ${capacity.required} questions this preset needs are available. ` +
      'Choose another preset or build a Custom interview.';
  });

  /**
   * Whether the Start button is disabled, for WHICHEVER mode is active. The
   * template must bind to this rather than startDisabled(): that one only
   * describes the Custom configuration, so with a preset selected (and Custom
   * left unconfigured) it would keep Start disabled and the preset unstartable.
   */
  readonly startDisabledForMode = computed(() =>
    this.selectedPreset() ? this.presetStartDisabled() : this.startDisabled()
  );

  selectPreset(id: InterviewPresetId | 'custom'): void {
    // Custom's in-progress difficulty/topics/count signals are deliberately left
    // untouched while a preset is previewed, so returning to Custom restores the
    // user's unfinished configuration exactly.
    this.selectedPresetId.set(id);
  }

  readonly topicsEnabled = computed(() => this.difficulty() !== null);

  readonly eligiblePool = computed(() => ({
    total: this.catalog.availableQuestions(this.selectedTopicIds())
  }));

  readonly selectedTopicNames = computed(() => {
    const selected = new Set(this.selectedTopicIds());
    return this.availableTopics()
      .filter((topic) => selected.has(topic.id))
      .map((topic) => topic.name);
  });

  // Duration is DERIVED from the question count, never chosen — which is why it
  // is not a field on the Signal Forms model.
  readonly durationMinutes = computed(
    () => DURATION_SECONDS_BY_COUNT[this.questionCount()] / 60
  );

  // Start validity now comes straight from the schema (required difficulty,
  // ≥1 topic, and the pool-capacity rule), so there is no second hand-rolled
  // definition of "valid" that could drift from the form's own.
  readonly startDisabled = computed(() => !this.builderForm().valid());

  // Pool-size messaging is shown ONLY to explain an invalid configuration.
  // DELIBERATELY KEPT despite the schema now reporting the same failure as a
  // boolean: `valid()` cannot tell the user how many questions are actually
  // available or what to change. The wording is unchanged.
  readonly invalidReason = computed(() => {
    if (!this.difficulty() || this.selectedTopicIds().length === 0) return '';
    const total = this.eligiblePool().total;
    if (total < this.questionCount()) {
      return `Only ${total} question${total === 1 ? '' : 's'} ${total === 1 ? 'is' : 'are'} available for this selection. ` +
        'Select another topic or choose a shorter interview.';
    }
    return '';
  });

  /**
   * Set the difficulty and prune topic selections that are no longer eligible —
   * never retain stale topic ids.
   *
   * This replaces a `valueChanges.subscribe()` bridge. The pruning is a direct
   * consequence of the write, so doing it here (rather than reacting to the
   * change afterwards) removes the component's only RxJS subscription for form
   * state and makes the two updates a single atomic model change.
   */
  setDifficulty(difficulty: InterviewDifficulty | null): void {
    const eligible = new Set(this.catalog.topicsFor(difficulty).map((t) => t.id));
    this.model.update((current) => ({
      ...current,
      difficulty,
      selectedTopicIds: current.selectedTopicIds.filter((id) => eligible.has(id))
    }));
  }

  ngOnInit(): void {
    // Topics come from the BACKEND, so fetch them on entry. Cached after the
    // first success, and there is deliberately no fallback to the bundled quiz
    // bank — offering topics the server cannot build from would be worse than
    // saying it is unreachable.
    void this.catalog.load();
  }

  /** Retry after a backend outage. */
  async retryCatalog(): Promise<void> {
    await this.catalog.reload();
  }

  isTopicSelected(id: string): boolean {
    return this.selectedTopicIds().includes(id);
  }

  // Immutable array updates. The filter/concat pair also guarantees no duplicate
  // id can enter the model even if a change event fires twice for one chip.
  toggleTopic(id: string, checked: boolean): void {
    this.builderForm.selectedTopicIds().value.update((current) => {
      const without = current.filter((existing) => existing !== id);
      return checked ? [...without, id] : without;
    });
  }

  selectAllTopics(): void {
    this.builderForm.selectedTopicIds().value.set(
      this.availableTopics().map((t) => t.id)
    );
  }

  clearTopics(): void {
    this.builderForm.selectedTopicIds().value.set([]);
  }

  // A count option is disabled when the eligible pool can't supply it.
  isCountDisabled(count: AssessmentQuestionCount): boolean {
    return this.eligiblePool().total < count;
  }

  setCount(count: AssessmentQuestionCount): void {
    if (this.isCountDisabled(count)) return;
    this.builderForm.questionCount().value.set(count);
  }

  /**
   * Create the assessment on the BACKEND and hand off to the session route.
   *
   * Stage 9C cutover: nothing is generated or scored locally any more. The
   * builder no longer calls AssessmentBuilderService or the old
   * InterviewSessionService — a failure surfaces as a retryable message rather
   * than silently falling back to local generation.
   */
  async startInterview(): Promise<void> {
    // ONE in-flight guard, independent of the disabled attribute: a double
    // click, Enter-plus-click or repeated key activation must not create two
    // attempts, and the backend mints a new attempt for every request.
    if (this.creating) return;

    const preset = this.selectedPreset();
    if (preset) {
      if (this.presetStartDisabled()) return;
    } else if (this.startDisabled()) {
      return;
    }

    // Fail CLOSED when the production API origin has not been configured.
    if (!isApiConfigured()) {
      this._createError.set($localize`Interview Mode is not configured for this environment.`);
      return;
    }

    let request: CreateInterviewSessionRequest;
    try {
      request = buildInterviewSessionRequest({
        presetId: preset?.id ?? null,
        difficulty: this.model().difficulty,
        topicIds: this.model().selectedTopicIds,
        questionCount: this.model().questionCount
      });
    } catch {
      this._createError.set($localize`The selected Interview configuration could not be created.`);
      return;
    }

    this.creating = true;
    this._isCreating.set(true);
    this._createError.set(null);
    this.stashTimerOverride();

    // Declared here (not inside the try) so `finally` can reach it — stays
    // null if createSession() itself throws, since showForStart() is only
    // ever called once a session actually exists.
    let spinnerHandle: QuizStartSpinnerHandle | null = null;

    try {
      const created = await firstValueFrom(this.api.createSession(request));

      // Only NOW is the previous session reference replaced — a failed create
      // must never destroy a still-valid session the user could resume.
      this.backendSession.activateCreatedSession(created.session, created.sessionToken);
      this.integrity.reset();

      spinnerHandle = this.spinner.showForStart($localize`Preparing Interview…`);
      // Retained immediately so the destroy hook can cancel exactly THIS
      // attempt — not reached at all if createSession() above threw first.
      this.currentSpinnerAttempt = spinnerHandle;
      await spinnerHandle.minimumElapsed;
      // The session id is NOT secret; the token stays in sessionStorage.
      await this.router.navigate(['/interview/session', created.session.sessionId]);
    } catch (err: unknown) {
      const error = err instanceof InterviewApiError ? err : new InterviewApiError('UNKNOWN', 0);
      this._createError.set(error.userMessage);
    } finally {
      // QuizStartSpinnerService no longer self-hides on a fixed timer (see
      // its own doc comment) — every caller of showForStart() must now
      // explicitly hide() its OWN handle once its own work is done. A null
      // handle means showForStart() was never reached (createSession threw
      // before we got that far), so there is nothing to hide — and nothing
      // for the destroy hook to cancel either, independent of when/whether
      // the handle was ever assigned.
      spinnerHandle?.hide();
      this.currentSpinnerAttempt = null;
      this.creating = false;
      this._isCreating.set(false);
    }
  }

  // Test-only hook: carry a `?interviewSeconds=` override into the session (via
  // sessionStorage) so Playwright can exercise timer expiry quickly. No effect
  // in normal use (the param is never present).
  private stashTimerOverride(): void {
    try {
      const raw = new URLSearchParams(window.location.search).get('interviewSeconds');
      if (raw && Number(raw) > 0) {
        sessionStorage.setItem('__interviewSeconds', raw);
      } else {
        sessionStorage.removeItem('__interviewSeconds');
      }
    } catch (err) {
      swallow('build-your-interview#stashTimerOverride', err);
    }
  }
}
