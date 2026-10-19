// Money helpers. Amounts are integer minor units (LKR cents).
// Intermediate products use BigInt: 2 * cumulativeItems * commission can
// exceed Number.MAX_SAFE_INTEGER for large orders.

/**
 * Cumulative commission returned for a seller order once `cumulativeItemRefunded`
 * cents of merchandise have been refunded (round half up).
 *
 *   returned_total(c) = floor((2*c*commission + subtotal) / (2*subtotal))
 *
 * subtotal = 0 returns 0 (no division), but only for zero refunded and zero commission;
 * any other input with a zero subtotal throws. A full item refund (c = subtotal)
 * returns exactly `commission`.
 */
export function returnedCommissionTotal(
  cumulativeItemRefunded: number,
  commissionCents: number,
  subtotalCents: number
): number {
  for (const [name, v] of [
    ["cumulativeItemRefunded", cumulativeItemRefunded],
    ["commissionCents", commissionCents],
    ["subtotalCents", subtotalCents],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  // Validate first, then short-circuit: a zero subtotal only admits zero
  // refunded and zero commission (the range checks below enforce that).
  if (cumulativeItemRefunded > subtotalCents) {
    throw new RangeError(
      "cumulative refunded item amount must be between 0 and the subtotal"
    )
  }
  if (commissionCents > subtotalCents) {
    throw new RangeError("commission must be between 0 and the subtotal")
  }
  if (subtotalCents === 0) return 0
  const c = BigInt(cumulativeItemRefunded)
  const com = BigInt(commissionCents)
  const sub = BigInt(subtotalCents)
  return Number((2n * c * com + sub) / (2n * sub))
}

/**
 * Commission returned by ONE refund allocation, computed at success time from
 * SUCCEEDED allocations only:
 *   returned_total(c_after) - SUM(commission_returned of earlier succeeded allocations)
 */
export function commissionReturnedForAllocation(args: {
  priorItemRefunded: number // cumulative succeeded item refunds BEFORE this allocation
  priorCommissionReturned: number // SUM(commission_returned) of those earlier allocations
  itemAmount: number // this allocation's item part
  commissionCents: number
  subtotalCents: number
}): number {
  const after = returnedCommissionTotal(
    args.priorItemRefunded + args.itemAmount,
    args.commissionCents,
    args.subtotalCents
  )
  return after - args.priorCommissionReturned
}

/**
 * Amount of the seller-ledger entry for a refund allocation (a debit, so
 * negative). Returns 0 when there is nothing to post (delivery-only refund,
 * or 100% commission): the caller must then skip the ledger row.
 */
export function refundLedgerAmount(
  itemAmount: number,
  commissionReturned: number
): number {
  const merchandise = itemAmount - commissionReturned
  return merchandise === 0 ? 0 : -merchandise
}
