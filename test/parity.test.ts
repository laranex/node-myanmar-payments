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
  WavePay,
  WavePayConfig,
  YomaMmqr,
  YomaMmqrConfig,
  type PaymentCallback,
  type TokenCache,
  type WavePayPaymentData,
} from '../src/index.js';
import { caught, FakeFetch, fixture, gatewayConfig } from './helpers.js';

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
    default_timeout: { variable: string; values: (string | null)[]; timeout_in_seconds: number };
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
    kbz_time_to_live_range: string;
  };
  kbz_pay_time_to_live: {
    variable: string;
    cases: { config: string; payment: number | null; timeout_express: string }[];
  };
  wave_pay_request_overrides: {
    config: {
      merchant_id: string;
      secret_key: string;
      merchant_name: string;
      time_to_live_in_seconds: number;
    };
    data: {
      order_id: string;
      merchant_reference_id: string;
      callback_url: string;
      return_url: string;
      description: string;
      items: [string, number][];
    };
    cases: (WaveOverrides & { expected: Record<string, unknown> })[];
    invalid: (WaveOverrides & { setting: 'merchant_name' | 'time_to_live_in_seconds' })[];
  };
  wave_pay_request: {
    config: {
      merchant_id: string;
      secret_key: string;
      merchant_name: string;
      base_url: string;
      base_redirect_url: string;
      time_to_live_in_seconds: number;
    };
    response: { status: number; body: Record<string, unknown> };
    expected: {
      method: string;
      url: string;
      headers: Record<string, string>;
      redirect_url: string;
      gateway_reference: string;
    };
    cases: { name: string; data: WaveData; expected_body: Record<string, unknown> }[];
  };
  wave_pay_limits: {
    data: WaveData;
    valid: WaveLimit[];
    invalid: WaveLimit[];
  };
}

interface WaveData {
  order_id: string;
  merchant_reference_id: string;
  callback_url: string;
  return_url: string;
  description: string;
  items: [string, number][];
  additional_field_3?: string | null;
  additional_field_4?: string | null;
  additional_field_5?: string | null;
}

interface WaveLimit {
  field: keyof WavePayPaymentData;
  value: string;
  error: string | null;
}

function waveData(data: WaveData, overrides: Partial<WavePayPaymentData> = {}): WavePayPaymentData {
  return {
    orderId: data.order_id,
    callbackUrl: data.callback_url,
    returnUrl: data.return_url,
    description: data.description,
    items: data.items.map(([name, amount]) => ({ name, amount })),
    merchantReferenceId: data.merchant_reference_id,
    additionalField3: data.additional_field_3,
    additionalField4: data.additional_field_4,
    additionalField5: data.additional_field_5,
    ...overrides,
  };
}

interface WaveOverrides {
  merchant_name: string | null;
  time_to_live_in_seconds: number | null;
}

interface CallbackCase {
  name: string;
  content_type: string;
  headers?: Record<string, string>;
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
    new KbzPay(gatewayConfig.kbzPay({ appKey: secrets.kbz_pay_app_key as string })).handleCallback(
      request,
    ),
  wave_pay: (request) =>
    new WavePay(
      gatewayConfig.wavePay({
        merchantId: 'merchant',
        secretKey: secrets.wave_pay_secret_key as string,
      }),
    ).handleCallback(request),
  aya_pay: (request) =>
    new AyaPay(
      gatewayConfig.ayaPay({ appSecret: secrets.aya_pay_app_secret as string }),
    ).handleCallback(request),
  yoma_mmqr: (request) =>
    new YomaMmqr(
      gatewayConfig.yomaMmqr({
        webhookHashKey: secrets.yoma_mmqr_webhook_hashkey as string,
        webhookSecret: secrets.yoma_mmqr_webhook_secret as string,
      }),
    ).handleCallback(request),
  cyber_source: (request) =>
    new CyberSource(
      gatewayConfig.cyberSource({ secretKey: secrets.cyber_source_secret_key as string }),
    ).handleCallback(request),
};

const callbackCases = Object.entries(vectors.callbacks).flatMap(([gateway, cases]) =>
  cases.map((vector) => ({ gateway, ...vector })),
);

