import { ConfigurationError } from './errors.js';

/** Environment variables, e.g. `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The first non-empty value among `keys`, trimmed, or `''`. @internal */
export function envFirst(env: EnvSource, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * A required whole number of seconds: an integer greater than 0, or text such as `'300'`. Unset
 * or blank throws the missing {@link ConfigurationError}; anything else throws the invalid one.
 *
 * @internal
 */
export function requireSeconds(gateway: string, key: string, value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new ConfigurationError(gateway, key);
  }
  let seconds: number | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    seconds = value;
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    seconds = Number.parseInt(value.trim(), 10);
  }
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ConfigurationError(gateway, key, true);
  }
  return seconds;
}

/**
 * An optional whole number of seconds: `undefined` when unset or blank, otherwise the same rules
 * as {@link requireSeconds}.
 *
 * @internal
 */
export function optionalSeconds(gateway: string, key: string, value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  return requireSeconds(gateway, key, value);
}

/** The variable holding the HTTP timeout of every gateway that calls an API. @internal */
export const HTTP_TIMEOUT_VARIABLE = 'MYANMAR_PAYMENTS_HTTP_TIMEOUT';

/** Seconds before the default HTTP client gives up on a request when no timeout is configured. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * The HTTP timeout in seconds: {@link DEFAULT_TIMEOUT_SECONDS} when unset or blank, otherwise a
 * whole number greater than 0 (or its text), or the invalid {@link ConfigurationError}.
 *
 * @internal
 */
export function resolveTimeout(gateway: string, value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return requireSeconds(gateway, 'timeout_in_seconds', value);
}

/** The trimmed value, or throws a {@link ConfigurationError} naming `key`. @internal */
export function requireSetting(gateway: string, key: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(gateway, key);
  }
  return value;
}

/** A trimmed optional string, `undefined` when blank. @internal */
export function optionalSetting(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Removes trailing slashes. @internal */
export function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The default environment: `process.env`. @internal */
export function defaultEnv(): EnvSource {
  return process.env;
}
