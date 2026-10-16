import { describe, expect, it, vi } from 'vitest';

import {
  Amount,
  ApiError,
  CallbackRequest,
  DEFAULT_TIMEOUT_SECONDS,
  InvalidPaymentDataError,
  SignatureVerificationError,
  WavePay,
  WavePayConfig,
  type PaymentStatus,
  type WavePayPaymentData,
} from '../src/index.js';
import * as subpath from '../src/wave-pay/index.js';
import { caught, FakeFetch, fixture, gatewayConfig, hmacHex, rejected } from './helpers.js';

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
];

function gateway(fake = new FakeFetch()): WavePay {
  return new WavePay(
    gatewayConfig.wavePay({
      baseUrl: 'https://api.wave.test:8107',
      baseRedirectUrl: 'https://pay.wave.test/',
    }),
    { fetch: fake.fetch },
  );
}

function paymentData(): WavePayPaymentData {
  return {
    orderId: '100',
    callbackUrl: 'https://shop.test/wave/callback',
    returnUrl: 'https://shop.test/done',
    description: 'Order 100',
    items: [
      { name: 'Shoes', amount: Amount.kyat(600) },
      { name: 'Socks', amount: Amount.kyat(400) },
    ],
    merchantReferenceId: 'ref-001',
  };
}

function signedCallback(payload: Record<string, unknown>, secret = 'test-secret'): CallbackRequest {
  const parts = CALLBACK_FIELDS.map((field) => {
    const value = payload[field];
    return value === undefined || value === null ? 'null' : String(value);
  });
  return CallbackRequest.fromJson({ ...payload, hashValue: hmacHex(parts.join(''), secret) });
}

