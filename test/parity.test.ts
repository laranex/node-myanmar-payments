import { describe, expect, it } from 'vitest';

import {
  Amount,
  ApiError,
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
  MiniAppPayment,
  SignatureVerificationError,
  WavePay,
  WavePayConfig,
  WavePayMiniApp,
  WavePayMiniAppConfig,
  YomaMmqr,
  YomaMmqrConfig,
  type AyaPayMethod,
  type CyberSourceTransactionType,
  type PaymentCallback,
  type PaymentStatusResult,
  type QrPayment,
  type TokenCache,
  type WavePayMiniAppPaymentData,
  type WavePayPaymentData,
} from '../src/index.js';
import { Validator } from '../src/core/validate.js';
import { caught, FakeFetch, fixture, gatewayConfig, hmacHex, rejected } from './helpers.js';

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
  url_validation: {
    field: string;
    message: string;
    cases: { url: string; valid: boolean }[];
  };
  query_escape: { cases: { input: string; escaped: string }[] };
  ascii_trim: {
    env: { value: string; app_id: string | null; message?: string }[];
    kbz_pay_order_id: { order_id: string; errors: Record<string, string> }[];
  };
  config_setting_types: {
    config: Record<string, string>;
    key: string;
    cases: { value: unknown; result: string | null }[];
    message: string;
  };
  config_integer_limits: {
    cases: {
      gateway: string;
      variable: string;
      value: string;
      seconds?: number;
      key?: string;
      message?: string;
    }[];
  };
  config_validation_order: {
    cases: { gateway: string; env: Record<string, string | null>; key: string; message: string }[];
  };
  negative_amounts: {
    cases: { gateway: string; data: Record<string, unknown>; errors: Record<string, string> }[];
  };
  wave_pay_validation: {
    data: WaveData;
    cases: { name: string; data: Partial<WaveData> & WaveExtra; errors: Record<string, string> }[];
  };
  wave_pay_exact_amount: {
    config: Vectors['wave_pay_request']['config'];
    data: WaveData;
    expected: { amount_json: string; items: string; hash: string };
  };
  wave_pay_errors: {
    cases: {
      status: number;
      body: string;
      gateway_code: string | null;
      gateway_message: string;
    }[];
  };
  aya_pay_services: {
    cases: {
      name: string;
      status?: number;
      body: string;
      services?: {
        name: string;
        key: string;
        image_url: string | null;
        methods: string[];
        unknown_methods: string[];
      }[];
      error?: ExpectedApiError;
    }[];
  };
  yoma_mmqr_responses: {
    cases: {
      name: string;
      call: 'status' | 'renew_qr';
      argument: string;
      responses: { status: number; body: string }[];
      result?: Record<string, string>;
      error?: ExpectedApiError;
    }[];
  };
  wave_pay_mini_app_token: {
    config: MiniAppConfig;
    response: { status: number; body: string };
    expected: {
      method: string;
      url: string;
      headers: Record<string, string>;
      form: Record<string, string>;
      body: string;
      token: string;
      cache_key: string;
      ttl: number;
    };
    tokens: { status?: number; body: string; token: string; ttl: number }[];
    errors: (ExpectedApiError & { status: number; body: string })[];
  };
  wave_pay_mini_app_payment: {
    config: MiniAppConfig;
    cases: {
      name: string;
      data: MiniAppData;
      hash_input: string;
      payload: Record<string, unknown>;
      json: string;
    }[];
    exact_amount: {
      data: MiniAppData;
      amount_json: string;
      hash_input: string;
      hash: string;
      json: string;
    };
    generated_reference: { data: MiniAppData; values: (string | null)[]; pattern: string };
  };
  wave_pay_mini_app_validation: {
    data: MiniAppData;
    cases: { name: string; data: Partial<MiniAppData>; errors: Record<string, string> }[];
  };
  kbz_pay_responses: {
    cases: {
      name: string;
      call: 'status' | 'qr';
      body: string;
      result?: Record<string, string | null>;
      error?: ExpectedApiError;
    }[];
  };
}

interface MiniAppConfig {
  client_id: string;
  client_secret: string;
  mini_app_id: string;
  secret_key: string;
  base_url: string;
}

/** Wave Pay Mini App payment data in snake_case; an item is [name, amount]. */
interface MiniAppData {
  order_id: string;
  callback_url: string;
  items: [string, number | string][];
  amount?: number | string;
  merchant_reference_id?: string | null;
}

