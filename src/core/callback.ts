import { parseJsonObject, setKey, toPlainObject, type LosslessObject } from './json.js';
import type { PaymentStatus } from './status.js';

/** Headers as a Fetch `Headers`, a Node-style object or `[name, value]` pairs. */
export type HeadersInput =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Iterable<readonly [string, string]>;

/** A query string, `URLSearchParams` or an object of values. */
export type QueryInput =
  string | URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

/** A request body: text or raw bytes (a `Buffer` works). */
export type BodyInput = string | Uint8Array | ArrayBuffer;

/** The parts of a gateway request. */
export interface CallbackRequestInit {
  /** The raw request body exactly as received. */
  body?: BodyInput | null | undefined;
  /** The request headers. */
  headers?: HeadersInput | null | undefined;
  /** The query string parameters. */
  query?: QueryInput | null | undefined;
}

/**
 * The parts of a Node `http.IncomingMessage` this package reads, so Express requests work too (and
 * Koa's `ctx.req` when no body parser consumed it).
 */
export interface NodeRequestLike extends AsyncIterable<unknown> {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  url?: string | undefined;
  /** A raw body captured by middleware, e.g. `express.raw()` or a `verify` hook. */
  rawBody?: unknown;
  /** A body parsed by middleware. Used only when the stream was already consumed. */
  body?: unknown;
}

/** The parts of a Fetch API `Request` this package reads. */
export interface WebRequestLike {
  readonly url: string;
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  clone(): { text(): Promise<string> };
}

/**
 * An incoming request from a gateway (a server callback or a browser return). Signatures are
 * verified against what the gateway actually sent, so build it from the real request with
 * {@link CallbackRequest.fromNodeRequest} or {@link CallbackRequest.fromWebRequest}.
 */
export class CallbackRequest {
  /** The raw request body, decoded as UTF-8. */
  readonly body: string;
  /** The request headers, with lowercase names. Repeated headers are joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  /** The query string parameters (the first value of each). */
  readonly query: Readonly<Record<string, string>>;

  constructor(init: CallbackRequestInit = {}) {
    this.body = bodyText(init.body);
    this.headers = Object.freeze(normalizeHeaders(init.headers));
    this.query = Object.freeze(normalizeQuery(init.query));
  }

  /** Builds a request from its parts, e.g. to replay a stored callback. */
  static from(init: CallbackRequestInit): CallbackRequest {
    return new CallbackRequest(init);
  }

  /**
   * Builds a request from a decoded payload, encoded as a JSON body, e.g. to replay a callback
   * stored as JSON.
   */
  static fromJson(payload: unknown, headers?: HeadersInput | null): CallbackRequest {
    return new CallbackRequest({
      body: JSON.stringify(payload),
      headers: { ...normalizeHeaders(headers), 'content-type': 'application/json' },
    });
  }

  /**
   * Reads a Node `http.IncomingMessage` (also Express `req`, or Koa `ctx.req` without a body
   * parser). Reads the raw body from the stream, or from `rawBody`/`body` when middleware captured
   * it as text or bytes. When a body parser already consumed the stream, the parsed `body` is
   * encoded again as JSON or a form. Fastify parses the body before your handler runs: use
   * {@link CallbackRequest.from} with the raw body there.
   */
  static async fromNodeRequest(request: NodeRequestLike): Promise<CallbackRequest> {
    const headers = normalizeHeaders(request.headers);
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams;

    let body: BodyInput | undefined = rawBody(request.rawBody) ?? rawBody(request.body);
    if (body === undefined) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array));
      }
      body = Buffer.concat(chunks);
      if (body.length === 0 && isPlainObject(request.body)) {
        body = encodeParsedBody(request.body, headers['content-type'] ?? '');
      }
    }

    return new CallbackRequest({ body, headers, query });
  }

  /**
   * Reads a Fetch API `Request` (Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers). The
   * body is read from a clone, so the request stays readable.
   */
  static async fromWebRequest(request: WebRequestLike): Promise<CallbackRequest> {
    return new CallbackRequest({
      body: request.bodyUsed ? '' : await request.clone().text(),
      headers: request.headers,
      query: new URL(request.url).searchParams,
    });
  }

  /** The named header, matched case-insensitively, or `undefined`. */
  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  /** The body decoded as JSON or as a urlencoded form. */
  parsedBody(): Record<string, unknown> {
    return toPlainObject(losslessBody(this));
  }

  /** The parsed body merged over the query string. */
  input(): Record<string, unknown> {
    return toPlainObject(losslessInput(this));
  }

  /** The query string merged over the parsed body. */
  queryInput(): Record<string, unknown> {
    return toPlainObject(losslessQueryInput(this));
  }
}

