/**
 * Redacting logger that strictly prevents credentials, tokens, cookies, or authorization headers
 * from ever being emitted to console or diagnostic buffers.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|token|pat|personalaccesstoken|password|secret|sessionid|csrftoken|x-csrftoken)$/i;

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9_\-.=]+/gi,
  /Token\s+[A-Za-z0-9_\-.=]+/gi,
  /(?:sessionid|csrftoken)\s*=\s*[^;\s]+/gi,
];

export function redactString(input: string): string {
  let result = input;
  for (const regex of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(regex, '[REDACTED]');
  }
  return result;
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[MAX_DEPTH]';
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly meta?: unknown;
}

export class Logger {
  private readonly scope: string;
  private readonly history: LogEntry[];
  private readonly maxEntries: number;

  public constructor(scope: string, historyBuffer: LogEntry[] = [], maxEntries = 100) {
    this.scope = scope;
    this.history = historyBuffer;
    this.maxEntries = maxEntries;
  }

  public child(subScope: string): Logger {
    return new Logger(`${this.scope}:${subScope}`, this.history, this.maxEntries);
  }

  public debug(message: string, meta?: unknown): void {
    this.record('debug', message, meta);
  }

  public info(message: string, meta?: unknown): void {
    this.record('info', message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.record('warn', message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.record('error', message, meta);
  }

  public getHistory(): readonly LogEntry[] {
    return [...this.history];
  }

  private record(level: LogLevel, message: string, meta?: unknown): void {
    const safeMessage = redactString(message);
    const safeMeta = meta !== undefined ? sanitizeLogValue(meta) : undefined;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      scope: this.scope,
      message: safeMessage,
      meta: safeMeta,
    };

    this.history.push(entry);
    if (this.history.length > this.maxEntries) {
      this.history.shift();
    }
  }
}

export const rootLogger = new Logger('cvat-3d-enhancer');