describe('WavePay', () => {
  it('posts a JSON, hashed payment request to the base URL and redirects to the redirect host', async () => {
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'enc/123+abc' } });
    const payment = await gateway(fake).initiate(paymentData());

    const sent = fake.last();
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://api.wave.test:8107/payment');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.accept).toBe('application/json');
    expect(sent.json()).toEqual({
      merchant_id: 'testmerchantID',
      order_id: '100',
      merchant_reference_id: 'ref-001',
      frontend_result_url: 'https://shop.test/done',
      backend_result_url: 'https://shop.test/wave/callback',
      amount: 1000,
      time_to_live_in_seconds: 300,
      payment_description: 'Order 100',
      currency: 'MMK',
      hash: hmacHex(
        '300testmerchantID1001000https://shop.test/wave/callbackref-001',
        'test-secret',
      ),
      merchant_name: 'Shop',
      items: '[{"name":"Shoes","amount":600},{"name":"Socks","amount":400}]',
    });
    expect(payment.url).toBe('https://pay.wave.test/authenticate?transaction_id=enc%2F123%2Babc');
    expect(payment.gatewayReference).toBe('enc/123+abc');
    expect(payment.raw).toEqual({ message: 'success', transaction_id: 'enc/123+abc' });
  });

  it('overrides the merchant name and time to live for one payment', async () => {
    const fake = new FakeFetch(
      { body: { message: 'success', transaction_id: 'a' } },
      { body: { message: 'success', transaction_id: 'b' } },
    );
    const wave = gateway(fake);

    await wave.initiate({ ...paymentData(), merchantName: 'Tikkat', timeToLiveSeconds: 600 });
    const overridden = fake.last().json();
    expect(overridden.merchant_name).toBe('Tikkat');
    expect(overridden.time_to_live_in_seconds).toBe(600);
    expect(overridden.hash).toBe(
      hmacHex('600testmerchantID1001000https://shop.test/wave/callbackref-001', 'test-secret'),
    );

    await wave.initiate({ ...paymentData(), merchantName: null, timeToLiveSeconds: null });
    const defaults = fake.last().json();
    expect(defaults.merchant_name).toBe('Shop');
    expect(defaults.time_to_live_in_seconds).toBe(300);
    expect(defaults.hash).toBe(
      hmacHex('300testmerchantID1001000https://shop.test/wave/callbackref-001', 'test-secret'),
    );
  });

  it.each([
    [
      'duplicate',
      409,
      { message: 'Record already exists' },
      'Record already exists',
      'Record already exists',
    ],
    ['bad hash', 400, { message: 'INVALID_HASH' }, 'INVALID_HASH', 'INVALID_HASH'],
    [
      'validation',
      422,
      { errors: { order_id: 'Taken.', amount: ['The amount must be an integer.', 'Too small.'] } },
      'VALIDATION_ERROR',
      'amount: The amount must be an integer. Too small.; order_id: Taken.',
    ],
    ['empty', 500, 'oops', undefined, 'unexpected response'],
    ['no transaction id', 200, { message: 'success' }, 'success', 'success'],
  ])('surfaces Wave errors: %s', async (_name, status, body, code, message) => {
    const error = (await rejected(
      gateway(new FakeFetch({ status, body })).initiate(paymentData()),
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ httpStatus: status, gatewayCode: code, gatewayMessage: message });
    expect(error.message).toBe(`Wave Pay payment request failed with HTTP ${status}: ${message}`);
  });

  it('defaults the amount to the item total and generates a unique reference per attempt', async () => {
    const fake = new FakeFetch(
      { body: { message: 'success', transaction_id: 'a' } },
      { body: { message: 'success', transaction_id: 'b' } },
    );
    const wave = gateway(fake);
    const first: WavePayPaymentData = {
      orderId: '100',
      callbackUrl: 'https://shop.test/cb',
      returnUrl: 'https://shop.test/done',
      description: 'x',
      items: [{ name: 'A', amount: 250 }],
    };
    const second = { ...first };
    await wave.initiate(first);
    await wave.initiate(second);
    expect(WavePay.resolvedAmount(first)?.toString()).toBe('250');
    expect(fake.requests[0]?.json().amount).toBe(250);
    expect(first.merchantReferenceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.merchantReferenceId).not.toBe(second.merchantReferenceId);
    expect(fake.requests[1]?.json().merchant_reference_id).toBe(second.merchantReferenceId);
  });

  it('charges an explicit amount', async () => {
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'a' } });
    await gateway(fake).initiate({ ...paymentData(), amount: Amount.kyat(900) });
    expect(fake.last().json().amount).toBe(900);
  });

  it('writes the amount as an exact JSON integer beyond Number.MAX_SAFE_INTEGER', async () => {
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'a' } });
    await gateway(fake).initiate({ ...paymentData(), amount: 9007199254740993n });
    expect(fake.last().body).toContain('"amount":9007199254740993,');
  });

  it('sends the additional fields only when set', async () => {
    const fake = new FakeFetch(
      { body: { message: 'success', transaction_id: 'a' } },
      { body: { message: 'success', transaction_id: 'b' } },
    );
    const wave = gateway(fake);

    await wave.initiate({
      ...paymentData(),
      additionalField3: 'note 3',
      additionalField4: 'note 4',
      additionalField5: 'note 5',
    });
    expect(fake.last().json()).toMatchObject({
      additional_field_3: 'note 3',
      additional_field_4: 'note 4',
      additional_field_5: 'note 5',
    });

    await wave.initiate({
      ...paymentData(),
      additionalField3: '',
      additionalField4: null,
      additionalField5: undefined,
    });
    expect(Object.keys(fake.last().json()).filter((key) => key.startsWith('additional'))).toEqual(
      [],
    );
  });

  it('leaves invalid data untouched', async () => {
    const data = {
      ...paymentData(),
      merchantReferenceId: undefined,
      callbackUrl: 'ftp://shop.test/cb',
    };
    expect(await rejected(gateway().initiate(data))).toBeInstanceOf(InvalidPaymentDataError);
    expect(data.merchantReferenceId).toBeUndefined();
  });

  it('hashes the callback in the documented order with null as "null"', () => {
    const vector = fixture<{
      hash_string: string;
      secret_key: string;
      payload: Record<string, unknown>;
    }>('wave_pay/callback.json');
    const request = CallbackRequest.fromJson({
      ...vector.payload,
      hashValue: hmacHex(vector.hash_string, vector.secret_key),
    });
    const callback = gateway().handleCallback(request);
    expect(callback.isSuccessful()).toBe(true);
    expect(callback).toMatchObject({
      orderId: '100',
      gatewayReference: '360',
      amount: '1000',
      gatewayStatus: 'PAYMENT_CONFIRMED',
    });
    expect(callback.raw).toMatchObject({
      merchantReferenceId: 'ref-001',
      timeToLiveSeconds: '300',
    });
    expect(callback.acknowledgement).toMatchObject({ status: 200, body: '' });
  });

  it('accepts an uppercase hash value', () => {
    const vector = fixture<{
      hash_string: string;
      secret_key: string;
      payload: Record<string, unknown>;
    }>('wave_pay/callback.json');
    const request = CallbackRequest.fromJson({
      ...vector.payload,
      hashValue: hmacHex(vector.hash_string, vector.secret_key).toUpperCase(),
    });
    expect(gateway().handleCallback(request).orderId).toBe('100');
  });

  it.each<[string, PaymentStatus]>([
    ['PAYMENT_CONFIRMED', 'successful'],
    ['INSUFFICIENT_BALANCE', 'failed'],
    ['ACCOUNT_LOCKED', 'failed'],
    ['BILL_COLLECTION_FAILED', 'failed'],
    ['PAYMENT_REQUEST_CANCELLED', 'canceled'],
    ['TRANSACTION_TIMED_OUT', 'expired'],
    ['SCHEDULER_TRANSACTION_TIMED_OUT', 'expired'],
    ['NEW_STATUS', 'unknown'],
  ])('maps the callback status %s', (status, expected) => {
    const callback = gateway().handleCallback(
      signedCallback({
        status,
        merchantId: 'testmerchantID',
        orderId: '100',
        amount: '1000',
        merchantReferenceId: 'ref-001',
        timeToLiveSeconds: 300,
      }),
    );
    expect(callback.status).toBe(expected);
    expect(callback.gatewayStatus).toBe(status);
  });

  it.each([
    ['missing', {}],
    ['null', { orderId: null }],
    ['empty', { orderId: '' }],
  ])('falls back to merchantReferenceId when orderId is %s', (_name, extra) => {
    const callback = gateway().handleCallback(
      signedCallback({
        status: 'PAYMENT_CONFIRMED',
        merchantReferenceId: 'ref-001',
        amount: '1000',
        ...extra,
      }),
    );
    expect(callback.orderId).toBe('ref-001');
    expect(callback.gatewayReference).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing amount', { amount: undefined }],
    ['a negative amount', { amount: '-1000' }],
    ['an amount with text', { amount: '1000MMK' }],
    ['an amount with two dots', { amount: '1.0.0' }],
    ['no order id and no merchant reference id', { orderId: '', merchantReferenceId: null }],
    ['an order id with other characters', { orderId: '100.1' }],
    ['an order id with a space', { orderId: '10 0' }],
    ['a merchant reference id with other characters', { merchantReferenceId: 'ref:001' }],
    ['a malformed merchant reference id next to an order id', { merchantReferenceId: 'r/1' }],
  ])('rejects a correctly hashed callback with %s', (_name, change) => {
    const fields: Record<string, unknown> = {
      status: 'PAYMENT_CONFIRMED',
      orderId: '100',
      amount: '1000',
      merchantReferenceId: 'ref-001',
      ...change,
    };
    expect(caught(() => gateway().handleCallback(signedCallback(fields)))).toBeInstanceOf(
      SignatureVerificationError,
    );
  });

  it('accepts ids with letters, digits, "_" and "-" and a decimal amount', () => {
    const callback = gateway().handleCallback(
      signedCallback({
        status: 'PAYMENT_CONFIRMED',
        orderId: 'Order_2026-10',
        amount: '1000.00',
        merchantReferenceId: 'ab12_CD-34',
      }),
    );
    expect(callback).toMatchObject({ orderId: 'Order_2026-10', amount: '1000.00' });
  });

  it('rejects a callback signed with another key or without a hash', () => {
    expect(
      caught(() =>
        gateway().handleCallback(
          signedCallback({ status: 'PAYMENT_CONFIRMED', orderId: '100' }, 'wrong'),
        ),
      ),
    ).toBeInstanceOf(SignatureVerificationError);
    expect(() =>
      gateway().handleCallback(CallbackRequest.fromJson({ status: 'PAYMENT_CONFIRMED' })),
    ).toThrow('Wave Pay callback hash verification failed.');
  });

  it.each<[string, (data: WavePayPaymentData) => WavePayPaymentData, string]>([
    ['no items', (d) => ({ ...d, items: [] }), 'items'],
    ['order id with a dot', (d) => ({ ...d, orderId: 'ORD.1' }), 'orderId'],
    ['order id with a space', (d) => ({ ...d, orderId: 'ORD 1' }), 'orderId'],
    [
      'merchant reference id with a colon',
      (d) => ({ ...d, merchantReferenceId: 'ref:1' }),
      'merchantReferenceId',
    ],
    ['items not a list', (d) => ({ ...d, items: undefined as never }), 'items'],
    ['ftp callback', (d) => ({ ...d, callbackUrl: 'ftp://shop.test/cb' }), 'callbackUrl'],
    ['missing return url', (d) => ({ ...d, returnUrl: '' }), 'returnUrl'],
    ['missing description', (d) => ({ ...d, description: '' }), 'description'],
    [
      'zero item amount',
      (d) => ({ ...d, items: [{ name: 'A', amount: Amount.kyat(0) }] }),
      'items.0.amount',
    ],
    [
      'decimal item',
      (d) => ({ ...d, items: [{ name: 'A', amount: Amount.parse('250.50') }] }),
      'items.0.amount',
    ],
    ['negative item', (d) => ({ ...d, items: [{ name: 'A', amount: -1 }] }), 'items.0.amount'],
    ['nameless item', (d) => ({ ...d, items: [{ name: '', amount: 1 }] }), 'items.0.name'],
    ['decimal total', (d) => ({ ...d, amount: Amount.parse('250.50') }), 'amount'],
    ['zero total', (d) => ({ ...d, amount: 0 }), 'amount'],
    ['blank merchant name', (d) => ({ ...d, merchantName: '  ' }), 'merchantName'],
    ['non-string merchant name', (d) => ({ ...d, merchantName: 5 as never }), 'merchantName'],
    ['zero time to live', (d) => ({ ...d, timeToLiveSeconds: 0 }), 'timeToLiveSeconds'],
    ['negative time to live', (d) => ({ ...d, timeToLiveSeconds: -5 }), 'timeToLiveSeconds'],
    ['decimal time to live', (d) => ({ ...d, timeToLiveSeconds: 1.5 }), 'timeToLiveSeconds'],
    ['text time to live', (d) => ({ ...d, timeToLiveSeconds: '60' as never }), 'timeToLiveSeconds'],
  ])('validates against Wave rules: %s', (_name, mutate, field) => {
    const error = caught(() => WavePay.validate(mutate(paymentData())));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });

  it('uses the documented messages for per-payment overrides', () => {
    const errors = (change: Partial<WavePayPaymentData>): Readonly<Record<string, string>> =>
      (caught(() => WavePay.validate({ ...paymentData(), ...change })) as InvalidPaymentDataError)
        .errors;
    expect(errors({ merchantName: '' })).toEqual({
      merchantName: 'The merchantName field is required.',
    });
    expect(errors({ timeToLiveSeconds: 0 })).toEqual({
      timeToLiveSeconds: 'The timeToLiveSeconds field must be greater than 0.',
    });
    expect(errors({ timeToLiveSeconds: 2.5 })).toEqual({
      timeToLiveSeconds: 'The timeToLiveSeconds field must be an integer.',
    });
    expect(() =>
      WavePay.validate({ ...paymentData(), merchantName: 'Tikkat', timeToLiveSeconds: 1 }),
    ).not.toThrow();
  });

  it('enforces the documented field limits in UTF-8 bytes', () => {
    const errors = (change: Partial<WavePayPaymentData>): Readonly<Record<string, string>> =>
      (caught(() => WavePay.validate({ ...paymentData(), ...change })) as InvalidPaymentDataError)
        .errors;
    const url = (length: number): string =>
      `https://shop.test/${'a'.repeat(length - 'https://shop.test/'.length)}`;

    expect(() =>
      WavePay.validate({
        ...paymentData(),
        orderId: 'o'.repeat(100),
        merchantReferenceId: 'r'.repeat(100),
        callbackUrl: url(255),
        returnUrl: url(255),
        description: 'd'.repeat(255),
        additionalField3: 'x'.repeat(50),
        additionalField4: 'x'.repeat(50),
        additionalField5: 'x'.repeat(50),
      }),
    ).not.toThrow();
    expect(
      errors({
        orderId: 'o'.repeat(101),
        merchantReferenceId: 'r'.repeat(101),
        callbackUrl: url(256),
        returnUrl: url(256),
        description: 'ဒ'.repeat(86),
        additionalField3: 'x'.repeat(51),
        additionalField4: 'ဒ'.repeat(17),
        additionalField5: 'x'.repeat(51),
      }),
    ).toEqual({
      orderId: 'The orderId field must not be greater than 100 characters.',
      merchantReferenceId: 'The merchantReferenceId field must not be greater than 100 characters.',
      callbackUrl: 'The callbackUrl field must not be greater than 255 characters.',
      returnUrl: 'The returnUrl field must not be greater than 255 characters.',
      description: 'The description field must not be greater than 255 characters.',
      additionalField3: 'The additionalField3 field must not be greater than 50 characters.',
      additionalField4: 'The additionalField4 field must not be greater than 50 characters.',
      additionalField5: 'The additionalField5 field must not be greater than 50 characters.',
    });
    expect(errors({ additionalField3: 3 as never })).toEqual({
      additionalField3: 'The additionalField3 field must be a string.',
    });
  });

  it('reports only the item when an item amount is invalid and no total is given', () => {
    const error = caught(() =>
      WavePay.validate({ ...paymentData(), items: [{ name: 'A', amount: Amount.parse('1.5') }] }),
    ) as InvalidPaymentDataError;
    expect(Object.keys(error.errors)).toEqual(['items.0.amount']);
  });

  it('names Wave in decimal errors', () => {
    const error = caught(() =>
      WavePay.validate({ ...paymentData(), amount: Amount.parse('250.50') }),
    ) as InvalidPaymentDataError;
    expect(error.errors.amount).toContain('Wave Pay does not accept decimal amounts');
  });

  it('accepts http and non-standard port callback URLs', () => {
    for (const callbackUrl of ['http://shop.test/cb', 'https://shop.test:8443/cb']) {
      expect(() =>
        WavePay.validate({ ...paymentData(), callbackUrl, returnUrl: 'http://shop.test/done' }),
      ).not.toThrow();
    }
  });

  it('sums items exactly beyond Number.MAX_SAFE_INTEGER', () => {
    const items = [
      { name: 'A', amount: 9223372036854775807n },
      { name: 'B', amount: 1 },
    ];
    expect(WavePay.resolvedAmount({ items })?.toString()).toBe('9223372036854775808');
    expect(
      WavePay.resolvedAmount({ items: [...items, { name: 'C', amount: Amount.parse('1.5') }] }),
    ).toBeUndefined();
    expect(WavePay.resolvedAmount({ items: [] })).toBeUndefined();
    expect(WavePay.resolvedAmount({ items: [], amount: 5 })?.toString()).toBe('5');
  });
});

