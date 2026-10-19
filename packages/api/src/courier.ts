import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CourierEvent } from '@workspace/domain';
import { z } from 'zod';
import { HttpError } from './http';

/**
 * Courier webhook adapter. ASSUMPTION: PromptXpress's real webhook/API format was not available while
 * writing this, so the default adapter is a GENERIC signed-JSON contract. When you have their API
 * documentation, write a new CourierAdapter (verify their auth, map their statuses) and pass it to
 * createApp; nothing else changes.
 *
 * Generic contract: POST JSON, header `x-signature` = hex HMAC-SHA256(rawBody, secret).
 *   { "tracking_number": "...", "status": "in_transit|delivered|failed|returned|cancelled|booked",
 *     "occurred_at": "2026-10-01T10:00:00Z", "description": "optional" }
 */
export interface CourierAdapter {
  /** Verify authenticity and translate. Throw HttpError(401) when the request is not genuine. */
  parse(rawBody: string, headers: Headers): CourierEvent;
}

const eventSchema = z.object({
  tracking_number: z.string().min(1).max(80),
  status: z.enum(['booked', 'in_transit', 'delivered', 'failed', 'returned', 'cancelled']),
  occurred_at: z.string().datetime(),
  description: z.string().max(500).optional(),
});

export function hmacJsonAdapter(secret: string, courierName = 'promptxpress'): CourierAdapter {
  return {
    parse(rawBody, headers) {
      const given = headers.get('x-signature') ?? '';
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(given);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'bad_signature', 'Invalid signature');
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new HttpError(400, 'invalid_json', 'Body must be valid JSON');
      }
      const e = eventSchema.parse(json);
      return { courier: courierName, trackingNumber: e.tracking_number, status: e.status, occurredAt: new Date(e.occurred_at), description: e.description ?? null };
    },
  };
}

export const signCourierBody = (rawBody: string, secret: string) => createHmac('sha256', secret).update(rawBody).digest('hex');
