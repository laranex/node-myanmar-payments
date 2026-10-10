import { Amount, type AmountInput } from '../core/amount.js';
import { CallbackRequest, losslessBody, PaymentCallback } from '../core/callback.js';
import { hmacSha256Hex, queryEscape, randomHex, safeEqual } from '../core/crypto.js';
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
  type RequestOptions,
} from '../core/http.js';
import { isLosslessObject, toPlainObject, type LosslessObject } from '../core/json.js';
import { RedirectPayment } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { get, isNested, optional, scalarString, trimmed } from '../core/values.js';

/** The settings of {@link WaveMoneyConfig}. */
export interface WaveMoneyConfigOptions {
  /** The merchant id Wave issued. */
  merchantId: string;
  /** The hash secret key Wave issued. */
  secretKey: string;
  /** Your business name, shown on Wave's payment page. */
  merchantName: string;
  /** How long the customer has to pay, in seconds: a whole number greater than 0 (or its text). */
  timeToLiveSeconds: number | string;
  /**
   * Seconds before the default HTTP client gives up on a request, a whole number greater than 0
   * (or its text). A client you pass keeps its own timeout.
   */
  timeoutSeconds: number | string;
  /** Overrides the API base URL, e.g. to point at UAT. */
  baseUrl?: string | undefined;
  /** Overrides the host the customer is redirected to. Wave serves it without the API port. */
  authenticateUrl?: string | undefined;
}

/**
 * Wave Money credentials and endpoints. A missing setting throws a `ConfigurationError`. The URLs
 * default to production.
 */
export class WaveMoneyConfig {
  static readonly PRODUCTION_URL = 'https://payments.wavemoney.io';
  static readonly PRODUCTION_AUTHENTICATE_URL = 'https://payments.wavemoney.io';

  readonly merchantId: string;
  readonly secretKey: string;
  readonly merchantName: string;
  /** Seconds the customer has to pay. */
  readonly timeToLiveSeconds: number;
  /** Seconds before the default HTTP client gives up on a request. */
  readonly timeoutSeconds: number;
  /** The API base URL in use. */
  readonly baseUrl: string;
  /** The host the customer is redirected to. */
  readonly authenticateUrl: string;

  constructor(options: WaveMoneyConfigOptions) {
    this.merchantId = requireSetting('wave_money', 'merchant_id', options.merchantId);
    this.secretKey = requireSetting('wave_money', 'secret_key', options.secretKey);
    this.merchantName = requireSetting('wave_money', 'merchant_name', options.merchantName);
    this.timeToLiveSeconds = requireSeconds(
      'wave_money',
      'time_to_live_in_seconds',
      options.timeToLiveSeconds,
    );
    this.timeoutSeconds = requireSeconds(
      'wave_money',
      'timeout_in_seconds',
      options.timeoutSeconds,
    );
    this.baseUrl = trimUrl(optionalSetting(options.baseUrl) ?? WaveMoneyConfig.PRODUCTION_URL);
    this.authenticateUrl = trimUrl(
      optionalSetting(options.authenticateUrl) ?? WaveMoneyConfig.PRODUCTION_AUTHENTICATE_URL,
    );
  }

