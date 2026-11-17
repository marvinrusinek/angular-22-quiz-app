import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { IntroExposedTextDirective } from './intro-exposed-text.directive';

@Component({
  standalone: true,
  imports: [IntroExposedTextDirective],
  template: `
    @if (show()) {
      <div class="group" role="group" tabindex="0">
        <div data-intro-visible aria-hidden="true">visible</div>
        <span [appIntroExposedText]="text()" [exposedTextMode]="mode()"></span>
      </div>
    }
  `
})
class HostComponent {
  readonly show = signal(true);
  readonly text = signal('one\ntwo');
  readonly mode = signal<'clone' | 'justify'>('clone');
}

@Component({
  standalone: true,
  imports: [IntroExposedTextDirective],
  template: `
    <div class="column">
      <div class="group" role="group">
        <div data-intro-visible aria-hidden="true">
          <img alt="" width="10" height="10" />
          <span data-intro-width-ref>sentence</span>
        </div>
        <span [appIntroExposedText]="text" exposedTextMode="spread" fitGroupWidth></span>
      </div>
    </div>
  `
})
class SpreadHostComponent {
  readonly text = 'Title!\nsentence';
}

/**
 * The directive's job is to expose ONE text node and to release what it
 * observes. Layout fitting itself needs real layout, so the fit maths is
 * covered by the browser checks; jsdom has no Range geometry.
 */
