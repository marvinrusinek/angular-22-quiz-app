import { Service } from '@angular/core';

import { FeedbackProps } from '@shared/models/FeedbackProps.model';
import { OptionBindings } from '@shared/models/OptionBindings.model';
import { feedbackAnchorMatches } from '@shared/utils/feedback-anchor';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';

type Host = SharedOptionComponent;

/**
 * Template-facing feedback-display predicates for SharedOptionComponent
 * (shouldShowFeedbackFor / shouldShowFeedbackAfter / getInlineFeedbackConfig).
 * The component keeps thin delegators because the HTML template calls them.
 *
 * NOTE: these predicates read the plain `_feedbackDisplay` field. Deterministic
 * re-render is guaranteed by the explicit `cdRef.markForCheck()` the click handler
 * runs after setting `_feedbackDisplay` (shared-option-click.service.ts) — the old
 * [FB-*] console.logs that used to incidentally nudge CD timing are no longer needed.
 */
@Service()
export class OptionFeedbackDisplayService {
  shouldShowFeedbackFor(host: Host, b: OptionBindings): boolean {
    const h = host as any;
    const id: any = b.option.optionId;
    return (
      id === h.lastFeedbackOptionId &&
      !!h.feedbackConfigs[id]?.showFeedback
    );
  }

  shouldShowFeedbackAfter(host: Host, b: OptionBindings, i: number): boolean {
    const h = host as any;
    // Anchor by optionId (identity) so pinned "All of the above" — whose display
    // index differs from its canonical index — still shows feedback on its own row.
    const ok = feedbackAnchorMatches(h._feedbackDisplay, b.option?.optionId, i);
    if (ok) {
      return true;
    }
    if (h.timerExpiredForQuestion()) {
      const cfg = h.feedbackConfigs[b.option?.optionId ?? -1] ?? h.feedbackConfigs[h.keyOf(b.option, i)];
      return !!cfg?.showFeedback;
    }
    return false;
  }

  getInlineFeedbackConfig(host: Host, b: OptionBindings, i: number): FeedbackProps | null {
    const h = host as any;
    const cfg = h.bindingService.getInlineFeedbackConfig(host, b, i);
    return cfg;
  }
}
