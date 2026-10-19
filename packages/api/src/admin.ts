import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { payments } from '@workspace/db/schema';
import {
  approveRefund,
  cancelPayout,
  completeRefund,
  confirmPayment,
  createPayout,
  failRefund,
  markPayoutFailed,
  markPayoutPaid,
  rejectRefund,
  requestRefund,
  retryPayout,
  startPayout,
  startRefundProcessing,
  verifyDelivery,
  type Db,
} from '@workspace/domain';
import { requirePermission, requireStaff, requireUser, type Authenticate, type Env } from './auth';
import type { AdminConfig } from './config';
import { HttpError, jsonBody, onError } from './http';
import { requireTrustedOrigin } from './origin';
import { actorId, refundBody, uuid } from './shared';

export interface AdminAppDeps {
  db: Db;
  authenticate: Authenticate;
  config: AdminConfig;
}

/**
 * Staff only. Every route needs a staff role, a second factor (unless disabled) and a specific permission.
 * Deploy as its own project on its own (sub)domain; it shares nothing with the public app but the database.
 */
export function createAdminApp(deps: AdminAppDeps) {
  const { db, config } = deps;
  const app = new Hono<Env>();
  app.onError(onError);
  app.use('*', requireTrustedOrigin(config.trustedOrigins)); // throws at startup if the list is empty
  app.get('/health', (c) => c.json({ ok: true }));
  app.use('*', requireUser(deps.authenticate), requireStaff(config.requireMfa));
  const dual = { dualControlThresholdCents: config.dualControlThresholdCents };

  app.post('/payments/:id/confirm', requirePermission('payments.confirm'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = await jsonBody(c, z.object({ reference: z.string().max(120).nullish() }));
    const [p] = await db.select({ method: payments.method }).from(payments).where(eq(payments.id, id));
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found');
    if (p.method !== 'bank_transfer') throw new HttpError(422, 'not_bank_transfer', 'Only bank-transfer payments are confirmed manually');
    return c.json(await confirmPayment(db, { paymentId: id, confirmedBy: actorId(c), providerReference: b.reference ?? null }));
  });
  app.post('/seller-orders/:id/verify-delivery', requirePermission('delivery.verify'), async (c) =>
    c.json(await verifyDelivery(db, uuid.parse(c.req.param('id')), { verifiedBy: actorId(c) })),
  );

  // Refunds: request (support or finance) -> approve (finance, a different person above the threshold) -> process.
  app.post('/refunds', requirePermission('refunds.request'), async (c) => {
    const b = await jsonBody(c, refundBody);
    return c.json(await requestRefund(db, { ...b, requestedBy: actorId(c), processedBy: actorId(c) }), 201);
  });
  app.post('/refunds/:id/approve', requirePermission('refunds.approve'), async (c) =>
    c.json(await approveRefund(db, uuid.parse(c.req.param('id')), { approvedBy: actorId(c), ...dual })),
  );
  // returns started=true to exactly one caller, who then sends ONE external refund keyed by the refund id.
  app.post('/refunds/:id/start', requirePermission('refunds.process'), async (c) => c.json(await startRefundProcessing(db, uuid.parse(c.req.param('id')))));
  app.post('/refunds/:id/complete', requirePermission('refunds.process'), async (c) => {
    const b = await jsonBody(c, z.object({ providerReference: z.string().max(120).nullish() }));
    return c.json(await completeRefund(db, uuid.parse(c.req.param('id')), { providerReference: b.providerReference ?? null, processedBy: actorId(c) }));
  });
  app.post('/refunds/:id/fail', requirePermission('refunds.process'), async (c) => c.json(await failRefund(db, uuid.parse(c.req.param('id')))));
  app.post('/refunds/:id/reject', requirePermission('refunds.approve'), async (c) => c.json(await rejectRefund(db, uuid.parse(c.req.param('id')))));

  // Payouts: create, then a different person above the threshold starts the transfer.
  const payouts = requirePermission('payouts.manage');
  app.post('/payouts', payouts, async (c) => {
    const b = await jsonBody(c, z.object({ sellerId: uuid }));
    const r = await createPayout(db, b.sellerId, { createdBy: actorId(c) });
    return c.json(r, r.created ? 201 : 200);
  });
  app.post('/payouts/:id/start', payouts, async (c) => c.json(await startPayout(db, uuid.parse(c.req.param('id')), actorId(c), dual)));
  app.post('/payouts/:id/paid', payouts, async (c) => {
    const b = await jsonBody(c, z.object({ bankReference: z.string().min(1).max(120) }));
    return c.json(await markPayoutPaid(db, uuid.parse(c.req.param('id')), { bankReference: b.bankReference, actorId: actorId(c) }));
  });
  app.post('/payouts/:id/failed', payouts, async (c) => {
    const b = await jsonBody(c, z.object({ reason: z.string().min(1).max(500) }));
    return c.json(await markPayoutFailed(db, uuid.parse(c.req.param('id')), { reason: b.reason, actorId: actorId(c) }));
  });
  app.post('/payouts/:id/retry', payouts, async (c) => c.json(await retryPayout(db, uuid.parse(c.req.param('id')), actorId(c))));
  app.post('/payouts/:id/cancel', payouts, async (c) => c.json(await cancelPayout(db, uuid.parse(c.req.param('id')), actorId(c))));

  return app;
}
