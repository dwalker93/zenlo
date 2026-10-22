import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { payments } from '@workspace/db/schema';
import {
  DeliveryNotVerifiableError,
  SellerOrderStateError,
  applyCourierEvent,
  audit,
  confirmPayment,
  expireOverdueOrders,
  reconcilePayouts,
  reconcileRefunds,
  runScheduledPayouts,
  recordPaymentFailure,
  verifyDelivery,
  type Db,
} from '@workspace/domain';
import type { Env } from './auth';
import { hmacJsonAdapter, type CourierAdapter } from './courier';
import type { MachineConfig, MachineConfigSource } from './config';
import { HttpError, onError } from './http';
import { parseAmountToCents, verifyNotifySignature, type NotifyFields } from './payhere';
import { bearerMatches, uuid } from './shared';

export interface MachineAppDeps {
  db: Db;
  /**
   * The config, or a function that loads it (pass `loadMachineConfig`, not `loadMachineConfig()`). A function runs on the
   * first machine request and again on each later one until it succeeds; only a success is cached, so a missing secret
   * answers 503 on machine routes only, and fixing the env var recovers without a restart.
   */
  config: MachineConfigSource;
  courier?: CourierAdapter;
}

/** Webhooks (PayHere, courier) and cron. Authenticated by signatures / bearer secrets; there are no user sessions here. */
export function createMachineApp(deps: MachineAppDeps) {
  const { db } = deps;
  let loaded: MachineConfig | undefined;
  const getConfig = (): MachineConfig => {
    if (loaded) return loaded;
    try {
      return (loaded = typeof deps.config === 'function' ? deps.config() : deps.config);
    } catch (e) {
      console.error('machine config unavailable', e); // the variable name stays in the log, not in the response
      throw new HttpError(503, 'not_configured', 'Machine endpoints are not configured');
    }
  };
  let defaultCourier: CourierAdapter | undefined;
  const getCourier = (config: MachineConfig) => deps.courier ?? (defaultCourier ??= hmacJsonAdapter(config.courierWebhookSecret));
  const app = new Hono<Env>();
  app.onError(onError);
  app.get('/health', (c) => c.json({ ok: true })); // needs no config

  // ---------- PayHere notification ----------
  app.post('/webhooks/payhere', async (c) => {
    const config = getConfig();
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const f: NotifyFields = {
      merchant_id: str('merchant_id'), order_id: str('order_id'), payment_id: str('payment_id'), payhere_amount: str('payhere_amount'),
      payhere_currency: str('payhere_currency'), status_code: str('status_code'), md5sig: str('md5sig'), method: str('method'), status_message: str('status_message'),
    };
    // 1. authenticity: our merchant id and a valid signature. Only this case is rejected.
    if (f.merchant_id !== config.payhere.merchantId || !verifyNotifySignature(f, config.payhere.merchantSecret)) {
      throw new HttpError(403, 'bad_signature', 'Invalid notification');
    }
    // From here the notification is GENUINE. Anything we cannot apply automatically is written to the audit
    // log for a human and answered 200, so PayHere does not retry a money question forever.
    if (!uuid.safeParse(f.order_id).success) {
      console.warn('payhere notify: order_id is not ours', f.order_id);
      return c.json({ status: 'ignored' });
    }
    const [p] = await db.select().from(payments).where(eq(payments.id, f.order_id));
    if (!p || p.method !== 'payhere') {
      await audit(db, { action: 'payment.payhere_unknown_payment', entityType: 'payment', entityId: f.order_id, metadata: { status_code: f.status_code, payhere_payment_id: f.payment_id } });
      return c.json({ status: 'needs_manual_review' });
    }
    // The amount and currency PayHere says it took must equal what we asked for.
    const cents = parseAmountToCents(f.payhere_amount);
    if (f.status_code === '2' && (cents !== p.amountCents || f.payhere_currency !== p.currency)) {
      await audit(db, { action: 'payment.payhere_amount_mismatch', entityType: 'payment', entityId: p.id, metadata: { amount: f.payhere_amount, currency: f.payhere_currency, expectedCents: p.amountCents } });
      return c.json({ status: 'needs_manual_review' });
    }
    const safeMeta = { payhere_payment_id: f.payment_id, status_code: f.status_code, status_message: f.status_message, method: f.method, amount: f.payhere_amount, currency: f.payhere_currency }; // never card data
    switch (f.status_code) {
      case '2': {
        try {
          const r = await confirmPayment(db, { paymentId: p.id, providerReference: f.payment_id || null, gatewayPayload: safeMeta });
          return c.json({ status: r.alreadyConfirmed ? 'already_confirmed' : 'confirmed' });
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'order_not_awaiting_payment' || code === 'payment_not_payable' || code === 'order_already_paid') {
            // Money arrived for an order that was cancelled/expired or already paid: acknowledge (stop retries) and flag for a human refund.
            await audit(db, { action: 'payment.needs_manual_review', entityType: 'payment', entityId: p.id, metadata: { ...safeMeta, reason: code } });
            return c.json({ status: 'needs_manual_review' });
          }
          throw e;
        }
      }
      case '-1':
      case '-2':
        await recordPaymentFailure(db, p.id, f.status_code === '-1' ? 'cancelled' : 'failed');
        return c.json({ status: 'recorded' });
      case '-3':
        await audit(db, { action: 'payment.chargeback', entityType: 'payment', entityId: p.id, metadata: safeMeta });
        return c.json({ status: 'chargeback_flagged' });
      default: // 0 = pending: nothing to do yet
        return c.json({ status: 'ignored' });
    }
  });

  // ---------- courier webhook ----------
  app.post('/webhooks/courier', async (c) => {
    const config = getConfig();
    const ev = getCourier(config).parse(await c.req.text(), c.req.raw.headers);
    const r = await applyCourierEvent(db, ev);
    if (r.matched && r.applied && ev.status === 'delivered' && config.autoVerifyDelivery) {
      try {
        await verifyDelivery(db, r.sellerOrderId);
      } catch (e) {
        // Expected, not an error: other parcels are still on the way (DeliveryNotVerifiableError), or the seller has
        // not marked the last parcel yet (partially_shipped). The event is already stored, so answer 200 and let
        // staff or the last parcel's event verify later. Any OTHER state error is a real concurrent change: let it through.
        const partial = e instanceof SellerOrderStateError && e.details?.actual === 'partially_shipped';
        if (!(e instanceof DeliveryNotVerifiableError) && !partial) throw e;
      }
    }
    return c.json({ matched: r.matched, applied: r.matched ? r.applied : false });
  });

  // ---------- scheduled jobs (Vercel Cron sends GET with Authorization: Bearer $CRON_SECRET) ----------
  const cron = new Hono<Env>();
  cron.use('*', async (c, next) => {
    const config = getConfig();
    if (!bearerMatches(c.req.header('authorization'), config.cronSecret)) throw new HttpError(401, 'unauthenticated', 'Invalid cron secret');
    await next();
  });
  cron.get('/expire-orders', async (c) => c.json(await expireOverdueOrders(db, { limit: 500 })));
  cron.get('/reconcile', async (c) => {
    const violations = [...(await reconcileRefunds(db, { stuckProcessingMinutes: 60 })), ...(await reconcilePayouts(db))];
    if (violations.length > 0) console.error('reconciliation violations', violations);
    return c.json({ ok: violations.length === 0, violations }, violations.length === 0 ? 200 : 500); // non-2xx so cron alerting fires
  });
  // Creates PENDING payouts only (createdBy = the system actor); a person with payouts.manage still starts each transfer.
  cron.get('/payout-run', async (c) => {
    const config = getConfig();
    const systemActorId = config.systemActorId;
    if (!systemActorId) throw new HttpError(503, 'not_configured', 'SYSTEM_ACTOR_ID is not set; no payouts were created');
    // One audit row per run, whatever happens: the heartbeat a monitor watches (see the README, "Scheduled payouts").
    // A failed audit write is logged and never hides the run's own outcome; a missing row trips the "no completed run" alert.
    const beat = (action: 'payout_run.completed' | 'payout_run.failed', metadata: Record<string, unknown>) =>
      audit(db, { actorId: systemActorId, action, entityType: 'system_job', entityId: systemActorId, metadata }).catch((e) =>
        console.error('could not write payout run audit row', e),
      );
    let run: Awaited<ReturnType<typeof runScheduledPayouts>>;
    try {
      run = await runScheduledPayouts(db, { systemActorId });
    } catch (e) {
      await beat('payout_run.failed', { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
      throw e; // still a 500 through onError, so cron alerting fires too
    }
    if (run.failed.length > 0) console.error('payout run failures', run.failed);
    await beat(run.failed.length === 0 ? 'payout_run.completed' : 'payout_run.failed', {
      created: run.created.length, skipped: run.skipped.length, failed: run.failed, more: run.more,
    });
    return c.json({ ok: run.failed.length === 0, ...run }, run.failed.length === 0 ? 200 : 500); // non-2xx so cron alerting fires
  });
  app.route('/cron', cron);

  return app;
}
