import { type AmountInput } from '../core/amount.js';
import {
  CallbackRequest,
  losslessInput,
  losslessQueryInput,
  PaymentCallback,
  PaymentStatusResult,
} from '../core/callback.js';
import { decodeBase64, hmacSha256Hex, safeEqual } from '../core/crypto.js';
import {
  defaultEnv,
  envFirst,
  envSandbox,
  optionalSetting,
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
import {
  isLosslessObject,
  parseJsonObject,
  toPlainObject,
  type LosslessObject,
} from '../core/json.js';
import { FormPayment, type FormField } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { get, object, optional, scalarString, trimmed } from '../core/values.js';

/** The settings of {@link AyaPayConfig}. */
export interface AyaPayConfigOptions {
  /** The public application key, sent with every request. */
  appKey: string;
  /** The secret that signs requests and verifies callbacks. */
  appSecret: string;
  /** Use the UAT environment (default `true`). */
  sandbox?: boolean | undefined;
  /** Overrides the gateway base URL. */
  baseUrl?: string | undefined;
}

/**
 * AYA Payment Gateway (APG) credentials and endpoints. A missing credential throws a
 * `ConfigurationError`.
 */
export class AyaPayConfig {
  static readonly SANDBOX_URL = 'https://uat-pgw.ayainnovation.com';
  static readonly PRODUCTION_URL = 'https://pgw.ayainnovation.com';

  readonly appKey: string;
  readonly appSecret: string;
  readonly sandbox: boolean;
  /** The base URL in use. */
  readonly baseUrl: string;

  constructor(options: AyaPayConfigOptions) {
    this.appKey = requireSetting('aya_pay', 'app_key', options.appKey);
    this.appSecret = requireSetting('aya_pay', 'app_secret', options.appSecret);
    this.sandbox = options.sandbox ?? true;
    this.baseUrl = trimUrl(
      optionalSetting(options.baseUrl) ??
        (this.sandbox ? AyaPayConfig.SANDBOX_URL : AyaPayConfig.PRODUCTION_URL),
    );
  }

  /**
   * Reads `AYA_PAY_APP_KEY`, `AYA_PAY_APP_SECRET`, `AYA_PAY_SANDBOX` and `AYA_PAY_BASE_URL`, falling
   * back to the `AYA_PGW_*` names.
   */
  static fromEnv(env: EnvSource = defaultEnv()): AyaPayConfig {
    return new AyaPayConfig({
      appKey: envFirst(env, 'AYA_PAY_APP_KEY', 'AYA_PGW_APP_KEY'),
      appSecret: envFirst(env, 'AYA_PAY_APP_SECRET', 'AYA_PGW_APP_SECRET'),
      sandbox: envSandbox(env, 'AYA_PAY_SANDBOX'),
      baseUrl: envFirst(env, 'AYA_PAY_BASE_URL', 'AYA_PGW_BASE_URL'),
    });
  }
}

/** How the customer pays through the chosen channel. `services()` lists the methods each channel supports. */
export type AyaPayMethod = 'WEB' | 'QR' | 'NOTI';

/** The AYA payment methods. */
export const AyaPayMethod = Object.freeze({
  /** Pay on a hosted web page (cards, web checkout). */
  Web: 'WEB',
  /** Scan a QR with the wallet app. */
  Qr: 'QR',
  /** Approve a push notification in the wallet app. */
  Noti: 'NOTI',
} as const);

const METHODS: readonly string[] = ['WEB', 'QR', 'NOTI'];

/**
 * An AYA Payment Gateway order. AYA only accepts MMK (currency code 104) and documents no decimals,
 * so amounts are whole kyat.
 */
export interface AyaPayPaymentData {
  /** Your unique order id (`merchOrderId`), 6 to 40 characters. */
  orderId: string;
  /** The amount in whole kyat, e.g. `Amount.kyat(1000)` or `1000`. */
  amount: AmountInput;
  /** The channel key from `services()`, e.g. `aya_pay`, `kbz_pay`, `visa`. */
  channel: string;
  /** How the customer pays through that channel. */
  method: AyaPayMethod;
  /** Where AYA sends the customer afterwards. Defaults to the URL registered with AYA. */
  returnUrl?: string | undefined;
  /** Shown to the customer. */
  description?: string | undefined;
  /** Up to five of your own reference values, echoed back in the callback. */
  userRefs?: readonly string[] | undefined;
}

/** A payment channel enabled for your merchant account. */
export class AyaPayService {
  /** The display name, e.g. `AYA Pay`. */
  readonly name: string;
  /** The `channel` value to send when initiating, e.g. `aya_pay` or `visa`. */
  readonly key: string;
  /** The channel's logo. */
  readonly imageUrl: string | undefined;
  /** The methods this channel supports. */
  readonly methods: readonly AyaPayMethod[];
  /** Methods the gateway listed that this package does not know yet. */
  readonly unknownMethods: readonly string[];

  constructor(init: {
    name: string;
    key: string;
    imageUrl?: string | undefined;
    methods: readonly AyaPayMethod[];
    unknownMethods?: readonly string[];
  }) {
    this.name = init.name;
    this.key = init.key;
    this.imageUrl = init.imageUrl;
    this.methods = Object.freeze([...init.methods]);
    this.unknownMethods = Object.freeze([...(init.unknownMethods ?? [])]);
  }

  /** Whether the channel supports `method`. */
  supports(method: AyaPayMethod): boolean {
    return this.methods.includes(method);
  }
}

const CURRENCY_MMK = '104';

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  '00': 'successful',
  '01': 'pending',
  '02': 'failed',
  '03': 'failed',
  '04': 'expired',
};

