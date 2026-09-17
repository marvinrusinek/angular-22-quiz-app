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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, TimeoutError } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { form, minLength, required, requiredError, validate } from '@angular/forms/signals';
import { Router } from '@angular/router';

import {
  AssessmentQuestionCount,
  DURATION_SECONDS_BY_COUNT,
  InterviewDifficulty
} from '../../../shared/models/AssessmentConfig.model';

import { InterviewApiService } from '../../../shared/services/api/interview-api.service';
import type { CreatedInterviewSession } from '../../../shared/services/api/interview-api.service';
import { InterviewApiError } from '../../../shared/services/api/interview-api.errors';
import { InterviewCatalogService } from '../../../shared/services/interview/interview-catalog.service';
import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';
import { AssessmentIntegrityService } from '../../../shared/services/features/interview/assessment-integrity.service';
import { buildInterviewSessionRequest } from '../../../shared/services/interview/interview-builder-request.mapper';
import { isInterviewApiConfigured } from '../../../shared/tokens/api-base-url.token';
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

/**
 * sessionStorage key for a PENDING (not yet confirmed) session-create
 * attempt — narrowly scoped to this one recovery flow, and always cleared
 * explicitly rather than left to accumulate (see
 * {@link BuildYourInterviewComponent#clearPersistedPendingCreate}). Holds
 * ONLY the idempotency key and the exact request that went with it — NEVER
 * a session token: an idempotency key identifies the client's OWN creation
 * attempt, not a credential (see migration
 * 007_interview_session_idempotency.sql's own doc comment), so persisting it
 * across a reload carries none of the risk a stored token would.
 */
const PENDING_CREATE_STORAGE_KEY = 'interviewPendingCreate:v1';

/**
 * How long a persisted pending attempt stays eligible for recovery. A
 * reload while a create request is in flight ABORTS that browser request —
 * the server may still be processing (or may already have committed) it
 * regardless — so this window has to comfortably outlast how long that
 * server-side work could plausibly still be running: generous relative to
 * both the in-page create timeout (SESSION_CREATE_TIMEOUT_MS, 60s) and
 * Render's own measured cold-start range (up to ~125s for a bare health
 * check — see introduction.component.ts's own doc comment). Long enough
 * that a genuinely still-processing cold start has time to land or fail
 * before this record goes stale; short enough that a months-old key is
 * never silently reused.
 */
const PENDING_CREATE_TTL_MS = 10 * 60_000;

interface PendingCreateRecord {
  readonly idempotencyKey: string;
  readonly request: CreateInterviewSessionRequest;
  readonly expiresAtMs: number;
}

