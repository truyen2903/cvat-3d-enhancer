/**
 * Guards against prototype pollution and unsafe object keys during deep merges or JSON parsing.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function assertNoPrototypePollution(value: unknown, path = 'root'): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPrototypePollution(value[i], `${path}[${i}]`);
    }
    return;
  }

  const ownNames = Object.getOwnPropertyNames(value);
  for (const key of ownNames) {
    if (isForbiddenKey(key)) {
      throw new Error(`Security violation: forbidden property "${key}" detected at ${path}.${key}`);
    }
    const child = (value as Record<string, unknown>)[key];
    assertNoPrototypePollution(child, `${path}.${key}`);
  }
}

export function safeJsonParse<T = unknown>(raw: string): T {
  const parsed: unknown = JSON.parse(raw, (key, value) => {
    if (isForbiddenKey(key)) {
      throw new Error(`Security violation: forbidden JSON key "${key}" rejected.`);
    }
    return value;
  });
  assertNoPrototypePollution(parsed);
  return parsed as T;
}

export function stripDangerousStrings(input: string): string {
  // Rejects control characters and neutralizes angle brackets for defense-in-depth
  let cleaned = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f && input[i] !== '<' && input[i] !== '>') {
      cleaned += input[i];
    }
  }
  return cleaned.trim();
}
