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
  config: {
    env: Record<string, string>;
    seconds: { time_to_live_in_seconds: number; timeout_in_seconds: number };
    urls: Record<string, Record<string, string>>;
    uat: { env: Record<string, string>; urls: Record<string, Record<string, string>> };
    errors: {
      gateway: string;
      variable: string;
      value: string | null;
      key: string;
      message: string;
    }[];
  };
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
    configuration_invalid: { gateway: string; key: string; message: string };
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
      timeoutSeconds: 30,
    }).handleCallback(request),
  wave_money: (request) =>
    new WaveMoney({
      merchantId: 'merchant',
      secretKey: secrets.wave_money_secret_key as string,
      merchantName: 'Shop',
      timeToLiveSeconds: 300,
      timeoutSeconds: 30,
    }).handleCallback(request),
  aya_pay: (request) =>
    new AyaPay({
      appKey: 'app',
      appSecret: secrets.aya_pay_app_secret as string,
      timeoutSeconds: 30,
    }).handleCallback(request),
  yoma_mmqr: (request) =>
    new YomaMmqr({
      merchantId: 'merchant',
      clientId: 'client',
      clientSecret: 'secret',
      webhookHashKey: secrets.yoma_mmqr_webhook_hashkey as string,
      apiVersion: 'v1rc',
      timeoutSeconds: 30,
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

  it('reads every gateway from the environment with production URLs', () => {
    const { env, seconds, urls, uat } = vectors.config;
    const check = (variables: Record<string, string>, expected: typeof urls): void => {
      const kbz = KbzPayConfig.fromEnv(variables);
      const wave = WaveMoneyConfig.fromEnv(variables);
      const aya = AyaPayConfig.fromEnv(variables);
      const yoma = YomaMmqrConfig.fromEnv(variables);
      const cyber = CyberSourceConfig.fromEnv(variables);
      expect({ api_url: kbz.apiUrl, pwa_url: kbz.pwaUrl }).toEqual(expected.kbz_pay);
      expect({ base_url: wave.baseUrl, authenticate_url: wave.authenticateUrl }).toEqual(
        expected.wave_money,
      );
      expect({ base_url: aya.baseUrl }).toEqual(expected.aya_pay);
      expect({ base_url: yoma.baseUrl }).toEqual(expected.yoma_mmqr);
      expect({ base_url: cyber.baseUrl }).toEqual(expected.cyber_source);
      expect(wave.timeToLiveSeconds).toBe(seconds.time_to_live_in_seconds);
      for (const config of [kbz, wave, aya, yoma]) {
        expect(config.timeoutSeconds).toBe(seconds.timeout_in_seconds);
      }
    };
    check(env, urls);
    check({ ...env, ...uat.env }, uat.urls);
  });

  const fromEnv: Record<string, (env: Record<string, string>) => unknown> = {
    kbz_pay: (env) => KbzPayConfig.fromEnv(env),
    wave_money: (env) => WaveMoneyConfig.fromEnv(env),
    aya_pay: (env) => AyaPayConfig.fromEnv(env),
    yoma_mmqr: (env) => YomaMmqrConfig.fromEnv(env),
    cyber_source: (env) => CyberSourceConfig.fromEnv(env),
  };

  it.each(vectors.config.errors)(
    '$gateway: $variable=$value',
    ({ gateway, variable, value, key, message }) => {
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(vectors.config.env).filter(([name]) => name !== variable),
      );
      if (value !== null) {
        env[variable] = value;
      }
      const build = fromEnv[gateway] as (env: Record<string, string>) => unknown;
      let error: unknown;
      try {
        build(env);
      } catch (caughtError) {
        error = caughtError;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ gateway, key, message });
    },
  );

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
        apiVersion: 'v1rc',
        timeoutSeconds: 30,
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
    const invalid = new ConfigurationError(
      messages.configuration_invalid.gateway,
      messages.configuration_invalid.key,
      true,
    );
    expect(invalid.message).toBe(messages.configuration_invalid.message);

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
