# @workspace/domain

Server-side use cases that call `@workspace/db`. The database constraints stop invalid
rows; these functions are what make the workflows safe.

- `placeOrder` – checkout: validate, lock stock rows (id order), atomic reserve, write order → seller orders → items + pending payment (one transaction)
- `confirmPayment` – guarded payment success: amount/currency check, order → processing, reservations → sales
- `cancelUnpaidOrder` / `expireOverdueOrders` – guarded cancel, releases stock exactly once

Lock order everywhere: order row → payment → inventory rows (by id).

## Tests (need a real PostgreSQL)
    DATABASE_URL_TEST=postgres://user@host:5432/postgres bun test
Each test file creates and drops its own database. Server-only: never import from client components.

## Refunds (`src/refunds.ts`)
`requestRefund` → `approveRefund` (A: reserve capacity under locks) → `startRefundProcessing` (B: guarded; only if `started`
may you send ONE external refund keyed by the refund id) → `completeRefund` (C) | `failRefund` (D, only when the gateway/bank
confirms no money moved). `rejectRefund` drops a refund that was never sent. `reserveRefund` = request + approve.
`reconcileRefunds(db)` returns invariant violations; run it as a scheduled job (pass `stuckProcessingMinutes` to flag stuck refunds).

## Ledger policy: refunds around delivery
The seller ledger only ever contains entries for DELIVERED seller orders (plus manual adjustments).
- `verifyDelivery` (shipped -> delivered, guarded) posts `sale` (+subtotal) and `commission` (-commission) once, and in the same
  transaction posts the refund debits of refunds that already succeeded before delivery (the catch-up).
- `completeRefund` posts its debit immediately only if the seller order is already delivered; otherwise it posts nothing
  (the commission share is still computed and stored on the allocation, so the catch-up uses it).
- A seller order that is refunded and/or cancelled and never delivered never touches the ledger: the seller earned nothing and owes nothing.
- Both paths lock order row -> seller order first, so a refund racing delivery verification posts the debit exactly once, whichever wins.
- `cancelSellerOrder` (processing -> cancelled, guarded) restocks and re-derives the order status; money back is a separate refund.
- Payouts therefore never see a debit without its sale. `reconcileRefunds` flags violations of this policy.

## Payouts (`src/payouts.ts`)
`createPayout` (claim all unclaimed entries of one seller; net <= 0 creates nothing and carries forward) -> `startPayout` ->
`markPayoutPaid` | `markPayoutFailed` -> `retryPayout` (same payout) | `cancelPayout` (releases its items). Paid is terminal.

**Recovery rule for an uncertain transfer.** `processing` is written BEFORE the bank transfer, so it means *may already have been sent*.
While a payout is `processing` its entries stay claimed and `cancelPayout` refuses (`PayoutOutcomeUnknownError`): releasing them could let a
later payout pay the seller twice. Ask the bank first. Transfer arrived -> `markPayoutPaid` (entries stay claimed forever). Transfer did
NOT happen (confirmed) -> `markPayoutFailed`, then either `retryPayout` (default, same payout) or `cancelPayout` (releases the entries).
Never call `markPayoutFailed` on a timeout alone. Cancel is allowed only from `pending` (nothing sent) or `failed` (confirmed not sent).
`reconcilePayouts` checks amount = sum of entries, seller ownership and released items. Every transition writes an audit row.

## Money bounds
`requestRefund` validates every line total and the header total as safe integers before inserting, and `approveRefund` guards the allocation
sum and every held total it adds. `placeOrder` rejects quantities outside 1..2,147,483,647 (the `integer` column) and any line total, subtotal, delivery fee or
total that is not a safe integer, before touching stock.

## Server-only boundary (enforced)
`@workspace/domain` and `@workspace/db/client` start with `import 'server-only'`: a client component that imports them fails the
Next.js build. `test/server-only.test.ts` proves the real package throws outside the server condition. Import only
`@workspace/db` / `/schema` / `/money` in browser code. In Next.js add both packages to `transpilePackages`.

## Shipping and payment attempts
`recordShipment` (seller hands over a parcel; guarded processing|partially_shipped -> shipped|partially_shipped; pickup location must belong to the seller),
`applyCourierEvent` (idempotent; the shipment follows the newest event by time; delivered/cancelled are final; never touches the ledger),
`recordPaymentFailure`, `createPaymentAttempt` (only while the order awaits payment and has no open attempt).

## Separation of duties
`requestRefund({ requestedBy })` writes a `refund.requested` audit row. `approveRefund(db, id, { approvedBy, dualControlThresholdCents })` refuses
(`SeparationOfDutiesError`) when the refund is at or above the threshold and the approver is the requester (or the approver, or the original requester, is unknown); it writes `refund.approved`.
`startPayout(db, id, actorId, { dualControlThresholdCents })` refuses when the payout is at or above the threshold and `actorId` created it.
Omit the threshold to disable the rule; `0` means always two people.
