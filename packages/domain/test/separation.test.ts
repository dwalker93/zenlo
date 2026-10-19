import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLogs, payouts, users } from '@workspace/db/schema';
import { SeparationOfDutiesError, approveRefund, createPayout, requestRefund, startPayout, verifyDelivery } from '../src';
import { addPayoutAccount, createPgTestDb, markShipped, paidOrder, type PgTest } from './pg';

let pg: PgTest;
let a: string;
let b: string;
beforeAll(async () => {
  pg = await createPgTestDb();
  [{ id: a }] = await pg.db.insert(users).values({ email: 'sod-a@test', name: 'A' }).returning({ id: users.id });
  [{ id: b }] = await pg.db.insert(users).values({ email: 'sod-b@test', name: 'B' }).returning({ id: users.id });
});
afterAll(async () => { await pg.close(); });

async function deliveredOrder() {
  const o = await paidOrder(pg.db);
  await markShipped(pg.db, o.A.id, o.sellers[0].locationId);
  await verifyDelivery(pg.db, o.A.id);
  return o;
}
const reqRefund = async (o: Awaited<ReturnType<typeof deliveredOrder>>, by: string) =>
  (await requestRefund(pg.db, { orderId: o.orderId, lines: [{ sellerOrderId: o.A.id, itemAmountCents: 1000, deliveryAmountCents: 0 }], requestedBy: by })).refundId;

describe('refund two-person rule', () => {
  test('requester cannot approve at/above the threshold; others can; the request and approval are audited', async () => {
    const o = await deliveredOrder();
    const id = await reqRefund(o, a);
    await expect(approveRefund(pg.db, id, { approvedBy: a, dualControlThresholdCents: 1000 })).rejects.toBeInstanceOf(SeparationOfDutiesError);
    await expect(approveRefund(pg.db, id, { dualControlThresholdCents: 1000 })).rejects.toBeInstanceOf(SeparationOfDutiesError); // approver unknown
    await approveRefund(pg.db, id, { approvedBy: b, dualControlThresholdCents: 1000 });
    const rows = await pg.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(rows.map((r) => r.action).sort()).toEqual(['refund.approved', 'refund.requested']);
    expect(rows.find((r) => r.action === 'refund.requested')?.actorId).toBe(a);
  });

  test('below the threshold, or with no threshold, the same person may do both', async () => {
    const o = await deliveredOrder();
    await approveRefund(pg.db, await reqRefund(o, a), { approvedBy: a, dualControlThresholdCents: 1001 });
    await approveRefund(pg.db, await reqRefund(o, a), { approvedBy: a });
  });
});

describe('payout two-person rule', () => {
  test('creator cannot start at/above the threshold; another person can', async () => {
    const o = await deliveredOrder();
    await addPayoutAccount(pg.db, o.sellers[0].sellerId);
    const made = await createPayout(pg.db, o.sellers[0].sellerId, { createdBy: a });
    if (!made.created) throw new Error('expected a payout');
    await expect(startPayout(pg.db, made.payoutId, a, { dualControlThresholdCents: 0 })).rejects.toBeInstanceOf(SeparationOfDutiesError);
    await expect(startPayout(pg.db, made.payoutId, undefined, { dualControlThresholdCents: 0 })).rejects.toBeInstanceOf(SeparationOfDutiesError);
    expect((await pg.db.select().from(payouts).where(eq(payouts.id, made.payoutId)))[0].status).toBe('pending');
    await startPayout(pg.db, made.payoutId, b, { dualControlThresholdCents: 0 });
    expect((await pg.db.select().from(payouts).where(eq(payouts.id, made.payoutId)))[0].status).toBe('processing');
  });
});