function miniAppConfig(config: MiniAppConfig): WavePayMiniAppConfig {
  return new WavePayMiniAppConfig({
    clientId: config.client_id,
    clientSecret: config.client_secret,
    miniAppId: config.mini_app_id,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
  });
}

function miniAppData(data: MiniAppData): WavePayMiniAppPaymentData {
  return {
    orderId: data.order_id,
    callbackUrl: data.callback_url,
    items: data.items.map(([name, amount]) => ({ name, amount: parsedAmount(amount) })),
    amount: data.amount === undefined ? undefined : parsedAmount(data.amount),
    merchantReferenceId: data.merchant_reference_id,
  };
}

/** A token cache that records the TTL of the last value it was given. */
class TtlCache implements TokenCache {
  readonly values = new Map<string, string>();
  ttl: number | undefined;

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string, ttlSeconds: number): void {
    this.values.set(key, value);
    this.ttl = ttlSeconds;
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

interface ExpectedApiError {
  message: string;
  gateway_code: string | null;
  gateway_message: string | null;
}

/** The fields wave_pay_validation sets on top of {@link WaveData}. */
interface WaveExtra {
  amount?: number | string;
  merchant_name?: string;
  time_to_live_in_seconds?: number;
}

interface WaveData {
  order_id: string;
  merchant_reference_id: string;
  callback_url: string;
  return_url: string;
  description: string;
  items: [string, number | string][];
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
    items: data.items.map(([name, amount]) => ({ name, amount: parsedAmount(amount) })),
    merchantReferenceId: data.merchant_reference_id,
    additionalField3: data.additional_field_3,
    additionalField4: data.additional_field_4,
    additionalField5: data.additional_field_5,
    ...overrides,
  };
}

/** A vector amount: text is parsed as a decimal, a number is whole kyat. */
function parsedAmount(amount: number | string): Amount | number {
  return typeof amount === 'string' ? Amount.parse(amount) : amount;
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
  callback_url?: string;
  expected: {
    valid: boolean;
    order_id?: string;
    status?: string;
    gateway_status?: string;
    gateway_reference?: string;
    amount?: string;
    merchant_reference_id?: string;
    message?: string;
  };
}

const vectors = fixture<Vectors>('parity/vectors.json');
const secrets = vectors.secrets;

const handlers: Record<
  string,
  (request: CallbackRequest, vector: CallbackCase) => PaymentCallback
