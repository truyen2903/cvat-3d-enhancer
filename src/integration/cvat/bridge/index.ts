import { BRIDGE_CHANNEL, type BridgeCommandName } from '../../../shared/constants';
import {
  ApplyCanvasVisualConfigPayloadSchema,
  BridgeRequestEnvelopeSchema,
  BridgeResponseEnvelopeSchema,
  CameraActionPayloadSchema,
  SetCanvasBackgroundPayloadSchema,
} from '../../../shared/schemas';
import type { BridgeRequestEnvelope, BridgeResponseEnvelope } from '../../../shared/types';
import { assertNoPrototypePollution } from '../../../shared/utils';

export class MessageProtocol {
  public static generateRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  public static generateSessionToken(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return `tok_${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  }

  public static createRequest<TPayload>(
    command: BridgeCommandName,
    payload: TPayload,
    sessionToken: string,
    requestId = MessageProtocol.generateRequestId()
  ): BridgeRequestEnvelope<TPayload> {
    assertNoPrototypePollution(payload);
    MessageProtocol.validateCommandPayload(command, payload);

    const envelope: BridgeRequestEnvelope<TPayload> = {
      channel: BRIDGE_CHANNEL,
      direction: 'CONTENT_TO_PAGE',
      requestId,
      sessionToken,
      command,
      timestamp: Date.now(),
      payload,
    };

    BridgeRequestEnvelopeSchema.parse(envelope);
    return envelope;
  }

  public static createSuccessResponse<TResult>(
    requestId: string,
    sessionToken: string,
    result: TResult
  ): BridgeResponseEnvelope<TResult> {
    assertNoPrototypePollution(result);
    const envelope: BridgeResponseEnvelope<TResult> = {
      channel: BRIDGE_CHANNEL,
      direction: 'PAGE_TO_CONTENT',
      requestId,
      sessionToken,
      ok: true,
      timestamp: Date.now(),
      result,
    };
    BridgeResponseEnvelopeSchema.parse(envelope);
    return envelope;
  }

  public static createErrorResponse(
    requestId: string,
    sessionToken: string,
    code: string,
    message: string
  ): BridgeResponseEnvelope<never> {
    const envelope: BridgeResponseEnvelope<never> = {
      channel: BRIDGE_CHANNEL,
      direction: 'PAGE_TO_CONTENT',
      requestId,
      sessionToken,
      ok: false,
      timestamp: Date.now(),
      error: {
        code: code.slice(0, 64),
        message: message.slice(0, 300),
      },
    };
    BridgeResponseEnvelopeSchema.parse(envelope);
    return envelope;
  }

  public static validateIncomingRequest(
    rawData: unknown,
    expectedSessionToken: string
  ): BridgeRequestEnvelope {
    assertNoPrototypePollution(rawData);
    const parsed = BridgeRequestEnvelopeSchema.parse(rawData);
    if (parsed.sessionToken !== expectedSessionToken) {
      throw new Error('Bridge session token mismatch.');
    }
    MessageProtocol.validateCommandPayload(parsed.command, parsed.payload);
    return {
      ...parsed,
      payload: parsed.payload ?? {},
    };
  }

  public static validateIncomingResponse(
    rawData: unknown,
    expectedSessionToken: string
  ): BridgeResponseEnvelope {
    assertNoPrototypePollution(rawData);
    const parsed = BridgeResponseEnvelopeSchema.parse(rawData);
    if (parsed.sessionToken !== expectedSessionToken) {
      throw new Error('Bridge response session token mismatch.');
    }
    return parsed;
  }

  public static validateCommandPayload(command: BridgeCommandName, payload: unknown): void {
    switch (command) {
      case 'BRIDGE_HANDSHAKE':
      case 'DETECT_RUNTIME':
      case 'GET_CAPABILITIES':
      case 'RESET_TO_CVAT_DEFAULT':
        if (payload !== undefined && payload !== null && typeof payload === 'object') {
          if (Object.keys(payload as Record<string, unknown>).length > 0) {
            throw new Error(`Command "${command}" does not accept payload properties.`);
          }
        }
        break;
      case 'APPLY_CANVAS_VISUAL_CONFIG':
        ApplyCanvasVisualConfigPayloadSchema.parse(payload);
        break;
      case 'DISPATCH_CAMERA_ACTION':
        CameraActionPayloadSchema.parse(payload);
        break;
      case 'SET_CANVAS_BACKGROUND':
        SetCanvasBackgroundPayloadSchema.parse(payload);
        break;
      default: {
        const exhaustive: never = command;
        throw new Error(`Unknown command: ${String(exhaustive)}`);
      }
    }
  }
}

export interface PendingBridgeRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Content-script side of the secure PageBridge.
 * Validates message source, origin, per-session random token, requestId, and Zod schemas.
 * Never transmits authentication credentials across the bridge.
 */
export class PageBridge {
  private readonly win: Window;
  private readonly sessionToken: string;
  private readonly pending = new Map<string, PendingBridgeRequest>();
  private readonly timeoutMs: number;
  private listenerAttached = false;

  public constructor(
    win: Window = window,
    sessionToken: string = MessageProtocol.generateSessionToken(),
    timeoutMs = 3_500
  ) {
    this.win = win;
    this.sessionToken = sessionToken;
    this.timeoutMs = timeoutMs;
  }

  public getSessionToken(): string {
    return this.sessionToken;
  }

  public attach(): () => void {
    if (!this.listenerAttached) {
      this.win.addEventListener('message', this.handleWindowMessage);
      this.listenerAttached = true;
    }
    return () => {
      this.detach();
    };
  }

  public detach(): void {
    if (this.listenerAttached) {
      this.win.removeEventListener('message', this.handleWindowMessage);
      this.listenerAttached = false;
    }
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Bridge detached before request "${id}" completed.`));
    }
    this.pending.clear();
  }

  public async sendCommand<TPayload = Record<string, never>, TResult = unknown>(
    command: BridgeCommandName,
    payload: TPayload
  ): Promise<TResult> {
    if (!this.listenerAttached) {
      this.attach();
    }

    const envelope = MessageProtocol.createRequest(command, payload, this.sessionToken);

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.requestId);
        reject(new Error(`Bridge command "${command}" timed out.`));
      }, this.timeoutMs);

      this.pending.set(envelope.requestId, {
        resolve: (val) => resolve(val as TResult),
        reject,
        timer,
      });

      this.win.postMessage(envelope, this.win.location.origin);
    });
  }

  private readonly handleWindowMessage = (event: MessageEvent): void => {
    // 1. Strict sender & origin verification
    const expectedOrigin = this.win.location.origin;
    const sourceValid = event.source === this.win || event.source === null;
    const originValid =
      event.origin === expectedOrigin || (event.origin === '' && event.source === null);
    if (!sourceValid || !originValid) {
      return;
    }

    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) {
      return;
    }

    const candidate = data as Record<string, unknown>;
    if (
      candidate.channel !== BRIDGE_CHANNEL ||
      candidate.direction !== 'PAGE_TO_CONTENT'
    ) {
      return;
    }

    let validated: BridgeResponseEnvelope;
    try {
      validated = MessageProtocol.validateIncomingResponse(data, this.sessionToken);
    } catch {
      return;
    }

    const pendingEntry = this.pending.get(validated.requestId);
    if (!pendingEntry) {
      return;
    }

    clearTimeout(pendingEntry.timer);
    this.pending.delete(validated.requestId);

    if (validated.ok) {
      pendingEntry.resolve(validated.result);
    } else {
      pendingEntry.reject(
        new Error(validated.error?.message ?? 'Bridge command execution failed.')
      );
    }
  };
}
