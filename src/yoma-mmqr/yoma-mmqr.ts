import { type AmountInput } from '../core/amount.js';
import { MemoryTokenCache, type TokenCache } from '../core/cache.js';
import {
  CallbackRequest,
  losslessBody,
  PaymentCallback,
  PaymentStatusResult,
} from '../core/callback.js';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../core/crypto.js';
import {
  defaultEnv,
  envFirst,
  HTTP_TIMEOUT_VARIABLE,
  optionalSetting,
  requireSeconds,
  requireSetting,
  trimUrl,
  type EnvSource,
} from '../core/env.js';
import { ApiError, SignatureVerificationError } from '../core/errors.js';
import {
  httpClientFrom,
  Transport,
  type GatewayOptions,
  type GatewayResponse,
  type RequestOptions,
} from '../core/http.js';
import { toPlainObject, type LosslessObject } from '../core/json.js';
import { QrPayment } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { get, isNested, optional, trimmed } from '../core/values.js';

/** The settings of {@link YomaMmqrConfig}. */
export interface YomaMmqrConfigOptions {
  /** The merchant id Yoma issued. */
  merchantId: string;
  /** The OAuth client id. */
  clientId: string;
  /** The OAuth client secret. */
  clientSecret: string;
  /** The hash key Yoma issued for verifying callbacks. */
  webhookHashKey: string;
  /** The secret you shared with Yoma; when set, callbacks must carry it in `X-Webhook-Secret`. */
  webhookSecret?: string | undefined;
  /** The `{version}` segment of the API paths, e.g. `v1rc`. */
  apiVersion: string;
  /**
   * Seconds before the default HTTP client gives up on a request, a whole number greater than 0
   * (or its text). A client you pass keeps its own timeout.
   */
  timeoutSeconds: number | string;
  /** Overrides the API base URL, e.g. to point at UAT. */
  baseUrl?: string | undefined;
}

/**
 * Yoma MMQR credentials and endpoints. A missing setting throws a `ConfigurationError`. The URL
 * defaults to production.
 */
export class YomaMmqrConfig {
  static readonly PRODUCTION_URL = 'https://paymenthubapi.yomabank.com';

  readonly merchantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookHashKey: string;
  readonly webhookSecret: string | undefined;
  /** The `{version}` segment of the API paths. */
  readonly apiVersion: string;
  /** Seconds before the default HTTP client gives up on a request. */
  readonly timeoutSeconds: number;
  /** The base URL in use. */
  readonly baseUrl: string;

  constructor(options: YomaMmqrConfigOptions) {
    this.merchantId = requireSetting('yoma_mmqr', 'merchant_id', options.merchantId);
    this.clientId = requireSetting('yoma_mmqr', 'client_id', options.clientId);
    this.clientSecret = requireSetting('yoma_mmqr', 'client_secret', options.clientSecret);
    this.webhookHashKey = requireSetting('yoma_mmqr', 'webhook_hashkey', options.webhookHashKey);
    this.apiVersion = requireSetting('yoma_mmqr', 'api_version', options.apiVersion);
    this.timeoutSeconds = requireSeconds('yoma_mmqr', 'timeout_in_seconds', options.timeoutSeconds);
    this.webhookSecret = optionalSetting(options.webhookSecret);
    this.baseUrl = trimUrl(optionalSetting(options.baseUrl) ?? YomaMmqrConfig.PRODUCTION_URL);
  }

  /**
   * Reads `YOMA_MMQR_MERCHANT_ID`, `YOMA_MMQR_CLIENT_ID`, `YOMA_MMQR_CLIENT_SECRET`,
   * `YOMA_MMQR_WEBHOOK_HASHKEY`, `YOMA_MMQR_API_VERSION`, `MYANMAR_PAYMENTS_HTTP_TIMEOUT`,
   * `YOMA_MMQR_WEBHOOK_SECRET` and `YOMA_MMQR_BASE_URL`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): YomaMmqrConfig {
    return new YomaMmqrConfig({
      merchantId: envFirst(env, 'YOMA_MMQR_MERCHANT_ID'),
      clientId: envFirst(env, 'YOMA_MMQR_CLIENT_ID'),
      clientSecret: envFirst(env, 'YOMA_MMQR_CLIENT_SECRET'),
      webhookHashKey: envFirst(env, 'YOMA_MMQR_WEBHOOK_HASHKEY'),
      apiVersion: envFirst(env, 'YOMA_MMQR_API_VERSION'),
      timeoutSeconds: envFirst(env, HTTP_TIMEOUT_VARIABLE),
      webhookSecret: envFirst(env, 'YOMA_MMQR_WEBHOOK_SECRET'),
      baseUrl: envFirst(env, 'YOMA_MMQR_BASE_URL'),
    });
  }
}

/**
 * A Yoma MMQR order. Yoma accepts each order number once; renew an expired QR with `renewQr()`.
 * Yoma documents no decimals, so amounts are whole kyat.
 */
export interface YomaMmqrPaymentData {
  /** Your unique order number, at most 20 characters. */
  orderId: string;
  /** The amount in whole kyat, e.g. `Amount.kyat(1000)` or `1000`. */
  amount: AmountInput;
  /** Shown on the payment slip, at most 50 characters. */
  description: string;
}

/** Options of {@link YomaMmqr}: the HTTP options plus the access token cache. */
export interface YomaMmqrOptions extends GatewayOptions {
  /** Keeps the access token between calls; defaults to a {@link MemoryTokenCache}. */
  tokenCache?: TokenCache | undefined;
}

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  SUCCESS: 'successful',
  PENDING: 'pending',
  FAILED: 'failed',
  FAIL: 'failed',
};

