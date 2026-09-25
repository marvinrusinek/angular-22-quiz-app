import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';

import { MatCardModule } from '@angular/material/card';
import {
  ActivatedRoute,
  ActivatedRouteSnapshot,
  NavigationEnd,
  Params,
  Router,
} from '@angular/router';
import { combineLatest, fromEvent, merge, Observable, of } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs/operators';

import { QuizService } from '@shared/services/data/quiz.service';
import { shallowObjectEqual } from '@shared/utils/shallow-equal';

import { ScoreComponent } from './score/score.component';
import { TimerComponent } from './timer/timer.component';

@Component({
  selector: 'codelab-scoreboard',
  standalone: true,
  imports: [MatCardModule, ScoreComponent, TimerComponent],
  templateUrl: './scoreboard.component.html',
  styleUrls: ['./scoreboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScoreboardComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizService = inject(QuizService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  // ── remaining variables ─────────────────────────────────────────
  private readonly routeIsOneBased = true;
  questionNumber = 0;

  // Normalize/clamp helper
  private coerceIndex = (raw: string | null): number => {
    let n = Number(raw);
    if (!Number.isFinite(n)) n = 0;
    if (this.routeIsOneBased) n -= 1; // normalize to 0-based internally
    return n < 0 ? 0 : n;
  };

  // Seed from snapshot to avoid the "1" flash on resume
  private readonly seedIndex = this.coerceIndex(
    this.activatedRoute.snapshot.paramMap.get('questionIndex')
  );

  // 0-based route index stream, seeded with snapshot
  readonly routeIndex$: Observable<number> = merge(
    of(this.seedIndex),
    this.activatedRoute.paramMap.pipe(map((pm) => this.coerceIndex(pm.get('questionIndex')))),
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.readIndexFromSnapshot())
    ),
    fromEvent(document, 'visibilitychange').pipe(
      filter(() => document.visibilityState === 'visible'),
      map(() => this.readIndexFromSnapshot())
    ),
    fromEvent(window, 'pageshow').pipe(map(() => this.readIndexFromSnapshot()))
    // refCount so the source — which includes document/window DOM listeners —
    // is released when the last subscriber goes. A bare shareReplay(1) never
    // unsubscribes upstream, so those listeners survived every destroyed
    // scoreboard for the app's lifetime. Safe here because all consumers
    // (toSignal + two takeUntilDestroyed subscribes) are created at construction
    // and live until destroy, so the count never dips to zero and back.
  ).pipe(distinctUntilChanged(), shareReplay({ bufferSize: 1, refCount: true }));

  // 1-based for display
  readonly displayIndex$: Observable<number> = this.routeIndex$.pipe(map((i) => i + 1));

  // Service badge stream. Seed with '' so combineLatest emits.
  private readonly serviceBadgeText$: Observable<string> = (
    this.quizService.badgeText as Observable<string>
  ).pipe(
    startWith(''),
    map((s) => (s ?? '').trim())
  );

  // Computed fallback badge (pure function of route index and totalQuestions)
  private readonly computedBadgeText$: Observable<string> = combineLatest([
    this.displayIndex$,
    this.quizService.totalQuestions$.pipe(
      map((t) => Number(t)),
      startWith(-1)
    ),
  ]).pipe(
    map(([n, total]) => (Number.isFinite(total) && total > 0 ? `Question ${n} of ${total}` : '')),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // Final badge: prefer service text only when it agrees with the route-
  // derived computed badge. The service signal can lag the route on tab
  // visibility return (stays at the previous question's text), so when
  // the two disagree, trust the route.
  private readonly badgeText$: Observable<string> = combineLatest([
    this.serviceBadgeText$,
    this.computedBadgeText$,
  ]).pipe(
    map(([svc, cmp]) => {
      if (svc === '') return cmp;
      if (cmp === '') return svc;
      return svc === cmp ? svc : cmp;
    }),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly badgeText = toSignal(this.badgeText$, { initialValue: '' });

  readonly badgeparts = computed(() => {
    const text = this.badgeText().replace('Question ', '');
    const parts = text.split(' of ');
    return [parts[0] || '', parts[1] || ''];
  });

  ngOnInit(): void {
    this.handleRouteParameters();
    this.syncBadgeWithRouteSlug();
  }

  private handleRouteParameters(): void {
    this.activatedRoute.params
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        distinctUntilChanged((prev, curr) => shallowObjectEqual(prev, curr)),
        switchMap((params: Params) => this.processRouteParams(params)),
        catchError(() => {
          return of(null);
        })
      )
      .subscribe((totalQuestions: number | null) => {
        if (totalQuestions !== null) {
          const validQuestionNumber = this.questionNumber >= 1 ? this.questionNumber : 1;

          if (validQuestionNumber <= totalQuestions) {
            this.quizService.updateBadgeText(validQuestionNumber, totalQuestions);
          }
        }
      });
  }

  private processRouteParams(params: Params): Observable<number> {
    if (params['questionIndex'] !== undefined) {
      const rawIndex = params['questionIndex'] != null ? String(params['questionIndex']) : null;
      const normalizedIndex = this.coerceIndex(rawIndex);
      const updatedQuestionNumber = normalizedIndex + 1;

      if (this.questionNumber !== updatedQuestionNumber) {
        this.questionNumber = updatedQuestionNumber;
      }

      return this.quizService.totalQuestions$;
    }

    return of(0);
  }

  private syncBadgeWithRouteSlug(): void {
    combineLatest([
      this.displayIndex$,
      this.quizService.totalQuestions$.pipe(
        map((total) => Number(total)),
        filter((total) => Number.isFinite(total) && total > 0)
      ),
    ])
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        filter(([displayIndex]) => Number.isFinite(displayIndex) && displayIndex > 0),
        distinctUntilChanged(
          ([prevIndex, prevTotal], [currIndex, currTotal]) =>
            prevIndex === currIndex && prevTotal === currTotal
        )
      )
      .subscribe(([displayIndex, totalQuestions]) => {
        this.quizService.updateBadgeText(displayIndex, totalQuestions);
      });
  }

  private getParamDeep(snap: ActivatedRouteSnapshot, key: string): string | null {
    let cur: ActivatedRouteSnapshot | null = snap;
    while (cur) {
      const v = cur.paramMap.get(key);
      if (v != null) return v;
      cur = cur.firstChild ?? null;
    }
    return null;
  }

  private readIndexFromSnapshot(): number {
    const raw = this.getParamDeep(this.router.routerState.snapshot.root, 'questionIndex');
    return this.coerceIndex(raw);
  }
}
