import { ComponentFixture, TestBed } from '@angular/core/testing';

import {
  buildVerdictNotice,
  CURRENT_CHECK_FAILED_MESSAGE,
  EARLIER_CHECK_FAILED_MESSAGE
} from '@shared/utils/verdict-notice';
import { VerdictNoticeComponent } from './verdict-notice.component';

describe('buildVerdictNotice', () => {
  it('says nothing when nothing has failed', () => {
    expect(buildVerdictNotice('resolved', false)).toBeNull();
    expect(buildVerdictNotice('checking', false)).toBeNull();
    expect(buildVerdictNotice('idle', false)).toBeNull();
    expect(buildVerdictNotice(null, false)).toBeNull();
  });

  it('a failure on the question on screen is retryable in place', () => {
    expect(buildVerdictNotice('error', true)).toEqual({ message: CURRENT_CHECK_FAILED_MESSAGE, canRetry: true });
    expect(buildVerdictNotice('error', false)).toEqual({ message: CURRENT_CHECK_FAILED_MESSAGE, canRetry: true });
  });

  it('a failure elsewhere is explained (it is why Results is hidden) but not retryable from here', () => {
    expect(buildVerdictNotice('resolved', true)).toEqual({ message: EARLIER_CHECK_FAILED_MESSAGE, canRetry: false });
  });
});

describe('VerdictNoticeComponent', () => {
  let fixture: ComponentFixture<VerdictNoticeComponent>;

  function mount(message: string, canRetry: boolean): void {
    fixture = TestBed.createComponent(VerdictNoticeComponent);
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('canRetry', canRetry);
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const button = (): HTMLButtonElement | null => el().querySelector('button');

  beforeEach(() => TestBed.configureTestingModule({ imports: [VerdictNoticeComponent] }));

  it('shows the message in an alert region, so it is announced when it appears', () => {
    mount(CURRENT_CHECK_FAILED_MESSAGE, true);
    const alert = el().querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("couldn't verify your answer");
  });

  it('offers a native, focusable Retry button that emits once per activation', () => {
    mount(CURRENT_CHECK_FAILED_MESSAGE, true);
    const retry = jest.fn();
    fixture.componentInstance.retry.subscribe(retry);

    const btn = button()!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.disabled).toBe(false);
    expect(btn.tabIndex).toBeGreaterThanOrEqual(0);      // keyboard reachable; Enter/Space activate a native button
    btn.focus();
    expect(document.activeElement).toBe(btn);

    btn.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no Retry when the failure is on another question', () => {
    mount(EARLIER_CHECK_FAILED_MESSAGE, false);
    expect(button()).toBeNull();
    expect(el().textContent).toContain('Results is unavailable');
  });
});
