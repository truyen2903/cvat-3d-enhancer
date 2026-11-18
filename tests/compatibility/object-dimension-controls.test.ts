import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VIEWPORT_DEFER_THRESHOLD,
  injectCvatObjectDimensionSyncControls,
} from '../../src/integration/cvat/runtime/object-dimension-controls';

const rowSelector = '.cvat-3d-enhancer-dim-sync-row';
const sync = () =>
  vi.fn(() => ({
    clientID: 1,
    dimension: 'H' as const,
    targetValue: 1.5,
    syncedFrames: 1,
    skippedAttributeMismatchFrames: 0,
  }));

function mountCard(content: string, type = 'CUBOID TRACK'): HTMLElement {
  document.body.innerHTML = `
    <div style="display:flex; margin-bottom:1px">
      <div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item cvat-objects-sidebar-state-active-item" style="--state-item-background:0,255,0">
        <span class="cvat-objects-sidebar-state-item-object-type-text">${type}</span>
        ${content}
        <div class="ant-collapse cvat-objects-sidebar-state-item-collapse">DETAILS</div>
      </div>
    </div>`;
  return document.getElementById('cvat-objects-sidebar-state-item-1')!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dimension controls on customized CVAT sidebars', () => {
  it('shows RS beside dimensions only for supported tracks and prevents overlapping operations', async () => {
    const card = mountCard('');
    let finish!: (result: {
      clientID: number;
      targetValue: string;
      updatedKeyframes: number;
      totalKeyframes: number;
    }) => void;
    const rideState = {
      isAvailable: vi.fn(() => true),
      sync: vi.fn(
        () =>
          new Promise<{
            clientID: number;
            targetValue: string;
            updatedKeyframes: number;
            totalKeyframes: number;
          }>((resolve) => {
            finish = resolve;
          })
      ),
    };
    const onSync = sync();
    injectCvatObjectDimensionSyncControls(document, onSync, {}, rideState);
    const button = card.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="RIDE_STATE"]')!;
    expect(button.textContent).toBe('RS');
    expect(card.querySelectorAll('button')).toHaveLength(5);
    button.click();
    button.click();
    await Promise.resolve();
    expect(rideState.sync).toHaveBeenCalledExactlyOnceWith(1);
    injectCvatObjectDimensionSyncControls(document, onSync, {}, rideState);
    expect(button.disabled).toBe(true);
    card.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="H"]')!.click();
    expect(onSync).not.toHaveBeenCalled();
    finish({ clientID: 1, targetValue: 'true', updatedKeyframes: 3, totalKeyframes: 4 });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.title).toContain('ride_state = true across all frames');
    rideState.isAvailable.mockReturnValue(false);
    injectCvatObjectDimensionSyncControls(document, onSync, {}, rideState);
    expect(card.querySelector('[data-enhancer-sync-dim="RIDE_STATE"]')).toBeNull();
    expect(card.querySelectorAll('button')).toHaveLength(4);
  });

  it.each([
    '<div class="ant-col ant-col-20 css-n0gjrg"><div class="ant-row"><span class="cvat-object-item-button-first-keyframe" style="opacity:0.5;pointer-events:none"></span></div></div>',
    '<div class="ant-col ant-col-24 css-company"><div class="company-actions"><span class="cvat-object-item-button-first-keyframe"></span></div></div>',
    '<div class="company-actions"><span class="cvat-object-item-button-lock anticon-unlock"></span></div>',
  ])('mounts all four actionable icons independently of the host grid: %s', async (content) => {
    const card = mountCard(content);
    const onSync = sync();
    expect(injectCvatObjectDimensionSyncControls(document, onSync)).toBe(1);
    expect(card.querySelectorAll(`${rowSelector} svg path`)).toHaveLength(4);
    const row = card.querySelector<HTMLElement>(rowSelector)!;
    expect(row.parentElement).toBe(card);
    expect(row.style.getPropertyPriority('display')).toBe('important');
    const button = row.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="H"]')!;
    expect(button.disabled).toBe(false);
    button.querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(onSync).toHaveBeenCalledWith(1, 'H'));
    expect(injectCvatObjectDimensionSyncControls(document, onSync)).toBe(0);
    expect(card.querySelectorAll(rowSelector)).toHaveLength(1);
  });

  it('repairs removed SVGs and buttons and rebinds a cloned row without duplicate handlers', async () => {
    const card = mountCard('');
    const onSync = sync();
    injectCvatObjectDimensionSyncControls(document, onSync);
    card.querySelector('[data-enhancer-sync-dim="H"] svg')!.remove();
    card.querySelector('[data-enhancer-sync-dim="W"]')!.remove();
    injectCvatObjectDimensionSyncControls(document, onSync);
    expect(card.querySelectorAll('svg path')).toHaveLength(4);
    const row = card.querySelector(rowSelector)!;
    row.replaceWith(row.cloneNode(true));
    injectCvatObjectDimensionSyncControls(document, onSync);
    injectCvatObjectDimensionSyncControls(document, onSync);
    card.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="H"]')!.click();
    await vi.waitFor(() => expect(onSync).toHaveBeenCalledTimes(1));
    card.querySelector(rowSelector)!.remove();
    expect(injectCvatObjectDimensionSyncControls(document, onSync)).toBe(1);
    expect(card.querySelectorAll('svg path')).toHaveLength(4);
  });

  it.each(['cvat-object-item-button-lock-enabled', 'anticon-lock'])(
    'honors lock variant %s before and after rerenders',
    async (lockClass) => {
      const card = mountCard(
        '<span class="cvat-object-item-button-lock anticon-unlock" aria-label="unlock"></span>'
      );
      const onSync = sync();
      injectCvatObjectDimensionSyncControls(document, onSync);
      const lock = card.querySelector('.cvat-object-item-button-lock')!;
      lock.className = `cvat-object-item-button-lock ${lockClass}`;
      const button = card.querySelector<HTMLButtonElement>('button')!;
      // Guard at click time as well, before the observer has reconciled disabled state.
      button.click();
      await Promise.resolve();
      expect(onSync).not.toHaveBeenCalled();
      injectCvatObjectDimensionSyncControls(document, onSync);
      expect(button.disabled).toBe(true);
      lock.className = 'cvat-object-item-button-lock anticon-unlock';
      injectCvatObjectDimensionSyncControls(document, onSync);
      expect(button.disabled).toBe(false);
      button.click();
      await vi.waitFor(() => expect(onSync).toHaveBeenCalledOnce());
    }
  );

  it('uses the current client ID and callback when CVAT recycles a card', async () => {
    const card = mountCard('');
    const oldSync = sync();
    const newSync = sync();
    injectCvatObjectDimensionSyncControls(document, oldSync);
    card.id = 'cvat-objects-sidebar-state-item-23';
    injectCvatObjectDimensionSyncControls(document, newSync);
    card.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(newSync).toHaveBeenCalledWith(23, 'H'));
    expect(oldSync).not.toHaveBeenCalled();
  });

  it.each(['RECTANGLE TRACK', 'CUBOID SHAPE'])('does not add track sync to %s', (type) => {
    mountCard('', type);
    expect(injectCvatObjectDimensionSyncControls(document, sync())).toBe(0);
  });

  it('surfaces a rejected sync in the tooltip without an unhandled rejection', async () => {
    const card = mountCard('');
    injectCvatObjectDimensionSyncControls(document, () => Promise.reject(new Error('unsupported')));
    const button = card.querySelector<HTMLButtonElement>('button')!;
    button.click();
    await vi.waitFor(() => expect(button.title).toContain('Sync failed'));
  });

  it('does not mutate the DOM on an unchanged reconciliation', async () => {
    mountCard('');
    injectCvatObjectDimensionSyncControls(document, sync());
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    injectCvatObjectDimensionSyncControls(document, sync());
    await Promise.resolve();
    observer.disconnect();
    expect(mutations).not.toHaveBeenCalled();
  });

  it('defers off-viewport cards via IntersectionObserver when > 64 cards exist and lazily mounts on scroll', async () => {
    expect(VIEWPORT_DEFER_THRESHOLD).toBe(64);
    const totalCards = 120;
    const sidebar = document.createElement('div');
    sidebar.className = 'cvat-objects-sidebar';
    const scrollList = document.createElement('div');
    scrollList.className = 'cvat-objects-sidebar-states-list';
    Object.defineProperty(scrollList, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollList, 'scrollHeight', { value: 6000, configurable: true });
    Object.defineProperty(scrollList, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    });

    const cards: HTMLElement[] = [];
    for (let i = 1; i <= totalCards; i++) {
      const card = document.createElement('div');
      card.id = `cvat-objects-sidebar-state-item-${i}`;
      card.className = 'cvat-objects-sidebar-state-item';
      card.innerHTML =
        '<span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>';
      scrollList.appendChild(card);
      cards.push(card);
    }
    sidebar.appendChild(scrollList);
    document.body.appendChild(sidebar);

    let ioCallback: IntersectionObserverCallback | null = null;
    const observed = new Set<Element>();
    const unobserved = new Set<Element>();
    class MockIntersectionObserver {
      readonly root: Element | Document | null;
      readonly rootMargin: string;
      readonly thresholds: readonly number[] = [0];
      constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
        ioCallback = callback;
        this.root = init?.root ?? null;
        this.rootMargin = init?.rootMargin ?? '0px';
      }
      observe(target: Element): void {
        observed.add(target);
      }
      unobserve(target: Element): void {
        observed.delete(target);
        unobserved.add(target);
      }
      disconnect(): void {
        observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    try {
      const onSync = sync();
      const rideState = {
        isAvailable: vi.fn((_id: number, card?: HTMLElement) => Boolean(card)),
        sync: vi.fn(async (id: number) => ({
          clientID: id,
          targetValue: 'true',
          updatedKeyframes: 1,
          totalKeyframes: 1,
        })),
      };

      const mountedInitially = injectCvatObjectDimensionSyncControls(
        document,
        onSync,
        {},
        rideState
      );
      expect(mountedInitially).toBeGreaterThan(0);
      expect(mountedInitially).toBeLessThanOrEqual(32);
      expect(rideState.isAvailable).toHaveBeenCalledTimes(mountedInitially);

      const farCard = cards[94]!; // clientID = 95
      expect(farCard.querySelector(rowSelector)).toBeNull();
      expect(observed.has(farCard)).toBe(true);

      // Simulate scrolling farCard into viewport
      expect(ioCallback).not.toBeNull();
      ioCallback!(
        [
          {
            target: farCard,
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      );

      expect(unobserved.has(farCard)).toBe(true);
      const farRow = farCard.querySelector(rowSelector);
      expect(farRow).not.toBeNull();
      expect(farCard.querySelectorAll('button')).toHaveLength(5);
      farCard.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="H"]')!.click();
      await vi.waitFor(() => expect(onSync).toHaveBeenCalledWith(95, 'H'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reconciles only targetCards when provided and passes card element to rideState.isAvailable', () => {
    document.body.innerHTML = `
      <div class="cvat-objects-sidebar">
        <div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item">
          <span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>
        </div>
        <div id="cvat-objects-sidebar-state-item-2" class="cvat-objects-sidebar-state-item">
          <span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>
        </div>
      </div>`;
    const card1 = document.getElementById('cvat-objects-sidebar-state-item-1')!;
    const card2 = document.getElementById('cvat-objects-sidebar-state-item-2')!;
    const rideState = {
      isAvailable: vi.fn(() => true),
      sync: vi.fn(),
    };
    const mounted = injectCvatObjectDimensionSyncControls(
      document,
      sync(),
      { targetCards: [card2] },
      rideState
    );
    expect(mounted).toBe(1);
    expect(card1.querySelector(rowSelector)).toBeNull();
    expect(card2.querySelector(rowSelector)).not.toBeNull();
    expect(rideState.isAvailable).toHaveBeenCalledExactlyOnceWith(2, card2);
  });
});
