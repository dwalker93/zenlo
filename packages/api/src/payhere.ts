import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PayHere (payhere.lk) helpers. Formulas from https://support.payhere.lk/api-&-mobile-sdk/checkout-api
 *   checkout hash = UPPER(md5(merchant_id + order_id + amount + currency + UPPER(md5(merchant_secret))))
 *   md5sig (notify) = UPPER(md5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(md5(merchant_secret))))
 * amount is "1000.00" (two decimals, dot). We use the payment id as PayHere's order_id.
 */
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const secretHash = (secret: string) => md5(secret).toUpperCase();

/** 123456 cents -> "1234.56" using integer maths only. */
export function formatAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('cents must be a non-negative safe integer');
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** "1234.56" -> 123456. Strict: digits with an optional 1-2 digit fraction, nothing else. */
export function parseAmountToCents(s: string): number | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

export function checkoutHash(p: { merchantId: string; orderId: string; amountCents: number; currency: string; merchantSecret: string }) {
  return md5(`${p.merchantId}${p.orderId}${formatAmount(p.amountCents)}${p.currency}${secretHash(p.merchantSecret)}`).toUpperCase();
}

/** PayHere requires these on every checkout form. */
export interface CheckoutCustomer { fullName: string; email: string; phone: string; address: string; city: string; country?: string }

/** PayHere wants first and last name; a single name goes in both so neither is empty. */
export function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '-', lastName: parts[0] ?? '-' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export function checkoutFields(p: {
  merchantId: string; merchantSecret: string; paymentId: string; amountCents: number; currency: string; itemsLabel: string;
  returnUrl: string; cancelUrl: string; notifyUrl: string; sandbox: boolean;
  customer: CheckoutCustomer;
}) {
  const { firstName, lastName } = splitName(p.customer.fullName);
  return {
    action: p.sandbox ? 'https://sandbox.payhere.lk/pay/checkout' : 'https://www.payhere.lk/pay/checkout',
    fields: {
      merchant_id: p.merchantId,
      return_url: p.returnUrl,
      cancel_url: p.cancelUrl,
      notify_url: p.notifyUrl,
      order_id: p.paymentId,
      items: p.itemsLabel,
      currency: p.currency,
      amount: formatAmount(p.amountCents),
      first_name: firstName,
      last_name: lastName,
      email: p.customer.email,
      phone: p.customer.phone,
      address: p.customer.address,
      city: p.customer.city,
      country: p.customer.country ?? 'Sri Lanka',
      hash: checkoutHash({ merchantId: p.merchantId, orderId: p.paymentId, amountCents: p.amountCents, currency: p.currency, merchantSecret: p.merchantSecret }),
    },
  };
}

export interface NotifyFields {
  merchant_id: string; order_id: string; payment_id?: string; payhere_amount: string; payhere_currency: string;
  status_code: string; md5sig: string; method?: string; status_message?: string;
}

/** Constant-time check of the notification signature. */
export function verifyNotifySignature(f: NotifyFields, merchantSecret: string): boolean {
  const expected = md5(`${f.merchant_id}${f.order_id}${f.payhere_amount}${f.payhere_currency}${f.status_code}${secretHash(merchantSecret)}`).toUpperCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(String(f.md5sig).toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}
