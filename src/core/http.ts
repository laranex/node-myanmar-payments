import { ApiError, PaymentError } from './errors.js';
import { parseJsonObject, type LosslessObject } from './json.js';

/** A request a gateway sends. Gateways only send `POST`s. */
export interface HttpRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Aborts the request, e.g. when the caller's own request is canceled. */
  signal?: AbortSignal | undefined;
}

/** A gateway's response: its status and raw body text. */
export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Sends the gateway's HTTP requests. Implement it to add proxies, tracing, retries or a test
 * double; the default is {@link FetchHttpClient}. Throw on network failures; any non-2xx status
 * is a normal response.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** The `fetch` function {@link FetchHttpClient} uses, e.g. `globalThis.fetch` or `undici.fetch`. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/** Options of {@link FetchHttpClient}. */
export interface FetchHttpClientOptions {
  /** The `fetch` to call; defaults to the global `fetch`. */
  fetch?: FetchFunction | undefined;
  /** Milliseconds before a request is aborted; defaults to 30000. `0` disables the timeout. */
  timeoutMs?: number | undefined;
}

/** The default request timeout: 30 seconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The default {@link HttpClient}: the global `fetch` (or the one you pass) with a 30 second
 * timeout.
 */
export class FetchHttpClient implements HttpClient {
  private readonly fetchFunction: FetchFunction | undefined;
  private readonly timeoutMs: number;

  constructor(options: FetchHttpClientOptions = {}) {
    this.fetchFunction = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const fetchFunction: FetchFunction | undefined = this.fetchFunction ?? globalThis.fetch;
    if (typeof fetchFunction !== 'function') {
      throw new TypeError('No fetch implementation is available; pass one with the fetch option.');
    }
    const response = await fetchFunction(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: combineSignals(request.signal, this.timeoutMs) ?? null,
    });
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new ApiError(`Could not read response from ${request.url}: ${describe(error)}`, {
        httpStatus: response.status,
        cause: error,
      });
    }
    return { status: response.status, body };
  }
}

/** Options every gateway that calls an API accepts. */
export interface GatewayOptions {
  /** Sends the requests. Takes precedence over `fetch` and `timeoutMs`. */
  httpClient?: HttpClient | undefined;
  /** The `fetch` the default client calls, e.g. a mocked one in tests. */
  fetch?: FetchFunction | undefined;
  /** Milliseconds before the default client aborts a request; defaults to 30000. */
  timeoutMs?: number | undefined;
}

/** Per-call options of every network method. */
export interface RequestOptions {
  /** Aborts the gateway call, e.g. with `AbortSignal.timeout(5000)` or the incoming request's signal. */
  signal?: AbortSignal | undefined;
}

/** @internal */
export function httpClientFrom(options: GatewayOptions = {}): HttpClient {
  return (
    options.httpClient ??
    new FetchHttpClient({ fetch: options.fetch, timeoutMs: options.timeoutMs })
  );
}

/** A decoded gateway response. @internal */
export class GatewayResponse {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {}

  successful(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** The body as a JSON object with exact numbers, or `{}` when it is not one. */
  json(): LosslessObject {
    return parseJsonObject(this.body) ?? {};
  }
}

/**
 * Posts the JSON and form requests the gateways use.
 *
 * @internal
 */
export class Transport {
  constructor(private readonly client: HttpClient) {}

  postJson(
    url: string,
    data: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<GatewayResponse> {
    return this.post(
      url,
      JSON.stringify(data),
      { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      signal,
    );
  }

  postForm(
    url: string,
    data: Record<string, string>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<GatewayResponse> {
    return this.post(
      url,
      new URLSearchParams(data).toString(),
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      signal,
    );
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<GatewayResponse> {
    let response: HttpResponse;
    try {
      response = await this.client.send({ method: 'POST', url, headers, body, signal });
    } catch (error) {
      if (error instanceof PaymentError) {
        throw error;
      }
      throw new ApiError(`Could not reach ${url}: ${describe(error)}`, { cause: error });
    }
    return new GatewayResponse(response.status, response.body);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal !== undefined) {
    signals.push(signal);
  }
  if (timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length <= 1) {
    return signals[0];
  }
  // AbortSignal.any() needs Node 20.3; this works on every supported version.
  const controller = new AbortController();
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener(
      'abort',
      () => {
        controller.abort(source.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
