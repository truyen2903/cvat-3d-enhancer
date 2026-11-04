import type {
  AuthenticationState,
  CvatRouteContext,
  CvatRuntimeSnapshot,
  EnhancerConfig,
} from '../shared/types';
import { rootLogger } from './logger';

export type CoreEventMap = {
  'route:changed': CvatRouteContext;
  'runtime:updated': CvatRuntimeSnapshot;
  'auth:updated': AuthenticationState;
  'config:updated': EnhancerConfig;
  'feature:toggled': { readonly featureId: string; readonly enabled: boolean };
  'ui:toggle-panel': undefined;
};

export type EventHandler<T> = (payload: T) => void;

export class EventBus<TEventMap extends object = CoreEventMap> {
  private readonly listeners = new Map<keyof TEventMap, Set<EventHandler<unknown>>>();
  private readonly log = rootLogger.child('event-bus');

  public on<K extends keyof TEventMap>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);

    return () => {
      this.off(event, handler);
    };
  }

  public off<K extends keyof TEventMap>(event: K, handler: EventHandler<TEventMap[K]>): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    set.delete(handler as EventHandler<unknown>);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  public emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        this.log.error(`Unhandled error in event listener for "${String(event)}"`, err);
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}
