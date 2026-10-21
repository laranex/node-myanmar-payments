import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Amount,
  ApiError,
  CallbackRequest,
  ConfigurationError,
  DEFAULT_TIMEOUT_SECONDS,
  InvalidPaymentDataError,
  MemoryTokenCache,
  MiniAppPayment,
  PaymentFlow,
  SignatureVerificationError,
  WavePayMiniApp,
  WavePayMiniAppConfig,
  WavePayMiniAppSigner,
  type WavePayMiniAppPaymentData,
} from '../src/index.js';
import * as subpath from '../src/wave-pay-mini-app/index.js';
import { caught, FakeFetch, gatewayConfig, hmacHex, rejected } from './helpers.js';

const CALLBACK_URL = 'https://shop.test/wave-pay-mini-app/callback';

function gateway(fake = new FakeFetch(), tokenCache = new MemoryTokenCache()): WavePayMiniApp {
  return new WavePayMiniApp(gatewayConfig.wavePayMiniApp({ baseUrl: 'https://wave.test/' }), {
    fetch: fake.fetch,
    tokenCache,
  });
}

function data(overrides: Partial<WavePayMiniAppPaymentData> = {}): WavePayMiniAppPaymentData {
  return {
    orderId: 'ORDER_1',
    callbackUrl: CALLBACK_URL,
    items: [{ name: 'Ticket', amount: 5000 }],
    ...overrides,
  };
}

