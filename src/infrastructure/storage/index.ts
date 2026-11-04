import { assertNoPrototypePollution } from '../../shared/utils';

export interface KeyValueStorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryStorageAdapter implements KeyValueStorageAdapter {
  private readonly store = new Map<string, unknown>();

  public async get<T = unknown>(key: string): Promise<T | undefined> {
    const val = this.store.get(key);
    if (val === undefined) {
      return undefined;
    }
    return structuredClone(val) as T;
  }

  public async set<T = unknown>(key: string, value: T): Promise<void> {
    assertNoPrototypePollution(value);
    this.store.set(key, structuredClone(value));
  }

  public async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }
}

export class ChromeLocalStorageAdapter implements KeyValueStorageAdapter {
  private readonly fallback = new InMemoryStorageAdapter();

  private hasChromeLocal(): boolean {
    return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
  }

  public async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.hasChromeLocal()) {
      return this.fallback.get<T>(key);
    }
    const result = await chrome.storage.local.get(key);
    const val = result[key];
    if (val !== undefined) {
      assertNoPrototypePollution(val);
    }
    return val as T | undefined;
  }

  public async set<T = unknown>(key: string, value: T): Promise<void> {
    assertNoPrototypePollution(value);
    if (!this.hasChromeLocal()) {
      await this.fallback.set(key, value);
      return;
    }
    await chrome.storage.local.set({ [key]: value });
  }

  public async remove(key: string): Promise<void> {
    if (!this.hasChromeLocal()) {
      await this.fallback.remove(key);
      return;
    }
    await chrome.storage.local.remove(key);
  }

  public async clear(): Promise<void> {
    if (!this.hasChromeLocal()) {
      await this.fallback.clear();
      return;
    }
    await chrome.storage.local.clear();
  }
}

/**
 * Ephemeral session storage adapter for sensitive values (e.g., optional PATs).
 * Never falls back to chrome.storage.local or window.localStorage.
 * Uses in-memory Map or chrome.storage.session restricted to trusted contexts.
 */
export class EphemeralSessionStorageAdapter implements KeyValueStorageAdapter {
  private readonly memory = new InMemoryStorageAdapter();

  private hasChromeSession(): boolean {
    return typeof chrome !== 'undefined' && Boolean(chrome.storage?.session);
  }

  public async get<T = unknown>(key: string): Promise<T | undefined> {
    const inMem = await this.memory.get<T>(key);
    if (inMem !== undefined) {
      return inMem;
    }
    if (this.hasChromeSession()) {
      try {
        const res = await chrome.storage.session.get(key);
        return res[key] as T | undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  public async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.memory.set(key, value);
    if (this.hasChromeSession()) {
      try {
        await chrome.storage.session.set({ [key]: value });
      } catch {
        // Content scripts without session access retain strictly in-memory storage
      }
    }
  }

  public async remove(key: string): Promise<void> {
    await this.memory.remove(key);
    if (this.hasChromeSession()) {
      try {
        await chrome.storage.session.remove(key);
      } catch {
        // Ignore if session storage is inaccessible from content context
      }
    }
  }

  public async clear(): Promise<void> {
    await this.memory.clear();
    if (this.hasChromeSession()) {
      try {
        await chrome.storage.session.clear();
      } catch {
        // Ignore
      }
    }
  }
}
