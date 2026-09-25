import { inject, Service, ViewContainerRef, ComponentRef, Type } from '@angular/core';

import { ANSWER_COMPONENT } from '@shared/tokens/answer-component.token';

@Service()
export class DynamicComponentService {
  // AnswerComponent is provided eagerly via ANSWER_COMPONENT (from main.ts)
  // instead of a dynamic import(). The lazy import produced a separate hashed
  // chunk whose fetch could fail on a cold load ("Failed to fetch dynamically
  // imported module" — observed in StackBlitz's WebContainer); injecting the
  // already-bundled class removes the chunk (and the rejected-promise cache)
  // entirely. The token is provided from the bootstrap entry, so this service
  // no longer imports AnswerComponent and the circular dependency that broke
  // bootstrap ("Class extends value undefined") is gone.
  private readonly answerComponent = inject<Type<any>>(ANSWER_COMPONENT);

  // ── public methods ──────────────────────────────────────────────
  // Kept async so existing `await loadComponent(...)` callers are unchanged.
  public async loadComponent<T>(
    container: ViewContainerRef,
    multipleAnswer: boolean,
    onOptionClicked: (event: any) => void
  ): Promise<ComponentRef<T>> {
    container.clear();

    const componentRef = container.createComponent(this.answerComponent as Type<T>);

    (componentRef.instance as any).isMultipleAnswer = multipleAnswer;

    const instance: any = componentRef.instance;

    if (instance.optionClicked) {
      instance.optionClicked.subscribe((event: any) => {
        onOptionClicked(event);
      });
    }

    return componentRef;
  }
}