/**
 * Yoma Bank MMQR: QR payments, status checks and callbacks. Access tokens are cached in a
 * {@link TokenCache}; share the gateway (or pass a shared cache) so they survive between calls.
 */
export class YomaMmqr {
  /** How long a generated QR stays payable, in seconds. */
  static readonly QR_LIFETIME_SECONDS = 120;

  /** The configuration in use. */
  readonly config: YomaMmqrConfig;
  private readonly transport: Transport;
  private readonly cache: TokenCache;
  private pendingToken: Promise<string> | undefined;

  constructor(config: YomaMmqrConfig | YomaMmqrConfigOptions, options: YomaMmqrOptions = {}) {
    this.config = config instanceof YomaMmqrConfig ? config : new YomaMmqrConfig(config);
    this.transport = new Transport(httpClientFrom(options, this.config.timeoutSeconds));
    this.cache = options.tokenCache ?? new MemoryTokenCache();
  }

  /** A gateway configured from the `YOMA_MMQR_*` environment variables. */
  static fromEnv(env: EnvSource = defaultEnv(), options: YomaMmqrOptions = {}): YomaMmqr {
    return new YomaMmqr(YomaMmqrConfig.fromEnv(env), options);
  }

  /** Checks the order against Yoma's documented limits; throws an `InvalidPaymentDataError`. */
  static validate(data: YomaMmqrPaymentData): void {
    new Validator()
      .required('orderId', data.orderId)
      .max('orderId', data.orderId, 20)
      .amount('amount', data.amount, { gateway: 'Yoma MMQR', maxDecimals: 0 })
      .required('description', data.description)
      .max('description', data.description, 50)
      .validate();
  }

  /** Checks the order out with Yoma and generates its first QR. Call it once per order. */
  async initiate(data: YomaMmqrPaymentData, options: RequestOptions = {}): Promise<QrPayment> {
    YomaMmqr.validate(data);

    const body = await this.call(
      'payment/checkout',
      {
        merchantId: this.config.merchantId,
        orderNumber: data.orderId,
        amount: String(toAmount(data.amount)),
        description: data.description,
      },
      [],
      options.signal,
    );
    if (body.checkOutStatus !== true) {
      throw new ApiError('Yoma MMQR did not confirm the checkout.', { raw: toPlainObject(body) });
    }

    return this.renewQr(data.orderId, options);
  }

  /**
   * Generates a new QR for an order that is already checked out, e.g. after the previous one
   * expired. The previous QR's reference stops working.
   */
  async renewQr(orderId: string, options: RequestOptions = {}): Promise<QrPayment> {
    const body = await this.call(
      'qr/generate',
      { merchantId: this.config.merchantId, orderNumber: orderId },
      [],
      options.signal,
    );

    const qrString = get(body, 'qrString');
    const reference = get(body, 'refLabel');
    if (qrString === '' || reference === '') {
      throw new ApiError('Yoma MMQR did not return a QR.', { raw: toPlainObject(body) });
    }

    return new QrPayment({
      orderId,
      qrImage: qrString,
      expiresAt: new Date(Date.now() + YomaMmqr.QR_LIFETIME_SECONDS * 1000),
      reference,
      raw: toPlainObject(body),
    });
  }

