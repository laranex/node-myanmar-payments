import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as subpath from '../src/aya-pay/index.js';
import {
  Amount,
  ApiError,
  AyaPay,
  AyaPayConfig,
  AyaPayMethod,
  AyaPayService,
  CallbackRequest,
  InvalidPaymentDataError,
  SignatureVerificationError,
  type AyaPayPaymentData,
  type PaymentStatus,
} from '../src/index.js';
import { caught, FakeFetch, fixture, hmacHex, rejected } from './helpers.js';

const NOW = 1733470212;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

function gateway(fake = new FakeFetch()): AyaPay {
  return new AyaPay(
    { appKey: 'app-key', appSecret: 'test-secret', baseUrl: 'https://aya.test' },
    { fetch: fake.fetch },
  );
}

function signed(
  payload: Record<string, unknown> | string,
  checksumString: string,
): Record<string, string> {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    payload: Buffer.from(json).toString('base64'),
    checkSum: hmacHex(checksumString, 'test-secret'),
    merchOrderId: 'ORD123456',
  };
}

function vector(): { payload: Record<string, unknown>; checksum: string } {
  const data = fixture<{ payload: Record<string, unknown>; checksum_string: string }>(
    'aya_pay/callback_payload.json',
  );
  return { payload: data.payload, checksum: data.checksum_string };
}

const order: AyaPayPaymentData = {
  orderId: 'ORD123456',
  amount: Amount.kyat(1000),
  channel: 'kbz_pay',
  method: AyaPayMethod.Qr,
  returnUrl: 'https://shop.test/done',
  description: 'Order',
  userRefs: ['cart-9'],
};

