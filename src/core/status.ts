/**
 * A gateway-independent payment status. Every gateway's own status values are mapped onto these.
 */
export type PaymentStatus =
  'successful' | 'pending' | 'failed' | 'cancelled' | 'expired' | 'unknown';

/**
 * The payment statuses, plus helpers.
 *
 * ```ts
 * if (callback.status === PaymentStatus.Successful) { ... }
 * PaymentStatus.isFinal(result.status)
 * ```
 */
export const PaymentStatus = Object.freeze({
  /** The customer paid. The only status that means money was collected. */
  Successful: 'successful',
  /** The payment is still in progress or waiting on the customer. */
  Pending: 'pending',
  /** The payment was attempted and failed or was rejected. */
  Failed: 'failed',
  /** The payment or order was canceled or closed before completing. */
  Cancelled: 'cancelled',
  /** The payment window ran out before the customer paid. */
  Expired: 'expired',
  /** The gateway sent a status this package does not recognize. Inspect `gatewayStatus`. */
  Unknown: 'unknown',
  /** Every status, in the order above. */
  values: Object.freeze([
    'successful',
    'pending',
    'failed',
    'cancelled',
    'expired',
    'unknown',
  ] as const),
  /** Whether the status will not change any more: `false` for `pending` and `unknown`. */
  isFinal(status: PaymentStatus): boolean {
    return status !== 'pending' && status !== 'unknown';
  },
});

/**
 * Maps a gateway status onto a {@link PaymentStatus}, trimming whitespace. Statuses missing from
 * the map resolve to `unknown`.
 */
export function resolveStatus(
  statuses: Readonly<Record<string, PaymentStatus>>,
  gatewayStatus: string | null | undefined,
): PaymentStatus {
  const key = (gatewayStatus ?? '').trim();
  return Object.prototype.hasOwnProperty.call(statuses, key)
    ? (statuses[key] as PaymentStatus)
    : 'unknown';
}

/**
 * How the customer completes a payment after it has been initiated.
 */
export type PaymentFlow = 'redirect' | 'form' | 'qr' | 'app';

/** The payment flows. */
export const PaymentFlow = Object.freeze({
  /** Send the customer's browser to a gateway-hosted URL. */
  Redirect: 'redirect',
  /** POST a signed form from the customer's browser to the gateway. */
  Form: 'form',
  /** Show a QR code the customer scans with their wallet app. */
  Qr: 'qr',
  /** Hand a signed payload to your mobile app, which opens the wallet SDK. */
  App: 'app',
} as const);
