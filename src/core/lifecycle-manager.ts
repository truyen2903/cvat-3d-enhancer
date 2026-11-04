import { rootLogger } from './logger';

export type CleanupFn = () => void | Promise<void>;

export interface Disposable {
  dispose(): void | Promise<void>;
}

/**
 * Tracks observers, DOM listeners, intervals, and disposables to guarantee
 * complete deterministic cleanup on navigation or teardown.
 */
export class LifecycleManager implements Disposable {
  private readonly cleanups: CleanupFn[] = [];
  private disposed = false;
  private readonly log = rootLogger.child('lifecycle');

  public registerCleanup(fn: CleanupFn): () => void {
    if (this.disposed) {
      try {
        void fn();
      } catch (err) {
        this.log.warn('Cleanup invoked on already disposed LifecycleManager', err);
      }
      return () => undefined;
    }

    this.cleanups.push(fn);
    return () => {
      const idx = this.cleanups.indexOf(fn);
      if (idx !== -1) {
        this.cleanups.splice(idx, 1);
      }
    };
  }

  public addEventListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  public addEventListener<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (ev: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  public addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): () => void {
    target.addEventListener(type, listener, options);
    return this.registerCleanup(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  public observeMutations(
    target: Node,
    options: MutationObserverInit,
    callback: MutationCallback
  ): MutationObserver {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.registerCleanup(() => {
      observer.disconnect();
    });
    return observer;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const tasks = this.cleanups.splice(0, this.cleanups.length).reverse();
    for (const task of tasks) {
      try {
        await task();
      } catch (err) {
        this.log.error('Error during lifecycle cleanup execution', err);
      }
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }
}