  /**
   * Reads `WAVE_MONEY_MERCHANT_ID`, `WAVE_MONEY_SECRET_KEY`, `WAVE_MONEY_MERCHANT_NAME`,
   * `WAVE_MONEY_TIME_TO_LIVE_IN_SECONDS`, `MYANMAR_PAYMENTS_HTTP_TIMEOUT`, `WAVE_MONEY_BASE_URL`
   * and `WAVE_MONEY_AUTHENTICATE_URL`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): WaveMoneyConfig {
    return new WaveMoneyConfig({
      merchantId: envFirst(env, 'WAVE_MONEY_MERCHANT_ID'),
      secretKey: envFirst(env, 'WAVE_MONEY_SECRET_KEY'),
      merchantName: envFirst(env, 'WAVE_MONEY_MERCHANT_NAME'),
      timeToLiveSeconds: envFirst(env, 'WAVE_MONEY_TIME_TO_LIVE_IN_SECONDS'),
      timeoutSeconds: envFirst(env, HTTP_TIMEOUT_VARIABLE),
      baseUrl: envFirst(env, 'WAVE_MONEY_BASE_URL'),
      authenticateUrl: envFirst(env, 'WAVE_MONEY_AUTHENTICATE_URL'),
    });
  }
}

/** A line item shown on Wave's payment page. */
export interface WaveMoneyItem {
  /** The item name. */
  name: string;
  /** The item amount in whole kyat, e.g. `Amount.kyat(1000)` or `1000`. */
  amount: AmountInput;
}

/**
 * A Wave Money payment request. Wave only accepts whole kyat (MMK).
 */
export interface WaveMoneyPaymentData {
  /** Your order id. One order can have several payment attempts. */
  orderId: string;
  /** The URL Wave posts the result to (`backend_result_url`). */
  callbackUrl: string;
  /** Where Wave sends the customer back (`frontend_result_url`). Not proof of payment. */
  returnUrl: string;
  /** Shown to the customer. */
  description: string;
  /** The line items shown on Wave's page; at least one. */
  items: readonly WaveMoneyItem[];
  /** The total in whole kyat. Leave it unset to charge the sum of the items. */
  amount?: AmountInput | undefined;
  /**
   * The unique id of this attempt; Wave rejects a reused one. `initiate()` fills it with a random
   * id when empty, so store it afterwards: Wave's callback may omit `orderId` but always carries
   * this.
   */
  merchantReferenceId?: string | undefined;
}

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  PAYMENT_CONFIRMED: 'successful',
  INSUFFICIENT_BALANCE: 'pending',
  ACCOUNT_LOCKED: 'failed',
  BILL_COLLECTION_FAILED: 'failed',
  PAYMENT_REQUEST_CANCELLED: 'canceled',
  TRANSACTION_TIMED_OUT: 'expired',
  SCHEDULER_TRANSACTION_TIMED_OUT: 'expired',
};

const CALLBACK_FIELDS = [
  'status',
  'timeToLiveSeconds',
  'merchantId',
  'orderId',
  'amount',
  'backendResultUrl',
  'merchantReferenceId',
  'initiatorMsisdn',
  'transactionId',
  'paymentRequestId',
  'requestTime',
] as const;

/**
 * Wave Money (WavePay payment gateway): redirect payments and callbacks. Wave has no status API,
 * so the callback is the only result.
 */
export class WaveMoney {
  /** The configuration in use. */
  readonly config: WaveMoneyConfig;
  private readonly transport: Transport;

  constructor(config: WaveMoneyConfig | WaveMoneyConfigOptions, options: GatewayOptions = {}) {
    this.config = config instanceof WaveMoneyConfig ? config : new WaveMoneyConfig(config);
    this.transport = new Transport(httpClientFrom(options, this.config.timeoutSeconds));
  }

  /** A gateway configured from the `WAVE_MONEY_*` environment variables. */
  static fromEnv(env: EnvSource = defaultEnv(), options: GatewayOptions = {}): WaveMoney {
    return new WaveMoney(WaveMoneyConfig.fromEnv(env), options);
  }

