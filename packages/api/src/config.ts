/** Public project: customers and sellers. Knows how to build PayHere checkout fields, nothing about staff or machines. */
export interface PublicConfig {
  payhere: { merchantId: string; merchantSecret: string; sandbox: boolean };
  /** Public origin used for PayHere return/cancel/notify URLs, e.g. https://example.com */
  publicBaseUrl: string;
  /** Origins allowed to make state-changing browser requests (CSRF guard). Required and non-empty; loaders set it to [publicBaseUrl]. */
  trustedOrigins: string[];
}
/** Admin project: staff only. */
export interface AdminConfig {
  /** Refuse staff sessions without a second factor. Keep true outside dev/tests. */
  requireMfa: boolean;
  /**
   * Two-person rule: refunds and payouts of at least this many cents need a second person
   * (approver != requester, starter != creator). 0 = always two people. Default LKR 50,000.
   */
  dualControlThresholdCents: number;
  /** Origins allowed to make state-changing browser requests (CSRF guard). Required and non-empty; the loader sets it to [ADMIN_BASE_URL]. */
  trustedOrigins: string[];
}
/** Machine project: PayHere/courier webhooks and cron. No user sessions. */
export interface MachineConfig {
  payhere: { merchantId: string; merchantSecret: string };
  /** Shared secret for signing courier webhooks (see courier.ts: adapt to the real PromptXpress API). */
  courierWebhookSecret: string;
  /** Bearer token Vercel Cron sends (CRON_SECRET). */
  cronSecret: string;
  /**
   * Users.id of the system actor that scheduled payout runs act as (see `ensureSystemActor`, `bun run create-system-actor`).
   * Optional: without it GET /cron/payout-run answers 503 and creates nothing.
   */
  systemActorId?: string;
  /** Verify delivery automatically when the courier reports every parcel delivered (else staff do it). */
  autoVerifyDelivery: boolean;
}
/**
 * Everything, for the combined dev/test app. The two CSRF origin lists are kept apart (a spread would let one overwrite
 * the other): createApp hands `publicTrustedOrigins` to the public app and `adminTrustedOrigins` to the admin app.
 */
export type ApiConfig = Omit<PublicConfig, 'trustedOrigins'> &
  Omit<AdminConfig, 'trustedOrigins'> &
  MachineConfig & { publicTrustedOrigins: string[]; adminTrustedOrigins: string[] };

type Env = Record<string, string | undefined>;
const need = (env: Env, k: string) => {
  const v = env[k];
  if (!v) throw new Error(`missing environment variable ${k}`);
  return v;
};

export const DEFAULT_DUAL_CONTROL_THRESHOLD_CENTS = 5_000_000;

export function loadPublicConfig(env: Env = process.env): PublicConfig {
  return {
    payhere: { merchantId: need(env, 'PAYHERE_MERCHANT_ID'), merchantSecret: need(env, 'PAYHERE_MERCHANT_SECRET'), sandbox: env.PAYHERE_SANDBOX !== 'false' },
    publicBaseUrl: need(env, 'PUBLIC_BASE_URL').replace(/\/$/, ''),
    trustedOrigins: [need(env, 'PUBLIC_BASE_URL').replace(/\/$/, '')],
  };
}
export function loadAdminConfig(env: Env = process.env): AdminConfig {
  const raw = env.DUAL_CONTROL_THRESHOLD_CENTS;
  const threshold = raw === undefined || raw === '' ? DEFAULT_DUAL_CONTROL_THRESHOLD_CENTS : Number(raw);
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error('DUAL_CONTROL_THRESHOLD_CENTS must be a non-negative integer');
  return {
    requireMfa: env.REQUIRE_MFA !== 'false',
    dualControlThresholdCents: threshold,
    trustedOrigins: [need(env, 'ADMIN_BASE_URL').replace(/\/$/, '')],
  };
}
export function loadMachineConfig(env: Env = process.env): MachineConfig {
  return {
    payhere: { merchantId: need(env, 'PAYHERE_MERCHANT_ID'), merchantSecret: need(env, 'PAYHERE_MERCHANT_SECRET') },
    courierWebhookSecret: need(env, 'COURIER_WEBHOOK_SECRET'),
    cronSecret: need(env, 'CRON_SECRET'),
    systemActorId: env.SYSTEM_ACTOR_ID || undefined,
    autoVerifyDelivery: env.AUTO_VERIFY_DELIVERY === 'true',
  };
}
export function loadConfig(env: Env = process.env): ApiConfig {
  const { trustedOrigins: publicTrustedOrigins, ...pub } = loadPublicConfig(env);
  const { trustedOrigins: adminTrustedOrigins, ...admin } = loadAdminConfig(env);
  return { ...pub, ...admin, ...loadMachineConfig(env), payhere: pub.payhere, publicTrustedOrigins, adminTrustedOrigins };
}