/**
 * The documented field order of the decoded callback / enquiry payload. AYA leaves out fields that
 * do not apply (e.g. card fields for wallet payments) and signs only the ones present. The payload
 * spells `currencyCode` as `currenyCode`.
 */
const PAYLOAD_FIELDS = [
  'merchOrderId',
  'tranId',
  'amount',
  'currencyCode',
  'statusCode',
  'paymentCardNumber',
  'paymentMobileNumber',
  'cardTypeName',
  'cardExpiryDate',
  'nameOnCard',
  'approvalCode',
  'tranRef',
  'userRef1',
  'userRef2',
  'userRef3',
  'userRef4',
  'userRef5',
  'description',
  'dateTime',
] as const;

/**
 * The AYA Payment Gateway (APG): one hosted checkout for AYA Pay, other wallets and cards, with
 * channel listing, status enquiry and verified callbacks.
 */
export class AyaPay {
  /** The configuration in use. */
  readonly config: AyaPayConfig;
  private readonly transport: Transport;

  constructor(config: AyaPayConfig | AyaPayConfigOptions, options: GatewayOptions = {}) {
    this.config = config instanceof AyaPayConfig ? config : new AyaPayConfig(config);
    this.transport = new Transport(httpClientFrom(options));
  }

  /** A gateway configured from the `AYA_PAY_*` (or `AYA_PGW_*`) environment variables. */
  static fromEnv(env: EnvSource = defaultEnv(), options: GatewayOptions = {}): AyaPay {
    return new AyaPay(AyaPayConfig.fromEnv(env), options);
  }

  /** Checks the order against AYA's documented rules; throws an `InvalidPaymentDataError`. */
  static validate(data: AyaPayPaymentData): void {
    const userRefs: unknown = data.userRefs;
    new Validator()
      .required('orderId', data.orderId)
      .length('orderId', data.orderId, 6, 40)
      .amount('amount', data.amount, { gateway: 'AYA Payment Gateway', maxDecimals: 0 })
      .required('channel', data.channel)
      .when(
        !METHODS.includes(data.method),
        'method',
        'The method field must be one of WEB, QR or NOTI.',
      )
      .string('returnUrl', data.returnUrl)
      .url('returnUrl', data.returnUrl)
      .string('description', data.description)
      .when(
        userRefs !== undefined &&
          (!Array.isArray(userRefs) || userRefs.some((ref) => typeof ref !== 'string')),
        'userRefs',
        'The userRefs field must be a list of strings.',
      )
      .when(
        Array.isArray(userRefs) && userRefs.length > 5,
        'userRefs',
        'The userRefs field must not have more than 5 items.',
      )
      .validate();
  }

  /** Lists the payment channels enabled for your merchant account. */
  async services(options: RequestOptions = {}): Promise<AyaPayService[]> {
    const timestamp = unixTime();
    const body = await this.post(
      'services',
      {
        appKey: this.config.appKey,
        timestamp,
        checkSum: this.checksum([this.config.appKey, this.config.appSecret, String(timestamp)]),
      },
      options.signal,
    );

    const list = Array.isArray(body.data) ? body.data : [];
    const services: AyaPayService[] = [];
    for (const entry of list) {
      if (!isLosslessObject(entry) || get(entry, 'key') === '') {
        continue;
      }
      const methods: AyaPayMethod[] = [];
      const unknownMethods: string[] = [];
      for (const method of Array.isArray(entry.methods) ? entry.methods : []) {
        const name = scalarString(method) ?? '';
        if (METHODS.includes(name)) {
          methods.push(name as AyaPayMethod);
        } else {
          unknownMethods.push(name);
        }
      }
      services.push(
        new AyaPayService({
          name: get(entry, 'name') || get(entry, 'key'),
          key: get(entry, 'key'),
          imageUrl: optional(entry, 'image_url'),
          methods,
          unknownMethods,
        }),
      );
    }
    return services;
  }

