import { Amount, type AmountInput } from '../core/amount.js';
import { MemoryTokenCache, type TokenCache } from '../core/cache.js';
import { CallbackRequest, losslessBody, PaymentCallback } from '../core/callback.js';
import { randomHex, sha256Hex } from '../core/crypto.js';
import {
  defaultEnv,
  envOptions,
  HTTP_TIMEOUT_VARIABLE,
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
import { toPlainObject } from '../core/json.js';
import { MiniAppPayment } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { asciiTrim, asciiTrimEnd, get, isNested, optional, trimmed } from '../core/values.js';
import { WavePayMiniAppSigner } from './signer.js';

/** The settings of {@link WavePayMiniAppConfig}. */
export interface WavePayMiniAppConfigOptions {
  /** The client id Wave issued, sent to the token endpoint. */
  clientId: string;
  /** The client secret Wave issued, sent to the token endpoint. */
  clientSecret: string;
  /** The mini app id Wave issued (`miniAppID` in `makePayment`). */
  miniAppId: string;
  /** The hash secret key Wave issued for payment and callback hashes. */
  secretKey: string;
  /**
   * The API base URL, e.g. `WavePayMiniAppConfig.PRODUCTION_URL` or
   * `https://preprodnewapi.wavemoney.io`. Tokens are requested at its
   * `/auth/v1/external-utility/token`.
   */
  baseUrl: string;
  /**
   * Seconds before the default HTTP client gives up on a request, a whole number greater than 0
   * (or its text). Defaults to 30 (`DEFAULT_TIMEOUT_SECONDS`) when unset or blank. A
   * client you pass keeps its own timeout.
   */
  timeoutSeconds?: number | string | null | undefined;
}

/**
 * Wave Pay Mini App (Wave Money JS SDK) credentials and endpoint. Every setting is required except
 * the HTTP timeout; a missing one throws a `ConfigurationError`. `PRODUCTION_URL` names
 * production's API base URL.
 */
export class WavePayMiniAppConfig {
  static readonly PRODUCTION_URL = 'https://api.wavemoney.io:8100';

  readonly clientId: string;
  readonly clientSecret: string;
  /** The mini app id (`miniAppID`). */
  readonly miniAppId: string;
  /** The hash secret key. */
  readonly secretKey: string;
  /** The API base URL in use. */
  readonly baseUrl: string;
  /** Seconds before the default HTTP client gives up on a request. */
  readonly timeoutSeconds: number;

  constructor(options: WavePayMiniAppConfigOptions) {
    this.clientId = requireSetting('wave_pay_mini_app', 'client_id', options.clientId);
    this.clientSecret = requireSetting('wave_pay_mini_app', 'client_secret', options.clientSecret);
    this.miniAppId = requireSetting('wave_pay_mini_app', 'mini_app_id', options.miniAppId);
    this.secretKey = requireSetting('wave_pay_mini_app', 'secret_key', options.secretKey);
    this.baseUrl = trimUrl(requireSetting('wave_pay_mini_app', 'base_url', options.baseUrl));
    this.timeoutSeconds = resolveTimeout('wave_pay_mini_app', options.timeoutSeconds);
  }

  /**
   * Reads `WAVE_PAY_MINI_APP_CLIENT_ID`, `WAVE_PAY_MINI_APP_CLIENT_SECRET`,
   * `WAVE_PAY_MINI_APP_MINI_APP_ID`, `WAVE_PAY_MINI_APP_SECRET_KEY`, `WAVE_PAY_MINI_APP_BASE_URL`
   * and `MYANMAR_PAYMENTS_HTTP_TIMEOUT`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): WavePayMiniAppConfig {
    return new WavePayMiniAppConfig(
      WavePayMiniAppConfig.optionsFromEnv(env) as WavePayMiniAppConfigOptions,
    );
  }

  /**
   * The options `fromEnv()` reads, without validating them: each value is trimmed of ASCII
   * whitespace and an unset or blank variable is left out (`undefined`). Merge your own options
   * over them per key; the constructor still validates the result, e.g.
   * `new WavePayMiniAppConfig({ ...WavePayMiniAppConfig.optionsFromEnv(), ...options } as WavePayMiniAppConfigOptions)`.
   */
  static optionsFromEnv(env: EnvSource = defaultEnv()): Partial<WavePayMiniAppConfigOptions> {
    return envOptions<WavePayMiniAppConfigOptions>(env, {
      clientId: 'WAVE_PAY_MINI_APP_CLIENT_ID',
      clientSecret: 'WAVE_PAY_MINI_APP_CLIENT_SECRET',
      miniAppId: 'WAVE_PAY_MINI_APP_MINI_APP_ID',
      secretKey: 'WAVE_PAY_MINI_APP_SECRET_KEY',
      baseUrl: 'WAVE_PAY_MINI_APP_BASE_URL',
      timeoutSeconds: HTTP_TIMEOUT_VARIABLE,
    });
  }
}

/** A line item of a mini app payment (`items` in `makePayment`). */
export interface WavePayMiniAppItem {
  /** The item name. */
  name: string;
  /** The item amount in whole kyat, e.g. `Amount.kyat(1000)` or `1000`. */
  amount: AmountInput;
}

/** A Wave Pay Mini App payment: the values signed into Wave's `makePayment` payload. */
export interface WavePayMiniAppPaymentData {
  /** Your order id (`orderID`). */
  orderId: string;
  /**
   * The URL Wave posts the result to (`callBackUrl`). It is signed into the hash, so verify the
   * callback with this same URL.
   */
  callbackUrl: string;
  /** The line items; at least one. */
  items: readonly WavePayMiniAppItem[];
  /**
   * The total in whole kyat. Leave it unset (or `null`) to charge the exact sum of the items. Wave
   * does not accept decimals.
   */
  amount?: AmountInput | null | undefined;
  /**
   * Your reference for this attempt (`merchantRefID`). `payment()` fills it with a random
   * 32-character hex id when empty, so store it afterwards: the callback's `merchantRefId` names
   * the attempt that was paid.
   */
  merchantReferenceId?: string | null | undefined;
}

/** Options of {@link WavePayMiniApp}: the HTTP options plus the access token cache. */
export interface WavePayMiniAppOptions extends GatewayOptions {
  /** Keeps the access token between calls; defaults to a {@link MemoryTokenCache}. */
  tokenCache?: TokenCache | undefined;
}

const GATEWAY = 'Wave Pay Mini App';

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  successful: 'successful',
  processing: 'pending',
  failed: 'failed',
};

