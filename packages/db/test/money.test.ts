import { describe, expect, test } from 'bun:test';
import {
  commissionReturnedForAllocation,
  refundLedgerAmount,
  returnedCommissionTotal,
} from '../src/money';

// Small deterministic PRNG so the property tests are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Replay a sequence of succeeded item refunds and return each allocation's commission return. */
function replay(parts: number[], commission: number, subtotal: number) {
  let prior = 0;
  let priorCommission = 0;
  return parts.map((item) => {
    const returned = commissionReturnedForAllocation({
      priorItemRefunded: prior,
      priorCommissionReturned: priorCommission,
      itemAmount: item,
      commissionCents: commission,
      subtotalCents: subtotal,
    });
    prior += item;
    priorCommission += returned;
    return returned;
  });
}

describe('returnedCommissionTotal', () => {
  test('the review example: commission 1 on subtotal 3, three 1-cent refunds -> 0, 1, 0', () => {
    expect(replay([1, 1, 1], 1, 3)).toEqual([0, 1, 0]);
  });

  test('a full item refund returns exactly the full commission', () => {
    expect(returnedCommissionTotal(450000, 45000, 450000)).toBe(45000);
    expect(returnedCommissionTotal(3, 1, 3)).toBe(1);
  });

  test('nothing refunded returns nothing', () => {
    expect(returnedCommissionTotal(0, 45000, 450000)).toBe(0);
  });

  test('zero subtotal returns 0 without dividing', () => {
    expect(returnedCommissionTotal(0, 0, 0)).toBe(0);
  });

  test('zero subtotal rejects nonzero refunded amount or commission', () => {
    expect(() => returnedCommissionTotal(1, 0, 0)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(0, 1, 0)).toThrow(RangeError);
  });

  test('rejects negative, fractional and unsafe inputs', () => {
    expect(() => returnedCommissionTotal(-1, 0, 0)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(0, 0, -5)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(1.5, 1, 100)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(0, 0, Number.NaN)).toThrow(RangeError);
  });

  test('rounds half up', () => {
    // 1 of 2 cents refunded, commission 1 -> exactly half -> rounds up to 1
    expect(returnedCommissionTotal(1, 1, 2)).toBe(1);
  });

  test('stays exact for amounts whose product exceeds Number.MAX_SAFE_INTEGER', () => {
    const subtotal = 9_000_000_000_000; // 90 billion LKR in cents
    const commission = 900_000_000_000;
    expect(returnedCommissionTotal(subtotal, commission, subtotal)).toBe(commission);
    expect(returnedCommissionTotal(subtotal / 2, commission, subtotal)).toBe(commission / 2);
  });

  test('rejects impossible inputs', () => {
    expect(() => returnedCommissionTotal(5, 1, 3)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(1, 4, 3)).toThrow(RangeError);
    expect(() => returnedCommissionTotal(-1, 1, 3)).toThrow(RangeError);
  });

  test('property: any split of a full item refund returns exactly the commission, never negative, never above its own item amount', () => {
    const rand = rng(42);
    for (let run = 0; run < 5000; run++) {
      const subtotal = 1 + Math.floor(rand() * 100_000);
      const commission = Math.floor(rand() * (subtotal + 1));
      const parts: number[] = [];
      let remaining = subtotal;
      while (remaining > 0) {
        const part = Math.min(remaining, 1 + Math.floor(rand() * remaining));
        parts.push(part);
        remaining -= part;
      }
      const returned = replay(parts, commission, subtotal);
      returned.forEach((r, i) => {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(parts[i]);
      });
      expect(returned.reduce((a, b) => a + b, 0)).toBe(commission);
    }
  });

  test('property: a refund that fails between two that succeed leaves no drift (computed at success time)', () => {
    const rand = rng(7);
    for (let run = 0; run < 2000; run++) {
      const subtotal = 3 + Math.floor(rand() * 50_000);
      const commission = Math.floor(rand() * (subtotal + 1));
      const a = 1 + Math.floor(rand() * (subtotal - 2));
      const b = 1 + Math.floor(rand() * (subtotal - a - 1)); // reserved then FAILS: never counted
      const c = subtotal - a; // the rest
      expect(b).toBeGreaterThan(0);
      // only a and c ever succeed
      const returned = replay([a, c], commission, subtotal);
      expect(returned.reduce((x, y) => x + y, 0)).toBe(commission);
    }
  });
});

describe('refundLedgerAmount', () => {
  test('is the negative of merchandise minus returned commission', () => {
    expect(refundLedgerAmount(450000, 45000)).toBe(-405000);
  });
  test('is 0 (post nothing) for a delivery-only refund', () => {
    expect(refundLedgerAmount(0, 0)).toBe(0);
  });
  test('is 0 (post nothing) when 100% commission is returned', () => {
    expect(refundLedgerAmount(1000, 1000)).toBe(0);
  });
});