/** Defensive: sessionStorage content is never trusted merely because this component wrote it. */
function isStoredCreateRequest(value: unknown): value is CreateInterviewSessionRequest {
  if (!value || typeof value !== 'object') return false;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === 'preset') {
    return typeof (value as { presetId?: unknown }).presetId === 'string';
  }
  if (mode === 'custom') {
    const candidate = value as { difficulty?: unknown; topicIds?: unknown; questionCount?: unknown };
    return (
      typeof candidate.difficulty === 'string' &&
      Array.isArray(candidate.topicIds) &&
      candidate.topicIds.every((id) => typeof id === 'string') &&
      typeof candidate.questionCount === 'number'
    );
  }
  return false;
}

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
  /**
   * True specifically when the LAST attempt failed in a way a Retry could
   * plausibly resolve (a cold-start timeout, or {@code BACKEND_UNAVAILABLE}/
   * {@code UNKNOWN} — see {@link InterviewApiError.retryable}) — renders the
   * Retry action. A non-retryable failure (e.g. a genuine 400) has nothing a
   * repeat of the SAME request could fix; only the ordinary Start button
   * (which always begins a fresh logical attempt) offers a way forward.
   */
  private readonly _createRetryable = signal(false);
  readonly createRetryable = this._createRetryable.asReadonly();

  /**
   * The current logical start attempt's own identity — a fresh
   * {@code crypto.randomUUID()} minted by {@link startInterview}, and the
   * EXACT request that went with it. {@link retryInterview} reuses BOTH,
   * unchanged, for every retry of this same attempt; a fresh click of Start
   * Assessment always replaces both with a new pair. Cleared the moment an
   * attempt resolves (success, or a non-retryable failure) — there is
   * nothing left to retry once neither is populated, and
   * {@link retryInterview} is a no-op if called anyway.
   */
  private pendingIdempotencyKey: string | null = null;
  private pendingRequest: CreateInterviewSessionRequest | null = null;

  /**
   * Bounded timeout for Interview SESSION CREATION only — independently
   * justified from (not copied from) Introduction's own 45s question-load
   * timeout, though grounded in the SAME measured Spring/Neon cold-start
   * data (render.yaml's own "roughly 30-60 seconds" estimate; a fully cold
   * Render container measured 55.7s-124.7s to answer even a bare health
   * check — see introduction.component.ts's own doc comment for the full
   * measurement). Session creation does MORE backend work than a read-only
   * question fetch — selection plus persistence — though the batched-insert
   * performance fix already reduced that work to roughly 6-8s warm. 60s
   * gives that real work about 15s of headroom on top of Introduction's own
   * 45s allowance for the wake itself, while still bounding the wait to a
   * concrete, user-visible ceiling rather than leaving a cold request
   * hanging indefinitely with only "Preparing…" as feedback.
   */
  private static readonly SESSION_CREATE_TIMEOUT_MS = 60_000;

  /**
   * Shown for EITHER of the two cold-start signals {@code
   * attemptCreateSession} can observe — a client-side {@code TimeoutError}
   * (SESSION_CREATE_TIMEOUT_MS exhausted with no response at all) or a
   * genuine HTTP 504 (a response arrived, and it was a gateway timeout) —
   * since both mean the same thing to the user: the backend is cold, the
   * request may or may not have committed, and retrying with the same key is
   * the correct next step. One shared string so the two branches can never
   * drift apart in wording.
   */
  private static readonly COLD_START_MESSAGE = $localize`The interview service is still waking up. Please try again.`;

  /**
   * Shown during the brief window between one attempt's cold-start-retryable
   * failure and the NEXT automatic attempt's own settling — see {@link
   * createWithAutomaticRetries}. Deliberately never paired with {@code
   * createRetryable() === true}: a manual Retry button has no place while an
   * automatic recovery of the SAME logical attempt is already in flight.
   * Distinct wording from {@link COLD_START_MESSAGE} so the two states
   * ("still recovering on your behalf" vs. "recovery failed, your move")
   * never read as identical to the user. Reused unchanged for BOTH automatic
   * retries — the user does not need an attempt counter, only to know
   * recovery is still in progress.
   */
  private static readonly COLD_START_RETRYING_MESSAGE = $localize`The interview service is still waking up. Retrying…`;

  /**
   * Total create attempts a fresh Start Assessment click may make: the
   * initial request plus up to TWO automatic retries. Chosen from the
   * production evidence this task's own diagnosis is built on — a real
   * Render/Neon cold start observed on {@code interview-api-spring
   * .onrender.com} exceeded the PRIOR single-automatic-retry design's
   * combined 120s budget (two consecutive 60s client-side timeouts), while
   * the very next request afterward (Spring now warm) succeeded in ~4s. A
   * third bounded attempt closes exactly that observed gap without becoming
   * an open-ended retry loop — MAX_CREATE_ATTEMPTS is a fixed compile-time
   * constant, never a counter that can be pushed higher at runtime. A
   * MANUAL retryInterview() always uses exactly 1 (see
   * {@link createWithAutomaticRetries}'s own `allowAutomaticRetry` handling),
   * never chaining a further automatic sequence on top of itself.
   */
  private static readonly MAX_CREATE_ATTEMPTS = 3;

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

  /**
   * Set once, in {@link DestroyRef#onDestroy}. Checked immediately before
   * {@link createWithAutomaticRetries} fires EITHER of its automatic
   * retries, so a component destroyed in the gap between one attempt's
   * failure and the NEXT one starting never sends that next attempt at all
   * — "cancel any pending retry" for a retry that has no timer/subscription
   * of its own to unsubscribe (it is a plain awaited `fetch`, not an RxJS
   * stream held open). Never reset — a destroyed component is never reused.
   */
  private destroyed = false;

  constructor() {
    // Defensive safety net: if this component is destroyed while
    // startInterview()'s async flow is still pending (e.g. the user
    // navigated away some other way during a slow cold-backend create),
    // the overlay must not be left stuck. forceCancel() bypasses the
    // minimum-duration floor and is scoped to THIS attempt's handle: a no-op
    // if it never got assigned (createSession failed first), already
    // completed (currentSpinnerAttempt is null), or was superseded by a
    // newer attempt (forceCancel() checks generation ownership itself).
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.currentSpinnerAttempt?.forceCancel();
    });
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

  /**
   * BUG FIXED HERE: while the catalog is still loading, every topic's
   * question count reads as 0 (nothing has arrived yet), which made this
   * computed report "Only 0 of the 25 questions this preset needs are
   * available" for the ENTIRE cold-start window (measured ~12s on the
   * Render free tier — see InterviewCatalogService's own doc comment) even
   * though capacity is simply UNKNOWN, not actually insufficient. Returning
   * '' while loading — the template shows a neutral "Checking topic
   * availability…" message instead (see presetCapacityUnknown below) — is
   * exactly the "avoid rendering ... as though loading were complete" fix:
   * the Start button correctly stays disabled the whole time regardless
   * (see presetStartDisabled, unaffected by this), only the MISLEADING
   * error text is suppressed until capacity is actually knowable.
   */
  readonly presetInvalidReason = computed(() => {
    if (this.catalog.loading()) return '';
    const capacity = this.presetCapacity();
    if (!capacity || capacity.usable >= capacity.required) return '';
    return `Only ${capacity.usable} of the ${capacity.required} questions this preset needs are available. ` +
      'Choose another preset or build a Custom interview.';
  });

  /** True while a preset is selected but its real capacity cannot be known yet — see presetInvalidReason's own doc comment. */
  readonly presetCapacityUnknown = computed(() => this.selectedPreset() !== undefined && this.catalog.loading());

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
    this.restorePendingCreateIfAny();
    this.warmUpSpring();
  }

  /**
   * Best-effort, NON-BLOCKING Spring wake-up — fired at most ONCE per
   * Builder lifecycle, entirely in PARALLEL with the catalog load above:
   * neither awaits nor gates the other, and this one is never surfaced to
   * the user in any way (no loading flag, no error text, no effect on
   * `startDisabled()`/`presetStartDisabled()`). Its only purpose is to give
   * Spring's free-tier container a head start before the user's eventual
   * Start Assessment click — see InterviewApiService#warmUp's own doc
   * comment for why this proves nothing about Neon/PostgreSQL readiness,
   * and docs/spring-production-runbook.md for the full picture (Node,
   * Spring and Neon can each independently be cold).
   *
   * `takeUntilDestroyed` unsubscribes on destroy — a component destroyed
   * before this resolves neither leaks the subscription nor does anything
   * observable once torn down (the empty `subscribe()` has no next/error/
   * complete handler to run late). No poll, no interval, no keep-alive: one
   * GET, once, ever, per component instance.
   */
  private warmUpSpring(): void {
    if (!isInterviewApiConfigured()) return;
    this.api.warmUp().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  /**
   * A page reload aborts any create request that was still in flight — the
   * browser drops it, but the SERVER may already have committed it (or may
   * still be processing it). If a not-yet-expired pending attempt survived
   * the reload in sessionStorage, restore it so Retry can check — WITHOUT
   * ever auto-firing a network request on the user's behalf: silently
   * retrying on page load could surprise a user who reloaded for an
   * unrelated reason, and the app's own convention (see the create-session
   * doc comments below) is that only an explicit Retry click issues a
   * request.
   */
  private restorePendingCreateIfAny(): void {
    const pending = this.loadPersistedPendingCreate();
    if (!pending) return;
    this.pendingIdempotencyKey = pending.idempotencyKey;
    this.pendingRequest = pending.request;
    this._createRetryable.set(true);
    this._createError.set(
      $localize`Your last attempt to start this interview may not have finished. Retry to check whether it went through.`
    );
  }

  private persistPendingCreate(idempotencyKey: string, request: CreateInterviewSessionRequest): void {
    try {
      const record: PendingCreateRecord = { idempotencyKey, request, expiresAtMs: Date.now() + PENDING_CREATE_TTL_MS };
      sessionStorage.setItem(PENDING_CREATE_STORAGE_KEY, JSON.stringify(record));
    } catch (err) {
      swallow('build-your-interview#persistPendingCreate', err);
    }
  }

  /**
   * Explicit cleanup — called the moment a pending attempt is RESOLVED
   * (success, or a non-retryable failure with nothing left to retry). A
   * stale record must never outlive the attempt it describes, independent
   * of the TTL safety net in {@link loadPersistedPendingCreate}.
   */
  private clearPersistedPendingCreate(): void {
    try {
      sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY);
    } catch (err) {
      swallow('build-your-interview#clearPersistedPendingCreate', err);
    }
  }

  private loadPersistedPendingCreate(): PendingCreateRecord | null {
    try {
      const raw = sessionStorage.getItem(PENDING_CREATE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PendingCreateRecord> | null;
      if (
        !parsed ||
        typeof parsed.idempotencyKey !== 'string' || parsed.idempotencyKey.length === 0 ||
        typeof parsed.expiresAtMs !== 'number' ||
        !isStoredCreateRequest(parsed.request)
      ) {
        this.clearPersistedPendingCreate();
        return null;
      }
      if (Date.now() >= parsed.expiresAtMs) {
        this.clearPersistedPendingCreate();
        return null;
      }
      return { idempotencyKey: parsed.idempotencyKey, request: parsed.request, expiresAtMs: parsed.expiresAtMs };
    } catch (err) {
      swallow('build-your-interview#loadPersistedPendingCreate', err);
      this.clearPersistedPendingCreate();
      return null;
    }
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
    if (!isInterviewApiConfigured()) {
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

    // A FRESH click of Start Assessment always begins a NEW logical attempt —
    // a new idempotency key, and THIS exact request cached for any retry of
    // it. This is the only place either is ever (re)assigned to a non-null
    // pair; retryInterview() below reuses them unchanged.
    this.pendingIdempotencyKey = crypto.randomUUID();
    this.pendingRequest = request;
    // Persisted so a reload during the request that follows can recover this
    // exact attempt rather than silently losing track of it — see
    // restorePendingCreateIfAny()'s own doc comment.
    this.persistPendingCreate(this.pendingIdempotencyKey, this.pendingRequest);

    // ONE bounded automatic retry is offered ONLY on a fresh click — a
    // MANUAL retryInterview() below never chains a further automatic one on
    // top of itself, which is what keeps this a single bounded recovery
    // rather than a loop.
    await this.attemptCreateSession(/* allowAutomaticRetry */ true);
  }

  /**
   * Retry the LAST attempt Start Assessment made — same idempotency key,
   * same request, never a new logical attempt. A no-op if there is nothing
   * pending (already succeeded, or the last failure was non-retryable and
   * therefore never left anything to retry) or if a request is already in
   * flight.
   */
  async retryInterview(): Promise<void> {
    if (this.creating) return;
    if (!this.pendingIdempotencyKey || !this.pendingRequest) return;
    await this.attemptCreateSession(/* allowAutomaticRetry */ false);
  }

  private async attemptCreateSession(allowAutomaticRetry: boolean): Promise<void> {
    const idempotencyKey = this.pendingIdempotencyKey;
    const request = this.pendingRequest;
    if (!idempotencyKey || !request) return; // unreachable via the public entry points above

    this.creating = true;
    this._isCreating.set(true);
    // Cleared at the START of every attempt, including a retry — a stale
    // message must never survive into the next attempt's own pending state.
    this._createError.set(null);
    this._createRetryable.set(false);
    this.stashTimerOverride();

    // Declared here (not inside the try) so `finally` can reach it — stays
    // null if createSession() itself throws, since showForStart() is only
    // ever called once a session actually exists.
    let spinnerHandle: QuizStartSpinnerHandle | null = null;

    try {
      const created = await this.createWithAutomaticRetries(request, idempotencyKey, allowAutomaticRetry);

      // This attempt is now resolved — nothing left to retry. Explicit even
      // though navigation (below) will normally unmount this component
      // anyway: a stale "Retrying…"/error string must never survive a
      // success, independent of how the template happens to react to it.
      this.pendingIdempotencyKey = null;
      this.pendingRequest = null;
      this.clearPersistedPendingCreate();
      this._createError.set(null);
      this._createRetryable.set(false);

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
      // A client-side TimeoutError (the in-page bound expired with NO
      // response at all) and a genuine HTTP 504 (a response DID arrive — a
      // gateway-timeout status) are two different signals reaching the same
      // conclusion: the backend is cold, and the request may or may not have
      // committed — see InterviewSessionRepository#mintAdditionalToken's own
      // doc comment for why retrying with the SAME key is safe regardless of
      // which turns out to be true. Both get the SAME specific wording,
      // deliberately more actionable than the generic BACKEND_UNAVAILABLE
      // message every OTHER retryable failure (500, 503, a network drop)
      // still shows. This is reached either when automatic retry was not
      // attempted (not allowed, already used, or a non-cold-start error) or
      // when the automatic retry ITSELF also failed — either way it is the
      // FINAL outcome of this attempt, so pendingIdempotencyKey/pendingRequest
      // are deliberately left set in every retryable branch below so a
      // MANUAL Retry can reuse them.
      if (err instanceof TimeoutError || error.status === 504) {
        this._createRetryable.set(true);
        this._createError.set(BuildYourInterviewComponent.COLD_START_MESSAGE);
      } else {
        this._createError.set(error.userMessage);
        if (error.retryable) {
          // BACKEND_UNAVAILABLE/UNKNOWN — same reasoning as the timeout
          // branch above; keep the pending pair for Retry.
          this._createRetryable.set(true);
        } else {
          // A non-retryable failure (e.g. BAD_REQUEST) would just fail again
          // identically — nothing to retry. Clearing the pending pair means
          // the only way forward is Start Assessment, which always mints a
          // genuinely new attempt rather than silently reusing this one.
          this.pendingIdempotencyKey = null;
          this.pendingRequest = null;
          this.clearPersistedPendingCreate();
        }
      }
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

  /**
   * Sends the create request and, ONLY when `allowAutomaticRetry` is true
   * (a fresh Start Assessment click — never a manual retryInterview()),
   * automatically sends up to {@link MAX_CREATE_ATTEMPTS} total attempts
   * (currently 3: the initial request plus two automatic retries) with the
   * EXACT SAME idempotency key and request, as long as each failure is a
   * cold-start-retryable signal. Never recursive (never calls
   * `startInterview()` or itself) and BOUNDED by a fixed loop over a fixed
   * constant — not an unbounded/open-ended retry loop: the iteration count
   * is capped at compile time, and every iteration that isn't the last
   * either returns a success or rethrows immediately on a non-retryable or
   * final-attempt failure.
   *
   * Deliberately narrow about WHAT triggers an automatic retry — only a
   * client-side {@link TimeoutError} or a genuine HTTP 504, the two
   * confirmed cold-start signals (see {@link isColdStartRetryable}) — not
   * every {@code retryable} InterviewApiError (BACKEND_UNAVAILABLE/UNKNOWN
   * also cover a plain network drop or an unrelated 500, neither of which
   * this task's evidence supports auto-retrying).
   */
  private async createWithAutomaticRetries(
    request: CreateInterviewSessionRequest,
    idempotencyKey: string,
    allowAutomaticRetry: boolean
  ): Promise<CreatedInterviewSession> {
    const maxAttempts = allowAutomaticRetry ? BuildYourInterviewComponent.MAX_CREATE_ATTEMPTS : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // A component destroyed in the gap between the previous attempt's
        // failure and this one starting must never have this retry fire —
        // "cancel any pending retry" for a retry that has no
        // timer/subscription of its own to unsubscribe (it is a plain
        // awaited fetch, not an RxJS stream held open).
        if (this.destroyed) throw lastError;
        // A DISTINCT message from COLD_START_MESSAGE, and deliberately
        // WITHOUT createRetryable(true) — a manual Retry button has no
        // place while an automatic recovery of this SAME logical attempt is
        // already in flight. this.creating is already true (set by the
        // caller before this method was ever invoked), so a duplicate click
        // during this window is still rejected the same way it would be
        // during the first attempt.
        this._createError.set(BuildYourInterviewComponent.COLD_START_RETRYING_MESSAGE);
      }

      try {
        return await this.sendCreateRequest(request, idempotencyKey);
      } catch (err: unknown) {
        lastError = err;
        if (attempt === maxAttempts || !this.isColdStartRetryable(err)) {
          throw err;
        }
        // else: fall through to the next iteration, one more bounded attempt.
      }
    }
    // Unreachable — the loop above always either returns or throws on its
    // LAST iteration — but TypeScript's control-flow analysis cannot see
    // that through a `for` loop, so this satisfies "all code paths must
    // return a value" without changing behavior. `lastError` is always
    // assigned by the time this line could execute (only reachable after at
    // least one failed iteration).
    throw lastError;
  }

  private sendCreateRequest(
    request: CreateInterviewSessionRequest,
    idempotencyKey: string
  ): Promise<CreatedInterviewSession> {
    return firstValueFrom(
      this.api.createSession(request, idempotencyKey).pipe(timeout(BuildYourInterviewComponent.SESSION_CREATE_TIMEOUT_MS))
    );
  }

  /** The two CONFIRMED cold-start signals — see createWithAutomaticRetries's own doc comment for why this stays narrow. */
  private isColdStartRetryable(err: unknown): boolean {
    return err instanceof TimeoutError || (err instanceof InterviewApiError && err.status === 504);
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
