import { Directive, input } from '@angular/core';

import { SharedOptionConfig } from '@shared/models/SharedOptionConfig.model';

@Directive({
  selector: '[sharedOptionConfig]',
  standalone: true
})
export class SharedOptionConfigDirective {
  // ── inputs ──────────────────────────────────────────────────────
  readonly sharedOptionConfig = input.required<SharedOptionConfig>();
}
