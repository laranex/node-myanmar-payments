import { describe, expect, it, vi } from 'vitest';

import {
  Amount,
  ApiError,
  CallbackRequest,
  InvalidPaymentDataError,
  SignatureVerificationError,
  WaveMoney,
  WaveMoneyConfig,
  type PaymentStatus,
  type WaveMoneyPaymentData,
} from '../src/index.js';
import * as subpath from '../src/wave-money/index.js';
import { caught, FakeFetch, fixture, hmacHex, rejected } from './helpers.js';

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

function gateway(fake = new FakeFetch()): WaveMoney {
  return new WaveMoney(
    {
      merchantId: 'testmerchantID',
      secretKey: 'test-secret',
      merchantName: 'Shop',
      baseUrl: 'https://wave.test',
      authenticateUrl: 'https://preprodpayments.wavemoney.io',
    },
    { fetch: fake.fetch },
  );
}

function paymentData(): WaveMoneyPaymentData {
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

describe('WaveMoney', () => {
  it('posts a form encoded, hashed payment request and redirects to authenticate', async () => {
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'enc/123+abc' } });
    const payment = await gateway(fake).initiate(paymentData());

    const sent = fake.last();
    const form = sent.form();
    expect(sent.path).toBe('/payment');
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form)).toMatchObject({
      time_to_live_in_seconds: '300',
      merchant_id: 'testmerchantID',
      order_id: '100',
      merchant_reference_id: 'ref-001',
      frontend_result_url: 'https://shop.test/done',
      backend_result_url: 'https://shop.test/wave/callback',
      amount: '1000',
      payment_description: 'Order 100',
      merchant_name: 'Shop',
      items: '[{"name":"Shoes","amount":600},{"name":"Socks","amount":400}]',
    });
    expect(form.get('hash')).toBe(
      hmacHex('300testmerchantID1001000https://shop.test/wave/callbackref-001', 'test-secret'),
    );
    expect(payment.url).toBe(
      'https://preprodpayments.wavemoney.io/authenticate?transaction_id=enc%2F123%2Babc',
    );
    expect(payment.gatewayReference).toBe('enc/123+abc');
    expect(payment.raw).toEqual({ message: 'success', transaction_id: 'enc/123+abc' });
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
    expect(error.message).toBe(`Wave Money payment request failed with HTTP ${status}: ${message}`);
  });

  it('defaults the amount to the item total and generates a unique reference per attempt', async () => {
    const fake = new FakeFetch(
      { body: { message: 'success', transaction_id: 'a' } },
      { body: { message: 'success', transaction_id: 'b' } },
    );
    const wave = gateway(fake);
    const first: WaveMoneyPaymentData = {
      orderId: '100',
      callbackUrl: 'https://shop.test/cb',
      returnUrl: 'https://shop.test/done',
      description: 'x',
      items: [{ name: 'A', amount: 250 }],
    };
    const second = { ...first };
    await wave.initiate(first);
    await wave.initiate(second);
    expect(WaveMoney.resolvedAmount(first)?.toString()).toBe('250');
    expect(fake.requests[0]?.form().get('amount')).toBe('250');
    expect(first.merchantReferenceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.merchantReferenceId).not.toBe(second.merchantReferenceId);
    expect(fake.requests[1]?.form().get('merchant_reference_id')).toBe(second.merchantReferenceId);
  });

  it('charges an explicit amount', async () => {
    const fake = new FakeFetch({ body: { message: 'success', transaction_id: 'a' } });
    await gateway(fake).initiate({ ...paymentData(), amount: Amount.kyat(900) });
    expect(fake.last().form().get('amount')).toBe('900');
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
    }>('wave_money/callback.json');
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
    expect(callback.raw).toMatchObject({ merchantReferenceId: 'ref-001', timeToLiveSeconds: 300 });
    expect(callback.acknowledgement).toMatchObject({ status: 200, body: '' });
  });

  it('accepts an uppercase hash value', () => {
    const vector = fixture<{
      hash_string: string;
      secret_key: string;
      payload: Record<string, unknown>;
    }>('wave_money/callback.json');
    const request = CallbackRequest.fromJson({
      ...vector.payload,
      hashValue: hmacHex(vector.hash_string, vector.secret_key).toUpperCase(),
    });
    expect(gateway().handleCallback(request).orderId).toBe('100');
  });

  it.each<[string, PaymentStatus]>([
    ['PAYMENT_CONFIRMED', 'successful'],
    ['INSUFFICIENT_BALANCE', 'pending'],
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
    ).toThrow('Wave Money callback hash verification failed.');
  });

  it.each<[string, (data: WaveMoneyPaymentData) => WaveMoneyPaymentData, string]>([
    ['no items', (d) => ({ ...d, items: [] }), 'items'],
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
  ])('validates against Wave rules: %s', (_name, mutate, field) => {
    const error = caught(() => WaveMoney.validate(mutate(paymentData())));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });

  it('reports only the item when an item amount is invalid and no total is given', () => {
    const error = caught(() =>
      WaveMoney.validate({ ...paymentData(), items: [{ name: 'A', amount: Amount.parse('1.5') }] }),
    ) as InvalidPaymentDataError;
    expect(Object.keys(error.errors)).toEqual(['items.0.amount']);
  });

  it('names Wave in decimal errors', () => {
    const error = caught(() =>
      WaveMoney.validate({ ...paymentData(), amount: Amount.parse('250.50') }),
    ) as InvalidPaymentDataError;
    expect(error.errors.amount).toContain('Wave Money does not accept decimal amounts');
  });

  it('accepts http and non-standard port callback URLs', () => {
    for (const callbackUrl of ['http://shop.test/cb', 'https://shop.test:8443/cb']) {
      expect(() =>
        WaveMoney.validate({ ...paymentData(), callbackUrl, returnUrl: 'http://shop.test/done' }),
      ).not.toThrow();
    }
  });

  it('sums items exactly beyond Number.MAX_SAFE_INTEGER', () => {
    const items = [
      { name: 'A', amount: 9223372036854775807n },
      { name: 'B', amount: 1 },
    ];
    expect(WaveMoney.resolvedAmount({ items })?.toString()).toBe('9223372036854775808');
    expect(
      WaveMoney.resolvedAmount({ items: [...items, { name: 'C', amount: Amount.parse('1.5') }] }),
    ).toBeUndefined();
    expect(WaveMoney.resolvedAmount({ items: [] })).toBeUndefined();
    expect(WaveMoney.resolvedAmount({ items: [], amount: 5 })?.toString()).toBe('5');
  });
});

