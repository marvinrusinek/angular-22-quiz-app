import { Directive, input } from '@angular/core';

import { SharedOptionConfig } from '@shared/models';

@Directive({
  selector: '[sharedOptionConfig]',
  standalone: true
})
export class SharedOptionConfigDirective {
  // ── inputs ──────────────────────────────────────────────────────
  readonly sharedOptionConfig = input.required<SharedOptionConfig>();
}
