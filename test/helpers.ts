import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  AyaPayConfigOptions,
  CyberSourceConfigOptions,
  FetchFunction,
  KbzPayConfigOptions,
  WavePayConfigOptions,
  WavePayMiniAppConfigOptions,
  YomaMmqrConfigOptions,
} from '../src/index.js';

/** A request captured by {@link FakeFetch}. */
export interface Recorded {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  json(): Record<string, unknown>;
  form(): URLSearchParams;
}

/** A canned reply: a status (default 200) and a body (objects are sent as JSON). */
export interface Reply {
  status?: number;
  body?: unknown;
}

/**
 * A `fetch` double that answers with canned replies in order and records every request.
 */
export class FakeFetch {
  readonly requests: Recorded[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies;
  }

  readonly fetch: FetchFunction = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init.body === 'string' ? init.body : '';
    this.requests.push({
      url: input,
      path: new URL(input).pathname,
      method: init.method ?? 'GET',
      headers,
      body,
      json: () => JSON.parse(body) as Record<string, unknown>,
      form: () => new URLSearchParams(body),
    });
    const reply = this.replies.shift() ?? { status: 500, body: { message: 'no canned reply' } };
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null);
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  last(): Recorded {
    const last = this.requests.at(-1);
    if (last === undefined) {
      throw new Error('no request was sent');
    }
    return last;
  }
}

/** Reads a shared test vector from test/fixtures. */
export function fixture<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)), 'utf8'),
  ) as T;
}

export function hmacHex(message: string, key: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

export function hmacBase64(message: string, key: string): string {
  return createHmac('sha256', key).update(message).digest('base64');
}

/** Runs `fn` and returns what it threw. Fails when it does not throw. */
export function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

/** Awaits `promise` and returns what it rejected with. Fails when it resolves. */
export async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/**
 * Complete, valid gateway settings with production URLs; tests override only what they check.
 * Every setting is required except the HTTP timeout.
 */
export const gatewayConfig = {
  kbzPay: (overrides: Partial<KbzPayConfigOptions> = {}): KbzPayConfigOptions => ({
    appId: 'kp123',
    appKey: 'secret-key',
    merchantCode: '100001',
    apiUrl: 'https://api.kbzpay.com/payment/gateway',
    pwaUrl: 'https://wap.kbzpay.com/pgw/pwa/#/',
    timeToLiveMinutes: 15,
    timeoutSeconds: 30,
    ...overrides,
  }),
  wavePay: (overrides: Partial<WavePayConfigOptions> = {}): WavePayConfigOptions => ({
    merchantId: 'testmerchantID',
    secretKey: 'test-secret',
    merchantName: 'Shop',
    baseUrl: 'https://payments.wavemoney.io',
    baseRedirectUrl: 'https://payments.wavemoney.io',
    timeToLiveSeconds: 300,
    timeoutSeconds: 30,
    ...overrides,
  }),
  wavePayMiniApp: (
    overrides: Partial<WavePayMiniAppConfigOptions> = {},
  ): WavePayMiniAppConfigOptions => ({
    clientId: 'client',
    clientSecret: 'client-secret',
    miniAppId: 'MINI456',
    secretKey: 'test-secret',
    baseUrl: 'https://api.wavemoney.io:8100',
    timeoutSeconds: 30,
    ...overrides,
  }),
  ayaPay: (overrides: Partial<AyaPayConfigOptions> = {}): AyaPayConfigOptions => ({
    appKey: 'app-key',
    appSecret: 'test-secret',
    baseUrl: 'https://pgw.ayainnovation.com',
    timeoutSeconds: 30,
    ...overrides,
  }),
  yomaMmqr: (overrides: Partial<YomaMmqrConfigOptions> = {}): YomaMmqrConfigOptions => ({
    merchantId: 'M001',
    clientId: 'client',
    clientSecret: 'secret',
    webhookHashKey: 'hash-key',
    apiVersion: 'v1rc',
    webhookSecret: 'webhook-secret',
    baseUrl: 'https://paymenthubapi.yomabank.com',
    timeoutSeconds: 30,
    ...overrides,
  }),
  cyberSource: (overrides: Partial<CyberSourceConfigOptions> = {}): CyberSourceConfigOptions => ({
    profileId: 'profile',
    accessKey: 'access',
    secretKey: 'secret',
    baseUrl: 'https://secureacceptance.cybersource.com',
    ...overrides,
  }),
};