describe('AyaPay', () => {
  it('signs the hosted checkout form in the documented field order', () => {
    const payment = gateway().initiate(order);
    const expected = hmacHex(
      [
        'ORD123456',
        '1000',
        'app-key',
        String(NOW),
        'cart-9',
        '',
        '',
        '',
        '',
        'Order',
        '104',
        'kbz_pay',
        'QR',
        'https://shop.test/done',
      ].join(':'),
      'test-secret',
    );
    expect(payment.action).toBe('https://aya.test/v1/payment/request');
    expect(payment.enctype).toBe('multipart/form-data');
    expect(payment.fields.map((field) => field.name)).toEqual([
      'merchOrderId',
      'amount',
      'appKey',
      'timestamp',
      'userRef1',
      'userRef2',
      'userRef3',
      'userRef4',
      'userRef5',
      'description',
      'currencyCode',
      'channel',
      'method',
      'overrideFrontendRedirectUrl',
      'checkSum',
    ]);
    expect(payment.field('checkSum')).toBe(expected);
    expect(payment.toHtml()).toContain(`name="checkSum" value="${expected}"`);
  });

  it('signs empty optional fields', () => {
    const payment = gateway().initiate({
      orderId: 'ORD123456',
      amount: 1000,
      channel: 'aya_pay',
      method: 'NOTI',
    });
    expect(payment.values()).toMatchObject({
      description: '',
      overrideFrontendRedirectUrl: '',
      userRef1: '',
      method: 'NOTI',
    });
    expect(payment.field('checkSum')).toBe(
      hmacHex(
        [
          'ORD123456',
          '1000',
          'app-key',
          String(NOW),
          '',
          '',
          '',
          '',
          '',
          '',
          '104',
          'aya_pay',
          'NOTI',
          '',
        ].join(':'),
        'test-secret',
      ),
    );
  });

  it('lists the enabled payment services', async () => {
    const fake = new FakeFetch({
      body: {
        status: '00',
        message: 'success',
        data: [
          {
            name: 'AYA Pay',
            key: 'aya_pay',
            image_url: 'https://img.test/aya.png',
            methods: ['QR', 'NOTI'],
          },
          { name: 'JCB', key: 'jcb', image_url: null, methods: ['WEB', 'TOKEN'] },
          { key: 'visa', methods: [null] },
          { key: 'mpu', name: 'MPU' },
          { name: 'No key' },
          'not an object',
        ],
      },
    });
    const services = await gateway(fake).services();
    expect(fake.last().url).toBe('https://aya.test/v1/payment/services');
    expect(fake.last().json()).toEqual({
      appKey: 'app-key',
      timestamp: NOW,
      checkSum: hmacHex(`app-key:test-secret:${NOW}`, 'test-secret'),
    });
    expect(services).toHaveLength(4);
    expect(services[3]).toMatchObject({ key: 'mpu', methods: [], unknownMethods: [] });
    expect(services[0]).toBeInstanceOf(AyaPayService);
    expect(services[0]).toMatchObject({
      key: 'aya_pay',
      name: 'AYA Pay',
      imageUrl: 'https://img.test/aya.png',
      methods: ['QR', 'NOTI'],
    });
    expect(services[0]?.supports(AyaPayMethod.Qr)).toBe(true);
    expect(services[0]?.supports(AyaPayMethod.Web)).toBe(false);
    expect(services[1]).toMatchObject({
      imageUrl: undefined,
      methods: ['WEB'],
      unknownMethods: ['TOKEN'],
    });
    expect(services[2]).toMatchObject({ name: 'visa', methods: [], unknownMethods: [''] });
  });

  it('returns no services when the list is missing', async () => {
    expect(await gateway(new FakeFetch({ body: { status: '00' } })).services()).toEqual([]);
  });

  it('verifies the callback against the fixed field order, not the JSON key order', () => {
    const { payload, checksum } = vector();
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    const callback = gateway().handleCallback(
      CallbackRequest.fromJson(signed(reordered, checksum)),
    );
    expect(callback.isSuccessful()).toBe(true);
    expect(callback).toMatchObject({
      orderId: 'ORD123456',
      gatewayReference: 'TRN0001',
      amount: '1000',
      gatewayStatus: '00',
    });
    expect(callback.raw).toMatchObject({ currenyCode: '104', paymentCardNumber: null });
    expect(callback.acknowledgement).toMatchObject({ status: 200, body: '' });
  });

  it('verifies a form-encoded callback and an uppercase checksum', () => {
    const { payload, checksum } = vector();
    const body = signed(payload, checksum);
    const request = new CallbackRequest({
      body: new URLSearchParams({
        ...body,
        checkSum: (body.checkSum as string).toUpperCase(),
      }).toString(),
    });
    expect(gateway().handleCallback(request).orderId).toBe('ORD123456');
  });

  it.each<[string, PaymentStatus]>([
    ['00', 'successful'],
    ['01', 'pending'],
    ['02', 'failed'],
    ['03', 'failed'],
    ['04', 'expired'],
    ['99', 'unknown'],
  ])('maps the status code %s', (code, status) => {
    const { payload, checksum } = vector();
    const callback = gateway().handleCallback(
      CallbackRequest.fromJson(
        signed({ ...payload, statusCode: code }, checksum.replace(':00:', `:${code}:`)),
      ),
    );
    expect(callback.status).toBe(status);
  });

  it('verifies a payload that leaves out fields, as AYA does for wallet payments', () => {
    const payload = {
      merchOrderId: 'LXAYA1007184542',
      tranId: 'C17913987426393655',
      amount: '1000',
      currenyCode: '104',
      statusCode: '01',
      paymentCardNumber: null,
      paymentMobileNumber: null,
      userRef1: null,
      userRef2: null,
      userRef3: null,
      userRef4: null,
      userRef5: null,
      description: null,
      dateTime: '2026-10-08 01:15:43',
    };
    const checksum = 'LXAYA1007184542:C17913987426393655:1000:104:01:::::::::2026-10-08 01:15:43';
    const callback = gateway().handleCallback(CallbackRequest.fromJson(signed(payload, checksum)));
    expect(callback).toMatchObject({ status: 'pending', gatewayReference: 'C17913987426393655' });
  });

  it('accepts the correctly spelled currencyCode and numeric values as sent', () => {
    const json =
      '{"merchOrderId":"ORD123456","tranId":"T1","amount":1000.50,"currencyCode":104,"statusCode":"00","dateTime":"x"}';
    const callback = gateway().handleCallback(
      CallbackRequest.fromJson(signed(json, 'ORD123456:T1:1000.50:104:00:x')),
    );
    expect(callback.amount).toBe('1000.50');
  });

  it('verifies the signed return redirect query string', () => {
    const { payload, checksum } = vector();
    const callback = gateway().verifyRedirect(
      new CallbackRequest({ query: signed(payload, checksum), body: 'payload=tampered' }),
    );
    expect(callback.orderId).toBe('ORD123456');
  });

  it.each([
    [
      'tampered amount',
      (body: Record<string, string>, payload: Record<string, unknown>) => ({
        ...body,
        payload: Buffer.from(JSON.stringify({ ...payload, amount: '1' })).toString('base64'),
      }),
    ],
    ['missing payload', (body: Record<string, string>) => ({ ...body, payload: '' })],
    ['payload not base64', (body: Record<string, string>) => ({ ...body, payload: '%%%' })],
    [
      'payload not JSON',
      (body: Record<string, string>) => ({
        ...body,
        payload: Buffer.from('not json').toString('base64'),
      }),
    ],
    [
      'payload a JSON list',
      (body: Record<string, string>) => ({
        ...body,
        payload: Buffer.from('[1]').toString('base64'),
      }),
    ],
    ['missing checksum', (body: Record<string, string>) => ({ ...body, checkSum: '' })],
  ])('rejects a callback: %s', (_name, mutate) => {
    const { payload, checksum } = vector();
    const error = caught(() =>
      gateway().handleCallback(
        CallbackRequest.fromJson(mutate(signed(payload, checksum), payload)),
      ),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as SignatureVerificationError).message).toBe(
      'AYA Pay callback checksum verification failed.',
    );
  });

  it('verifies the enquiry response payload', async () => {
    const { payload, checksum } = vector();
    const fake = new FakeFetch({
      body: { status: '00', message: 'success', data: signed(payload, checksum) },
    });
    const result = await gateway(fake).status('ORD123456');
    expect(fake.last().url).toBe('https://aya.test/v1/payment/enquiry');
    expect(fake.last().json()).toEqual({
      merchOrderId: 'ORD123456',
      appKey: 'app-key',
      timestamp: NOW,
      checkSum: hmacHex(`ORD123456:${NOW}:app-key`, 'test-secret'),
    });
    expect(result.isSuccessful()).toBe(true);
    expect(result).toMatchObject({
      orderId: 'ORD123456',
      gatewayReference: 'TRN0001',
      amount: '1000',
      gatewayStatus: '00',
    });
  });

  it('falls back to the queried order id and rejects an unsigned enquiry', async () => {
    const json = '{"tranId":"T1","statusCode":"01"}';
    const fake = new FakeFetch({ body: { status: '00', data: signed(json, 'T1:01') } });
    expect((await gateway(fake).status('ORD999999')).orderId).toBe('ORD999999');

    const error = await rejected(
      gateway(new FakeFetch({ body: { status: '00', data: 'x' } })).status('ORD1'),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as Error).message).toBe('AYA Pay enquiry response checksum verification failed.');
  });

  it('throws AYA API errors with their code', async () => {
    const error = (await rejected(
      gateway(new FakeFetch({ body: { status: '20', message: 'Transaction not found' } })).status(
        'ORD123456',
      ),
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ gatewayCode: '20', gatewayMessage: 'Transaction not found' });
    expect(error.message).toBe('AYA Pay enquiry failed: [20] Transaction not found');

    const bare = (await rejected(
      gateway(new FakeFetch({ body: { status: '09' } })).status('ORD1'),
    )) as ApiError;
    expect(bare.message).toBe('AYA Pay enquiry failed: [09]');

    const http = (await rejected(
      gateway(new FakeFetch({ status: 500, body: '' })).services(),
    )) as ApiError;
    expect(http).toMatchObject({
      gatewayCode: undefined,
      httpStatus: 500,
      message: 'AYA Pay services failed with HTTP 500.',
    });
  });

  it.each<[string, Partial<AyaPayPaymentData>, string]>([
    ['short order id', { orderId: 'A1' }, 'orderId'],
    ['long order id', { orderId: 'A'.repeat(41) }, 'orderId'],
    ['six user refs', { userRefs: ['1', '2', '3', '4', '5', '6'] }, 'userRefs'],
    ['user refs that are not strings', { userRefs: [1 as unknown as string] }, 'userRefs'],
    ['unknown method', { method: 'SMS' as AyaPayMethod }, 'method'],
    ['missing channel', { channel: '' }, 'channel'],
    ['missing amount', { amount: undefined as never }, 'amount'],
    ['decimal amount', { amount: Amount.parse('1000.50') }, 'amount'],
    ['relative return url', { returnUrl: '/done' }, 'returnUrl'],
  ])('validates against AYA rules: %s', (_name, change, field) => {
    const error = caught(() => AyaPay.validate({ ...order, ...change }));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });
});

