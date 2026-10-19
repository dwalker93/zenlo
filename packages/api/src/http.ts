import { DomainError } from '@workspace/domain';
import type { Context } from 'hono';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const STATUS: Record<string, 400 | 403 | 404 | 409 | 422> = {
  separation_of_duties: 403,
  out_of_stock: 409,
  variant_unavailable: 422,
  invalid_order: 422,
  invalid_refund: 422,
  invalid_shipment: 422,
  payment_not_found: 404,
  refund_not_found: 404,
  seller_order_not_found: 404,
  payout_not_found: 404,
  payment_amount_mismatch: 409,
  payment_not_payable: 409,
  order_not_awaiting_payment: 409,
  order_already_paid: 409,
  open_payment_exists: 409,
  refund_state: 409,
  refund_capacity_exceeded: 409,
  refund_payment: 409,
  seller_order_state: 409,
  delivery_not_verifiable: 409,
  payout_state: 409,
  payout_outcome_unknown: 409,
  no_payout_account: 409,
};

/** Map any thrown error to a JSON response. Unknown errors are logged and never leak details. */
export function onError(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  if (err instanceof DomainError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, STATUS[err.code] ?? 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'invalid_request', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, 400);
  }
  console.error('unhandled error', err);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
}

/** Parse a JSON body with a zod schema (throws ZodError -> 400). */
export async function jsonBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be valid JSON');
  }
  return schema.parse(raw);
}
