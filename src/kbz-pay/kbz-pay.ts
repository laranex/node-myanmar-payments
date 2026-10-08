import { type AmountInput } from '../core/amount.js';
import {
  Acknowledgement,
  CallbackRequest,
  losslessBody,
  PaymentCallback,
  PaymentStatusResult,
} from '../core/callback.js';
import { queryEscape, randomHex } from '../core/crypto.js';
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
import { toPlainObject, type LosslessObject } from '../core/json.js';
import { AppPayment, QrPayment, RedirectPayment } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { get, object, optional, trimmed } from '../core/values.js';
import { KbzPaySigner } from './signer.js';

/** The settings of {@link KbzPayConfig}. */
export interface KbzPayConfigOptions {
  /** The `appid` KBZ issued for your merchant app. */
  appId: string;
  /** The secret key used to sign requests. */
  appKey: string;
  /** The `merch_code` KBZ issued. */
  merchantCode: string;
  /** Use the UAT endpoints (default `true`). UAT and production issue separate credentials. */
  sandbox?: boolean | undefined;
  /** Overrides the API base URL, e.g. to go through a proxy. */
  apiUrl?: string | undefined;
  /** Overrides the PWA checkout URL. A trailing `#` or `#/` is normalized to `#/`. */
  pwaUrl?: string | undefined;
}

/**
 * KBZ Pay credentials and endpoints. A missing credential throws a `ConfigurationError`.
 */
export class KbzPayConfig {
  static readonly SANDBOX_API_URL = 'http://api-uat.kbzpay.com/payment/gateway/uat';
  static readonly PRODUCTION_API_URL = 'https://api.kbzpay.com/payment/gateway';
  static readonly SANDBOX_PWA_URL = 'https://static.kbzpay.com/pgw/uat/pwa/#/';
  static readonly PRODUCTION_PWA_URL = 'https://wap.kbzpay.com/pgw/pwa/#/';

  readonly appId: string;
  readonly appKey: string;
  readonly merchantCode: string;
  readonly sandbox: boolean;
  /** The API base URL in use. */
  readonly apiUrl: string;
  /** The PWA checkout URL in use, always ending in `/`. */
  readonly pwaUrl: string;

  constructor(options: KbzPayConfigOptions) {
    this.appId = requireSetting('kbz_pay', 'app_id', options.appId);
    this.appKey = requireSetting('kbz_pay', 'app_key', options.appKey);
    this.merchantCode = requireSetting('kbz_pay', 'merchant_code', options.merchantCode);
    this.sandbox = options.sandbox ?? true;
    this.apiUrl = trimUrl(
      optionalSetting(options.apiUrl) ??
        (this.sandbox ? KbzPayConfig.SANDBOX_API_URL : KbzPayConfig.PRODUCTION_API_URL),
    );
    this.pwaUrl = `${trimUrl(
      optionalSetting(options.pwaUrl) ??
        (this.sandbox ? KbzPayConfig.SANDBOX_PWA_URL : KbzPayConfig.PRODUCTION_PWA_URL),
    )}/`;
  }

  /**
   * Reads `KBZ_PAY_APP_ID`, `KBZ_PAY_APP_KEY`, `KBZ_PAY_MERCHANT_CODE`, `KBZ_PAY_SANDBOX`,
   * `KBZ_PAY_BASE_URL` and `KBZ_PAY_PWA_BASE_REDIRECT_URL`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): KbzPayConfig {
    return new KbzPayConfig({
      appId: envFirst(env, 'KBZ_PAY_APP_ID'),
      appKey: envFirst(env, 'KBZ_PAY_APP_KEY'),
      merchantCode: envFirst(env, 'KBZ_PAY_MERCHANT_CODE'),
      sandbox: envSandbox(env, 'KBZ_PAY_SANDBOX'),
      apiUrl: envFirst(env, 'KBZ_PAY_BASE_URL'),
      pwaUrl: envFirst(env, 'KBZ_PAY_PWA_BASE_REDIRECT_URL'),
    });
  }
}

/**
 * A KBZ Pay order, used for the PWA, QR and in-app flows alike. KBZ Pay only accepts MMK.
 */
export interface KbzPayPaymentData {
  /** Your unique order id (`merch_order_id`): letters, digits and `_` only, at most 40. */
  orderId: string;
  /** Kyat, greater than 0 with at most 2 decimal places, e.g. `Amount.kyat(1000)` or `Amount.parse('1000.50')`. */
  amount: AmountInput;
  /** The public URL KBZ posts the result to (`notify_url`): at most 512 characters, no query string. */
  callbackUrl: string;
  /** The product name shown to the customer. */
  title?: string | undefined;
  /** How long the order stays payable, 1 to 120 minutes. KBZ defaults to 120. */
  timeoutMinutes?: number | undefined;
  /** Free text KBZ sends back unchanged in the callback, at most 512 characters once URL-encoded. */
  callbackInfo?: string | undefined;
}

const ORDER_ID = /^[A-Za-z0-9_]+$/;

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  PAY_SUCCESS: 'successful',
  WAIT_PAY: 'pending',
  PAYING: 'pending',
  PAY_FAILED: 'failed',
  ORDER_CLOSED: 'cancelled',
  ORDER_EXPIRED: 'expired',
};

