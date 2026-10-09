import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Amount,
  ApiError,
  CallbackRequest,
  ConfigurationError,
  InvalidPaymentDataError,
  KbzPay,
  KbzPayConfig,
  KbzPaySigner,
  SignatureVerificationError,
  type KbzPayPaymentData,
  type PaymentStatus,
} from '../src/index.js';
import * as subpath from '../src/kbz-pay/index.js';
import { caught, FakeFetch, fixture, rejected, type Reply } from './helpers.js';

const NOW = 1536637503;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

const config = {
  appId: 'kp123',
  appKey: 'secret-key',
  merchantCode: '100001',
  apiUrl: 'https://kbz.test',
};

function gateway(fake = new FakeFetch()): KbzPay {
  return new KbzPay(config, { fetch: fake.fetch });
}

function precreate(extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      Response: { result: 'SUCCESS', code: '0', msg: 'success', prepay_id: 'PREPAY123', ...extra },
    },
  };
}

const data: KbzPayPaymentData = {
  orderId: 'ORDER_1',
  amount: Amount.kyat(1000),
  callbackUrl: 'https://shop.test/kbz/callback',
};

const signer = new KbzPaySigner('secret-key');

function requestOf(fake: FakeFetch): Record<string, unknown> {
  return fake.last().json().Request as Record<string, unknown>;
}

describe('KbzPaySigner', () => {
  it('builds the sign string exactly as the KBZ docs example', () => {
    const vector = fixture<{ fields: Record<string, unknown>; expected: string }>(
      'kbz_pay/sign_string.json',
    );
    expect(new KbzPaySigner('any').signString(vector.fields)).toBe(vector.expected);
  });

  it('does not URL-encode values when signing', () => {
    expect(
      new KbzPaySigner('k').signString({
        notify_url: 'https://a.test/x y',
        callback_info: 'title%3Diphonex',
      }),
    ).toBe('callback_info=title%3Diphonex&notify_url=https://a.test/x y');
  });

  it('skips empty and non-scalar fields and signs booleans as text', () => {
    expect(
      new KbzPaySigner('k').signString({ b: true, a: '', c: null, d: { x: 1 }, e: false }),
    ).toBe('b=true&e=false');
  });

  it('signs with the app key, uppercase, and verifies case-insensitively', () => {
    const fields = { a: '1', sign_type: 'SHA256' };
    const sign = signer.sign(fields);
    expect(sign).toMatch(/^[0-9A-F]{64}$/);
    expect(signer.verify({ ...fields, sign: sign.toLowerCase() })).toBe(true);
    expect(signer.verify({ ...fields, sign: 'X' })).toBe(false);
    expect(signer.verify({ ...fields, sign: 1 })).toBe(false);
    expect(signer.verify(fields)).toBe(false);
  });
});