  /**
   * The total that will be charged: `amount`, or the exact sum of the items when it is unset.
   * `undefined` when an item amount is missing, malformed or has decimals.
   */
  static resolvedAmount(data: Pick<WaveMoneyPaymentData, 'amount' | 'items'>): Amount | undefined {
    if (data.amount !== undefined) {
      return toAmount(data.amount);
    }
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return undefined;
    }
    let total = 0n;
    for (const item of data.items as readonly WaveMoneyItem[]) {
      const amount = toAmount(item?.amount);
      if (amount === undefined || amount.decimalPlaces() > 0) {
        return undefined;
      }
      total += BigInt(amount.toString());
    }
    return Amount.kyat(total);
  }

  /** Checks the request against Wave's documented rules; throws an `InvalidPaymentDataError`. */
  static validate(data: WaveMoneyPaymentData): void {
    const items: readonly WaveMoneyItem[] = Array.isArray(data.items) ? data.items : [];
    const validator = new Validator()
      .required('orderId', data.orderId)
      .required('callbackUrl', data.callbackUrl)
      .url('callbackUrl', data.callbackUrl)
      .required('returnUrl', data.returnUrl)
      .url('returnUrl', data.returnUrl)
      .required('description', data.description)
      .when(items.length === 0, 'items', 'The items field must have at least one item.')
      .string('merchantReferenceId', data.merchantReferenceId);
    items.forEach((item, index) => {
      validator
        .required(`items.${index}.name`, item?.name)
        .amount(`items.${index}.amount`, item?.amount, { gateway: 'Wave Money', maxDecimals: 0 });
    });
    const resolved = WaveMoney.resolvedAmount(data);
    if (!(items.length > 0 && data.amount === undefined && resolved === undefined)) {
      validator.amount('amount', data.amount ?? resolved, {
        gateway: 'Wave Money',
        maxDecimals: 0,
      });
    }
    validator.validate();
  }

  /**
   * Creates a payment request and returns Wave's page to redirect the customer to. Once `data`
   * passes validation it fills `data.merchantReferenceId` with a random id when empty, so store it
   * afterwards. Invalid data is left untouched.
   */
  async initiate(
    data: WaveMoneyPaymentData,
    options: RequestOptions = {},
  ): Promise<RedirectPayment> {
    WaveMoney.validate(data);
    if (!data.merchantReferenceId) {
      data.merchantReferenceId = randomHex();
    }

    const amount = (WaveMoney.resolvedAmount(data) as Amount).toString();
    const ttl = String(this.config.timeToLiveSeconds);
    // Wave documents items as [{"name": "...", "amount": 1000}] with a numeric amount; the amount
    // text is written as a JSON number without passing through a float.
    const items = `[${data.items
      .map(
        (item) => `{"name":${JSON.stringify(item.name)},"amount":${String(toAmount(item.amount))}}`,
      )
      .join(',')}]`;

    const response = await this.transport.postForm(
      `${this.config.baseUrl}/payment`,
      {
        time_to_live_in_seconds: ttl,
        merchant_id: this.config.merchantId,
        order_id: data.orderId,
        merchant_reference_id: data.merchantReferenceId,
        frontend_result_url: data.returnUrl,
        backend_result_url: data.callbackUrl,
        amount,
        payment_description: data.description,
        merchant_name: this.config.merchantName,
        items,
        hash: this.hash([
          ttl,
          this.config.merchantId,
          data.orderId,
          amount,
          data.callbackUrl,
          data.merchantReferenceId,
        ]),
      },
      {},
      options.signal,
    );

    const body = response.json();
    const transactionId = get(body, 'transaction_id');
    if (!response.successful() || get(body, 'message') !== 'success' || transactionId === '') {
      const message = errorMessage(body);
      throw new ApiError(
        `Wave Money payment request failed with HTTP ${response.status}: ${message}`,
        {
          gatewayCode: 'errors' in body ? 'VALIDATION_ERROR' : optional(body, 'message'),
          gatewayMessage: message,
          httpStatus: response.status,
          raw: toPlainObject(body),
        },
      );
    }

    return new RedirectPayment({
      orderId: data.orderId,
      url: `${this.config.authenticateUrl}/authenticate?transaction_id=${queryEscape(transactionId)}`,
      gatewayReference: transactionId,
      raw: toPlainObject(body),
    });
  }

  /**
   * Verifies Wave's callback. Only `PAYMENT_CONFIRMED` means the customer paid. `orderId` falls
   * back to `merchantReferenceId` when it is missing, null or empty, because Wave marks `orderId` as
   * optional. A hashed field holding an object or array fails verification.
   */
  handleCallback(request: CallbackRequest): PaymentCallback {
    const payload = losslessBody(request);
    const expected = this.hash(
      CALLBACK_FIELDS.map((field) => scalarString(payload[field]) ?? 'null'),
    );
    const hashValue = payload.hashValue;

    if (
      typeof hashValue !== 'string' ||
      CALLBACK_FIELDS.some((field) => isNested(payload[field])) ||
      !safeEqual(expected, hashValue.toLowerCase())
    ) {
      throw new SignatureVerificationError(
        'Wave Money callback hash verification failed.',
        toPlainObject(payload),
      );
    }

    const gatewayStatus = trimmed(payload, 'status');
    return new PaymentCallback({
      orderId: get(payload, 'orderId') || get(payload, 'merchantReferenceId'),
      status: resolveStatus(STATUSES, gatewayStatus),
      gatewayStatus,
      gatewayReference: optional(payload, 'transactionId'),
      amount: optional(payload, 'amount'),
      raw: toPlainObject(payload),
    });
  }

  private hash(parts: readonly string[]): string {
    return hmacSha256Hex(this.config.secretKey, parts.join(''));
  }
}

function errorMessage(body: LosslessObject): string {
  const errors = body.errors;
  if (isLosslessObject(errors)) {
    return Object.keys(errors)
      .sort()
      .map((field) => {
        const list = errors[field];
        const texts = (Array.isArray(list) ? list : [list])
          .map((item) => scalarString(item))
          .filter((text): text is string => text !== undefined);
        return `${field}: ${texts.join(' ')}`;
      })
      .join('; ');
  }
  return get(body, 'message') || 'unexpected response';
}