interface Order {
  prepayId: string;
  nonce: string;
  timestamp: string;
  response: LosslessObject;
}

/**
 * KBZ Pay: PWA (redirect), QR and in-app payments, order status queries and payment
 * notifications.
 */
export class KbzPay {
  /** The configuration in use. */
  readonly config: KbzPayConfig;
  /** KBZ Pay's request signer, for custom calls. */
  readonly signer: KbzPaySigner;
  private readonly transport: Transport;

  constructor(config: KbzPayConfig | KbzPayConfigOptions, options: GatewayOptions = {}) {
    this.config = config instanceof KbzPayConfig ? config : new KbzPayConfig(config);
    this.signer = new KbzPaySigner(this.config.appKey);
    this.transport = new Transport(httpClientFrom(options));
  }

  /** A gateway configured from the `KBZ_PAY_*` environment variables. */
  static fromEnv(env: EnvSource = defaultEnv(), options: GatewayOptions = {}): KbzPay {
    return new KbzPay(KbzPayConfig.fromEnv(env), options);
  }

  /** Checks the order against KBZ's documented limits; throws an `InvalidPaymentDataError`. */
  static validate(data: KbzPayPaymentData): void {
    const callbackUrl = typeof data.callbackUrl === 'string' ? data.callbackUrl : '';
    new Validator()
      .required('orderId', data.orderId)
      .max('orderId', data.orderId, 40)
      .pattern('orderId', data.orderId, ORDER_ID, 'letters, numbers and underscores')
      .amount('amount', data.amount, { gateway: 'KBZ Pay', maxDecimals: 2 })
      .required('callbackUrl', data.callbackUrl)
      .url('callbackUrl', callbackUrl)
      .max('callbackUrl', callbackUrl, 512)
      .when(
        callbackUrl.includes('?'),
        'callbackUrl',
        'The callbackUrl field must not contain a query string.',
      )
      .string('title', data.title)
      .between('timeoutMinutes', data.timeoutMinutes, 1, 120)
      .string('callbackInfo', data.callbackInfo)
      .max(
        'callbackInfo',
        typeof data.callbackInfo === 'string' ? queryEscape(data.callbackInfo) : undefined,
        512,
      )
      .validate();
  }

  /**
   * Creates an order and returns the KBZ Pay PWA checkout URL to redirect the customer to.
   *
   * The redirect only works on a phone with the KBZ Pay app installed, and its Referer must match
   * the URL registered with KBZ.
   */
  async pwa(data: KbzPayPaymentData, options: RequestOptions = {}): Promise<RedirectPayment> {
    const order = await this.precreate(data, 'PWAAPP', options);
    const fields = this.orderInfoFields(order);
    return new RedirectPayment({
      orderId: data.orderId,
      url: `${this.config.pwaUrl}?${this.signer.signString(fields)}&sign=${this.signer.sign(fields)}`,
      gatewayReference: order.prepayId,
      raw: toPlainObject(order.response),
    });
  }

  /** Creates an order and returns a QR payload for the customer to scan with the KBZ Pay app. */
  async qr(data: KbzPayPaymentData, options: RequestOptions = {}): Promise<QrPayment> {
    const order = await this.precreate(data, 'PAY_BY_QRCODE', options);
    const qrCode = get(order.response, 'qrCode');
    if (qrCode === '') {
      throw new ApiError('KBZ Pay did not return a QR code.', {
        raw: toPlainObject(order.response),
      });
    }
    return new QrPayment({
      orderId: data.orderId,
      qrString: qrCode,
      expiresAt:
        data.timeoutMinutes === undefined
          ? undefined
          : new Date(Date.now() + data.timeoutMinutes * 60_000),
      reference: order.prepayId,
      raw: toPlainObject(order.response),
    });
  }

  /**
   * Creates an order and returns the signed values your mobile app passes to `KBZPay.startPay()`.
   * The SDK's own result only means the payment screen closed; rely on the callback or `status()`.
   */
  async app(data: KbzPayPaymentData, options: RequestOptions = {}): Promise<AppPayment> {
    const order = await this.precreate(data, 'APP', options);
    const fields = this.orderInfoFields(order);
    return new AppPayment({
      orderId: data.orderId,
      orderInfo: this.signer.signString(fields),
      sign: this.signer.sign(fields),
      signType: 'SHA256',
      raw: toPlainObject(order.response),
    });
  }