describe('KbzPay', () => {
  it('sends a signed precreate request and returns the PWA redirect URL', async () => {
    const fake = new FakeFetch(precreate());
    const kbz = gateway(fake);

    const payment = await kbz.pwa(data);

    const request = requestOf(fake);
    const biz = request.biz_content as Record<string, unknown>;
    expect(fake.last().url).toBe('https://kbz.test/precreate');
    expect(request).toMatchObject({
      method: 'kbz.payment.precreate',
      version: '1.0',
      notify_url: data.callbackUrl,
      timestamp: String(NOW),
      sign_type: 'SHA256',
    });
    expect(biz).toEqual({
      appid: 'kp123',
      merch_code: '100001',
      merch_order_id: 'ORDER_1',
      trade_type: 'PWAAPP',
      total_amount: '1000',
      trans_currency: 'MMK',
    });
    const { biz_content: _biz, ...common } = request;
    expect(request.sign).toBe(signer.sign({ ...common, ...biz }));

    expect(payment.flow).toBe('redirect');
    expect(payment.url.startsWith(`${KbzPayConfig.SANDBOX_PWA_URL}?`)).toBe(true);
    expect(payment.gatewayReference).toBe('PREPAY123');
    expect(payment.orderId).toBe('ORDER_1');
    expect(payment.raw).toMatchObject({ prepay_id: 'PREPAY123' });

    const query = new URLSearchParams(payment.url.slice(payment.url.indexOf('?') + 1));
    const fields = Object.fromEntries([...query].filter(([key]) => key !== 'sign'));
    expect(Object.keys(fields)).toEqual([
      'appid',
      'merch_code',
      'nonce_str',
      'prepay_id',
      'timestamp',
    ]);
    expect(fields.nonce_str).toBe(request.nonce_str);
    expect(query.get('sign')).toBe(signer.sign(fields));
  });

  it('returns the QR payload for the QR flow', async () => {
    const fake = new FakeFetch(precreate({ qrCode: 'kbzpay://qr/abc' }));
    const payment = await gateway(fake).qr(data);
    expect(payment).toMatchObject({
      qrString: 'kbzpay://qr/abc',
      qrImage: undefined,
      reference: 'PREPAY123',
      expiresAt: undefined,
    });
    expect(payment.qrImageDataUri()).toBeUndefined();
    expect((requestOf(fake).biz_content as Record<string, unknown>).trade_type).toBe(
      'PAY_BY_QRCODE',
    );
  });

  it('sets the QR expiry from timeoutMinutes', async () => {
    const payment = await gateway(new FakeFetch(precreate({ qrCode: 'qr' }))).qr({
      ...data,
      timeoutMinutes: 30,
    });
    expect(payment.expiresAt?.getTime()).toBe((NOW + 30 * 60) * 1000);
  });

  it('fails when KBZ returns no QR code', async () => {
    const error = await rejected(gateway(new FakeFetch(precreate())).qr(data));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('KBZ Pay did not return a QR code.');
  });

  it('returns signed order info for the in-app flow', async () => {
    const fake = new FakeFetch(precreate());
    const payment = await gateway(fake).app(data);
    const nonce = requestOf(fake).nonce_str as string;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(payment.orderInfo).toBe(
      `appid=kp123&merch_code=100001&nonce_str=${nonce}&prepay_id=PREPAY123&timestamp=${NOW}`,
    );
    expect(payment.signType).toBe('SHA256');
    expect(payment.sign).toBe(
      signer.sign({
        appid: 'kp123',
        merch_code: '100001',
        nonce_str: nonce,
        prepay_id: 'PREPAY123',
        timestamp: String(NOW),
      }),
    );
    expect(JSON.parse(JSON.stringify(payment))).toEqual({
      orderId: 'ORDER_1',
      orderInfo: payment.orderInfo,
      sign: payment.sign,
      signType: 'SHA256',
    });
  });

  it('sends optional order fields inside biz_content and keeps decimals', async () => {
    const fake = new FakeFetch(precreate());
    await gateway(fake).pwa({
      orderId: 'ORDER_1',
      amount: Amount.parse('1000.50'),
      callbackUrl: 'https://shop.test/cb',
      title: 'Shoes',
      timeoutMinutes: 30,
      callbackInfo: 'cart=9',
    });
    expect(requestOf(fake).biz_content).toMatchObject({
      title: 'Shoes',
      timeout_express: '30m',
      callback_info: 'cart%3D9',
      total_amount: '1000.50',
    });
  });

  it('accepts a whole number of kyat as the amount', async () => {
    const fake = new FakeFetch(precreate());
    await gateway(fake).pwa({ ...data, amount: 2500 });
    expect((requestOf(fake).biz_content as Record<string, unknown>).total_amount).toBe('2500');
  });

  it('throws the gateway error when precreate fails', async () => {
    const fake = new FakeFetch({
      body: { Response: { result: 'FAIL', code: 'ORDER_ID_USED', msg: 'Order id used' } },
    });
    const error = (await rejected(gateway(fake).pwa(data))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      gatewayCode: 'ORDER_ID_USED',
      gatewayMessage: 'Order id used',
      httpStatus: 200,
    });
    expect(error.message).toBe('KBZ Pay precreate failed: [ORDER_ID_USED] Order id used');
  });

  it('reports a KBZ code without a message', async () => {
    const fake = new FakeFetch({ body: { Response: { result: 'FAIL', code: 'AOP08508' } } });
    const error = (await rejected(gateway(fake).pwa(data))) as ApiError;
    expect(error.message).toBe('KBZ Pay precreate failed: [AOP08508]');
    expect(error.gatewayMessage).toBeUndefined();
  });

  it('reports HTTP failures without a KBZ code', async () => {
    const error = (await rejected(
      gateway(new FakeFetch({ status: 502, body: 'Bad gateway' })).pwa(data),
    )) as ApiError;
    expect(error.message).toBe('KBZ Pay precreate failed with HTTP 502.');
    expect(error.gatewayCode).toBeUndefined();
    expect(error.httpStatus).toBe(502);
  });

  it('fails when precreate returns no prepay_id', async () => {
    const fake = new FakeFetch({ body: { Response: { result: 'SUCCESS', code: '0' } } });
    expect(((await rejected(gateway(fake).app(data))) as ApiError).message).toBe(
      'KBZ Pay did not return a prepay_id.',
    );
  });

  it('validates before sending anything', async () => {
    const fake = new FakeFetch();
    const error = await rejected(gateway(fake).pwa({ ...data, orderId: 'ORDER-1' }));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect(fake.requests).toHaveLength(0);
  });

  it.each<[string, PaymentStatus]>([
    ['PAY_SUCCESS', 'successful'],
    [' PAY_SUCCESS', 'successful'],
    ['WAIT_PAY', 'pending'],
    ['PAYING', 'pending'],
    ['PAY_FAILED', 'failed'],
    ['ORDER_CLOSED', 'canceled'],
    ['ORDER_EXPIRED', 'expired'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps the queryorder trade status %j', async (tradeStatus, status) => {
    const fake = new FakeFetch({
      body: {
        Response: {
          result: 'SUCCESS',
          code: '0',
          merch_order_id: 'ORDER_1',
          trade_status: tradeStatus,
          total_amount: '1000',
          mm_order_id: 'MM1',
        },
      },
    });
    const result = await gateway(fake).status('ORDER_1');
    expect(fake.last().url).toBe('https://kbz.test/queryorder');
    expect(requestOf(fake)).toMatchObject({ method: 'kbz.payment.queryorder', version: '3.0' });
    expect(requestOf(fake).biz_content).toEqual({
      appid: 'kp123',
      merch_code: '100001',
      merch_order_id: 'ORDER_1',
    });
    expect(result).toMatchObject({
      orderId: 'ORDER_1',
      status,
      gatewayStatus: tradeStatus.trim(),
      gatewayReference: 'MM1',
      amount: '1000',
    });
    expect(result.isSuccessful()).toBe(status === 'successful');
  });

  it('keeps the queried order id and the exact amount text', async () => {
    const fake = new FakeFetch({
      body: '{"Response":{"result":"SUCCESS","code":0,"trade_status":"WAIT_PAY","total_amount":1000.50}}',
    });
    const result = await gateway(fake).status('ORDER_9');
    expect(result).toMatchObject({
      orderId: 'ORDER_9',
      amount: '1000.50',
      gatewayReference: undefined,
      status: 'pending',
    });
    expect(result.raw.total_amount).toBe('1000.50');
  });

  it('passes the abort signal to the request', async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const kbz = new KbzPay(config, {
      httpClient: {
        send: async (request) => {
          received = request.signal;
          return { status: 200, body: JSON.stringify(precreate().body) };
        },
      },
    });
    await kbz.pwa(data, { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });

  it('reports an aborted status check as an ApiError wrapping the abort', async () => {
    const kbz = new KbzPay(config, {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    });
    const error = (await rejected(
      kbz.status('ORDER_1', { signal: AbortSignal.timeout(10) }),
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect((error.cause as Error).name).toBe('TimeoutError');
  });

  it('is safe for concurrent use', async () => {
    const kbz = new KbzPay(config, {
      fetch: async () =>
        new Response('{"Response":{"result":"SUCCESS","code":"0","prepay_id":"P","qrCode":"qr"}}'),
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => kbz.qr(data)));
    expect(results.every((payment) => payment.qrString === 'qr')).toBe(true);
  });

  function signedCallback(fields: Record<string, unknown>): CallbackRequest {
    const signed = { ...fields, sign_type: 'SHA256' };
    return CallbackRequest.fromJson({ Request: { ...signed, sign: signer.sign(signed) } });
  }

  it('verifies a callback and acknowledges it with plain success', () => {
    const callback = gateway().handleCallback(
      signedCallback({
        appid: 'kp123',
        notify_time: 1536637503,
        merch_code: '100001',
        merch_order_id: 'ORDER_1',
        mm_order_id: '0112345',
        total_amount: '1000',
        trans_currency: 'MMK',
        trade_status: 'PAY_SUCCESS',
        callback_info: 'title%3Diphonex',
        nonce_str: 'abc',
      }),
    );
    expect(callback.isSuccessful()).toBe(true);
    expect(callback).toMatchObject({
      orderId: 'ORDER_1',
      gatewayReference: '0112345',
      amount: '1000',
      gatewayStatus: 'PAY_SUCCESS',
    });
    expect(callback.raw).toMatchObject({ notify_time: '1536637503', merch_order_id: 'ORDER_1' });
    expect(callback.acknowledgement).toMatchObject({
      status: 200,
      body: 'success',
      headers: { 'Content-Type': 'text/plain' },
    });
  });

  it('verifies numbers with the exact text KBZ sent', () => {
    const fields = {
      merch_order_id: 'ORDER_1',
      total_amount: '1000.50',
      trade_status: 'PAY_SUCCESS',
      notify_time: '1536637503',
    };
    const sign = signer.sign(fields);
    const body = `{"Request":{"merch_order_id":"ORDER_1","total_amount":1000.50,"trade_status":"PAY_SUCCESS","notify_time":1536637503,"sign_type":"SHA256","sign":"${sign}"}}`;
    const callback = gateway().handleCallback(new CallbackRequest({ body }));
    expect(callback.amount).toBe('1000.50');
  });

  it('accepts a callback that is not wrapped in Request', () => {
    const fields = { merch_order_id: 'ORDER_1', trade_status: 'WAIT_PAY' };
    const callback = gateway().handleCallback(
      CallbackRequest.fromJson({ ...fields, sign: signer.sign(fields) }),
    );
    expect(callback).toMatchObject({
      status: 'pending',
      gatewayReference: undefined,
      amount: undefined,
    });
  });

  it('rejects a tampered callback', () => {
    const fields: Record<string, unknown> = {
      merch_order_id: 'ORDER_1',
      total_amount: '1000',
      trade_status: 'PAY_SUCCESS',
      sign_type: 'SHA256',
    };
    fields.sign = signer.sign(fields);
    fields.total_amount = '1';
    const error = caught(() =>
      gateway().handleCallback(CallbackRequest.fromJson({ Request: fields })),
    );
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as SignatureVerificationError).raw).toMatchObject({
      Request: { total_amount: '1' },
    });
    expect(() => gateway().handleCallback(new CallbackRequest())).toThrow(
      SignatureVerificationError,
    );
  });

  it.each<[string, Partial<KbzPayPaymentData>, string]>([
    ['order id with dashes', { orderId: 'ORDER-1' }, 'orderId'],
    ['order id too long', { orderId: 'a'.repeat(41) }, 'orderId'],
    ['missing order id', { orderId: '' }, 'orderId'],
    ['zero amount', { amount: Amount.kyat(0) }, 'amount'],
    ['three decimals', { amount: Amount.parse('1000.505') }, 'amount'],
    ['negative', { amount: -5 }, 'amount'],
    ['float', { amount: 10.5 }, 'amount'],
    ['missing callback url', { callbackUrl: '' }, 'callbackUrl'],
    ['undefined callback url', { callbackUrl: undefined as never }, 'callbackUrl'],
    ['callback url with query', { callbackUrl: 'https://shop.test/cb?x=1' }, 'callbackUrl'],
    ['relative callback url', { callbackUrl: '/cb' }, 'callbackUrl'],
    [
      'callback url over 512',
      { callbackUrl: `https://shop.test/${'a'.repeat(500)}` },
      'callbackUrl',
    ],
    ['timeout above 120', { timeoutMinutes: 121 }, 'timeoutMinutes'],
    ['timeout of 0', { timeoutMinutes: 0 }, 'timeoutMinutes'],
    ['negative timeout', { timeoutMinutes: -1 }, 'timeoutMinutes'],
    ['callback info over 512 encoded', { callbackInfo: '='.repeat(200) }, 'callbackInfo'],
  ])('validates the order against KBZ limits: %s', (_name, change, field) => {
    const error = caught(() => KbzPay.validate({ ...data, ...change }));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });

  it('accepts up to two decimal places and http callback URLs, as KBZ documents', () => {
    expect(() =>
      KbzPay.validate({
        ...data,
        amount: Amount.parse('1000.55'),
        callbackUrl: 'http://shop.test/cb',
      }),
    ).not.toThrow();
    const error = caught(() =>
      KbzPay.validate({ ...data, amount: Amount.parse('1000.505') }),
    ) as InvalidPaymentDataError;
    expect(error.errors.amount).toContain('KBZ Pay accepts at most 2 decimal places');
  });
});

describe('KbzPayConfig', () => {
  it('names a missing key', () => {
    expect(
      caught(() => new KbzPayConfig({ appId: 'a', appKey: '', merchantCode: 'c' })),
    ).toMatchObject({
      gateway: 'kbz_pay',
      key: 'app_key',
    });
    expect(() => new KbzPay({ appId: '', appKey: 'b', merchantCode: 'c' })).toThrow(
      ConfigurationError,
    );
  });

  it('normalizes the PWA URL so the query always follows "#/"', () => {
    for (const pwaUrl of [
      'https://static.kbzpay.com/pgw/uat/pwa/#',
      'https://static.kbzpay.com/pgw/uat/pwa/#/',
    ]) {
      expect(new KbzPayConfig({ ...config, pwaUrl }).pwaUrl).toBe(KbzPayConfig.SANDBOX_PWA_URL);
    }
  });

  it('selects the sandbox or production endpoints', () => {
    const sandbox = new KbzPayConfig({ appId: 'a', appKey: 'b', merchantCode: 'c' });
    expect(sandbox).toMatchObject({
      sandbox: true,
      apiUrl: KbzPayConfig.SANDBOX_API_URL,
      pwaUrl: KbzPayConfig.SANDBOX_PWA_URL,
    });
    const production = new KbzPayConfig({
      appId: 'a',
      appKey: 'b',
      merchantCode: 'c',
      sandbox: false,
    });
    expect(production).toMatchObject({
      apiUrl: KbzPayConfig.PRODUCTION_API_URL,
      pwaUrl: KbzPayConfig.PRODUCTION_PWA_URL,
    });
    expect(new KbzPayConfig({ ...config, apiUrl: 'https://proxy.test/kbz/' }).apiUrl).toBe(
      'https://proxy.test/kbz',
    );
  });

  it('reads the environment', () => {
    const env = {
      KBZ_PAY_APP_ID: 'kp1',
      KBZ_PAY_APP_KEY: 'key',
      KBZ_PAY_MERCHANT_CODE: '200',
      KBZ_PAY_SANDBOX: 'false',
      KBZ_PAY_BASE_URL: 'https://api.test/',
      KBZ_PAY_PWA_BASE_REDIRECT_URL: 'https://pwa.test/#',
    };
    expect(KbzPayConfig.fromEnv(env)).toMatchObject({
      appId: 'kp1',
      appKey: 'key',
      merchantCode: '200',
      sandbox: false,
      apiUrl: 'https://api.test',
      pwaUrl: 'https://pwa.test/#/',
    });
    expect(KbzPay.fromEnv(env).config.appId).toBe('kp1');
    expect(caught(() => KbzPay.fromEnv({}))).toMatchObject({ key: 'app_id' });
  });

  it('reads process.env by default', () => {
    vi.stubEnv('KBZ_PAY_APP_ID', 'from-process');
    vi.stubEnv('KBZ_PAY_APP_KEY', 'k');
    vi.stubEnv('KBZ_PAY_MERCHANT_CODE', 'm');
    try {
      expect(KbzPayConfig.fromEnv().appId).toBe('from-process');
      expect(KbzPay.fromEnv().config.appId).toBe('from-process');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the kbz-pay subpath', () => {
    expect(subpath.KbzPay).toBe(KbzPay);
    expect(subpath.KbzPayConfig).toBe(KbzPayConfig);
    expect(subpath.KbzPaySigner).toBe(KbzPaySigner);
    expect(new KbzPay(new KbzPayConfig(config)).signer).toBeInstanceOf(KbzPaySigner);
  });
});
