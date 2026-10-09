import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Amount,
  ApiError,
  CallbackRequest,
  InvalidPaymentDataError,
  MemoryTokenCache,
  SignatureVerificationError,
  YomaMmqr,
  YomaMmqrConfig,
  type PaymentStatus,
  type TokenCache,
  type YomaMmqrConfigOptions,
} from '../src/index.js';
import * as subpath from '../src/yoma-mmqr/index.js';
import { caught, FakeFetch, hmacHex, rejected, type Reply } from './helpers.js';

const NOW = 1791393600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

const options: YomaMmqrConfigOptions = {
  merchantId: 'M001',
  clientId: 'client',
  clientSecret: 'secret',
  webhookHashKey: 'hash-key',
  baseUrl: 'https://yoma.test',
};

function gateway(
  fake = new FakeFetch(),
  cache?: TokenCache,
  extra: Partial<YomaMmqrConfigOptions> = {},
): YomaMmqr {
  return new YomaMmqr({ ...options, ...extra }, { fetch: fake.fetch, tokenCache: cache });
}

function token(value: string, expiresIn: unknown = 28800): Reply {
  return {
    body: { access_token: value, scope: 'default', token_type: 'Bearer', expires_in: expiresIn },
  };
}

describe('YomaMmqr', () => {
  it('checks out the order, generates the QR and returns the image with its expiry', async () => {
    const fake = new FakeFetch(
      token('token-1'),
      { body: { checkOutStatus: true, errorCode: null, errorDescription: null } },
      { body: { refLabel: '100000083331', qrString: 'iVBORw0KGgo=', errorCode: null } },
    );
    const qr = await gateway(fake).initiate({
      orderId: 'ORD-2026-001',
      amount: Amount.kyat(1000),
      description: 'Order 1',
    });

    const [tokenRequest, checkout, generate] = fake.requests;
    expect(tokenRequest?.path).toBe('/token');
    expect(tokenRequest?.headers.authorization).toBe(
      `Basic ${Buffer.from('client:secret').toString('base64')}`,
    );
    expect(tokenRequest?.form().get('grant_type')).toBe('client_credentials');
    expect(checkout?.path).toBe('/payment-gateway/v1rc/api/payment/checkout');
    expect(checkout?.headers.authorization).toBe('Bearer token-1');
    expect(checkout?.json()).toEqual({
      merchantId: 'M001',
      orderNumber: 'ORD-2026-001',
      amount: '1000',
      description: 'Order 1',
    });
    expect(generate?.path).toBe('/payment-gateway/v1rc/api/qr/generate');
    expect(generate?.json()).toEqual({ merchantId: 'M001', orderNumber: 'ORD-2026-001' });

    expect(qr).toMatchObject({
      orderId: 'ORD-2026-001',
      qrImage: 'iVBORw0KGgo=',
      qrString: undefined,
      reference: '100000083331',
    });
    expect(qr.expiresAt?.getTime()).toBe((NOW + 120) * 1000);
    expect(qr.qrImageDataUri()).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(YomaMmqr.QR_LIFETIME_SECONDS).toBe(120);
  });

  it('fails when the checkout is not confirmed or no QR comes back', async () => {
    const unconfirmed = new FakeFetch(token('t'), { body: { checkOutStatus: false } });
    expect(
      (
        (await rejected(
          gateway(unconfirmed).initiate({ orderId: 'O', amount: 1, description: 'd' }),
        )) as ApiError
      ).message,
    ).toBe('Yoma MMQR did not confirm the checkout.');
    const noQr = new FakeFetch(token('t'), { body: { refLabel: '1' } });
    expect(((await rejected(gateway(noQr).renewQr('O'))) as ApiError).message).toBe(
      'Yoma MMQR did not return a QR.',
    );
  });

  it('reuses the cached token across calls and gateways', async () => {
    const fake = new FakeFetch(
      token('token-1'),
      { body: { refLabel: '1', qrString: 'a', errorCode: null } },
      { body: { refLabel: '1', paymentStatus: 'PENDING', errorCode: null } },
    );
    const cache = new MemoryTokenCache();
    await gateway(fake, cache).renewQr('ORD-1');
    await gateway(fake, cache).status('1');
    expect(fake.requests).toHaveLength(3);
  });

  it('caches the token for expires_in minus a minute, at least a minute', async () => {
    const set = vi.fn();
    const cache: TokenCache = { get: () => undefined, set, delete: () => undefined };
    for (const [expiresIn, ttl] of [
      [28800, 28740],
      ['90', 60],
      [0, 3540],
      ['bad', 3540],
      ['28800.0', 28740],
      ['1e5', 60],
      [-5, 3540],
    ] as const) {
      const fake = new FakeFetch(token('t', expiresIn), {
        body: { refLabel: '1', paymentStatus: 'PENDING' },
      });
      await gateway(fake, cache).status('1');
      expect(set).toHaveBeenLastCalledWith(
        expect.stringMatching(/^myanmar-payments\.yoma-mmqr\.token\.[0-9a-f]{64}$/),
        't',
        ttl,
      );
    }
  });

  it('works with an asynchronous cache', async () => {
    const store = new Map<string, string>();
    const cache: TokenCache = {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
    };
    const fake = new FakeFetch(
      token('async'),
      { body: { paymentStatus: 'SUCCESS' } },
      { body: { paymentStatus: 'SUCCESS' } },
    );
    await gateway(fake, cache).status('1');
    await gateway(fake, cache).status('1');
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/token',
      '/payment-gateway/v1rc/api/payment/check-status',
      '/payment-gateway/v1rc/api/payment/check-status',
    ]);
  });

  it('refreshes the token once when Yoma answers 401', async () => {
    const fake = new FakeFetch(
      token('old'),
      { status: 401, body: { message: 'Unauthorized' } },
      token('new'),
      { body: { refLabel: '1', paymentStatus: 'SUCCESS', errorCode: null } },
    );
    const result = await gateway(fake).status('1');
    expect(fake.last().headers.authorization).toBe('Bearer new');
    expect(result.isSuccessful()).toBe(true);
  });

  it('forgets the cached token so the next call authenticates again', async () => {
    const fake = new FakeFetch(token('one'), { body: { paymentStatus: 'PENDING' } }, token('two'), {
      body: { paymentStatus: 'PENDING' },
    });
    const yoma = gateway(fake);
    await yoma.status('1');
    await yoma.forgetToken();
    await yoma.status('1');
    expect(fake.last().headers.authorization).toBe('Bearer two');
  });

  it('shares one token request between concurrent calls', async () => {
    let tokens = 0;
    const yoma = new YomaMmqr(options, {
      fetch: async (url) => {
        if (url.endsWith('/token')) {
          tokens++;
          return new Response('{"access_token":"token","expires_in":28800}');
        }
        return new Response('{"refLabel":"1","paymentStatus":"PENDING","errorCode":null}');
      },
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => yoma.status('1')));
    expect(results.every((result) => result.status === 'pending')).toBe(true);
    expect(tokens).toBe(1);
  });

  it('treats a business error sent with HTTP 200 as a failure', async () => {
    const fake = new FakeFetch(token('t'), {
      body: {
        checkOutStatus: false,
        errorCode: 'PAYMENT ALREADY EXISTS',
        errorDescription: 'Payment already exists',
      },
    });
    const error = (await rejected(
      gateway(fake).initiate({ orderId: 'ORD-1', amount: 1000, description: 'Order 1' }),
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      gatewayCode: 'PAYMENT ALREADY EXISTS',
      gatewayMessage: 'Payment already exists',
      httpStatus: 200,
    });
    expect(error.message).toBe(
      'Yoma MMQR payment/checkout failed: [PAYMENT ALREADY EXISTS] Payment already exists',
    );
  });

  it('reports token and HTTP failures', async () => {
    const badToken = (await rejected(
      gateway(
        new FakeFetch({
          status: 401,
          body: { error: 'invalid_client', error_description: 'Bad client' },
        }),
      ).status('1'),
    )) as ApiError;
    expect(badToken).toMatchObject({
      gatewayCode: 'invalid_client',
      gatewayMessage: 'Bad client',
      httpStatus: 401,
    });
    expect(badToken.message).toBe('Yoma MMQR token failed: [invalid_client] Bad client');

    const http = (await rejected(
      gateway(new FakeFetch(token('t'), { status: 500, body: '' })).status('1'),
    )) as ApiError;
    expect(http).toMatchObject({
      gatewayCode: undefined,
      gatewayMessage: undefined,
      message: 'Yoma MMQR payment/check-status failed with HTTP 500.',
    });

    const noMessage = (await rejected(
      gateway(new FakeFetch(token('t'), { body: { errorCode: 'X' } })).status('1'),
    )) as ApiError;
    expect(noMessage.message).toBe('Yoma MMQR payment/check-status failed: [X]');
  });

  it.each<[string, Record<string, unknown>, PaymentStatus, string]>([
    ['success', { paymentStatus: 'SUCCESS', errorCode: null }, 'successful', 'SUCCESS'],
    ['pending', { paymentStatus: 'PENDING', errorCode: null }, 'pending', 'PENDING'],
    ['failed', { paymentStatus: 'FAILED', errorCode: null }, 'failed', 'FAILED'],
    ['lowercase', { paymentStatus: ' success ', errorCode: null }, 'successful', 'success'],
    ['new', { paymentStatus: 'REVERSED', errorCode: null }, 'unknown', 'REVERSED'],
    [
      'expired',
      { paymentStatus: null, errorCode: 'QR EXPIRED', errorDescription: 'Qr has been expired.' },
      'expired',
      'QR EXPIRED',
    ],
  ])('maps status check results: %s', async (_name, body, status, gatewayStatus) => {
    const fake = new FakeFetch(token('t'), { body: { refLabel: '1', ...body } });
    const result = await gateway(fake).status('1');
    expect(fake.last().json()).toEqual({ merchantId: 'M001', refLabel: '1' });
    expect(result).toMatchObject({
      status,
      gatewayStatus,
      gatewayReference: '1',
      orderId: undefined,
      amount: undefined,
    });
  });

  it('falls back to the queried reference', async () => {
    const result = await gateway(
      new FakeFetch(token('t'), { body: { paymentStatus: 'PENDING' } }),
    ).status('REF9');
    expect(result.gatewayReference).toBe('REF9');
  });

  function callback(
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): CallbackRequest {
    return CallbackRequest.fromJson(payload, headers);
  }

  it.each<[string, PaymentStatus]>([
    ['success', 'successful'],
    ['fail', 'failed'],
    ['SUCCESS', 'successful'],
    ['other', 'unknown'],
  ])(
    'verifies the callback hash keyed with the order number and hash key: %s',
    (status, expected) => {
      const hash = hmacHex(
        `orderNumber=ORD-2026-001235&status=${status}`,
        'ORD-2026-001235hash-key',
      );
      const result = gateway().handleCallback(
        callback({ orderNumber: 'ORD-2026-001235', status, hashValue: hash }),
      );
      expect(result).toMatchObject({
        orderId: 'ORD-2026-001235',
        status: expected,
        gatewayStatus: status,
        gatewayReference: undefined,
        amount: undefined,
      });
      expect(result.acknowledgement).toMatchObject({ status: 200, body: '' });
    },
  );

  it('rejects a callback with a wrong hash or no order number', () => {
    const error = caught(() =>
      gateway().handleCallback(
        callback({
          orderNumber: 'ORD-1',
          status: 'success',
          hashValue: hmacHex('orderNumber=ORD-1&status=fail', 'ORD-1hash-key'),
        }),
      ),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect(() =>
      gateway().handleCallback(
        callback({
          status: 'success',
          hashValue: hmacHex('orderNumber=&status=success', 'hash-key'),
        }),
      ),
    ).toThrow('Yoma MMQR callback hash verification failed.');
  });

  it('checks the webhook secret header when one is configured', () => {
    const yoma = gateway(new FakeFetch(), undefined, { webhookSecret: 'shared' });
    const payload = {
      orderNumber: 'ORD-1',
      status: 'success',
      hashValue: hmacHex('orderNumber=ORD-1&status=success', 'ORD-1hash-key'),
    };
    expect(
      yoma.handleCallback(callback(payload, { 'X-Webhook-Secret': 'shared' })).isSuccessful(),
    ).toBe(true);
    for (const headers of [undefined, { 'X-Webhook-Secret': 'wrong' }]) {
      const error = caught(() =>
        yoma.handleCallback(callback(payload, headers)),
      ) as SignatureVerificationError;
      expect(error).toBeInstanceOf(SignatureVerificationError);
      expect(error.message).toContain('X-Webhook-Secret');
    }
  });

  it('enforces the order number, amount and description limits', () => {
    const error = caught(() =>
      YomaMmqr.validate({ orderId: 'A'.repeat(21), amount: 1000, description: 'd'.repeat(51) }),
    ) as InvalidPaymentDataError;
    expect(Object.keys(error.errors).sort()).toEqual(['description', 'orderId']);
    for (const [name, amount] of [
      ['decimal', Amount.parse('1000.50')],
      ['zero', Amount.kyat(0)],
      ['negative', -1],
      ['missing', undefined],
    ] as const) {
      const invalid = caught(() =>
        YomaMmqr.validate({ orderId: 'ORD-1', amount: amount as never, description: 'Order 1' }),
      ) as InvalidPaymentDataError;
      expect(invalid.errors.amount, name).toBeTruthy();
      if (name === 'decimal') {
        expect(invalid.errors.amount).toContain('Yoma MMQR does not accept decimal amounts');
      }
    }
  });

  it('validates before calling Yoma', async () => {
    const fake = new FakeFetch();
    expect(
      await rejected(gateway(fake).initiate({ orderId: '', amount: 1, description: 'x' })),
    ).toBeInstanceOf(InvalidPaymentDataError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('YomaMmqrConfig', () => {
  it('defaults to the sandbox and the v1rc API', () => {
    const { baseUrl: _baseUrl, ...rest } = options;
    expect(new YomaMmqrConfig(rest)).toMatchObject({
      baseUrl: YomaMmqrConfig.SANDBOX_URL,
      apiVersion: 'v1rc',
      webhookSecret: undefined,
    });
    expect(new YomaMmqrConfig({ ...rest, sandbox: false }).baseUrl).toBe(
      'https://paymenthubapi.yomabank.com',
    );
    expect(caught(() => new YomaMmqrConfig({ ...rest, webhookHashKey: '' }))).toMatchObject({
      gateway: 'yoma_mmqr',
      key: 'webhook_hashkey',
    });
  });

  it('reads the environment', () => {
    const env = {
      YOMA_MMQR_MERCHANT_ID: 'M',
      YOMA_MMQR_CLIENT_ID: 'C',
      YOMA_MMQR_CLIENT_SECRET: 'S',
      YOMA_MMQR_WEBHOOK_HASHKEY: 'H',
      YOMA_MMQR_WEBHOOK_SECRET: 'W',
      YOMA_MMQR_SANDBOX: 'false',
      YOMA_MMQR_BASE_URL: 'https://hub.test/',
      YOMA_MMQR_API_VERSION: 'v2',
    };
    expect(YomaMmqrConfig.fromEnv(env)).toMatchObject({
      merchantId: 'M',
      webhookSecret: 'W',
      sandbox: false,
      baseUrl: 'https://hub.test',
      apiVersion: 'v2',
    });
    expect(YomaMmqr.fromEnv(env).config.clientId).toBe('C');
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    try {
      expect(YomaMmqr.fromEnv().config.apiVersion).toBe('v2');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the yoma-mmqr subpath', () => {
    expect(subpath.YomaMmqr).toBe(YomaMmqr);
    expect(subpath.YomaMmqrConfig).toBe(YomaMmqrConfig);
    expect(new YomaMmqr(new YomaMmqrConfig(options)).config.merchantId).toBe('M001');
  });
});
