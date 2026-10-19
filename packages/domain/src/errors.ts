export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidOrderError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_order', message, details);
  }
}
export class VariantUnavailableError extends DomainError {
  constructor(variantId: string, reason: string) {
    super('variant_unavailable', `Variant ${variantId} cannot be purchased: ${reason}`, { variantId, reason });
  }
}
export class OutOfStockError extends DomainError {
  constructor(variantId: string, requested: number, available: number) {
    super('out_of_stock', `Not enough stock for variant ${variantId}`, { variantId, requested, available });
  }
}
export class PaymentNotFoundError extends DomainError {
  constructor(paymentId: string) {
    super('payment_not_found', `Payment ${paymentId} not found`, { paymentId });
  }
}
export class PaymentAmountMismatchError extends DomainError {
  constructor(paymentId: string) {
    super('payment_amount_mismatch', 'Payment amount or currency does not match the order', { paymentId });
  }
}
export class PaymentNotPayableError extends DomainError {
  constructor(paymentId: string, status: string) {
    super('payment_not_payable', `Payment ${paymentId} is ${status} and cannot be confirmed`, { paymentId, status });
  }
}
/** Money arrived for an order that is no longer awaiting payment (cancelled/expired). Needs manual handling. */
export class OrderNotAwaitingPaymentError extends DomainError {
  constructor(orderId: string) {
    super('order_not_awaiting_payment', `Order ${orderId} is not awaiting payment`, { orderId });
  }
}
export class OrderAlreadyPaidError extends DomainError {
  constructor(orderId: string) {
    super('order_already_paid', `Order ${orderId} already has a succeeded payment`, { orderId });
  }
}

export class InvalidRefundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_refund', message, details);
  }
}
export class RefundNotFoundError extends DomainError {
  constructor(refundId: string) {
    super('refund_not_found', `Refund ${refundId} not found`, { refundId });
  }
}
/** The refund is not in the status this step needs (e.g. completing a refund that is not processing). */
export class RefundStateError extends DomainError {
  constructor(refundId: string, expected: string, actual: string) {
    super('refund_state', `Refund ${refundId} is ${actual}, expected ${expected}`, { refundId, expected, actual });
  }
}
export class RefundCapacityExceededError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('refund_capacity_exceeded', message, details);
  }
}
/** The refund's payment is not the order's succeeded payment, or its amount/currency differ from the order's. */
export class RefundPaymentError extends DomainError {
  constructor(refundId: string, reason: string) {
    super('refund_payment', `Refund ${refundId}: ${reason}`, { refundId, reason });
  }
}

export class SellerOrderNotFoundError extends DomainError {
  constructor(sellerOrderId: string) {
    super('seller_order_not_found', `Seller order ${sellerOrderId} not found`, { sellerOrderId });
  }
}
export class SellerOrderStateError extends DomainError {
  constructor(sellerOrderId: string, expected: string, actual: string) {
    super('seller_order_state', `Seller order ${sellerOrderId} is ${actual}, expected ${expected}`, { sellerOrderId, expected, actual });
  }
}
export class DeliveryNotVerifiableError extends DomainError {
  constructor(sellerOrderId: string, reason: string) {
    super('delivery_not_verifiable', `Seller order ${sellerOrderId}: ${reason}`, { sellerOrderId, reason });
  }
}
export class PayoutNotFoundError extends DomainError {
  constructor(payoutId: string) {
    super('payout_not_found', `Payout ${payoutId} not found`, { payoutId });
  }
}
export class PayoutStateError extends DomainError {
  constructor(payoutId: string, expected: string, actual: string) {
    super('payout_state', `Payout ${payoutId} is ${actual}, expected ${expected}`, { payoutId, expected, actual });
  }
}
export class NoPayoutAccountError extends DomainError {
  constructor(sellerId: string) {
    super('no_payout_account', `Seller ${sellerId} has no active default payout account`, { sellerId });
  }
}

/** A payout in `processing` may already have reached the seller's bank, so its entries must stay claimed. */
export class PayoutOutcomeUnknownError extends DomainError {
  constructor(payoutId: string) {
    super(
      'payout_outcome_unknown',
      `Payout ${payoutId} is processing: the transfer may already have been sent. Confirm with the bank first: if it arrived, markPayoutPaid; if it did NOT, markPayoutFailed, and only then cancelPayout.`,
      { payoutId },
    );
  }
}

export class ShipmentNotFoundError extends DomainError {
  constructor(what: string) {
    super('shipment_not_found', `Shipment not found: ${what}`, { what });
  }
}
export class ShipmentNotAllowedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('shipment_not_allowed', message, details);
  }
}

export class InvalidShipmentError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_shipment', message, details);
  }
}
export class OpenPaymentExistsError extends DomainError {
  constructor(orderId: string) {
    super('open_payment_exists', `Order ${orderId} already has a payment in progress`, { orderId });
  }
}

/** Two-person rule: the person who created a refund/payout may not also approve/start it above the threshold. */
export class SeparationOfDutiesError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('separation_of_duties', message, details);
  }
}
