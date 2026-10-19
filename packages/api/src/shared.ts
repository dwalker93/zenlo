import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from './auth';
import { principalOf } from './auth';

export const uuid = z.string().uuid();
export const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const placeOrderBody = z.object({
  items: z.array(z.object({ variantId: uuid, quantity: z.number().int().min(1).max(2_147_483_647) })).min(1).max(100),
  shipping: z.object({
    fullName: z.string().min(1).max(150),
    phone: z.string().min(5).max(32),
    line1: z.string().min(1).max(255),
    line2: z.string().max(255).nullish(),
    city: z.string().min(1).max(100),
    district: z.string().min(1).max(80),
    postalCode: z.string().max(16).nullish(),
  }),
  paymentMethod: z.enum(['bank_transfer', 'payhere']),
});
export const refundBody = z.object({
  orderId: uuid,
  lines: z.array(z.object({ sellerOrderId: uuid, itemAmountCents: money, deliveryAmountCents: money })).min(1).max(100),
  reason: z.string().max(1000).nullish(),
});


export function bearerMatches(header: string | undefined, secret: string) {
  const given = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}


export const actorId = (c: Context<Env>) => principalOf(c).userId;