/** The body as JSON (numbers kept exact) or a form, or `{}`. @internal */
export function losslessBody(request: CallbackRequest): LosslessObject {
  const body = request.body.trim();
  if (body === '') {
    return {};
  }
  const json = parseJsonObject(body);
  if (json !== undefined) {
    return json;
  }
  return firstValues(new URLSearchParams(body));
}

/** @internal */
export function losslessInput(request: CallbackRequest): LosslessObject {
  return merge({ ...request.query }, losslessBody(request));
}

/** @internal */
export function losslessQueryInput(request: CallbackRequest): LosslessObject {
  return merge(losslessBody(request), request.query);
}

function merge(target: LosslessObject, source: Readonly<LosslessObject>): LosslessObject {
  const result: LosslessObject = {};
  for (const object of [target, source]) {
    for (const key of Object.keys(object)) {
      setKey(result, key, object[key]);
    }
  }
  return result;
}

/** The headers, a status and a body a gateway expects after it delivers a callback. */
export interface AcknowledgementInit {
  status?: number | undefined;
  body?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
}

/** The parts of a Node `http.ServerResponse` (or Express `res`) {@link Acknowledgement.send} uses. */
export interface ServerResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/**
 * The HTTP response a gateway expects after it delivers a callback. Gateways retry until they
 * receive it.
 */
export class Acknowledgement {
  /** The HTTP status, 200 unless a gateway documents another. */
  readonly status: number;
  /** The response body, e.g. KBZ Pay's plain `success`. */
  readonly body: string;
  /** The response headers. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(init: AcknowledgementInit = {}) {
    this.status = init.status ?? 200;
    this.body = init.body ?? '';
    this.headers = Object.freeze({ ...(init.headers ?? { 'Content-Type': 'text/plain' }) });
  }

  /** An empty `200 text/plain` response, which most gateways expect. */
  static default(): Acknowledgement {
    return new Acknowledgement();
  }

  /** Writes the acknowledgement to a Node `http.ServerResponse` (or Express `res`) and ends it. */
  send(response: ServerResponseLike): void {
    response.statusCode = this.status;
    for (const [name, value] of Object.entries(this.headers)) {
      response.setHeader(name, value);
    }
    response.end(this.body);
  }

  /** The acknowledgement as a Fetch API `Response`, for Next.js, Hono, Bun and other Fetch servers. */
  toResponse(): Response {
    return new Response(this.body, { status: this.status, headers: { ...this.headers } });
  }
}

/** The fields of a {@link PaymentCallback}. */
export interface PaymentCallbackInit {
  orderId: string;
  status: PaymentStatus;
  gatewayStatus: string;
  gatewayReference?: string | undefined;
  amount?: string | undefined;
  raw?: Readonly<Record<string, unknown>> | undefined;
  acknowledgement?: Acknowledgement | undefined;
}

/**
 * A gateway notification whose signature has been verified.
 *
 * Always compare `amount` with your order before fulfilling it, and handle duplicates: gateways
 * retry.
 */