/** A callback body signed with the test secret over `amount . orderId . MINI456 . ref . url`. */
function callback(fields: Record<string, unknown> = {}, url = CALLBACK_URL): string {
  const body: Record<string, unknown> = {
    merchantRefId: 'ref-001',
    orderId: 'ORDER_1',
    amount: 5000,
    msisdn: '9790000000',
    transactionId: 'T1',
    transactionStatus: 'successful',
    ...fields,
  };
  body.hashValue ??= hmacHex(
    `${String(body.amount)}${String(body.orderId)}MINI456${String(body.merchantRefId)}${url}`,
    'test-secret',
  );
  return JSON.stringify(body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WavePayMiniAppConfig', () => {
  it('requires every setting except the timeout and trims the base URL', () => {
    const config = new WavePayMiniAppConfig(
      gatewayConfig.wavePayMiniApp({ baseUrl: 'https://wave.test//', timeoutSeconds: undefined }),
    );
    expect(config.baseUrl).toBe('https://wave.test');
    expect(config.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(WavePayMiniAppConfig.PRODUCTION_URL).toBe('https://api.wavemoney.io:8100');
    expect(
      caught(() => new WavePayMiniAppConfig(gatewayConfig.wavePayMiniApp({ miniAppId: ' ' }))),
    ).toMatchObject({ gateway: 'wave_pay_mini_app', key: 'mini_app_id' });
    expect(caught(() => new WavePayMiniAppConfig({} as never))).toBeInstanceOf(ConfigurationError);
  });

  it('reads the WAVE_PAY_MINI_APP_* variables', () => {
    const env = {
      WAVE_PAY_MINI_APP_CLIENT_ID: ' client ',
      WAVE_PAY_MINI_APP_CLIENT_SECRET: 'secret',
      WAVE_PAY_MINI_APP_MINI_APP_ID: 'MINI456',
      WAVE_PAY_MINI_APP_SECRET_KEY: 'key',
      WAVE_PAY_MINI_APP_BASE_URL: 'https://preprodnewapi.wavemoney.io/',
      MYANMAR_PAYMENTS_HTTP_TIMEOUT: '10',
    };
    expect(WavePayMiniAppConfig.optionsFromEnv(env)).toEqual({
      clientId: 'client',
      clientSecret: 'secret',
      miniAppId: 'MINI456',
      secretKey: 'key',
      baseUrl: 'https://preprodnewapi.wavemoney.io/',
      timeoutSeconds: '10',
    });
    const config = WavePayMiniAppConfig.fromEnv(env);
    expect(config).toMatchObject({
      clientId: 'client',
      baseUrl: 'https://preprodnewapi.wavemoney.io',
      timeoutSeconds: 10,
    });
    expect(WavePayMiniApp.fromEnv(env).config).toEqual(config);
    expect(WavePayMiniAppConfig.optionsFromEnv()).toBeTypeOf('object');
    expect(new WavePayMiniApp(config).config).toBe(config);
  });

  it('exports the gateway from its own entry point', () => {
    expect(subpath.WavePayMiniApp).toBe(WavePayMiniApp);
    expect(subpath.WavePayMiniAppConfig).toBe(WavePayMiniAppConfig);
    expect(subpath.WavePayMiniAppSigner).toBe(WavePayMiniAppSigner);
  });
});

describe('WavePayMiniApp.accessToken', () => {
  it('posts the client credentials as a form and caches the token', async () => {
    const fake = new FakeFetch({
      body: { token_type: 'Bearer', access_token: 'tok', expires_in: 300 },
    });
    const cache = new MemoryTokenCache();
    const miniApp = gateway(fake, cache);

    expect(await miniApp.accessToken()).toBe('tok');
    expect(await gateway(new FakeFetch(), cache).accessToken()).toBe('tok');
    expect(fake.requests).toHaveLength(1);
    expect(fake.last().url).toBe('https://wave.test/auth/v1/external-utility/token');
    expect(fake.last().headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fake.last().headers.accept).toBe('application/json');
    expect(Object.fromEntries(fake.last().form())).toEqual({
      client_id: 'client',
      client_secret: 'client-secret',
      grant_type: 'client_credentials',
    });
  });

  it('requests a new token after forgetToken() or when the cached value is empty', async () => {
    const fake = new FakeFetch(
      { body: { access_token: 'one' } },
      { body: { access_token: 'two' } },
    );
    const cache = new MemoryTokenCache();
    const miniApp = gateway(fake, cache);
    expect(await miniApp.accessToken()).toBe('one');
    await miniApp.forgetToken();
    expect(await miniApp.accessToken()).toBe('two');

    const empty = new FakeFetch({ body: { access_token: 'three' } });
    const blank = {
      get: () => '',
      set: () => undefined,
      delete: () => undefined,
    };
    expect(await gateway(empty, blank as never).accessToken()).toBe('three');
  });

  it('shares one in-flight token request between concurrent callers', async () => {
    const fake = new FakeFetch({ body: { access_token: 'shared', expires_in: 3600 } });
    const miniApp = gateway(fake);
    const tokens = await Promise.all([
      miniApp.accessToken(),
      miniApp.accessToken(),
      miniApp.accessToken(),
    ]);
    expect(tokens).toEqual(['shared', 'shared', 'shared']);
    expect(fake.requests).toHaveLength(1);

    const failing = gateway(
      new FakeFetch({ status: 500, body: 'down' }, { body: { access_token: 'next' } }),
    );
    const errors = await Promise.all([
      rejected(failing.accessToken()),
      rejected(failing.accessToken()),
    ]);
    expect(errors[0]).toBeInstanceOf(ApiError);
    expect(errors[1]).toBe(errors[0]);
    expect(await failing.accessToken()).toBe('next');
  });

  it("lets a caller's signal stop only its own wait, not the shared request", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          expect(init.signal?.aborted).toBe(false);
          release = resolve;
        }),
    );
    const miniApp = new WavePayMiniApp(gatewayConfig.wavePayMiniApp(), { fetch });
    const controller = new AbortController();
    const aborted = miniApp.accessToken({ signal: controller.signal });
    const other = miniApp.accessToken();
    const signaled = miniApp.accessToken({ signal: new AbortController().signal });
    controller.abort(new Error('caller gone'));

    const error = await rejected(aborted);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(
      'Could not reach https://api.wavemoney.io:8100/auth/v1/external-utility/token: caller gone',
    );
    expect((error as ApiError).cause).toBeInstanceOf(Error);

    release(new Response('{"access_token":"tok"}', { status: 200 }));
    expect(await other).toBe('tok');
    expect(await signaled).toBe('tok');
    expect(fetch).toHaveBeenCalledTimes(1);

    const early = new AbortController();
    early.abort('stop');
    const cachedMiss = new WavePayMiniApp(gatewayConfig.wavePayMiniApp(), {
      fetch: new FakeFetch({ body: { access_token: 'later' } }).fetch,
    });
    expect(await rejected(cachedMiss.accessToken({ signal: early.signal }))).toMatchObject({
      message: 'Could not reach https://api.wavemoney.io:8100/auth/v1/external-utility/token: stop',
      cause: 'stop',
    });
    expect(await cachedMiss.accessToken()).toBe('later');
  });

  it('reports a failed token request', async () => {
    const error = await rejected(
      gateway(
        new FakeFetch({
          status: 401,
          body: { error: 'invalid_client', error_description: 'Bad client' },
        }),
      ).accessToken(),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: 'Wave Pay Mini App token request failed: [invalid_client] Bad client',
      gatewayCode: 'invalid_client',
      gatewayMessage: 'Bad client',
      httpStatus: 401,
      raw: { error: 'invalid_client', error_description: 'Bad client' },
    });
  });
});

