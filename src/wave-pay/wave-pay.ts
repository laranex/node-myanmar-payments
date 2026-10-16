import { Amount, type AmountInput } from '../core/amount.js';
import { CallbackRequest, losslessBody, PaymentCallback } from '../core/callback.js';
import { hmacSha256Hex, queryEscape, randomHex, safeEqual } from '../core/crypto.js';
import {
  defaultEnv,
  envFirst,
  HTTP_TIMEOUT_VARIABLE,
  requireSeconds,
  requireSetting,
  resolveTimeout,
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

/** The settings of {@link WavePayConfig}. */
export interface WavePayConfigOptions {
  /** The merchant id Wave issued. */
  merchantId: string;
  /** The hash secret key Wave issued. */
  secretKey: string;
  /** Your business name, shown on Wave's payment page. */
  merchantName: string;
  /**
   * The API base URL, e.g. `WavePayConfig.PRODUCTION_URL` or
   * `https://preprodpayments.wavemoney.io:8107`. Payments are requested at its `/payment`.
   */
  baseUrl: string;
  /**
   * The host the customer is sent to, e.g. `WavePayConfig.PRODUCTION_URL` or
   * `https://preprodpayments.wavemoney.io:8107`. The customer approves the payment at its
   * `/authenticate`.
   */
  baseRedirectUrl: string;
  /**
   * How long the customer has to pay, in seconds: a whole number greater than 0 (or its text). A
   * payment's own `timeToLiveSeconds` overrides it.
   */
  timeToLiveSeconds: number | string;
  /**
   * Seconds before the default HTTP client gives up on a request, a whole number greater than 0
   * (or its text). Defaults to 30 (`DEFAULT_TIMEOUT_SECONDS`) when unset or blank. A
   * client you pass keeps its own timeout.
   */
  timeoutSeconds?: number | string | null | undefined;
}

/**
 * Wave Pay (Pay with Wave) credentials and endpoints. Every setting is required except the HTTP timeout; a
 * missing one throws a `ConfigurationError`. `PRODUCTION_URL` names production's API and payment
 * page host.
 */
export class WavePayConfig {
  static readonly PRODUCTION_URL = 'https://payments.wavemoney.io';

  readonly merchantId: string;
  readonly secretKey: string;
  readonly merchantName: string;
  /** The API base URL in use; payments are requested at its `/payment`. */
  readonly baseUrl: string;
  /** The host the customer is sent to, at its `/authenticate`. */
  readonly baseRedirectUrl: string;
  /** Seconds the customer has to pay unless the payment sets its own. */
  readonly timeToLiveSeconds: number;
  /** Seconds before the default HTTP client gives up on a request. */
  readonly timeoutSeconds: number;

  constructor(options: WavePayConfigOptions) {
    this.merchantId = requireSetting('wave_pay', 'merchant_id', options.merchantId);
    this.secretKey = requireSetting('wave_pay', 'secret_key', options.secretKey);
    this.merchantName = requireSetting('wave_pay', 'merchant_name', options.merchantName);
    this.baseUrl = trimUrl(requireSetting('wave_pay', 'base_url', options.baseUrl));
    this.baseRedirectUrl = trimUrl(
      requireSetting('wave_pay', 'base_redirect_url', options.baseRedirectUrl),
    );
    this.timeToLiveSeconds = requireSeconds(
      'wave_pay',
      'time_to_live_in_seconds',
      options.timeToLiveSeconds,
    );
    this.timeoutSeconds = resolveTimeout('wave_pay', options.timeoutSeconds);
  }

  /**
   * Reads `WAVE_PAY_MERCHANT_ID`, `WAVE_PAY_SECRET_KEY`, `WAVE_PAY_MERCHANT_NAME`,
   * `WAVE_PAY_BASE_URL`, `WAVE_PAY_BASE_REDIRECT_URL`, `WAVE_PAY_TIME_TO_LIVE_IN_SECONDS` and
   * `MYANMAR_PAYMENTS_HTTP_TIMEOUT`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): WavePayConfig {
    return new WavePayConfig({
      merchantId: envFirst(env, 'WAVE_PAY_MERCHANT_ID'),
      secretKey: envFirst(env, 'WAVE_PAY_SECRET_KEY'),
      merchantName: envFirst(env, 'WAVE_PAY_MERCHANT_NAME'),
      baseUrl: envFirst(env, 'WAVE_PAY_BASE_URL'),
      baseRedirectUrl: envFirst(env, 'WAVE_PAY_BASE_REDIRECT_URL'),
      timeToLiveSeconds: envFirst(env, 'WAVE_PAY_TIME_TO_LIVE_IN_SECONDS'),
      timeoutSeconds: envFirst(env, HTTP_TIMEOUT_VARIABLE),
    });
  }
}

/** A line item shown on Wave's payment page. */
export interface WavePayItem {
  /** The item name. */
  name: string;
  /** The item amount in whole kyat, e.g. `Amount.kyat(1000)` or `1000`. */
  amount: AmountInput;
}

/**
 * A Wave Pay payment request. Wave only accepts whole kyat (MMK). Lengths are counted in UTF-8
 * bytes.
 */
export interface WavePayPaymentData {
  /**
   * Your order id, at most 100 characters: letters, digits, `_` and `-`. One order can have several
   * payment attempts.
   */
  orderId: string;
  /** The URL Wave posts the result to (`backend_result_url`), at most 255 characters. */
  callbackUrl: string;
  /**
   * Where Wave sends the customer back (`frontend_result_url`), at most 255 characters. Not proof
   * of payment.
   */
  returnUrl: string;
  /** Shown to the customer (`payment_description`), at most 255 characters. */
  description: string;
  /** The line items shown on Wave's page; at least one. */
  items: readonly WavePayItem[];
  /** The total in whole kyat. Leave it unset to charge the sum of the items. */
  amount?: AmountInput | undefined;
  /**
   * The unique id of this attempt, at most 100 characters (letters, digits, `_` and `-`); Wave
   * rejects a reused one.
   * `initiate()` fills it with a random id when empty, so store it afterwards: Wave's callback may omit `orderId` but always carries
   * this.
   */
  merchantReferenceId?: string | undefined;
  /**
   * The business name shown on Wave's page for this payment. Defaults to the configured
   * `merchantName` when unset.
   */
  merchantName?: string | null | undefined;
  /**
   * How long the customer has to pay this payment, in seconds: a whole number greater than 0.
   * Overrides the configured `timeToLiveSeconds` for this payment.
   */
  timeToLiveSeconds?: number | null | undefined;
  /**
   * Extra information sent as `additional_field_3`, at most 50 characters; Wave echoes it as the
   * callback's `additionalField3`. Not sent when null or empty.
   */
  additionalField3?: string | null | undefined;
  /**
   * Extra information sent as `additional_field_4`, at most 50 characters; echoed as
   * `additionalField4`. Not sent when null or empty.
   */
  additionalField4?: string | null | undefined;
  /**
   * Extra information sent as `additional_field_5`, at most 50 characters; echoed as
   * `additionalField5`. Not sent when null or empty.
   */
  additionalField5?: string | null | undefined;
}

const CURRENCY = 'MMK';

const ADDITIONAL_FIELDS = [
  ['additional_field_3', 'additionalField3'],
  ['additional_field_4', 'additionalField4'],
  ['additional_field_5', 'additionalField5'],
] as const;

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  PAYMENT_CONFIRMED: 'successful',
  BILL_COLLECTION_FAILED: 'failed',
  INSUFFICIENT_BALANCE: 'failed',
  ACCOUNT_LOCKED: 'failed',
  PAYMENT_REQUEST_CANCELLED: 'canceled',
  TRANSACTION_TIMED_OUT: 'expired',
  SCHEDULER_TRANSACTION_TIMED_OUT: 'expired',
};

/** The callback's `amount`: a non-negative decimal. */
const AMOUNT = /^\d+(\.\d+)?$/;

/** `orderId` and `merchantReferenceId`, in a payment and in its callback. */
const ID = /^[A-Za-z0-9_-]+$/;
const ID_DESCRIPTION = 'letters, digits, underscores and dashes';

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
 * Wave Pay (Pay with Wave API v1.3): redirect payments and callbacks. Wave has no status API, so
 * the callback is the only result.
 */
export class WavePay {
  /** The configuration in use. */
  readonly config: WavePayConfig;
  private readonly transport: Transport;

  constructor(config: WavePayConfig | WavePayConfigOptions, options: GatewayOptions = {}) {
    this.config = config instanceof WavePayConfig ? config : new WavePayConfig(config);
    this.transport = new Transport(httpClientFrom(options, this.config.timeoutSeconds));
  }

  /** A gateway configured from the `WAVE_PAY_*` environment variables. */
  static fromEnv(env: EnvSource = defaultEnv(), options: GatewayOptions = {}): WavePay {
    return new WavePay(WavePayConfig.fromEnv(env), options);
  }

  /**
   * The total that will be charged: `amount`, or the exact sum of the items when it is unset.
   * `undefined` when an item amount is missing, malformed or has decimals.
   */
  static resolvedAmount(data: Pick<WavePayPaymentData, 'amount' | 'items'>): Amount | undefined {
    if (data.amount !== undefined) {
      return toAmount(data.amount);
    }
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return undefined;
    }
    let total = 0n;
    for (const item of data.items as readonly WavePayItem[]) {
      const amount = toAmount(item?.amount);
      if (amount === undefined || amount.decimalPlaces() > 0) {
        return undefined;
      }
      total += BigInt(amount.toString());
    }
    return Amount.kyat(total);
  }

  /** Checks the request against Wave's documented rules; throws an `InvalidPaymentDataError`. */
  static validate(data: WavePayPaymentData): void {
    const items: readonly WavePayItem[] = Array.isArray(data.items) ? data.items : [];
    const validator = new Validator()
      .required('orderId', data.orderId)
      .max('orderId', data.orderId, 100)
      .pattern('orderId', data.orderId, ID, ID_DESCRIPTION)
      .required('callbackUrl', data.callbackUrl)
      .url('callbackUrl', data.callbackUrl)
      .max('callbackUrl', data.callbackUrl, 255)
      .required('returnUrl', data.returnUrl)
      .url('returnUrl', data.returnUrl)
      .max('returnUrl', data.returnUrl, 255)
      .required('description', data.description)
      .max('description', data.description, 255)
      .when(items.length === 0, 'items', 'The items field must have at least one item.')
      .string('merchantReferenceId', data.merchantReferenceId)
      .max('merchantReferenceId', data.merchantReferenceId, 100)
      .pattern('merchantReferenceId', data.merchantReferenceId, ID, ID_DESCRIPTION)
      .string('merchantName', data.merchantName)
      .when(
        typeof data.merchantName === 'string' && data.merchantName.trim() === '',
        'merchantName',
        'The merchantName field is required.',
      )
      .when(
        isSet(data.timeToLiveSeconds) && !Number.isInteger(data.timeToLiveSeconds),
        'timeToLiveSeconds',
        'The timeToLiveSeconds field must be an integer.',
      )
      .when(
        isSet(data.timeToLiveSeconds) && (data.timeToLiveSeconds as number) < 1,
        'timeToLiveSeconds',
        'The timeToLiveSeconds field must be greater than 0.',
      );
    for (const [, field] of ADDITIONAL_FIELDS) {
      validator.string(field, data[field]).max(field, data[field] ?? undefined, 50);
    }
    items.forEach((item, index) => {
      validator
        .required(`items.${index}.name`, item?.name)
        .amount(`items.${index}.amount`, item?.amount, { gateway: 'Wave Pay', maxDecimals: 0 });
    });
    const resolved = WavePay.resolvedAmount(data);
    if (!(items.length > 0 && data.amount === undefined && resolved === undefined)) {
      validator.amount('amount', data.amount ?? resolved, {
        gateway: 'Wave Pay',
        maxDecimals: 0,
      });
    }
    validator.validate();
  }

  /**
   * Creates a payment request (a JSON post to `{baseUrl}/payment`, currency MMK) and returns Wave's
   * page to redirect the customer to (`{baseRedirectUrl}/authenticate?transaction_id=...`). Once `data`
   * passes validation it fills `data.merchantReferenceId` with a random id when empty, so store it
   * afterwards. Invalid data is left untouched.
   */
  async initiate(data: WavePayPaymentData, options: RequestOptions = {}): Promise<RedirectPayment> {
    WavePay.validate(data);
    const timeToLiveSeconds = data.timeToLiveSeconds ?? this.config.timeToLiveSeconds;
    if (!data.merchantReferenceId) {
      data.merchantReferenceId = randomHex();
    }

    const amount = (WavePay.resolvedAmount(data) as Amount).toString();
    const ttl = String(timeToLiveSeconds);
    // Wave documents items as [{"name": "...", "amount": 1000}] with a numeric amount; the amount
    // text is written as a JSON number without passing through a float.
    const items = `[${data.items
      .map(
        (item) => `{"name":${JSON.stringify(item.name)},"amount":${String(toAmount(item.amount))}}`,
      )
      .join(',')}]`;

    // The spec sends amount and time_to_live_in_seconds as JSON integers and items as a JSON
    // string; the amount text is written as a JSON number without passing through a float.
    const fields: [string, string][] = [
      ['merchant_id', JSON.stringify(this.config.merchantId)],
      ['order_id', JSON.stringify(data.orderId)],
      ['merchant_reference_id', JSON.stringify(data.merchantReferenceId)],
      ['frontend_result_url', JSON.stringify(data.returnUrl)],
      ['backend_result_url', JSON.stringify(data.callbackUrl)],
      ['amount', amount],
      ['time_to_live_in_seconds', ttl],
      ['payment_description', JSON.stringify(data.description)],
      ['currency', JSON.stringify(CURRENCY)],
      [
        'hash',
        JSON.stringify(
          this.hash([
            ttl,
            this.config.merchantId,
            data.orderId,
            amount,
            data.callbackUrl,
            data.merchantReferenceId,
          ]),
        ),
      ],
      ['merchant_name', JSON.stringify(data.merchantName ?? this.config.merchantName)],
      ['items', JSON.stringify(items)],
    ];
    for (const [name, field] of ADDITIONAL_FIELDS) {
      const value = data[field];
      if (typeof value === 'string' && value !== '') {
        fields.push([name, JSON.stringify(value)]);
      }
    }

    const response = await this.transport.postJsonText(
      `${this.config.baseUrl}/payment`,
      `{${fields.map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(',')}}`,
      {},
      options.signal,
    );

    const body = response.json();
    const transactionId = get(body, 'transaction_id');
    if (!response.successful() || get(body, 'message') !== 'success' || transactionId === '') {
      const message = errorMessage(body);
      throw new ApiError(
        `Wave Pay payment request failed with HTTP ${response.status}: ${message}`,
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
      url: `${this.config.baseRedirectUrl}/authenticate?transaction_id=${queryEscape(transactionId)}`,
      gatewayReference: transactionId,
      raw: toPlainObject(body),
    });
  }

  /**
   * Verifies Wave's callback. Only `PAYMENT_CONFIRMED` means the customer paid. `orderId` falls
   * back to `merchantReferenceId` when it is missing, null or empty, as a safeguard: earlier Wave
   * documents marked `orderId` optional. A hashed field holding an object or array fails verification, and so does a callback
   * whose `amount` is not a non-negative decimal, which has neither id, or whose `orderId` or
   * `merchantReferenceId` holds anything but letters, digits, `_` and `-`: Wave hashes the values
   * with no separator, so only well-formed values pin each one down.
   */
  handleCallback(request: CallbackRequest): PaymentCallback {
    const payload = losslessBody(request);
    const expected = this.hash(
      CALLBACK_FIELDS.map((field) => scalarString(payload[field]) ?? 'null'),
    );
    const hashValue = payload.hashValue;

    // Wave concatenates the values with no separator, so a matching hash alone does not pin where
    // one value ends and the next begins: the ids and the amount must also be well formed.
    const orderId = get(payload, 'orderId');
    const merchantReferenceId = get(payload, 'merchantReferenceId');
    if (
      typeof hashValue !== 'string' ||
      CALLBACK_FIELDS.some((field) => isNested(payload[field])) ||
      !safeEqual(expected, hashValue.toLowerCase()) ||
      !AMOUNT.test(get(payload, 'amount')) ||
      (orderId === '' && merchantReferenceId === '') ||
      [orderId, merchantReferenceId].some((id) => id !== '' && !ID.test(id))
    ) {
      throw new SignatureVerificationError(
        'Wave Pay callback hash verification failed.',
        toPlainObject(payload),
      );
    }

    const gatewayStatus = trimmed(payload, 'status');
    return new PaymentCallback({
      orderId: orderId || merchantReferenceId,
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

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
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
