import { z } from 'zod';
import { validateCvatOrigin } from '../../shared/utils';

export const BackgroundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PING'),
  }),
  z.object({
    type: z.literal('CHECK_ORIGIN_PERMISSION'),
    origin: z.string().min(1).max(256),
  }),
]);

export type BackgroundMessage = z.infer<typeof BackgroundMessageSchema>;

export interface BackgroundResponse {
  readonly ok: boolean;
  readonly authorized?: boolean;
  readonly error?: string;
}

export function handleBackgroundMessage(
  rawMessage: unknown,
  senderOrigin?: string
): BackgroundResponse {
  const parsed = BackgroundMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid background message schema',
    };
  }

  const msg = parsed.data;
  if (msg.type === 'PING') {
    return { ok: true };
  }

  const targetOrigin = senderOrigin ?? msg.origin;
  const validation = validateCvatOrigin(targetOrigin);
  return {
    ok: true,
    authorized: validation.valid,
    error: validation.reason,
  };
}