const settings = gatewayConfig.wavePay({ merchantId: 'm', secretKey: 's' });

const waveEnv: Record<string, string> = {
  WAVE_PAY_MERCHANT_ID: 'm1',
  WAVE_PAY_SECRET_KEY: 's1',
  WAVE_PAY_MERCHANT_NAME: 'My Shop',
  WAVE_PAY_BASE_URL: 'https://payments.wavemoney.io',
  WAVE_PAY_BASE_REDIRECT_URL: 'https://payments.wavemoney.io',
  WAVE_PAY_TIME_TO_LIVE_IN_SECONDS: '600',
};

describe('WavePayConfig', () => {
  it('requires every setting and names the production host', () => {
    expect(
      new WavePayConfig({
        ...settings,
        baseUrl: WavePayConfig.PRODUCTION_URL,
        baseRedirectUrl: `${WavePayConfig.PRODUCTION_URL}/`,
      }),
    ).toMatchObject({
      baseUrl: 'https://payments.wavemoney.io',
      baseRedirectUrl: 'https://payments.wavemoney.io',
      timeToLiveSeconds: 300,
      timeoutSeconds: 30,
    });
    expect(caught(() => new WavePayConfig({ ...settings, merchantName: '' }))).toMatchObject({
      gateway: 'wave_pay',
      key: 'merchant_name',
    });
    for (const [option, key] of [
      ['baseUrl', 'base_url'],
      ['baseRedirectUrl', 'base_redirect_url'],
      ['timeToLiveSeconds', 'time_to_live_in_seconds'],
    ] as const) {
      for (const value of [undefined, null, '', '   ']) {
        const options = { ...settings, [option]: value } as unknown as typeof settings;
        expect(caught(() => new WavePayConfig(options))).toMatchObject({
          gateway: 'wave_pay',
          key,
          message: `The wave_pay configuration is missing [${key}].`,
        });
      }
    }
  });

  it('requires every variable except the HTTP timeout', () => {
    expect(WavePayConfig.fromEnv(waveEnv).timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    for (const [variable, key] of [
      ['WAVE_PAY_BASE_URL', 'base_url'],
      ['WAVE_PAY_BASE_REDIRECT_URL', 'base_redirect_url'],
      ['WAVE_PAY_TIME_TO_LIVE_IN_SECONDS', 'time_to_live_in_seconds'],
    ]) {
      const { [variable as string]: _removed, ...env } = waveEnv;
      expect(caught(() => WavePayConfig.fromEnv(env))).toMatchObject({
        gateway: 'wave_pay',
        key,
      });
    }
  });

  it('takes the time to live and the timeout as whole numbers of seconds', () => {
    for (const value of [undefined, null, '', '  ']) {
      expect(new WavePayConfig({ ...settings, timeoutSeconds: value }).timeoutSeconds).toBe(
        DEFAULT_TIMEOUT_SECONDS,
      );
    }
    for (const key of ['timeToLiveSeconds', 'timeoutSeconds'] as const) {
      const name = key === 'timeToLiveSeconds' ? 'time_to_live_in_seconds' : 'timeout_in_seconds';
      for (const value of [0, -1, 2.5, 'five', '-3']) {
        expect(
          caught(
            () => new WavePayConfig({ ...settings, [key]: value } as unknown as typeof settings),
          ),
        ).toMatchObject({
          key: name,
          message: `The wave_pay configuration [${name}] must be a whole number greater than 0.`,
        });
      }
    }
    expect(new WavePayConfig({ ...settings, timeToLiveSeconds: '+600' }).timeToLiveSeconds).toBe(
      600,
    );
  });

  it('reads the environment', () => {
    const env: Record<string, string> = {
      ...waveEnv,
      MYANMAR_PAYMENTS_HTTP_TIMEOUT: '20',
      WAVE_PAY_BASE_URL: 'https://preprodpayments.wavemoney.io:8107/',
      WAVE_PAY_BASE_REDIRECT_URL: 'https://preprodpayments.wavemoney.io:8107/',
    };
    expect(WavePayConfig.fromEnv(env)).toMatchObject({
      merchantId: 'm1',
      merchantName: 'My Shop',
      timeToLiveSeconds: 600,
      timeoutSeconds: 20,
      baseUrl: 'https://preprodpayments.wavemoney.io:8107',
      baseRedirectUrl: 'https://preprodpayments.wavemoney.io:8107',
    });
    const { WAVE_PAY_MERCHANT_NAME: _name, ...withoutName } = env;
    expect(caught(() => WavePay.fromEnv({ ...withoutName, APP_NAME: 'App' }))).toMatchObject({
      key: 'merchant_name',
    });
    vi.stubEnv('WAVE_PAY_MERCHANT_ID', 'p');
    vi.stubEnv('WAVE_PAY_SECRET_KEY', 'p');
    vi.stubEnv('WAVE_PAY_MERCHANT_NAME', 'p');
    vi.stubEnv('WAVE_PAY_TIME_TO_LIVE_IN_SECONDS', '300');
    vi.stubEnv('WAVE_PAY_BASE_URL', 'https://payments.wavemoney.io');
    vi.stubEnv('WAVE_PAY_BASE_REDIRECT_URL', 'https://payments.wavemoney.io');
    vi.stubEnv('MYANMAR_PAYMENTS_HTTP_TIMEOUT', '30');
    try {
      expect(WavePay.fromEnv().config.merchantId).toBe('p');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the wave-pay subpath', () => {
    expect(subpath.WavePay).toBe(WavePay);
    expect(subpath.WavePayConfig).toBe(WavePayConfig);
    expect(new WavePay(new WavePayConfig(settings)).config.merchantId).toBe('m');
  });
});
