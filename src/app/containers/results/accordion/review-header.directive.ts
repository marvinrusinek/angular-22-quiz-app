import { Directive, ElementRef, inject } from '@angular/core';
import { FocusableOption } from '@angular/cdk/a11y';

/**
 * Marks a Quiz Review header button so the accordion's FocusKeyManager can move focus between
 * headers with Arrow Up/Down and Home/End (the same keys Material's expansion panel supports).
 */
@Directive({
  selector: 'button[codelabReviewHeader]',
  exportAs: 'codelabReviewHeader',
  standalone: true
})
export class ReviewHeaderDirective implements FocusableOption {
  private readonly el = inject<ElementRef<HTMLButtonElement>>(ElementRef);

  focus(): void {
    this.el.nativeElement.focus();
  }
}