describe('IntroExposedTextDirective', () => {
  let observers: Array<{ observe: jest.Mock; disconnect: jest.Mock; cb: () => void }>;
  let fontsResolve: () => void;
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

  beforeEach(() => {
    observers = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe = jest.fn();
      disconnect = jest.fn();
      constructor(public cb: () => void) {
        observers.push(this as unknown as (typeof observers)[number]);
      }
    };
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise<void>((r) => (fontsResolve = r)) }
    });
    TestBed.configureTestingModule({ imports: [HostComponent, SpreadHostComponent] });
  });

  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
    if (realFonts) Object.defineProperty(document, 'fonts', realFonts);
    else delete (document as unknown as { fonts?: unknown }).fonts;
  });

  const render = () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    TestBed.tick();
    const exposed = (fixture.nativeElement as HTMLElement).querySelector('.intro-exposed-text')!;
    return { fixture, exposed };
  };

  it('exposes exactly one text node holding the whole text, newlines included', () => {
    const { exposed } = render();
    expect(exposed.childNodes).toHaveLength(1);
    expect(exposed.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(exposed.textContent).toBe('one\ntwo');
  });

  it('stays one text node when the text changes', () => {
    const { fixture, exposed } = render();
    fixture.componentInstance.text.set('a\nb\nc');
    fixture.detectChanges();
    TestBed.tick();
    expect(exposed.childNodes).toHaveLength(1);
    expect(exposed.textContent).toBe('a\nb\nc');
  });

  it('observes the group and the visible content, and nothing else', () => {
    render();
    expect(observers).toHaveLength(1);
    const observed = observers[0].observe.mock.calls.map(([el]) => (el as HTMLElement).className || (el as HTMLElement).tagName);
    expect(observed).toEqual(['group', 'DIV']);
  });

  it('disconnects its observer when destroyed', () => {
    const { fixture } = render();
    expect(observers[0].disconnect).not.toHaveBeenCalled();
    fixture.destroy();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the group is removed from the view, not only on teardown', () => {
    const { fixture } = render();
    fixture.componentInstance.show.set(false);
    fixture.detectChanges();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores the web-font callback after it is destroyed', async () => {
    const { fixture } = render();
    const range = jest.spyOn(document, 'createRange');
    fixture.destroy();
    range.mockClear();
    fontsResolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(range).not.toHaveBeenCalled();
    range.mockRestore();
  });

  describe('spread mode with fitGroupWidth (the feedback group)', () => {
    const renderSpread = () => {
      const fixture = TestBed.createComponent(SpreadHostComponent);
      fixture.detectChanges();
      TestBed.tick();
      return fixture.nativeElement as HTMLElement;
    };

    it('still exposes exactly one text node', () => {
      const exposed = renderSpread().querySelector('.intro-exposed-text')!;
      expect(exposed.childNodes).toHaveLength(1);
      expect(exposed.textContent).toBe('Title!\nsentence');
    });

    it('observes the parent of the group, not the group it resizes (no feedback loop)', () => {
      const root = renderSpread();
      const observed = observers[0].observe.mock.calls.map(([el]) => (el as HTMLElement).className || (el as HTMLElement).tagName);
      expect(observed).toContain('column');
      expect(observed).not.toContain('group');
      expect(root.querySelector('.group')).not.toBeNull();
    });

    it('releases that observer on destroy too', () => {
      const fixture = TestBed.createComponent(SpreadHostComponent);
      fixture.detectChanges();
      TestBed.tick();
      fixture.destroy();
      expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('adds no listeners to the document or window', () => {
    const doc = jest.spyOn(document, 'addEventListener');
    const win = jest.spyOn(window, 'addEventListener');
    render();
    expect(doc).not.toHaveBeenCalled();
    expect(win).not.toHaveBeenCalled();
    doc.mockRestore();
    win.mockRestore();
  });

  it('copes with an environment that has no layout (nothing to fit)', () => {
    expect(() => render()).not.toThrow();
  });
});

@Component({
  standalone: true,
  imports: [IntroExposedTextDirective],
  template: `
    <div class="g" role="group">
      <div data-intro-visible aria-hidden="true"><span data-intro-font-ref>label</span></div>
      <span [appIntroExposedText]="text()" exposedTextMode="cover" exposedTextBox="group"></span>
    </div>
  `
})
class CoverHostComponent {
  readonly text = signal('Completed in 0 minutes and 1 second.');
}

/**
 * fit() runs several times while a page settles (text effect, ResizeObserver's first callback, fonts.ready). Each
 * run replaced the exposed text node, which fires UI Automation text/structure events, even when nothing it
 * depends on had changed. A re-fit with identical inputs must now write nothing; a real change must still re-fit.
 */
describe('IntroExposedTextDirective: redundant re-fits', () => {
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  let callbacks: Array<() => void>;
  let rectSpy: jest.SpyInstance;

  beforeEach(() => {
    callbacks = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe = jest.fn();
      disconnect = jest.fn();
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
    };
    // jsdom has no layout: give every element the same, fixed geometry.
    rectSpy = jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40, x: 10, y: 20, toJSON: () => ({})
    } as DOMRect);
  });

  afterEach(() => {
    rectSpy.mockRestore();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  });

  const settle = async (f: ReturnType<typeof TestBed.createComponent<CoverHostComponent>>): Promise<void> => {
    f.detectChanges();
    TestBed.tick();
    await Promise.resolve();
  };

  it('writes nothing when a re-fit has identical inputs, but still re-fits on a real change', async () => {
    const f = TestBed.createComponent(CoverHostComponent);
    await settle(f);
    const host = f.nativeElement.querySelector('[data-intro-visible] + span') as HTMLElement;
    expect(host.childNodes).toHaveLength(1);
    expect(callbacks.length).toBeGreaterThan(0);

    const records: MutationRecord[] = [];
    const mo = new MutationObserver((rs) => records.push(...rs));
    mo.observe(host, { childList: true, characterData: true, subtree: true, attributes: true });

    // the ResizeObserver callback fires again and again with the same geometry
    for (let i = 0; i < 4; i++) callbacks.forEach((cb) => cb());
    await Promise.resolve();
    records.push(...mo.takeRecords());
    expect(records).toHaveLength(0);

    // a real change (the text) still re-fits and updates the single text node
    f.componentInstance.text.set('Completed in 0 minutes and 2 seconds.');
    await settle(f);
    records.push(...mo.takeRecords());
    expect(records.length).toBeGreaterThan(0);
    // cover mode lays a single sentence out as two rows (newline-separated) even without layout
    expect((host.textContent ?? '').replace(/\n/g, ' ')).toBe('Completed in 0 minutes and 2 seconds.');
    expect(host.childNodes).toHaveLength(1);
    mo.disconnect();
  });

  it('re-fits again after the text goes A, B, A (the effect restored the raw text)', async () => {
    const f = TestBed.createComponent(CoverHostComponent);
    await settle(f);
    const host = f.nativeElement.querySelector('[data-intro-visible] + span') as HTMLElement;
    f.componentInstance.text.set('B');
    await settle(f);
    f.componentInstance.text.set('Completed in 0 minutes and 1 second.');
    await settle(f);
    // cover mode lays a single sentence out as two rows (newline-separated) even without layout
    expect((host.textContent ?? '').replace(/\n/g, ' ')).toBe('Completed in 0 minutes and 1 second.');
    expect(host.childNodes).toHaveLength(1);
  });
});
