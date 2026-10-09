import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { losslessBody } from '../src/core/callback.js';
import { JsonNumber } from '../src/core/json.js';
import {
  Acknowledgement,
  ApiError,
  AppPayment,
  CallbackRequest,
  ConfigurationError,
  DEFAULT_TIMEOUT_MS,
  FetchHttpClient,
  FormPayment,
  InvalidPaymentDataError,
  MemoryTokenCache,
  PaymentCallback,
  PaymentError,
  PaymentFlow,
  PaymentStatus,
  PaymentStatusResult,
  QrPayment,
  RedirectPayment,
  resolveStatus,
  SignatureVerificationError,
  type FetchFunction,
} from '../src/index.js';
import { Transport } from '../src/core/http.js';
import { FakeFetch, rejected } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

function nodeRequest(
  body: string | string[],
  init: Partial<IncomingMessage> & Record<string, unknown> = {},
) {
  const stream = Readable.from(Array.isArray(body) ? body : [Buffer.from(body)]);
  return Object.assign(stream, { headers: {}, url: '/', ...init }) as unknown as IncomingMessage;
}

describe('CallbackRequest', () => {
  it('parses JSON and form bodies with the documented precedence', () => {
    const json = new CallbackRequest({
      body: '{"amount": 1000.50, "nested": {"a": "b"}}',
      query: { q: '1' },
    });
    expect(losslessBody(json).amount).toEqual(new JsonNumber('1000.50'));
    expect(json.parsedBody()).toEqual({ amount: '1000.50', nested: { a: 'b' } });
    expect(json.input()).toEqual({ q: '1', amount: '1000.50', nested: { a: 'b' } });

    const form = new CallbackRequest({
      body: 'decision=ACCEPT&amount=10.50&decision=SECOND',
      query: 'decision=QUERY&extra=x',
    });
    expect(form.input()).toEqual({ decision: 'ACCEPT', amount: '10.50', extra: 'x' });
    expect(form.queryInput()).toEqual({ decision: 'QUERY', amount: '10.50', extra: 'x' });
  });

  it('decodes an empty body and bodies given as bytes', () => {
    expect(new CallbackRequest({ body: '  \n' }).parsedBody()).toEqual({});
    expect(new CallbackRequest().parsedBody()).toEqual({});
    expect(new CallbackRequest({ body: null, headers: null, query: null }).body).toBe('');
    expect(
      new CallbackRequest({ body: new TextEncoder().encode('{"a":"ü"}') }).parsedBody(),
    ).toEqual({ a: 'ü' });
    expect(new CallbackRequest({ body: new TextEncoder().encode('a=1').buffer }).body).toBe('a=1');
    expect(CallbackRequest.from({ body: 'a=1' }).parsedBody()).toEqual({ a: '1' });
  });

  it('accepts headers and queries in every shape', () => {
    const fromObject = new CallbackRequest({
      headers: { 'X-Signature': 'sig', 'X-Multi': ['a', 'b'], 'X-None': undefined },
      query: { orderId: 'ORDER_1', list: ['first', 'second'], none: undefined },
    });
    expect(fromObject.header('x-signature')).toBe('sig');
    expect(fromObject.header('X-SIGNATURE')).toBe('sig');
    expect(fromObject.header('x-multi')).toBe('a, b');
    expect(fromObject.header('authorization')).toBeUndefined();
    expect(fromObject.query).toEqual({ orderId: 'ORDER_1', list: 'first' });

    const fromHeaders = new CallbackRequest({
      headers: new Headers({ 'X-Webhook-Secret': 'shared' }),
      query: new URLSearchParams('a=1&a=2'),
    });
    expect(fromHeaders.header('X-Webhook-Secret')).toBe('shared');
    expect(fromHeaders.query).toEqual({ a: '1' });

    const fromPairs = new CallbackRequest({
      headers: [
        ['X-A', '1'],
        ['x-a', '2'],
      ],
    });
    expect(fromPairs.headers).toEqual({ 'x-a': '1, 2' });
  });

  it('builds a JSON request from a decoded payload', () => {
    const request = CallbackRequest.fromJson(
      { orderId: 'ORDER_1', amount: 1000 },
      { 'X-Signature': 'sig' },
    );
    expect(request.body).toBe('{"orderId":"ORDER_1","amount":1000}');
    expect(request.header('Content-Type')).toBe('application/json');
    expect(request.header('x-signature')).toBe('sig');
    expect(request.input()).toEqual({ orderId: 'ORDER_1', amount: '1000' });
    expect(CallbackRequest.fromJson({}).header('content-type')).toBe('application/json');
  });

  it('reads a Node request stream, its headers and its query string', async () => {
    const request = await CallbackRequest.fromNodeRequest(
      nodeRequest(['{"a":', '"b"}'], {
        headers: { 'x-webhook-secret': 'shared', 'content-type': 'application/json' },
        url: '/cb?x=1',
      }),
    );
    expect(request.body).toBe('{"a":"b"}');
    expect(request.header('X-Webhook-Secret')).toBe('shared');
    expect(request.query).toEqual({ x: '1' });

    const withoutUrl = await CallbackRequest.fromNodeRequest(
      Object.assign(Readable.from([]), { headers: {} }) as never,
    );
    expect(withoutUrl.body).toBe('');
  });

  it('prefers a raw body captured by middleware', async () => {
    const raw = await CallbackRequest.fromNodeRequest(
      nodeRequest('', { rawBody: Buffer.from('a=1') }),
    );
    expect(raw.body).toBe('a=1');
    const text = await CallbackRequest.fromNodeRequest(nodeRequest('', { body: '{"a":1}' }));
    expect(text.body).toBe('{"a":1}');
  });

  it('encodes a body that a parser already consumed', async () => {
    const json = await CallbackRequest.fromNodeRequest(
      nodeRequest('', { body: { a: 'b' }, headers: { 'content-type': 'application/json' } }),
    );
    expect(json.body).toBe('{"a":"b"}');

    const form = await CallbackRequest.fromNodeRequest(
      nodeRequest('', {
        body: { decision: 'ACCEPT', list: ['1', '2'] },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(form.body).toBe('decision=ACCEPT&list=1&list=2');

    const noType = await CallbackRequest.fromNodeRequest(nodeRequest('', { body: { a: 1 } }));
    expect(noType.body).toBe('{"a":1}');
  });

  it('reads a real node:http request', async () => {
    const server = createServer((req, res) => {
      void CallbackRequest.fromNodeRequest(req).then((request) => {
        Acknowledgement.default().send(res);
        received.push(request);
      });
    });
    const received: CallbackRequest[] = [];
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          port,
          host: '127.0.0.1',
          method: 'POST',
          path: '/cb?gateway=kbz',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{"Request":{"a":"1"}}');
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(status).toBe(200);
    expect(received[0]?.body).toBe('{"Request":{"a":"1"}}');
    expect(received[0]?.query).toEqual({ gateway: 'kbz' });
    expect(received[0]?.header('content-type')).toBe('application/json');
  });

  it('reads a Fetch API request and keeps it readable', async () => {
    const webRequest = new Request('https://shop.test/cb?x=1', {
      method: 'POST',
      headers: { 'X-Webhook-Secret': 'shared' },
      body: '{"a":"b"}',
    });
    const request = await CallbackRequest.fromWebRequest(webRequest);
    expect(request.body).toBe('{"a":"b"}');
    expect(request.header('x-webhook-secret')).toBe('shared');
    expect(request.query).toEqual({ x: '1' });
    expect(await webRequest.text()).toBe('{"a":"b"}');

    const used = await CallbackRequest.fromWebRequest(webRequest);
    expect(used.body).toBe('');
  });
});

describe('Acknowledgement', () => {
  it('defaults to an empty 200 text/plain response', () => {
    const ack = new Acknowledgement();
    expect(ack).toMatchObject({ status: 200, body: '', headers: { 'Content-Type': 'text/plain' } });
    expect(Acknowledgement.default()).toEqual(ack);
  });

  it('writes itself to a Node response', () => {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 0,
      body: '',
      setHeader: (name: string, value: string) => (headers[name] = value),
      end(body?: string) {
        this.body = body ?? '';
      },
    };
    new Acknowledgement({ status: 202, body: 'success', headers: { 'X-A': '1' } }).send(response);
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('success');
    expect(headers).toEqual({ 'X-A': '1' });
  });

  it('becomes a Fetch API response', async () => {
    const response = new Acknowledgement({ body: 'success' }).toResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('success');
  });
});

describe('results', () => {
  it('describes a redirect payment', () => {
    const payment = new RedirectPayment({ orderId: 'O1', url: 'https://pay.test' });
    expect(payment).toMatchObject({
      flow: 'redirect',
      orderId: 'O1',
      url: 'https://pay.test',
      gatewayReference: undefined,
      raw: {},
    });
  });

  it('renders a form payment as an escaped, auto-submitting page', () => {
    const payment = new FormPayment({
      orderId: 'O1',
      action: 'https://pay.test/?a="b"&c=<d>',
      fields: [
        { name: 'x', value: `"><script>alert(1)</script>` },
        { name: "o'k", value: '1' },
      ],
      enctype: 'multipart/form-data',
    });
    const html = payment.toHtml();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('&#34;&gt;&lt;script&gt;');
    expect(html).toContain('action="https://pay.test/?a=&#34;b&#34;&amp;c=&lt;d&gt;"');
    expect(html).toContain('name="o&#39;k"');
    expect(payment.flow).toBe(PaymentFlow.Form);
    expect(payment.field("o'k")).toBe('1');
    expect(payment.field('missing')).toBeUndefined();
    expect(payment.values()).toEqual({ x: `"><script>alert(1)</script>`, "o'k": '1' });
    expect(Object.isFrozen(payment.fields)).toBe(true);
    expect(new FormPayment({ orderId: 'O1', action: 'https://pay.test', fields: [] }).enctype).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('builds QR data URIs only when there is an image', () => {
    expect(new QrPayment({ orderId: 'O1', qrImage: 'abc' }).qrImageDataUri()).toBe(
      'data:image/png;base64,abc',
    );
    expect(new QrPayment({ orderId: 'O1', qrImage: 'abc' }).qrImageDataUri('image/jpeg')).toBe(
      'data:image/jpeg;base64,abc',
    );
    const kbz = new QrPayment({ orderId: 'O1', qrString: 'kbzpay://qr' });
    expect(kbz.qrImageDataUri()).toBeUndefined();
    expect(kbz).toMatchObject({ flow: 'qr', raw: {}, expiresAt: undefined, reference: undefined });
  });

  it('serializes an app payment without its raw response', () => {
    const payment = new AppPayment({
      orderId: 'O1',
      orderInfo: 'a=1',
      sign: 'S',
      signType: 'SHA256',
      raw: { x: 1 },
    });
    expect(JSON.parse(JSON.stringify(payment))).toEqual({
      orderId: 'O1',
      orderInfo: 'a=1',
      sign: 'S',
      signType: 'SHA256',
    });
    expect(payment.flow).toBe('app');
    expect(new AppPayment({ orderId: 'O1', orderInfo: '', sign: '', signType: '' }).raw).toEqual(
      {},
    );
  });

  it('builds callbacks and status results for your own tests', () => {
    const callback = new PaymentCallback({
      orderId: 'O1',
      status: PaymentStatus.Successful,
      gatewayStatus: 'PAID',
    });
    expect(callback.isSuccessful()).toBe(true);
    expect(callback.acknowledgement).toEqual(Acknowledgement.default());
    expect(callback.raw).toEqual({});
    expect(
      new PaymentCallback({ orderId: 'O1', status: 'pending', gatewayStatus: 'X' }).isSuccessful(),
    ).toBe(false);

    const result = new PaymentStatusResult({ status: 'failed', gatewayStatus: 'FAILED' });
    expect(result.isSuccessful()).toBe(false);
    expect(result.orderId).toBeUndefined();
    expect(result.raw).toEqual({});
    expect(
      new PaymentStatusResult({
        status: 'successful',
        gatewayStatus: 'OK',
        raw: { a: 1 },
      }).isSuccessful(),
    ).toBe(true);
  });
});

describe('PaymentStatus', () => {
  it('lists the statuses and knows which are final', () => {
    expect(PaymentStatus.values).toEqual([
      'successful',
      'pending',
      'failed',
      'canceled',
      'expired',
      'unknown',
    ]);
    expect(PaymentStatus.values.filter((status) => PaymentStatus.isFinal(status))).toEqual([
      'successful',
      'failed',
      'canceled',
      'expired',
    ]);
    expect(PaymentFlow).toEqual({ Redirect: 'redirect', Form: 'form', Qr: 'qr', App: 'app' });
  });

  it('resolves gateway statuses, trimming whitespace', () => {
    expect(resolveStatus({ OK: 'successful' }, ' OK ')).toBe('successful');
    expect(resolveStatus({ OK: 'successful' }, 'X')).toBe('unknown');
    expect(resolveStatus({}, 'toString')).toBe('unknown');
    expect(resolveStatus({}, undefined)).toBe('unknown');
  });
});

describe('errors', () => {
  it('share the PaymentError base and name themselves', () => {
    const invalid = new InvalidPaymentDataError({ b: 'Second.', a: 'First.' });
    expect(invalid.message).toBe('Invalid payment data: First. Second.');
    expect(invalid.name).toBe('InvalidPaymentDataError');
    expect(Object.isFrozen(invalid.errors)).toBe(true);

    const cause = new Error('boom');
    const api = new ApiError('failed', {
      gatewayCode: '09',
      gatewayMessage: 'dup',
      httpStatus: 409,
      raw: { a: 1 },
      cause,
    });
    expect(api).toMatchObject({
      gatewayCode: '09',
      gatewayMessage: 'dup',
      httpStatus: 409,
      raw: { a: 1 },
      cause,
    });
    expect(new ApiError('failed')).toMatchObject({
      httpStatus: 0,
      raw: {},
      gatewayCode: undefined,
    });
    expect(new ApiError('failed').cause).toBeUndefined();

    const signature = new SignatureVerificationError('bad', { x: 1 });
    expect(signature.raw).toEqual({ x: 1 });
    expect(new SignatureVerificationError('bad').raw).toEqual({});

    const config = new ConfigurationError('kbz_pay', 'app_key');
    expect(config.message).toBe('The kbz_pay configuration is missing [app_key].');

    for (const error of [invalid, api, signature, config]) {
      expect(error).toBeInstanceOf(PaymentError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('MemoryTokenCache', () => {
  it('expires entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new MemoryTokenCache();
    cache.set('k', 'v', 60);
    cache.set('forever', 'v', 0);
    expect(cache.get('k')).toBe('v');
    vi.setSystemTime(59_999);
    expect(cache.get('k')).toBe('v');
    vi.setSystemTime(60_000);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.get('forever')).toBe('v');
    cache.delete('forever');
    expect(cache.get('forever')).toBeUndefined();
    cache.set('a', 'b', 10);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('FetchHttpClient and transport', () => {
  it('posts compact JSON with merged headers and reads exact numbers', async () => {
    const fake = new FakeFetch({ body: '{"result":"SUCCESS","amount":1000.50}' });
    const transport = new Transport(new FetchHttpClient({ fetch: fake.fetch }));
    const response = await transport.postJson(
      'https://api.test/precreate',
      { url: 'https://shop.test/?a=1&b=2', name: 'ကျပ်' },
      { 'X-Custom': 'yes', Accept: 'text/plain' },
    );
    const sent = fake.last();
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/precreate');
    expect(sent.body).toBe('{"url":"https://shop.test/?a=1&b=2","name":"ကျပ်"}');
    expect(sent.headers).toMatchObject({
      'content-type': 'application/json',
      'x-custom': 'yes',
      accept: 'text/plain',
    });
    expect(response.successful()).toBe(true);
    expect(response.json().amount).toEqual(new JsonNumber('1000.50'));
  });

  it('posts urlencoded forms and treats non-JSON bodies as empty', async () => {
    const fake = new FakeFetch({ status: 400, body: 'not json' });
    const response = await new Transport(new FetchHttpClient({ fetch: fake.fetch })).postForm(
      'https://api.test/pay',
      { amount: '1000', 'order id': 'A&B' },
    );
    expect(fake.last().body).toBe('amount=1000&order+id=A%26B');
    expect(fake.last().headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    });
    expect(response.successful()).toBe(false);
    expect(response.json()).toEqual({});
  });

  it('turns network failures into ApiErrors with the cause', async () => {
    const cause = new TypeError('fetch failed');
    const transport = new Transport(new FetchHttpClient({ fetch: () => Promise.reject(cause) }));
    const error = (await rejected(transport.postJson('https://api.test/x', {}))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Could not reach https://api.test/x: fetch failed');
    expect(error.cause).toBe(cause);
    expect(error.httpStatus).toBe(0);

    const stringCause = new Transport({ send: () => Promise.reject('down') });
    expect(
      ((await rejected(stringCause.postJson('https://api.test/x', {}))) as ApiError).message,
    ).toBe('Could not reach https://api.test/x: down');
  });

  it('reports an unreadable body with the response status', async () => {
    const broken: FetchFunction = async () =>
      ({ status: 502, text: () => Promise.reject(new Error('boom')) }) as unknown as Response;
    const error = (await rejected(
      new Transport(new FetchHttpClient({ fetch: broken })).postJson('https://api.test/x', {}),
    )) as ApiError;
    expect(error.httpStatus).toBe(502);
    expect(error.message).toBe('Could not read response from https://api.test/x: boom');
    const nonError: FetchFunction = async () =>
      ({ status: 200, text: () => Promise.reject('nope') }) as unknown as Response;
    expect(
      (
        (await rejected(
          new FetchHttpClient({ fetch: nonError }).send({
            method: 'POST',
            url: 'https://x.test',
            headers: {},
            body: '',
          }),
        )) as ApiError
      ).message,
    ).toContain('nope');
  });

  it('aborts on the caller signal and on the timeout', async () => {
    const hang: FetchFunction = (_input, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(init.signal.reason);
        }
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    const controller = new AbortController();
    const pending = new Transport(new FetchHttpClient({ fetch: hang })).postJson(
      'https://api.test/x',
      {},
      {},
      controller.signal,
    );
    controller.abort();
    const aborted = (await rejected(pending)) as ApiError;
    expect(aborted).toBeInstanceOf(ApiError);
    expect((aborted.cause as Error).name).toBe('AbortError');

    const timedOut = (await rejected(
      new Transport(new FetchHttpClient({ fetch: hang, timeoutMs: 20 })).postJson(
        'https://api.test/x',
        {},
      ),
    )) as ApiError;
    expect((timedOut.cause as Error).name).toBe('TimeoutError');

    const already = new AbortController();
    already.abort();
    const early = (await rejected(
      new Transport(new FetchHttpClient({ fetch: hang, timeoutMs: 1000 })).postJson(
        'https://api.test/x',
        {},
        {},
        already.signal,
      ),
    )) as ApiError;
    expect((early.cause as Error).name).toBe('AbortError');
  });

  it('sends without any signal when the timeout is disabled', async () => {
    let signal: unknown = 'unset';
    const spy: FetchFunction = async (_input, init) => {
      signal = init.signal;
      return new Response('{}');
    };
    await new FetchHttpClient({ fetch: spy, timeoutMs: 0 }).send({
      method: 'POST',
      url: 'https://x.test',
      headers: {},
      body: '',
    });
    expect(signal).toBeNull();
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('uses the global fetch by default and fails clearly without one', async () => {
    const fake = new FakeFetch({ body: {} });
    vi.stubGlobal('fetch', fake.fetch);
    try {
      await new FetchHttpClient().send({
        method: 'POST',
        url: 'https://x.test/a',
        headers: {},
        body: '',
      });
      expect(fake.requests).toHaveLength(1);
      vi.stubGlobal('fetch', undefined);
      await expect(
        new FetchHttpClient().send({
          method: 'POST',
          url: 'https://x.test/a',
          headers: {},
          body: '',
        }),
      ).rejects.toThrow('No fetch implementation is available');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