/** The callback fields Wave documents. A nested (object or list) value in any of them fails. */
const CALLBACK_FIELDS = [
  'merchantRefId',
  'orderId',
  'amount',
  'msisdn',
  'hashValue',
  'transactionId',
  'transactionStatus',
] as const;

/**
 * Wave Pay Mini App (Wave Money JS SDK spec v1.8): the customer pays inside the WavePay app, on
 * your web page loaded in its webview. Your server covers three steps:
 *
 * 1. {@link accessToken} for the page's `WaveJsSDK.authModule.loginWithAccessToken(token)`.
 * 2. {@link payment} signs the object the page passes to `WaveJsSDK.paymentModule.makePayment(payload)`.
 * 3. {@link handleCallback} verifies the result Wave posts to your callback URL.
 *
 * Wave has no status API, so the callback is the only result. Access tokens are kept in a
 * {@link TokenCache}; share the gateway (or pass a shared cache) so they survive between calls.
 */
export class WavePayMiniApp {
  /**
   * Prefix of the access token's cache key, the same in every Laranex SDK so services in different
   * languages can share one cache. The key ends with the SHA-256 of `<base url>|<client id>`.
   */
  static readonly TOKEN_CACHE_PREFIX = 'myanmar-payments.wave-pay-mini-app.token.';

  /** The configuration in use. */
  readonly config: WavePayMiniAppConfig;
  /** Computes and verifies Wave's hashes. */
  readonly signer: WavePayMiniAppSigner;
  private readonly transport: Transport;
  private readonly cache: TokenCache;

  constructor(
    config: WavePayMiniAppConfig | WavePayMiniAppConfigOptions,
    options: WavePayMiniAppOptions = {},
  ) {
    this.config =
      config instanceof WavePayMiniAppConfig ? config : new WavePayMiniAppConfig(config);
    this.transport = new Transport(httpClientFrom(options, this.config.timeoutSeconds));
    this.signer = new WavePayMiniAppSigner(this.config.secretKey);
    this.cache = options.tokenCache ?? new MemoryTokenCache();
  }