> = {
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
  wave_pay_mini_app: (request, vector) =>
    new WavePayMiniApp(
      gatewayConfig.wavePayMiniApp({
        miniAppId: secrets.wave_pay_mini_app_mini_app_id as string,
        secretKey: secrets.wave_pay_mini_app_secret_key as string,
      }),
    ).handleCallback(request, vector.callback_url as string),
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
  it.each(callbackCases)('$gateway: $name', ({ gateway, ...vector }) => {
    const { content_type, headers, body, expected } = vector;
    const request = new CallbackRequest({
      body,
      headers: { 'Content-Type': content_type, ...headers },
    });
    const handle = handlers[gateway] as (
      request: CallbackRequest,
      vector: CallbackCase,
    ) => PaymentCallback;

    if (!expected.valid) {
      const error = caught(() => handle(request, vector));
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect((error as SignatureVerificationError).message).toBe(expected.message);
      return;
    }

    const callback = handle(request, vector);
    expect(callback.orderId).toBe(expected.order_id);
    expect(callback.status).toBe(expected.status);
    expect(callback.gatewayStatus).toBe(expected.gateway_status);
    expect(callback.gatewayReference).toBe(expected.gateway_reference);
    expect(callback.amount).toBe(expected.amount);
    if (expected.merchant_reference_id !== undefined) {
      expect(callback.raw.merchantRefId).toBe(expected.merchant_reference_id);
    }
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

  it('reads the production and UAT URLs like every other SDK', () => {
    const { env, seconds, urls, uat } = vectors.config;
    const check = (variables: Record<string, string>, expected: typeof urls): void => {
      const kbz = KbzPayConfig.fromEnv(variables);
      const wave = WavePayConfig.fromEnv(variables);
      const aya = AyaPayConfig.fromEnv(variables);
      const yoma = YomaMmqrConfig.fromEnv(variables);
      const cyber = CyberSourceConfig.fromEnv(variables);
      const miniApp = WavePayMiniAppConfig.fromEnv(variables);
      expect({ base_url: miniApp.baseUrl }).toEqual(expected.wave_pay_mini_app);
      expect({ api_url: kbz.apiUrl, pwa_url: kbz.pwaUrl }).toEqual(expected.kbz_pay);
      expect({ base_url: wave.baseUrl, base_redirect_url: wave.baseRedirectUrl }).toEqual(
        expected.wave_pay,
      );
      expect({ base_url: aya.baseUrl }).toEqual(expected.aya_pay);
      expect({ base_url: yoma.baseUrl }).toEqual(expected.yoma_mmqr);
      expect({ base_url: cyber.baseUrl }).toEqual(expected.cyber_source);
      expect(wave.timeToLiveSeconds).toBe(seconds.time_to_live_in_seconds);
      for (const config of [kbz, wave, aya, yoma, miniApp]) {
        expect(config.timeoutSeconds).toBe(seconds.timeout_in_seconds);
      }
    };
    check(env, urls);
    check({ ...env, ...uat.env }, uat.urls);
  });

  const fromEnv: Record<string, (env: Record<string, string>) => unknown> = {
    kbz_pay: (env) => KbzPayConfig.fromEnv(env),
    wave_pay: (env) => WavePayConfig.fromEnv(env),
    wave_pay_mini_app: (env) => WavePayMiniAppConfig.fromEnv(env),
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
      for (const gateway of ['kbz_pay', 'wave_pay', 'aya_pay', 'yoma_mmqr', 'wave_pay_mini_app']) {
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

  it('validates URLs like every other SDK', () => {
    const { field, message, cases } = vectors.url_validation;
    for (const { url, valid } of cases) {
      const errors = errorsOf(() => new Validator().url(field, url).validate());
      expect(errors, JSON.stringify(url)).toEqual(valid ? {} : { [field]: message });
    }
  });

  it('escapes query values like every other SDK', async () => {
    for (const { input, escaped } of vectors.query_escape.cases) {
      const kbz = new FakeFetch({
        body: { Response: { result: 'SUCCESS', code: '0', prepay_id: 'P1', qrCode: 'qr' } },
      });
      await KbzPay.fromEnv(vectors.config.env, { fetch: kbz.fetch }).qr({
        orderId: 'ORDER_1',
        amount: 1000,
        callbackUrl: 'https://shop.test/cb',
        callbackInfo: input,
      });
      const request = kbz.last().json().Request as { biz_content: Record<string, unknown> };
      expect(request.biz_content.callback_info).toBe(escaped);

      const wave = new FakeFetch({ body: { message: 'success', transaction_id: input } });
      const payment = await WavePay.fromEnv(vectors.config.env, { fetch: wave.fetch }).initiate(
        waveData(vectors.wave_pay_limits.data),
      );
      expect(payment.url.endsWith(`/authenticate?transaction_id=${escaped}`)).toBe(true);
    }
  });

  it('trims only ASCII whitespace like every other SDK', () => {
    const { env, kbz_pay_order_id } = vectors.ascii_trim;
    for (const testCase of env) {
      const variables = { ...vectors.config.env, KBZ_PAY_APP_ID: testCase.value };
      if (testCase.app_id === null) {
        expect(() => KbzPayConfig.fromEnv(variables)).toThrow(testCase.message);
      } else {
        expect(KbzPayConfig.fromEnv(variables).appId).toBe(testCase.app_id);
      }
    }
    for (const { order_id, errors } of kbz_pay_order_id) {
      expect(
        errorsOf(() =>
          KbzPay.validate({ orderId: order_id, amount: 1000, callbackUrl: 'https://shop.test/cb' }),
        ),
      ).toEqual(errors);
    }
  });

  it('accepts integer string settings like every other SDK', () => {
    const { config, key, cases, message } = vectors.config_setting_types;
    for (const { value, result } of cases) {
      const options = { ...camelKeys(config), [camel(key)]: value } as never;
      if (result === null) {
        expect(() => new CyberSourceConfig(options), JSON.stringify(value)).toThrow(message);
      } else {
        expect(new CyberSourceConfig(options).profileId).toBe(result);
      }
    }
  });

  it('caps whole-number settings at 2147483647 like every other SDK', () => {
    for (const testCase of vectors.config_integer_limits.cases) {
      const build = fromEnv[testCase.gateway] as (env: Record<string, string>) => {
        timeoutSeconds: number;
        timeToLiveSeconds?: number;
      };
      const env = envWith(testCase.variable, testCase.value);
      if (testCase.seconds !== undefined) {
        const config = build(env);
        expect(
          testCase.variable === 'WAVE_PAY_TIME_TO_LIVE_IN_SECONDS'
            ? config.timeToLiveSeconds
            : config.timeoutSeconds,
        ).toBe(testCase.seconds);
        continue;
      }
      const error = caught(() => build(env));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({
        gateway: testCase.gateway,
        key: testCase.key,
        message: testCase.message,
      });
    }
  });

  it('reports the first configuration error in the same order as every other SDK', () => {
    for (const testCase of vectors.config_validation_order.cases) {
      const env = Object.fromEntries(
        Object.entries({ ...vectors.config.env, ...testCase.env }).filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      );
      const error = caught(() => (fromEnv[testCase.gateway] as (env: object) => unknown)(env));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ key: testCase.key, message: testCase.message });
    }
  });

  it('collects negative amounts with the other errors like every other SDK', () => {
    for (const { gateway, data, errors } of vectors.negative_amounts.cases) {
      const validate: Record<string, () => void> = {
        kbz_pay: () =>
          KbzPay.validate({
            orderId: data.order_id as string,
            amount: data.amount as number,
            callbackUrl: data.callback_url as string,
          }),
        wave_pay: () =>
          WavePay.validate(
            waveData(data as unknown as WaveData, {
              amount: data.amount as number | undefined,
            }),
          ),
        wave_pay_mini_app: () =>
          WavePayMiniApp.validate(miniAppData(data as unknown as MiniAppData)),
        aya_pay: () =>
          AyaPay.validate({
            orderId: data.order_id as string,
            amount: data.amount as number,
            channel: data.channel as string,
            method: data.method as AyaPayMethod,
          }),
        yoma_mmqr: () =>
          YomaMmqr.validate({
            orderId: data.order_id as string,
            amount: data.amount as number,
            description: data.description as string,
          }),
        cyber_source: () =>
          CyberSource.validate({
            orderId: data.order_id as string,
            amount: data.amount as number,
            callbackUrl: data.callback_url as string,
            currency: data.currency as string,
            transactionType: data.transaction_type as CyberSourceTransactionType,
            locale: data.locale as string,
          }),
      };
      expect(Object.entries(errorsOf(validate[gateway] as () => void)), gateway).toEqual(
        Object.entries(errors),
      );
    }
  });

  it('validates Wave Pay payments in the same order as every other SDK', () => {
    const { data, cases } = vectors.wave_pay_validation;
    for (const testCase of cases) {
      const merged = { ...data, ...testCase.data };
      const overrides: Partial<WavePayPaymentData> = {};
      if (merged.amount !== undefined) {
        overrides.amount = parsedAmount(merged.amount);
      }
      if (merged.merchant_name !== undefined) {
        overrides.merchantName = merged.merchant_name;
      }
      if (merged.time_to_live_in_seconds !== undefined) {
        overrides.timeToLiveSeconds = merged.time_to_live_in_seconds;
      }
      expect(
        Object.entries(errorsOf(() => WavePay.validate(waveData(merged, overrides)))),
        testCase.name,
      ).toEqual(Object.entries(testCase.errors));
    }
  });

  it('treats a Wave Pay amount of null as not given', () => {
    const data = waveData(vectors.wave_pay_limits.data, { amount: null });
    expect(() => WavePay.validate(data)).not.toThrow();
    expect(WavePay.resolvedAmount(data)?.toString()).toBe('1000');
  });

  it('sends exact Wave Pay amounts like every other SDK', async () => {
    const { config, data, expected } = vectors.wave_pay_exact_amount;
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'T1' } });
    await new WavePay(
      {
        merchantId: config.merchant_id,
        secretKey: config.secret_key,
        merchantName: config.merchant_name,
        baseUrl: config.base_url,
        baseRedirectUrl: config.base_redirect_url,
        timeToLiveSeconds: config.time_to_live_in_seconds,
      },
      { fetch: fake.fetch },
    ).initiate(waveData(data));

    const body = fake.last().body;
    expect(body).toContain(`"amount":${expected.amount_json},`);
    expect(fake.last().json().items).toBe(expected.items);
    expect(fake.last().json().hash).toBe(expected.hash);
  });

  it('reports Wave Pay request failures like every other SDK', async () => {
    const { config } = vectors.wave_pay_request;
    for (const testCase of vectors.wave_pay_errors.cases) {
      const fake = new FakeFetch({ status: testCase.status, body: testCase.body });
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
      expectApiError(
        await rejected(gateway.initiate(waveData(vectors.wave_pay_limits.data))),
        {
          message: `Wave Pay payment request failed with HTTP ${testCase.status}: ${testCase.gateway_message}`,
          gateway_code: testCase.gateway_code,
          gateway_message: testCase.gateway_message,
        },
        testCase.body,
      );
    }
  });

  it('reads AYA Pay services like every other SDK', async () => {
    for (const testCase of vectors.aya_pay_services.cases) {
      const fake = new FakeFetch({ status: testCase.status ?? 200, body: testCase.body });
      const gateway = AyaPay.fromEnv(vectors.config.env, { fetch: fake.fetch });
      if (testCase.error !== undefined) {
        expectApiError(await rejected(gateway.services()), testCase.error, testCase.name);
        continue;
      }
      const services = await gateway.services();
      expect(
        services.map((service) => ({
          name: service.name,
          key: service.key,
          image_url: service.imageUrl ?? null,
          methods: [...service.methods],
          unknown_methods: [...service.unknownMethods],
        })),
        testCase.name,
      ).toEqual(testCase.services);
    }
  });

  it('reads Yoma MMQR responses like every other SDK', async () => {
    for (const testCase of vectors.yoma_mmqr_responses.cases) {
      const fake = new FakeFetch(
        ...testCase.responses.map(({ status, body }) => ({ status, body })),
      );
      const gateway = YomaMmqr.fromEnv(vectors.config.env, { fetch: fake.fetch });
      const call = (): Promise<QrPayment | PaymentStatusResult> =>
        testCase.call === 'status'
          ? gateway.status(testCase.argument)
          : gateway.renewQr(testCase.argument);
      if (testCase.error !== undefined) {
        expectApiError(await rejected(call()), testCase.error, testCase.name);
        continue;
      }
      const result = await call();
      expect(
        testCase.call === 'renew_qr'
          ? {
              qr_image: (result as QrPayment).qrImage,
              reference: (result as QrPayment).reference,
            }
          : {
              status: (result as PaymentStatusResult).status,
              gateway_status: (result as PaymentStatusResult).gatewayStatus,
              gateway_reference: (result as PaymentStatusResult).gatewayReference,
            },
        testCase.name,
      ).toEqual(testCase.result);
    }
  });

  it('requests and caches the Wave Pay Mini App access token like every other SDK', async () => {
    const { config, response, expected, tokens, errors } = vectors.wave_pay_mini_app_token;
    const cache = new TtlCache();
    const fake = new FakeFetch(
      { status: response.status, body: response.body },
      { body: { access_token: 'token-2' } },
    );
    const gateway = new WavePayMiniApp(miniAppConfig(config), {
      fetch: fake.fetch,
      tokenCache: cache,
    });

    expect(await gateway.accessToken()).toBe(expected.token);
    expect(await gateway.accessToken()).toBe(expected.token);
    expect(fake.requests).toHaveLength(1);
    const request = fake.last();
    expect(request.method).toBe(expected.method);
    expect(request.url).toBe(expected.url);
    expect(
      Object.fromEntries(
        Object.keys(expected.headers).map((name) => [name, request.headers[name.toLowerCase()]]),
      ),
    ).toEqual(expected.headers);
    expect(request.body).toBe(expected.body);
    expect(Object.fromEntries(request.form())).toEqual(expected.form);
    expect(cache.get(expected.cache_key)).toBe(expected.token);
    expect(cache.ttl).toBe(expected.ttl);

    await gateway.forgetToken();
    expect(cache.get(expected.cache_key)).toBeUndefined();
    expect(await gateway.accessToken()).toBe('token-2');

    for (const testCase of tokens) {
      const tokenCache = new TtlCache();
      const replies = new FakeFetch({ status: testCase.status ?? 200, body: testCase.body });
      const token = await new WavePayMiniApp(miniAppConfig(config), {
        fetch: replies.fetch,
        tokenCache,
      }).accessToken();
      expect(token, testCase.body).toBe(testCase.token);
      expect(tokenCache.ttl, testCase.body).toBe(testCase.ttl);
    }

    for (const testCase of errors) {
      const replies = new FakeFetch({ status: testCase.status, body: testCase.body });
      expectApiError(
        await rejected(
          new WavePayMiniApp(miniAppConfig(config), { fetch: replies.fetch }).accessToken(),
        ),
        testCase,
        testCase.body,
      );
    }
  });

  it('signs the same Wave Pay Mini App payment payload as every other SDK', () => {
    const { config, cases, exact_amount, generated_reference } = vectors.wave_pay_mini_app_payment;
    const gateway = new WavePayMiniApp(miniAppConfig(config));

    for (const testCase of cases) {
      const payment = gateway.payment(miniAppData(testCase.data));
      expect(payment, testCase.name).toBeInstanceOf(MiniAppPayment);
      expect(payment.flow).toBe('mini_app');
      expect(payment.hashValue, testCase.name).toBe(
        hmacHex(testCase.hash_input, config.secret_key),
      );
      expect(Object.entries(payment.toJSON()), testCase.name).toEqual(
        Object.entries(testCase.payload),
      );
      expect(payment.toJsonString(), testCase.name).toBe(testCase.json);
      expect(JSON.stringify(payment), testCase.name).toBe(testCase.json);
    }

    const payment = gateway.payment(miniAppData(exact_amount.data));
    expect(payment.amount.toString()).toBe(exact_amount.amount_json);
    expect(payment.hashValue).toBe(exact_amount.hash);
    expect(hmacHex(exact_amount.hash_input, config.secret_key)).toBe(exact_amount.hash);
    expect(payment.toJsonString()).toBe(exact_amount.json);

    for (const value of generated_reference.values) {
      const generated = gateway.payment(
        miniAppData({ ...generated_reference.data, merchant_reference_id: value }),
      );
      expect(generated.merchantReferenceId).toMatch(new RegExp(generated_reference.pattern));
    }
  });

  it('validates Wave Pay Mini App payments in the same order as every other SDK', () => {
    const { data, cases } = vectors.wave_pay_mini_app_validation;
    for (const testCase of cases) {
      expect(
        Object.entries(
          errorsOf(() => WavePayMiniApp.validate(miniAppData({ ...data, ...testCase.data }))),
        ),
        testCase.name,
      ).toEqual(Object.entries(testCase.errors));
    }
  });

  it('reads KBZ Pay responses like every other SDK', async () => {
    for (const testCase of vectors.kbz_pay_responses.cases) {
      const fake = new FakeFetch({ body: testCase.body });
      const gateway = KbzPay.fromEnv(vectors.config.env, { fetch: fake.fetch });
      const call = (): Promise<QrPayment | PaymentStatusResult> =>
        testCase.call === 'status'
          ? gateway.status('ORDER_1')
          : gateway.qr({ orderId: 'ORDER_1', amount: 1000, callbackUrl: 'https://shop.test/cb' });
      if (testCase.error !== undefined) {
        expectApiError(await rejected(call()), testCase.error, testCase.name);
        continue;
      }
      const result = await call();
      expect(
        testCase.call === 'qr'
          ? {
              qr_string: (result as QrPayment).qrString,
              reference: (result as QrPayment).reference,
            }
          : {
              order_id: (result as PaymentStatusResult).orderId,
              status: (result as PaymentStatusResult).status,
              gateway_status: (result as PaymentStatusResult).gatewayStatus,
              gateway_reference: (result as PaymentStatusResult).gatewayReference ?? null,
              amount: (result as PaymentStatusResult).amount ?? null,
            },
        testCase.name,
      ).toEqual(testCase.result);
    }
  });
});

/** The shared config env with `variable` set to `value`. */
function envWith(variable: string, value: string): Record<string, string> {
  return { ...vectors.config.env, [variable]: value };
}

/** The errors `validate` throws, in the order they were found, or `{}`. */
function errorsOf(validate: () => void): Readonly<Record<string, string>> {
  try {
    validate();
  } catch (error) {
    return (error as InvalidPaymentDataError).errors;
  }
  return {};
}

/** Checks an {@link ApiError} against a vector's expected error (`null` means none). */
function expectApiError(error: unknown, expected: ExpectedApiError, name: string): void {
  expect(error, name).toBeInstanceOf(ApiError);
  const { message, gatewayCode, gatewayMessage } = error as ApiError;
  expect([message, gatewayCode ?? null, gatewayMessage ?? null], name).toEqual([
    expected.message,
    expected.gateway_code,
    expected.gateway_message,
  ]);
}

/** `profile_id` as `profileId`. */
function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelKeys(config: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [camel(key), value]));
}
