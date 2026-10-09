import { type AmountInput } from '../core/amount.js';
import { CallbackRequest, losslessInput, PaymentCallback } from '../core/callback.js';
import { hmacSha256Base64, randomHex, safeEqual } from '../core/crypto.js';
import {
  defaultEnv,
  envFirst,
  envSandbox,
  parseSandbox,
  optionalSetting,
  requireSetting,
  trimUrl,
  type EnvSource,
} from '../core/env.js';
import { SignatureVerificationError } from '../core/errors.js';
import { setKey, toPlainObject, type LosslessObject } from '../core/json.js';
import { FormPayment, type FormField } from '../core/results.js';
import { resolveStatus, type PaymentStatus } from '../core/status.js';
import { toAmount, Validator } from '../core/validate.js';
import { get, optional, scalarString, trimmed } from '../core/values.js';

/** The settings of {@link CyberSourceConfig}. */
export interface CyberSourceConfigOptions {
  /** The Secure Acceptance profile id. */
  profileId: string;
  /** The profile's access key. */
  accessKey: string;
  /** The profile's secret key, which signs the fields. */
  secretKey: string;
  /**
   * Use the test environment (default `true`).
   * Text is read like a `*_SANDBOX` variable: `false`, `0`, `f`, `no` or `off` select production.
   */
  sandbox?: boolean | string | undefined;
  /** Overrides the Secure Acceptance base URL. */
  baseUrl?: string | undefined;
}

/**
 * A CyberSource Secure Acceptance profile. A missing credential throws a `ConfigurationError`.
 */
export class CyberSourceConfig {
  static readonly SANDBOX_URL = 'https://testsecureacceptance.cybersource.com';
  static readonly PRODUCTION_URL = 'https://secureacceptance.cybersource.com';

  readonly profileId: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly sandbox: boolean;
  /** The base URL in use. */
  readonly baseUrl: string;

  constructor(options: CyberSourceConfigOptions) {
    this.profileId = requireSetting('cyber_source', 'profile_id', options.profileId);
    this.accessKey = requireSetting('cyber_source', 'access_key', options.accessKey);
    this.secretKey = requireSetting('cyber_source', 'secret_key', options.secretKey);
    this.sandbox = parseSandbox(options.sandbox);
    this.baseUrl = trimUrl(
      optionalSetting(options.baseUrl) ??
        (this.sandbox ? CyberSourceConfig.SANDBOX_URL : CyberSourceConfig.PRODUCTION_URL),
    );
  }

  /**
   * Reads `CYBER_SOURCE_PROFILE_ID`, `CYBER_SOURCE_ACCESS_KEY`, `CYBER_SOURCE_SECRET_KEY`,
   * `CYBER_SOURCE_SANDBOX` and `CYBER_SOURCE_BASE_URL`.
   */
  static fromEnv(env: EnvSource = defaultEnv()): CyberSourceConfig {
    return new CyberSourceConfig({
      profileId: envFirst(env, 'CYBER_SOURCE_PROFILE_ID'),
      accessKey: envFirst(env, 'CYBER_SOURCE_ACCESS_KEY'),
      secretKey: envFirst(env, 'CYBER_SOURCE_SECRET_KEY'),
      sandbox: envSandbox(env, 'CYBER_SOURCE_SANDBOX'),
      baseUrl: envFirst(env, 'CYBER_SOURCE_BASE_URL'),
    });
  }
}

/** What CyberSource does with the card. */
export type CyberSourceTransactionType =
  'sale' | 'authorization' | 'sale,create_payment_token' | 'authorization,create_payment_token';

/** The CyberSource transaction types. */
export const CyberSourceTransactionType = Object.freeze({
  /** Authorize and capture in one step. */
  Sale: 'sale',
  /** Authorize only; capture later. */
  Authorization: 'authorization',
  /** A sale that also saves the card as a payment token. */
  SaleAndCreateToken: 'sale,create_payment_token',
  /** An authorization that also saves the card as a payment token. */
  AuthorizationAndCreateToken: 'authorization,create_payment_token',
} as const);

const TRANSACTION_TYPES: readonly string[] = Object.values(CyberSourceTransactionType);

/**
 * A Secure Acceptance card payment. CyberSource is multi-currency.
 */
export interface CyberSourcePaymentData {
  /** Your order id (`reference_number`), at most 50 characters. Echoed back as `req_reference_number`. */
  orderId: string;
  /** The total in `currency`: 0 or more, any decimals, at most 15 characters, e.g. `Amount.parse('10.50')`. */
  amount: AmountInput;
  /** The URL CyberSource posts the result to (`override_backoffice_post_url`), at most 255 characters. */
  callbackUrl: string;
  /** The receipt page (`override_custom_receipt_page`), at most 255 characters. */
  returnUrl?: string | undefined;
  /** The page shown on cancel (`override_custom_cancel_page`), at most 255 characters. */
  cancelUrl?: string | undefined;
  /** An ISO 4217 code (default `MMK`). */
  currency?: string | undefined;
  /** What to do with the card (default `sale`). */
  transactionType?: CyberSourceTransactionType | undefined;
  /** The hosted page language, e.g. `en-us` (the default). */
  locale?: string | undefined;
}

const SIGNED_FIELDS = [
  'access_key',
  'profile_id',
  'transaction_uuid',
  'signed_field_names',
  'signed_date_time',
  'locale',
  'transaction_type',
  'reference_number',
  'amount',
  'currency',
  'override_custom_receipt_page',
  'override_backoffice_post_url',
  'override_custom_cancel_page',
] as const;