  /** A gateway configured from the `WAVE_PAY_MINI_APP_*` environment variables. */
  static fromEnv(
    env: EnvSource = defaultEnv(),
    options: WavePayMiniAppOptions = {},
  ): WavePayMiniApp {
    return new WavePayMiniApp(WavePayMiniAppConfig.fromEnv(env), options);
  }

  /**
   * The total that will be signed: `amount`, or the exact sum of the items when it is unset.
   * `undefined` when an item amount is missing, malformed or has decimals.
   */
  static resolvedAmount(
    data: Pick<WavePayMiniAppPaymentData, 'amount' | 'items'>,
  ): Amount | undefined {
    if (data.amount !== undefined && data.amount !== null) {
      return toAmount(data.amount);
    }
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return undefined;
    }
    let total = 0n;
    for (const item of data.items as readonly WavePayMiniAppItem[]) {
      const amount = toAmount(item?.amount);
      if (amount === undefined || amount.decimalPlaces() > 0) {
        return undefined;
      }
      total += BigInt(amount.toString());
    }
    return Amount.kyat(total);
  }

  /**
   * Checks the payment against Wave's documented rules; throws an `InvalidPaymentDataError` with
   * every invalid field, in this order: `orderId`, `callbackUrl`, `items`, `merchantReferenceId`,
   * each item's name and amount, then `amount`. Wave gives no length limits, so none are checked.
   */
  static validate(data: WavePayMiniAppPaymentData): void {
    const items: readonly WavePayMiniAppItem[] = Array.isArray(data.items) ? data.items : [];
    const reference = data.merchantReferenceId;
    const validator = new Validator()
      .required('orderId', data.orderId)
      .required('callbackUrl', data.callbackUrl)
      .url('callbackUrl', data.callbackUrl)
      .when(items.length === 0, 'items', 'The items field must have at least one item.')
      .string('merchantReferenceId', reference)
      .when(
        typeof reference === 'string' && reference !== '' && asciiTrim(reference) === '',
        'merchantReferenceId',
        'The merchantReferenceId field is required.',
      );
    items.forEach((item, index) => {
      validator
        .required(`items.${index}.name`, item?.name)
        .amount(`items.${index}.amount`, item?.amount, { gateway: GATEWAY, maxDecimals: 0 });
    });
    const given = data.amount !== undefined && data.amount !== null;
    const resolved = WavePayMiniApp.resolvedAmount(data);
    if (!(items.length > 0 && !given && resolved === undefined)) {
      validator.amount('amount', given ? data.amount : resolved, {
        gateway: GATEWAY,
        maxDecimals: 0,
      });
    }
    validator.validate();
  }

  /**
   * An access token for the mini app page's `WaveJsSDK.authModule.loginWithAccessToken(token)`,
   * from the cache or a form post of the client credentials to
   * `{baseUrl}/auth/v1/external-utility/token`. It is kept for its `expires_in` minus a minute (at
   * least a minute; an hour when Wave sends none). Never call the token endpoint from the page: it
   * needs the client secret. Throws an `ApiError` when the request fails or the response has no
   * `access_token`.
   */
  async accessToken(options: RequestOptions = {}): Promise<string> {
    const key = this.tokenCacheKey();
    const cached = await this.cache.get(key);
    if (typeof cached === 'string' && cached !== '') {
      return cached;
    }

    const response = await this.transport.postForm(
      `${this.config.baseUrl}/auth/v1/external-utility/token`,
      {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
      },
      {},
      options.signal,
    );

    const body = response.json();
    const token = get(body, 'access_token');
    if (!response.successful() || token === '') {
      const errorCode = optional(body, 'error') || undefined;
      const message = optional(body, 'error_description') || optional(body, 'message') || undefined;
      throw new ApiError(
        errorCode
          ? asciiTrimEnd(`${GATEWAY} token request failed: [${errorCode}] ${message ?? ''}`)
          : `${GATEWAY} token request failed with HTTP ${response.status}.`,
        {
          gatewayCode: errorCode,
          gatewayMessage: message,
          httpStatus: response.status,
          raw: toPlainObject(body),
        },
      );
    }

    // The leading digits of `expires_in` after any whitespace; missing, non-numeric or 0 means an
    // hour.
    const expiresIn = Number(/^[ \t\n\v\f\r]*(\d+)/.exec(get(body, 'expires_in'))?.[1] ?? 0);
    await this.cache.set(key, token, Math.max(60, (expiresIn > 0 ? expiresIn : 3600) - 60));
    return token;
  }

  /** Drops the cached access token, e.g. after rotating the client secret. */
  async forgetToken(): Promise<void> {
    await this.cache.delete(this.tokenCacheKey());
  }

  /**
   * Signs a payment for the page's `WaveJsSDK.paymentModule.makePayment(payload)`. No request is
   * sent: pass `JSON.stringify(payment)` (or `payment.toJsonString()`) to the page unchanged. Once
   * `data` passes validation it fills `data.merchantReferenceId` with a random id when empty, so
   * store it afterwards. Invalid data is left untouched.
   */
  payment(data: WavePayMiniAppPaymentData): MiniAppPayment {
    WavePayMiniApp.validate(data);
    if (!data.merchantReferenceId) {
      data.merchantReferenceId = randomHex();
    }

    const amount = WavePayMiniApp.resolvedAmount(data) as Amount;
    return new MiniAppPayment({
      orderId: data.orderId,
      amount,
      miniAppId: this.config.miniAppId,
      merchantReferenceId: data.merchantReferenceId,
      callbackUrl: data.callbackUrl,
      hashValue: this.signer.hash(
        amount.toString(),
        data.orderId,
        this.config.miniAppId,
        data.merchantReferenceId,
        data.callbackUrl,
      ),
      items: data.items.map((item) => ({
        name: item.name,
        amount: toAmount(item.amount) as Amount,
      })),
    });
  }

  /**
   * Verifies Wave's callback. Only `successful` means the customer paid; `processing` is pending
   * and `failed` failed (matched trimmed and case-insensitively).
   *
   * The callback carries neither the mini app id nor the callback URL, so pass the callback URL the
   * payment was signed with: normally the URL this callback was posted to, without its query
   * string. The mini app id comes from the configuration. A nested value, a `hashValue` that is not
   * a string and a wrong hash fail with "Wave Pay Mini App callback hash verification failed.".
   * After the hash matches, `orderId` and `merchantRefId` must not be empty and `amount` must be a
   * whole number, else "Wave Pay Mini App callback is malformed.". `merchantRefId` is in `raw`.
   * Wave defines no response body: acknowledge with an empty 200.
   */
  handleCallback(request: CallbackRequest, callbackUrl: string): PaymentCallback {
    const payload = losslessBody(request);
    const hashValue = payload.hashValue;
    const orderId = get(payload, 'orderId');
    const merchantReferenceId = get(payload, 'merchantRefId');
    const amount = get(payload, 'amount');

    if (
      CALLBACK_FIELDS.some((field) => isNested(payload[field])) ||
      typeof hashValue !== 'string' ||
      !this.signer.verify(
        hashValue,
        amount,
        orderId,
        this.config.miniAppId,
        merchantReferenceId,
        callbackUrl,
      )
    ) {
      throw new SignatureVerificationError(
        `${GATEWAY} callback hash verification failed.`,
        toPlainObject(payload),
      );
    }

    if (orderId === '' || merchantReferenceId === '' || !/^\d+$/.test(amount)) {
      throw new SignatureVerificationError(
        `${GATEWAY} callback is malformed.`,
        toPlainObject(payload),
      );
    }

    const gatewayStatus = trimmed(payload, 'transactionStatus');
    return new PaymentCallback({
      orderId,
      status: resolveStatus(STATUSES, gatewayStatus.toLowerCase()),
      gatewayStatus,
      gatewayReference: optional(payload, 'transactionId'),
      amount,
      raw: toPlainObject(payload),
    });
  }

  private tokenCacheKey(): string {
    return `${WavePayMiniApp.TOKEN_CACHE_PREFIX}${sha256Hex(`${this.config.baseUrl}|${this.config.clientId}`)}`;
  }
}