  /**
   * Signs the order. The customer's browser must POST the returned form to AYA's hosted checkout;
   * `toHtml()` renders a page that does it. Makes no network call.
   */
  initiate(data: AyaPayPaymentData): FormPayment {
    AyaPay.validate(data);

    const refs = [...(data.userRefs ?? []), '', '', '', '', ''].slice(0, 5);
    const fields: FormField[] = [
      { name: 'merchOrderId', value: data.orderId },
      { name: 'amount', value: String(toAmount(data.amount)) },
      { name: 'appKey', value: this.config.appKey },
      { name: 'timestamp', value: String(unixTime()) },
      { name: 'userRef1', value: refs[0] as string },
      { name: 'userRef2', value: refs[1] as string },
      { name: 'userRef3', value: refs[2] as string },
      { name: 'userRef4', value: refs[3] as string },
      { name: 'userRef5', value: refs[4] as string },
      { name: 'description', value: data.description ?? '' },
      { name: 'currencyCode', value: CURRENCY_MMK },
      { name: 'channel', value: data.channel },
      { name: 'method', value: data.method },
      { name: 'overrideFrontendRedirectUrl', value: data.returnUrl ?? '' },
    ];
    fields.push({ name: 'checkSum', value: this.checksum(fields.map((field) => field.value)) });

    return new FormPayment({
      orderId: data.orderId,
      action: `${this.config.baseUrl}/v1/payment/request`,
      fields,
      enctype: 'multipart/form-data',
    });
  }

  /** Asks AYA for the current state of an order (enquiry). */
  async status(orderId: string, options: RequestOptions = {}): Promise<PaymentStatusResult> {
    const timestamp = unixTime();
    const body = await this.post(
      'enquiry',
      {
        merchOrderId: orderId,
        appKey: this.config.appKey,
        timestamp,
        checkSum: this.checksum([orderId, String(timestamp), this.config.appKey]),
      },
      options.signal,
    );

    const payload = this.verifiedPayload(object(body, 'data') ?? {}, 'enquiry response');
    const statusCode = trimmed(payload, 'statusCode');
    return new PaymentStatusResult({
      orderId: optional(payload, 'merchOrderId') || orderId,
      status: resolveStatus(STATUSES, statusCode),
      gatewayStatus: statusCode,
      gatewayReference: optional(payload, 'tranId'),
      amount: optional(payload, 'amount'),
      raw: toPlainObject(payload),
    });
  }

  /** Verifies AYA's backend callback. */
  handleCallback(request: CallbackRequest): PaymentCallback {
    return toCallback(this.verifiedPayload(losslessInput(request), 'callback'));
  }

  /**
   * Verifies the signed query string AYA adds when it sends the customer back to your return URL.
   * Use it to show the right page; fulfill orders from the backend callback.
   */
  verifyRedirect(request: CallbackRequest): PaymentCallback {
    return toCallback(this.verifiedPayload(losslessQueryInput(request), 'redirect'));
  }

  /** Decodes a `payload` + `checkSum` pair and returns the payload if the checksum matches. */
  private verifiedPayload(input: LosslessObject, context: string): LosslessObject {
    const fail = (): SignatureVerificationError =>
      new SignatureVerificationError(
        `AYA Pay ${context} checksum verification failed.`,
        toPlainObject(input),
      );

    const json = decodeBase64(get(input, 'payload'));
    const payload = json === undefined ? undefined : parseJsonObject(json);
    if (payload === undefined) {
      throw fail();
    }

    const parts: string[] = [];
    for (const field of PAYLOAD_FIELDS) {
      const key = field === 'currencyCode' && 'currenyCode' in payload ? 'currenyCode' : field;
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        parts.push(scalarString(payload[key]) ?? '');
      }
    }

    if (!safeEqual(this.checksum(parts), get(input, 'checkSum').toLowerCase())) {
      throw fail();
    }
    return payload;
  }

  private checksum(parts: readonly string[]): string {
    return hmacSha256Hex(this.config.appSecret, parts.join(':'));
  }

  private async post(
    endpoint: string,
    data: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<LosslessObject> {
    const response = await this.transport.postJson(
      `${this.config.baseUrl}/v1/payment/${endpoint}`,
      data,
      {},
      signal,
    );
    const body = response.json();
    const status = get(body, 'status');
    if (!response.successful() || status !== '00') {
      const message = optional(body, 'message');
      throw new ApiError(
        status
          ? `AYA Pay ${endpoint} failed: [${status}] ${message ?? ''}`.trimEnd()
          : `AYA Pay ${endpoint} failed with HTTP ${response.status}.`,
        {
          gatewayCode: status || undefined,
          gatewayMessage: message,
          httpStatus: response.status,
          raw: toPlainObject(body),
        },
      );
    }
    return body;
  }
}

function toCallback(payload: LosslessObject): PaymentCallback {
  const statusCode = trimmed(payload, 'statusCode');
  return new PaymentCallback({
    orderId: get(payload, 'merchOrderId'),
    status: resolveStatus(STATUSES, statusCode),
    gatewayStatus: statusCode,
    gatewayReference: optional(payload, 'tranId'),
    amount: optional(payload, 'amount'),
    raw: toPlainObject(payload),
  });
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}
