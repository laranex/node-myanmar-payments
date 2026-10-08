import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FetchFunction } from '../src/index.js';

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