  /** Asks KBZ Pay for the current state of an order (`queryorder`). */
  async status(orderId: string, options: RequestOptions = {}): Promise<PaymentStatusResult> {
    const response = await this.call(
      'queryorder',
      'kbz.payment.queryorder',
      '3.0',
      {
        appid: this.config.appId,
        merch_code: this.config.merchantCode,
        merch_order_id: orderId,
      },
      {},
      randomHex(),
      timestamp(),
      options.signal,
    );

    const tradeStatus = trimmed(response, 'trade_status');
    return new PaymentStatusResult({
      orderId: optional(response, 'merch_order_id') || orderId,
      status: resolveStatus(STATUSES, tradeStatus),
      gatewayStatus: tradeStatus,
      gatewayReference: optional(response, 'mm_order_id'),
      amount: optional(response, 'total_amount'),
      raw: toPlainObject(response),
    });
  }

  /**
   * Verifies KBZ Pay's payment notification. Reply with the callback's `acknowledgement` (plain
   * `success`) or KBZ retries.
   */
  handleCallback(request: CallbackRequest): PaymentCallback {
    const input = losslessBody(request);
    const fields = object(input, 'Request') ?? input;

    if (!this.signer.verify(fields)) {
      throw new SignatureVerificationError(
        'KBZ Pay callback signature verification failed.',
        toPlainObject(input),
      );
    }

    const tradeStatus = trimmed(fields, 'trade_status');
    return new PaymentCallback({
      orderId: get(fields, 'merch_order_id'),
      status: resolveStatus(STATUSES, tradeStatus),
      gatewayStatus: tradeStatus,
      gatewayReference: optional(fields, 'mm_order_id'),
      amount: optional(fields, 'total_amount'),
      raw: toPlainObject(fields),
      acknowledgement: new Acknowledgement({ body: 'success' }),
    });
  }

  private async precreate(
    data: KbzPayPaymentData,
    tradeType: string,
    options: RequestOptions,
  ): Promise<Order> {
    KbzPay.validate(data);

    const biz: Record<string, string> = {
      appid: this.config.appId,
      merch_code: this.config.merchantCode,
      merch_order_id: data.orderId,
      trade_type: tradeType,
      total_amount: String(toAmount(data.amount)),
      trans_currency: 'MMK',
    };
    if (data.title) {
      biz.title = data.title;
    }
    if (data.timeoutMinutes !== undefined) {
      biz.timeout_express = `${data.timeoutMinutes}m`;
    }
    if (data.callbackInfo) {
      biz.callback_info = queryEscape(data.callbackInfo);
    }

    const nonce = randomHex();
    const time = timestamp();
    const response = await this.call(
      'precreate',
      'kbz.payment.precreate',
      '1.0',
      biz,
      { notify_url: data.callbackUrl },
      nonce,
      time,
      options.signal,
    );

    const prepayId = get(response, 'prepay_id');
    if (prepayId === '') {
      throw new ApiError('KBZ Pay did not return a prepay_id.', { raw: toPlainObject(response) });
    }
    return { prepayId, nonce, timestamp: time, response };
  }

  /** Sends a signed request and returns the `Response` object, throwing when KBZ reports an error. */
  private async call(
    endpoint: string,
    method: string,
    version: string,
    biz: Record<string, string>,
    extra: Record<string, string>,
    nonce: string,
    time: string,
    signal: AbortSignal | undefined,
  ): Promise<LosslessObject> {
    const common: Record<string, string> = {
      timestamp: time,
      method,
      nonce_str: nonce,
      version,
      ...extra,
    };
    const request = {
      ...common,
      sign_type: 'SHA256',
      sign: this.signer.sign({ ...common, ...biz }),
      biz_content: biz,
    };

    const response = await this.transport.postJson(
      `${this.config.apiUrl}/${endpoint}`,
      { Request: request },
      {},
      signal,
    );
    const body = response.json();
    const result = object(body, 'Response') ?? {};

    if (
      !response.successful() ||
      get(result, 'result') !== 'SUCCESS' ||
      get(result, 'code') !== '0'
    ) {
      const code = optional(result, 'code');
      const message = optional(result, 'msg');
      throw new ApiError(
        code
          ? `KBZ Pay ${endpoint} failed: [${code}] ${message ?? ''}`.trimEnd()
          : `KBZ Pay ${endpoint} failed with HTTP ${response.status}.`,
        {
          gatewayCode: code,
          gatewayMessage: message,
          httpStatus: response.status,
          raw: toPlainObject(body),
        },
      );
    }
    return result;
  }

  private orderInfoFields(order: Order): Record<string, string> {
    return {
      appid: this.config.appId,
      merch_code: this.config.merchantCode,
      nonce_str: order.nonce,
      prepay_id: order.prepayId,
      timestamp: order.timestamp,
    };
  }
}

function timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}