export class PaymentCallback {
  /** Your order id. */
  readonly orderId: string;
  /** The status mapped onto this package's statuses. */
  readonly status: PaymentStatus;
  /** The gateway's own status value, unmapped. */
  readonly gatewayStatus: string;
  /** The gateway's id for the payment, when it sends one. */
  readonly gatewayReference: string | undefined;
  /** The amount the gateway reports, exactly as it sent it, when it sends one. */
  readonly amount: string | undefined;
  /** The verified payload. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** The response to send so the gateway stops retrying. */
  readonly acknowledgement: Acknowledgement;

  constructor(init: PaymentCallbackInit) {
    this.orderId = init.orderId;
    this.status = init.status;
    this.gatewayStatus = init.gatewayStatus;
    this.gatewayReference = init.gatewayReference;
    this.amount = init.amount;
    this.raw = init.raw ?? {};
    this.acknowledgement = init.acknowledgement ?? Acknowledgement.default();
  }

  /** Whether the customer paid. */
  isSuccessful(): boolean {
    return this.status === 'successful';
  }
}

/** The fields of a {@link PaymentStatusResult}. */
export interface PaymentStatusResultInit {
  orderId?: string | undefined;
  status: PaymentStatus;
  gatewayStatus: string;
  gatewayReference?: string | undefined;
  amount?: string | undefined;
  raw?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The state of a payment as reported by a gateway's status API.
 */
export class PaymentStatusResult {
  /** Your order id, when the gateway returns it. */
  readonly orderId: string | undefined;
  /** The status mapped onto this package's statuses. */
  readonly status: PaymentStatus;
  /** The gateway's own status value, unmapped. */
  readonly gatewayStatus: string;
  /** The gateway's id for the payment, when it sends one. */
  readonly gatewayReference: string | undefined;
  /** The amount the gateway reports, exactly as it sent it, when it sends one. */
  readonly amount: string | undefined;
  /** The gateway's response, for logging. */
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(init: PaymentStatusResultInit) {
    this.orderId = init.orderId;
    this.status = init.status;
    this.gatewayStatus = init.gatewayStatus;
    this.gatewayReference = init.gatewayReference;
    this.amount = init.amount;
    this.raw = init.raw ?? {};
  }

  /** Whether the customer paid. */
  isSuccessful(): boolean {
    return this.status === 'successful';
  }
}

function bodyText(body: BodyInput | null | undefined): string {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  return new TextDecoder().decode(body);
}

function rawBody(value: unknown): BodyInput | undefined {
  if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeParsedBody(body: Record<string, unknown>, contentType: string): string {
  if (!contentType.toLowerCase().includes('urlencoded')) {
    return JSON.stringify(body);
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      form.append(key, String(item));
    }
  }
  return form.toString();
}

function normalizeHeaders(headers: HeadersInput | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined || headers === null) {
    return result;
  }
  const add = (name: string, value: string | readonly string[] | undefined): void => {
    if (value === undefined) {
      return;
    }
    const text = typeof value === 'string' ? value : value.join(', ');
    const key = name.toLowerCase();
    setKey(result, key, result[key] === undefined ? text : `${result[key]}, ${text}`);
  };
  if (
    typeof (headers as Headers).forEach === 'function' &&
    typeof (headers as Headers).get === 'function'
  ) {
    (headers as Headers).forEach((value, name) => {
      add(name, value);
    });
  } else if (Symbol.iterator in headers) {
    for (const [name, value] of headers as Iterable<readonly [string, string]>) {
      add(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      add(name, value);
    }
  }
  return result;
}

function normalizeQuery(query: QueryInput | null | undefined): Record<string, string> {
  if (query === undefined || query === null) {
    return {};
  }
  if (typeof query === 'string' || query instanceof URLSearchParams) {
    return firstValues(new URLSearchParams(query)) as Record<string, string>;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const first = typeof value === 'string' ? value : value?.[0];
    if (first !== undefined) {
      setKey(result, key, first);
    }
  }
  return result;
}

function firstValues(params: URLSearchParams): LosslessObject {
  const result: LosslessObject = {};
  for (const [key, value] of params) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      setKey(result, key, value);
    }
  }
  return result;
}