describe('parity vectors', () => {
  it.each(callbackCases)(
    '$gateway: $name',
    ({ gateway, content_type, headers, body, expected }) => {
      const request = new CallbackRequest({
        body,
        headers: { 'Content-Type': content_type, ...headers },
      });
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
    },
  );

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

  it('reads the production and UAT URLs like every other SDK', () => {
    const { env, seconds, urls, uat } = vectors.config;
    const check = (variables: Record<string, string>, expected: typeof urls): void => {
      const kbz = KbzPayConfig.fromEnv(variables);
      const wave = WavePayConfig.fromEnv(variables);
      const aya = AyaPayConfig.fromEnv(variables);
      const yoma = YomaMmqrConfig.fromEnv(variables);
      const cyber = CyberSourceConfig.fromEnv(variables);
      expect({ api_url: kbz.apiUrl, pwa_url: kbz.pwaUrl }).toEqual(expected.kbz_pay);
      expect({ base_url: wave.baseUrl, base_redirect_url: wave.baseRedirectUrl }).toEqual(
        expected.wave_pay,
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
    wave_pay: (env) => WavePayConfig.fromEnv(env),
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

  it.each(vectors.config.default_timeout.values)(
    'defaults the HTTP timeout when the variable is %j',
    (value) => {
      const { variable, timeout_in_seconds } = vectors.config.default_timeout;
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(vectors.config.env).filter(([name]) => name !== variable),
      );
      if (value !== null) {
        env[variable] = value;
      }
      for (const gateway of ['kbz_pay', 'wave_pay', 'aya_pay', 'yoma_mmqr']) {
        const build = fromEnv[gateway] as (env: Record<string, string>) => {
          timeoutSeconds: number;
        };
        expect(build(env).timeoutSeconds).toBe(timeout_in_seconds);
      }
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
    const yoma = new YomaMmqr(gatewayConfig.yomaMmqr({ clientId: client_id, baseUrl: base_url }), {
      fetch: fake.fetch,
      tokenCache: cache,
    });
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
        WavePay.validate({
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
      errorsOf(() => KbzPay.validate({ ...kbz, amount: 1000, timeToLiveMinutes: 0 }))
        .timeToLiveMinutes,
    ).toBe(messages.kbz_time_to_live_range);
  });

  it('applies per-payment Wave Pay overrides like every other SDK', async () => {
    const { config, data, cases, invalid } = vectors.wave_pay_request_overrides;
    const build = (overrides: WaveOverrides): WavePayPaymentData => ({
      orderId: data.order_id,
      callbackUrl: data.callback_url,
      returnUrl: data.return_url,
      description: data.description,
      items: data.items.map(([name, amount]) => ({ name, amount })),
      merchantReferenceId: data.merchant_reference_id,
      merchantName: overrides.merchant_name,
      timeToLiveSeconds: overrides.time_to_live_in_seconds,
    });

    for (const testCase of cases) {
      const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'T1' } });
      const gateway = new WavePay(
        gatewayConfig.wavePay({
          merchantId: config.merchant_id,
          secretKey: config.secret_key,
          merchantName: config.merchant_name,
          timeToLiveSeconds: config.time_to_live_in_seconds,
        }),
        { fetch: fake.fetch },
      );

      await gateway.initiate(build(testCase));

      expect(fake.last().json()).toMatchObject(testCase.expected);
    }

    const fields = { merchant_name: 'merchantName', time_to_live_in_seconds: 'timeToLiveSeconds' };
    for (const testCase of invalid) {
      const error = caught(() => WavePay.validate(build(testCase)));
      expect(error).toBeInstanceOf(InvalidPaymentDataError);
      expect(Object.keys((error as InvalidPaymentDataError).errors)).toEqual([
        fields[testCase.setting],
      ]);
    }
  });

  it('sends the same Wave Pay JSON request as every other SDK', async () => {
    const { config, response, expected, cases } = vectors.wave_pay_request;
    for (const testCase of cases) {
      const fake = new FakeFetch({ status: response.status, body: response.body });
      const gateway = new WavePay(
        {
          merchantId: config.merchant_id,
          secretKey: config.secret_key,
          merchantName: config.merchant_name,
          baseUrl: config.base_url,
          baseRedirectUrl: config.base_redirect_url,
          timeToLiveSeconds: config.time_to_live_in_seconds,
        },
        { fetch: fake.fetch },
      );

      const payment = await gateway.initiate(waveData(testCase.data));

      const request = fake.last();
      expect(request.method, testCase.name).toBe(expected.method);
      expect(request.url, testCase.name).toBe(expected.url);
      expect(
        Object.fromEntries(
          Object.keys(expected.headers).map((name) => [name, request.headers[name.toLowerCase()]]),
        ),
        testCase.name,
      ).toEqual(expected.headers);
      expect(Object.entries(request.json()), testCase.name).toEqual(
        Object.entries(testCase.expected_body),
      );
      expect(payment.url, testCase.name).toBe(expected.redirect_url);
      expect(payment.gatewayReference, testCase.name).toBe(expected.gateway_reference);
    }
  });

  it('enforces the same Wave Pay field limits as every other SDK', () => {
    const { data, valid, invalid } = vectors.wave_pay_limits;
    for (const testCase of valid) {
      expect(
        () => WavePay.validate(waveData(data, { [testCase.field]: testCase.value })),
        testCase.field,
      ).not.toThrow();
    }
    for (const testCase of invalid) {
      const error = caught(() =>
        WavePay.validate(waveData(data, { [testCase.field]: testCase.value })),
      );
      expect(error, testCase.field).toBeInstanceOf(InvalidPaymentDataError);
      expect((error as InvalidPaymentDataError).errors, testCase.field).toEqual({
        [testCase.field]: testCase.error,
      });
    }
  });

  it("takes KBZ Pay's time to live from the payment over the configuration like every other SDK", async () => {
    const { variable, cases } = vectors.kbz_pay_time_to_live;
    for (const testCase of cases) {
      const fake = new FakeFetch({
        body: {
          Response: {
            result: 'SUCCESS',
            code: '0',
            msg: 'success',
            prepay_id: 'PREPAY123',
            qrCode: 'qr',
          },
        },
      });
      const env = envWith(variable, testCase.config);
      const payment = await KbzPay.fromEnv(env, { fetch: fake.fetch }).qr({
        orderId: 'ORDER_1',
        amount: 1000,
        callbackUrl: 'https://shop.test/cb',
        timeToLiveMinutes: testCase.payment ?? undefined,
      });

      const request = fake.last().json().Request as { biz_content: Record<string, unknown> };
      expect(request.biz_content.timeout_express, JSON.stringify(testCase)).toBe(
        testCase.timeout_express,
      );
      expect(payment.expiresAt).toBeInstanceOf(Date);
    }
  });
});

/** The shared config env with `variable` set to `value`. */
function envWith(variable: string, value: string): Record<string, string> {
  return { ...vectors.config.env, [variable]: value };
}