describe('AyaPayConfig', () => {
  it('selects endpoints and names a missing key', () => {
    expect(new AyaPayConfig({ appKey: 'k', appSecret: 's' }).baseUrl).toBe(
      AyaPayConfig.SANDBOX_URL,
    );
    expect(new AyaPayConfig({ appKey: 'k', appSecret: 's', sandbox: false }).baseUrl).toBe(
      AyaPayConfig.PRODUCTION_URL,
    );
    expect(caught(() => new AyaPayConfig({ appKey: 'k', appSecret: '' }))).toMatchObject({
      gateway: 'aya_pay',
      key: 'app_secret',
    });
  });

  it('reads AYA_PAY_* and falls back to AYA_PGW_*', () => {
    expect(
      AyaPayConfig.fromEnv({
        AYA_PGW_APP_KEY: 'k',
        AYA_PGW_APP_SECRET: 's',
        AYA_PGW_BASE_URL: 'https://pgw.test/',
        AYA_PAY_SANDBOX: '0',
      }),
    ).toMatchObject({ appKey: 'k', appSecret: 's', baseUrl: 'https://pgw.test', sandbox: false });
    expect(
      AyaPay.fromEnv({ AYA_PAY_APP_KEY: 'a', AYA_PGW_APP_KEY: 'b', AYA_PAY_APP_SECRET: 's' }).config
        .appKey,
    ).toBe('a');
    vi.stubEnv('AYA_PAY_APP_KEY', 'p');
    vi.stubEnv('AYA_PAY_APP_SECRET', 'p');
    try {
      expect(AyaPay.fromEnv().config.appKey).toBe('p');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the aya-pay subpath', () => {
    expect(subpath.AyaPay).toBe(AyaPay);
    expect(subpath.AyaPayMethod).toEqual({ Web: 'WEB', Qr: 'QR', Noti: 'NOTI' });
    expect(new AyaPay(new AyaPayConfig({ appKey: 'k', appSecret: 's' })).config.appKey).toBe('k');
    expect(new AyaPayService({ name: 'X', key: 'x', methods: [] }).unknownMethods).toEqual([]);
  });
});
