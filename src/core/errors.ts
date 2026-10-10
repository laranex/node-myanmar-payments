/**
 * Base class of every error thrown by this package.
 */
export class PaymentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown when payment data has values the gateway would reject. Thrown before any request is sent.
 */
export class InvalidPaymentDataError extends PaymentError {
  /** Field name to error message, e.g. `{ amount: 'The amount field is required.' }`. */
  readonly errors: Readonly<Record<string, string>>;

  constructor(errors: Record<string, string>) {
    const messages = Object.keys(errors)
      .sort()
      .map((field) => errors[field]);
    super(`Invalid payment data: ${messages.join(' ')}`);
    this.errors = Object.freeze({ ...errors });
  }
}

/**
 * Thrown when a gateway rejects a request or answers with an error, including errors sent with
 * HTTP 200, or when it cannot be reached (the network error is the `cause`).
 */
export class ApiError extends PaymentError {
  /** The gateway's own error code, e.g. `ORDER_ID_USED` or `09`. */
  readonly gatewayCode: string | undefined;
  /** The gateway's own error message. */
  readonly gatewayMessage: string | undefined;
  /** The HTTP status of the response, or `0` when no response was received. */
  readonly httpStatus: number;
  /** The decoded response body. */
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    details: {
      gatewayCode?: string | undefined;
      gatewayMessage?: string | undefined;
      httpStatus?: number;
      raw?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.gatewayCode = details.gatewayCode;
    this.gatewayMessage = details.gatewayMessage;
    this.httpStatus = details.httpStatus ?? 0;
    this.raw = details.raw ?? {};
  }
}

/**
 * Thrown when a callback, return redirect or gateway response fails signature verification.
 * Never act on its payload.
 */
export class SignatureVerificationError extends PaymentError {
  /** The unverified payload, for logging only. */
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(message: string, raw: Record<string, unknown> = {}) {
    super(message);
    this.raw = raw;
  }
}

/**
 * Thrown when a gateway is missing a credential or setting it needs, or a whole-number setting
 * is not a whole number greater than 0.
 */
export class ConfigurationError extends PaymentError {
  /** The gateway, e.g. `kbz_pay`. */
  readonly gateway: string;
  /** The missing or invalid setting, e.g. `app_key`. */
  readonly key: string;

  /**
   * @param invalid `true` when the setting is set but is not a whole number greater than 0;
   *   `false` (the default) when it is missing.
   */
  constructor(gateway: string, key: string, invalid = false) {
    super(
      invalid
        ? `The ${gateway} configuration [${key}] must be a whole number greater than 0.`
        : `The ${gateway} configuration is missing [${key}].`,
    );
    this.gateway = gateway;
    this.key = key;
  }
}
