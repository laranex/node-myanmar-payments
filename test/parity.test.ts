import { describe, expect, it } from 'vitest';

import {
  Amount,
  AyaPay,
  AyaPayConfig,
  CallbackRequest,
  ConfigurationError,
  CyberSource,
  CyberSourceConfig,
  FormPayment,
  InvalidPaymentDataError,
  KbzPay,
  KbzPayConfig,
  SignatureVerificationError,
  WaveMoney,
  WaveMoneyConfig,
  YomaMmqr,
  YomaMmqrConfig,
  type PaymentCallback,
  type TokenCache,
} from '../src/index.js';
import { FakeFetch, fixture } from './helpers.js';

/** The cross-SDK vectors php-, go-, node- and python-myanmar-payments all ship unchanged. */
interface Vectors {
  secrets: Record<string, string>;
  callbacks: Record<string, CallbackCase[]>;
  amount_parse: { input: string; value: string | null }[];
  amount_parse_error: { input: string; errors: Record<string, string> };
  amount_equals: { amount: string; other: string | null; equal: boolean }[];
  sandbox: { value: string; sandbox: boolean }[];
  yoma_mmqr_token_cache_key: { base_url: string; client_id: string; key: string };
  form_html: {
    order_id: string;
    action: string;
    fields: [string, string][];
    enctype: string;
    html: string;
  };
  messages: {
    invalid_payment_data: { errors: Record<string, string>; message: string };
    configuration: { gateway: string; key: string; message: string };
    whole_amounts_only: string;
    aya_whole_amounts_only: string;
    kbz_decimals: string;
    kbz_timeout_zero: string;
  };
}

interface CallbackCase {
  name: string;
  content_type: string;
  body: string;
  expected: {
    valid: boolean;
    order_id?: string;
    status?: string;
    gateway_status?: string;
    gateway_reference?: string;
    amount?: string;
  };
}

const vectors = fixture<Vectors>('parity/vectors.json');
const secrets = vectors.secrets;

const handlers: Record<string, (request: CallbackRequest) => PaymentCallback> = {
  kbz_pay: (request) =>
    new KbzPay({
      appId: 'kp123',
      appKey: secrets.kbz_pay_app_key as string,
      merchantCode: '100001',
    }).handleCallback(request),
  wave_money: (request) =>
    new WaveMoney({
      merchantId: 'merchant',
      secretKey: secrets.wave_money_secret_key as string,
      merchantName: 'Shop',
    }).handleCallback(request),
  aya_pay: (request) =>
    new AyaPay({ appKey: 'app', appSecret: secrets.aya_pay_app_secret as string }).handleCallback(
      request,
    ),
  yoma_mmqr: (request) =>
    new YomaMmqr({
      merchantId: 'merchant',
      clientId: 'client',
      clientSecret: 'secret',
      webhookHashKey: secrets.yoma_mmqr_webhook_hashkey as string,
    }).handleCallback(request),
  cyber_source: (request) =>
    new CyberSource({
      profileId: 'profile',
      accessKey: 'access',
      secretKey: secrets.cyber_source_secret_key as string,
    }).handleCallback(request),
};

const callbackCases = Object.entries(vectors.callbacks).flatMap(([gateway, cases]) =>
  cases.map((vector) => ({ gateway, ...vector })),
);