describe('WaveMoneyConfig', () => {
  it('uses the documented hosts', () => {
    const sandbox = new WaveMoneyConfig({ merchantId: 'm', secretKey: 's', merchantName: 'Shop' });
    expect(sandbox).toMatchObject({
      baseUrl: 'https://preprodpayments.wavemoney.io:8107',
      authenticateUrl: 'https://preprodpayments.wavemoney.io',
      timeToLiveSeconds: 300,
    });
    const production = new WaveMoneyConfig({
      merchantId: 'm',
      secretKey: 's',
      merchantName: 'Shop',
      sandbox: false,
    });
    expect(production).toMatchObject({
      baseUrl: WaveMoneyConfig.PRODUCTION_URL,
      authenticateUrl: WaveMoneyConfig.PRODUCTION_AUTHENTICATE_URL,
    });
    expect(
      new WaveMoneyConfig({
        merchantId: 'm',
        secretKey: 's',
        merchantName: 'S',
        timeToLiveSeconds: -1,
      }).timeToLiveSeconds,
    ).toBe(300);
    expect(
      caught(() => new WaveMoneyConfig({ merchantId: 'm', secretKey: 's', merchantName: '' })),
    ).toMatchObject({
      gateway: 'wave_money',
      key: 'merchant_name',
    });
  });

  it('reads the environment, falling back to APP_NAME', () => {
    const env = {
      WAVE_MONEY_MERCHANT_ID: 'm1',
      WAVE_MONEY_SECRET_KEY: 's1',
      APP_NAME: 'My Shop',
      WAVE_MONEY_TIME_TO_LIVE_IN_SECONDS: '600',
      WAVE_MONEY_SANDBOX: 'off',
      WAVE_MONEY_BASE_URL: 'https://wave.test/',
      WAVE_MONEY_AUTHENTICATE_URL: 'https://auth.test',
    };
    expect(WaveMoneyConfig.fromEnv(env)).toMatchObject({
      merchantId: 'm1',
      merchantName: 'My Shop',
      timeToLiveSeconds: 600,
      sandbox: false,
      baseUrl: 'https://wave.test',
      authenticateUrl: 'https://auth.test',
    });
    expect(
      WaveMoney.fromEnv({ ...env, WAVE_MONEY_MERCHANT_NAME: 'Wave Shop' }).config.merchantName,
    ).toBe('Wave Shop');
    vi.stubEnv('WAVE_MONEY_MERCHANT_ID', 'p');
    vi.stubEnv('WAVE_MONEY_SECRET_KEY', 'p');
    vi.stubEnv('WAVE_MONEY_MERCHANT_NAME', 'p');
    try {
      expect(WaveMoney.fromEnv().config.merchantId).toBe('p');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the wave-money subpath', () => {
    expect(subpath.WaveMoney).toBe(WaveMoney);
    expect(subpath.WaveMoneyConfig).toBe(WaveMoneyConfig);
    expect(
      new WaveMoney(new WaveMoneyConfig({ merchantId: 'm', secretKey: 's', merchantName: 'S' }))
        .config.merchantId,
    ).toBe('m');
  });
});