describe('WavePayMiniApp.payment', () => {
  it("signs Wave's makePayment object without sending a request", () => {
    const fake = new FakeFetch();
    const payment = gateway(fake).payment(
      data({
        amount: Amount.kyat(5000),
        orderId: 'ORDER123',
        merchantReferenceId: 'MERCHANT789',
        callbackUrl: 'https://yourdomain.com/callback',
      }),
    );
    expect(fake.requests).toHaveLength(0);
    expect(payment).toBeInstanceOf(MiniAppPayment);
    expect(payment.flow).toBe(PaymentFlow.MiniApp);
    expect(payment.hashValue).toBe(
      hmacHex('5000ORDER123MINI456MERCHANT789https://yourdomain.com/callback', 'test-secret'),
    );
    expect(payment.items[0]?.amount.toString()).toBe('5000');
    expect(Object.isFrozen(payment.items)).toBe(true);
    expect(payment.toJSON()).toEqual({
      amount: 5000,
      miniAppID: 'MINI456',
      merchantRefID: 'MERCHANT789',
      orderID: 'ORDER123',
      callBackUrl: 'https://yourdomain.com/callback',
      hashValue: payment.hashValue,
      items: [{ name: 'Ticket', amount: 5000 }],
    });
  });

  it('defaults the amount to the exact sum of the items and fills a missing reference', () => {
    const request = data({
      items: [
        { name: 'A', amount: 1000 },
        { name: 'B', amount: 2500n },
      ],
    });
    const payment = gateway().payment(request);
    expect(payment.amount.toString()).toBe('3500');
    expect(payment.merchantReferenceId).toMatch(/^[0-9a-f]{32}$/);
    expect(request.merchantReferenceId).toBe(payment.merchantReferenceId);
    expect(WavePayMiniApp.resolvedAmount({ items: 'x' as never })).toBeUndefined();
    expect(WavePayMiniApp.resolvedAmount({ items: [], amount: 7 })?.toString()).toBe('7');
  });

  it('leaves invalid data untouched and reports every field', () => {
    const request = data({ orderId: '', items: [], merchantReferenceId: 5 as never });
    const error = caught(() => gateway().payment(request));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors).toEqual({
      orderId: 'The orderId field is required.',
      items: 'The items field must have at least one item.',
      merchantReferenceId: 'The merchantReferenceId field must be a string.',
      amount: 'The amount field is required.',
    });
    expect(request.merchantReferenceId).toBe(5);
    expect(
      caught(() => WavePayMiniApp.validate(data({ items: undefined as never, amount: 10 }))),
    ).toMatchObject({ errors: { items: 'The items field must have at least one item.' } });
  });

  it('writes amounts beyond a safe integer with every digit', () => {
    const payment = gateway().payment(
      data({ items: [{ name: 'Big', amount: 10n ** 20n }], merchantReferenceId: 'ref' }),
    );
    expect(payment.toJsonString()).toContain('"amount":100000000000000000000,');
    expect(payment.toJsonString()).toContain('{"name":"Big","amount":100000000000000000000}');

    const rawJSON = vi.fn((text: string) => ({ rawJSON: text }));
    vi.stubGlobal('JSON', { ...JSON, stringify: JSON.stringify, rawJSON });
    expect(payment.toJSON().amount).toEqual({ rawJSON: '100000000000000000000' });
    expect(rawJSON).toHaveBeenCalledTimes(2);

    vi.stubGlobal('JSON', { parse: JSON.parse, stringify: JSON.stringify });
    expect(() => payment.toJSON()).toThrow(RangeError);
    expect(() => payment.toJSON()).toThrow(/use toJsonString\(\)/);
  });
});