const STATUSES: Readonly<Record<string, PaymentStatus>> = {
  ACCEPT: 'successful',
  REVIEW: 'pending',
  DECLINE: 'failed',
  ERROR: 'failed',
  CANCEL: 'canceled',
};

/**
 * CyberSource Secure Acceptance hosted checkout for card payments: signs the form and verifies the
 * result posts. Makes no network calls.
 */
export class CyberSource {
  /** The configuration in use. */
  readonly config: CyberSourceConfig;

  constructor(config: CyberSourceConfig | CyberSourceConfigOptions) {
    this.config = config instanceof CyberSourceConfig ? config : new CyberSourceConfig(config);
  }

  /** A gateway configured from the `CYBER_SOURCE_*` environment variables. */
  static fromEnv(env: EnvSource = defaultEnv()): CyberSource {
    return new CyberSource(CyberSourceConfig.fromEnv(env));
  }

  /** Checks the payment against the Secure Acceptance field reference; throws an `InvalidPaymentDataError`. */
  static validate(data: CyberSourcePaymentData): void {
    new Validator()
      .required('orderId', data.orderId)
      .max('orderId', data.orderId, 50)
      .amount('amount', data.amount, {
        gateway: 'CyberSource',
        maxDecimals: null,
        maxLength: 15,
        allowZero: true,
      })
      .required('callbackUrl', data.callbackUrl)
      .url('callbackUrl', data.callbackUrl)
      .max('callbackUrl', data.callbackUrl, 255)
      .string('returnUrl', data.returnUrl)
      .url('returnUrl', data.returnUrl)
      .max('returnUrl', data.returnUrl, 255)
      .string('cancelUrl', data.cancelUrl)
      .url('cancelUrl', data.cancelUrl)
      .max('cancelUrl', data.cancelUrl, 255)
      .pattern(
        'currency',
        String(data.currency || 'MMK'),
        /^[A-Z]{3}$/,
        'a three letter ISO 4217 code',
      )
      .pattern(
        'locale',
        String(data.locale || 'en-us'),
        /^[a-z]{2}-[a-z]{2}$/,
        'a locale code such as en-us',
      )
      .when(
        !TRANSACTION_TYPES.includes(String(data.transactionType || 'sale')),
        'transactionType',
        'The transactionType field is not a supported transaction type.',
      )
      .validate();
  }

  /**
   * Signs the payment fields. The customer's browser must POST the returned form to CyberSource;
   * `toHtml()` renders a page that does it.
   */
  initiate(data: CyberSourcePaymentData): FormPayment {
    CyberSource.validate(data);

    const values: Record<(typeof SIGNED_FIELDS)[number], string> = {
      access_key: this.config.accessKey,
      profile_id: this.config.profileId,
      transaction_uuid: randomHex(),
      signed_field_names: SIGNED_FIELDS.join(','),
      signed_date_time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      locale: data.locale || 'en-us',
      transaction_type: data.transactionType || 'sale',
      reference_number: data.orderId,
      amount: String(toAmount(data.amount)),
      currency: data.currency || 'MMK',
      override_custom_receipt_page: data.returnUrl ?? '',
      override_backoffice_post_url: data.callbackUrl,
      override_custom_cancel_page: data.cancelUrl ?? '',
    };

    const fields: FormField[] = SIGNED_FIELDS.map((name) => ({ name, value: values[name] }));
    fields.push({ name: 'signature', value: this.sign(values) as string });

    return new FormPayment({
      orderId: data.orderId,
      action: `${this.config.baseUrl}/pay`,
      fields,
    });
  }

  /**
   * Verifies CyberSource's result post. The same check works for the browser post to your receipt
   * page. Only the fields listed in `signed_field_names` are trusted: `decision` and
   * `req_reference_number` must be signed, and unsigned fields are left out of the result.
   */
  handleCallback(request: CallbackRequest): PaymentCallback {
    const payload = losslessInput(request);
    const expected = this.sign(payload);
    const names = signedNames(payload);
    if (
      expected === undefined ||
      !safeEqual(expected, get(payload, 'signature')) ||
      !names.includes('decision') ||
      !names.includes('req_reference_number')
    ) {
      throw new SignatureVerificationError(
        'CyberSource callback signature verification failed.',
        toPlainObject(payload),
      );
    }

    // A signature only covers the listed fields, so anything else in the post could have been
    // added by the sender (e.g. a `decision` next to the signed request fields).
    const signed: LosslessObject = {};
    for (const name of [...names, 'signature']) {
      setKey(signed, name, payload[name]);
    }

    const decision = trimmed(signed, 'decision').toUpperCase();
    return new PaymentCallback({
      orderId: get(signed, 'req_reference_number'),
      status: resolveStatus(STATUSES, decision),
      gatewayStatus: decision,
      gatewayReference: optional(signed, 'transaction_id'),
      amount: get(signed, 'auth_amount') || optional(signed, 'req_amount'),
      raw: toPlainObject(signed),
    });
  }

  /** Signs the fields listed in `signed_field_names`; `undefined` when a listed field is missing. */
  private sign(fields: Readonly<Record<string, unknown>>): string | undefined {
    const pairs: string[] = [];
    for (const name of signedNames(fields)) {
      const value = scalarString(fields[name]);
      if (value === undefined) {
        return undefined;
      }
      pairs.push(`${name}=${value}`);
    }
    return pairs.length === 0
      ? undefined
      : hmacSha256Base64(this.config.secretKey, pairs.join(','));
  }
}

/** The names listed in `signed_field_names`, in order. */
function signedNames(fields: Readonly<Record<string, unknown>>): string[] {
  return get(fields, 'signed_field_names')
    .split(',')
    .filter((name) => name !== '');
}