describe('parity vectors', () => {
  it.each(callbackCases)('$gateway: $name', ({ gateway, content_type, body, expected }) => {
    const request = new CallbackRequest({ body, headers: { 'Content-Type': content_type } });
    const handle = handlers[gateway] as (request: CallbackRequest) => PaymentCallback;

    if (!expected.valid) {
      expect(() => handle(request)).toThrow(SignatureVerificationError);
      return;
    }

    const callback = handle(request);
    expect(callback.orderId).toBe(expected.order_id);
    expect(callback.status).toBe(expected.status);
    expect(callback.gatewayStatus).toBe(expected.gateway_status);
    expect(callback.gatewayReference).toBe(expected.gateway_reference);
    expect(callback.amount).toBe(expected.amount);
  });

  it.each(vectors.amount_parse)('parses amount $input', ({ input, value }) => {
    if (value === null) {
      expect(() => Amount.parse(input)).toThrow(InvalidPaymentDataError);
    } else {
      expect(Amount.parse(input).toString()).toBe(value);
    }
  });

  it('reports a malformed amount with the shared message', () => {
    const { input, errors } = vectors.amount_parse_error;
    try {
      Amount.parse(input);
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidPaymentDataError).errors).toEqual(errors);
    }
  });

  it.each(vectors.amount_equals)('compares $amount with $other', ({ amount, other, equal }) => {
    expect(Amount.parse(amount).equals(other)).toBe(equal);
    if (other !== null && /^\d+(\.\d+)?$/.test(other)) {
      expect(Amount.parse(amount).equals(Amount.parse(other))).toBe(equal);
    }
  });

  it.each(vectors.sandbox)('reads *_SANDBOX=$value', ({ value, sandbox }) => {
    const configs = [
      KbzPayConfig.fromEnv({
        KBZ_PAY_APP_ID: 'a',
        KBZ_PAY_APP_KEY: 'k',
        KBZ_PAY_MERCHANT_CODE: 'm',
        KBZ_PAY_SANDBOX: value,
      }),
      WaveMoneyConfig.fromEnv({
        WAVE_MONEY_MERCHANT_ID: 'm',
        WAVE_MONEY_SECRET_KEY: 's',
        WAVE_MONEY_MERCHANT_NAME: 'n',
        WAVE_MONEY_SANDBOX: value,
      }),
      AyaPayConfig.fromEnv({
        AYA_PAY_APP_KEY: 'k',
        AYA_PAY_APP_SECRET: 's',
        AYA_PAY_SANDBOX: value,
      }),
      YomaMmqrConfig.fromEnv({
        YOMA_MMQR_MERCHANT_ID: 'm',
        YOMA_MMQR_CLIENT_ID: 'c',
        YOMA_MMQR_CLIENT_SECRET: 's',
        YOMA_MMQR_WEBHOOK_HASHKEY: 'h',
        YOMA_MMQR_SANDBOX: value,
      }),
      CyberSourceConfig.fromEnv({
        CYBER_SOURCE_PROFILE_ID: 'p',
        CYBER_SOURCE_ACCESS_KEY: 'a',
        CYBER_SOURCE_SECRET_KEY: 's',
        CYBER_SOURCE_SANDBOX: value,
      }),
    ];
    for (const config of configs) {
      expect(config.sandbox).toBe(sandbox);
    }
    expect(new AyaPayConfig({ appKey: 'k', appSecret: 's', sandbox: value }).sandbox).toBe(sandbox);
  });

  it('caches the Yoma MMQR token under the shared key', async () => {
    const { base_url, client_id, key } = vectors.yoma_mmqr_token_cache_key;
    const keys: string[] = [];
    const cache: TokenCache = {
      get: () => undefined,
      set: (name) => void keys.push(name),
      delete: () => undefined,
    };
    const fake = new FakeFetch(
      { body: { access_token: 't', expires_in: 28800 } },
      { body: { refLabel: '1', paymentStatus: 'PENDING' } },
    );
    const yoma = new YomaMmqr(
      {
        merchantId: 'm',
        clientId: client_id,
        clientSecret: 's',
        webhookHashKey: 'h',
        baseUrl: base_url,
      },
      { fetch: fake.fetch, tokenCache: cache },
    );
    await yoma.status('1');
    expect(keys).toEqual([key]);
  });

  it('renders the shared auto-submitting form page', () => {
    const { order_id, action, fields, enctype, html } = vectors.form_html;
    const form = new FormPayment({
      orderId: order_id,
      action,
      fields: fields.map(([name, value]) => ({ name, value })),
      enctype,
    });
    expect(form.toHtml()).toBe(html);
  });

  it('uses the shared error messages', () => {
    const { messages } = vectors;
    expect(new InvalidPaymentDataError(messages.invalid_payment_data.errors).message).toBe(
      messages.invalid_payment_data.message,
    );
    const configuration = new ConfigurationError(
      messages.configuration.gateway,
      messages.configuration.key,
    );
    expect(configuration.message).toBe(messages.configuration.message);

    const errorsOf = (validate: () => void): Readonly<Record<string, string>> => {
      try {
        validate();
      } catch (error) {
        return (error as InvalidPaymentDataError).errors;
      }
      return {};
    };
    const decimal = Amount.parse('1000.50');
    expect(
      errorsOf(() =>
        WaveMoney.validate({
          orderId: 'ORDER_1',
          callbackUrl: 'https://shop.test/cb',
          returnUrl: 'https://shop.test/done',
          description: 'Order',
          items: [{ name: 'Item', amount: 1000 }],
          amount: decimal,
        }),
      ).amount,
    ).toBe(messages.whole_amounts_only);
    expect(
      errorsOf(() =>
        AyaPay.validate({ orderId: 'ORDER_1', amount: decimal, channel: 'kbz_pay', method: 'QR' }),
      ).amount,
    ).toBe(messages.aya_whole_amounts_only);
    const kbz = { orderId: 'ORDER_1', callbackUrl: 'https://shop.test/cb' };
    expect(
      errorsOf(() => KbzPay.validate({ ...kbz, amount: Amount.parse('1000.505') })).amount,
    ).toBe(messages.kbz_decimals);
    expect(
      errorsOf(() => KbzPay.validate({ ...kbz, amount: 1000, timeoutMinutes: 0 })).timeoutMinutes,
    ).toBe(messages.kbz_timeout_zero);
  });
});