describe('WavePayMiniApp.handleCallback', () => {
  it('verifies the hash with the callback URL the payment was signed with', () => {
    const result = gateway().handleCallback(
      new CallbackRequest({ body: callback(), headers: { 'Content-Type': 'application/json' } }),
      CALLBACK_URL,
    );
    expect(result).toMatchObject({
      orderId: 'ORDER_1',
      status: 'successful',
      gatewayStatus: 'successful',
      gatewayReference: 'T1',
      amount: '5000',
      raw: { merchantRefId: 'ref-001', msisdn: '9790000000' },
    });
    expect(result.isSuccessful()).toBe(true);
    expect(result.acknowledgement.status).toBe(200);
    expect(result.acknowledgement.body).toBe('');
  });

  it('accepts a form body and an uppercase hash, and maps the statuses', () => {
    for (const [status, expected] of [
      ['PROCESSING', 'pending'],
      [' failed ', 'failed'],
      ['PAYMENT_COMPLETED', 'unknown'],
    ] as const) {
      const fields = JSON.parse(callback({ transactionStatus: status })) as Record<string, string>;
      fields.hashValue = (fields.hashValue as string).toUpperCase();
      const result = gateway().handleCallback(
        new CallbackRequest({ body: new URLSearchParams(fields).toString() }),
        CALLBACK_URL,
      );
      expect(result.status).toBe(expected);
    }
  });

  it('rejects a wrong URL, a tampered value, a nested value and a malformed callback', () => {
    const verify = (body: string, url = CALLBACK_URL): unknown =>
      caught(() => gateway().handleCallback(new CallbackRequest({ body }), url));
    const failed = 'Wave Pay Mini App callback hash verification failed.';
    expect(verify(callback(), 'https://shop.test/other')).toMatchObject({ message: failed });
    expect(verify(callback({ hashValue: 1 }))).toMatchObject({ message: failed });
    expect(verify(callback({ msisdn: ['x'] }))).toMatchObject({ message: failed });
    const tampered = JSON.parse(callback()) as Record<string, unknown>;
    tampered.amount = 1;
    const error = verify(JSON.stringify(tampered));
    expect(error).toBeInstanceOf(SignatureVerificationError);
    expect((error as SignatureVerificationError).raw).toMatchObject({ amount: '1' });
    expect(verify(callback({ amount: '10.5' }))).toMatchObject({
      message: 'Wave Pay Mini App callback is malformed.',
    });
  });
});

describe('WavePayMiniAppSigner', () => {
  it('hashes and verifies case-insensitively', () => {
    const signer = new WavePayMiniAppSigner('test-secret');
    const hash = signer.hash(
      '5000',
      'ORDER123',
      'MINI456',
      'MERCHANT789',
      'https://yourdomain.com/callback',
    );
    expect(hash).toBe('aae8c2959c7d5c4995bcdeb6ec4aa6e4f34fbd7607d039436991f901ed883f6c');
    expect(
      signer.verify(
        hash.toUpperCase(),
        '5000',
        'ORDER123',
        'MINI456',
        'MERCHANT789',
        'https://yourdomain.com/callback',
      ),
    ).toBe(true);
    expect(
      signer.verify(
        hash,
        '5001',
        'ORDER123',
        'MINI456',
        'MERCHANT789',
        'https://yourdomain.com/callback',
      ),
    ).toBe(false);
  });
});
