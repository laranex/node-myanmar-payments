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

/** The variable holding the HTTP timeout of every gateway that calls an API. @internal */
export const HTTP_TIMEOUT_VARIABLE = 'MYANMAR_PAYMENTS_HTTP_TIMEOUT';

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