  /** Checks a QR's payment status by its reference (`QrPayment.reference`). An expired QR reports `expired`. */
  async status(reference: string, options: RequestOptions = {}): Promise<PaymentStatusResult> {
    const body = await this.call(
      'payment/check-status',
      { merchantId: this.config.merchantId, refLabel: reference },
      ['QR EXPIRED'],
      options.signal,
    );

    if (get(body, 'errorCode') === 'QR EXPIRED') {
      return new PaymentStatusResult({
        status: 'expired',
        gatewayStatus: 'QR EXPIRED',
        gatewayReference: reference,
        raw: toPlainObject(body),
      });
    }

    const paymentStatus = trimmed(body, 'paymentStatus');
    return new PaymentStatusResult({
      status: resolveStatus(STATUSES, paymentStatus.toUpperCase()),
      gatewayStatus: paymentStatus,
      gatewayReference: get(body, 'refLabel') || reference,
      raw: toPlainObject(body),
    });
  }

  /**
   * Verifies Yoma's payment callback: HMAC-SHA256 of `orderNumber=..&status=..` keyed with the
   * order number followed by the webhook hash key.
   */
  handleCallback(request: CallbackRequest): PaymentCallback {
    const payload = losslessBody(request);

    if (
      this.config.webhookSecret !== undefined &&
      !safeEqual(this.config.webhookSecret, request.header('X-Webhook-Secret') ?? '')
    ) {
      throw new SignatureVerificationError(
        'Yoma MMQR callback has a missing or wrong X-Webhook-Secret header.',
        toPlainObject(payload),
      );
    }

    const orderNumber = get(payload, 'orderNumber');
    const status = trimmed(payload, 'status');
    const expected = hmacSha256Hex(
      orderNumber + this.config.webhookHashKey,
      `orderNumber=${orderNumber}&status=${status}`,
    );
    if (
      orderNumber === '' ||
      isNested(payload.status) ||
      !safeEqual(expected, get(payload, 'hashValue').toLowerCase())
    ) {
      throw new SignatureVerificationError(
        'Yoma MMQR callback hash verification failed.',
        toPlainObject(payload),
      );
    }

    return new PaymentCallback({
      orderId: orderNumber,
      status: resolveStatus(STATUSES, status.toUpperCase()),
      gatewayStatus: status,
      raw: toPlainObject(payload),
    });
  }

  /** Drops the cached access token, e.g. after rotating the client secret. */
  async forgetToken(): Promise<void> {
    await this.cache.delete(this.tokenCacheKey());
  }

  private async call(
    path: string,
    data: Record<string, unknown>,
    allowedErrors: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<LosslessObject> {
    const url = `${this.config.baseUrl}/payment-gateway/${this.config.apiVersion}/api/${path}`;
    const send = async (): Promise<GatewayResponse> =>
      this.transport.postJson(url, data, { Authorization: `Bearer ${await this.token()}` }, signal);

    let response = await send();
    if (response.status === 401) {
      await this.forgetToken();
      response = await send();
    }

    const body = response.json();
    const errorCode = get(body, 'errorCode');
    if (!response.successful() || (errorCode !== '' && !allowedErrors.includes(errorCode))) {
      throw apiError(path, response.status, body, errorCode);
    }
    return body;
  }

  private async token(): Promise<string> {
    const cached = await this.cache.get(this.tokenCacheKey());
    if (typeof cached === 'string' && cached !== '') {
      return cached;
    }
    // Concurrent calls share one token request; it ignores any one caller's signal so aborting
    // that caller does not fail the others (the client timeout still applies).
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    const response = await this.transport.postForm(
      `${this.config.baseUrl}/token`,
      { grant_type: 'client_credentials' },
      { Authorization: `Basic ${credentials}` },
    );

    const body = response.json();
    const token = get(body, 'access_token');
    if (!response.successful() || token === '') {
      throw apiError('token', response.status, body, get(body, 'error'));
    }

    // The leading digits of `expires_in`; missing, non-numeric or 0 means an hour.
    const expiresIn = Number(/^\d+/.exec(get(body, 'expires_in'))?.[0] ?? 0);
    const ttl = Math.max(60, (expiresIn > 0 ? expiresIn : 3600) - 60);
    await this.cache.set(this.tokenCacheKey(), token, ttl);
    return token;
  }

  private tokenCacheKey(): string {
    return `myanmar-payments.yoma-mmqr.token.${sha256Hex(`${this.config.baseUrl}|${this.config.clientId}`)}`;
  }
}

function apiError(
  endpoint: string,
  status: number,
  body: LosslessObject,
  errorCode: string,
): ApiError {
  const message = optional(body, 'errorDescription') || optional(body, 'error_description');
  return new ApiError(
    errorCode
      ? `Yoma MMQR ${endpoint} failed: [${errorCode}] ${message ?? ''}`.trimEnd()
      : `Yoma MMQR ${endpoint} failed with HTTP ${status}.`,
    {
      gatewayCode: errorCode || undefined,
      gatewayMessage: message || undefined,
      httpStatus: status,
      raw: toPlainObject(body),
    },
  );
}
