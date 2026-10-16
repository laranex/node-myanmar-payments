import { ConfigurationError } from './errors.js';
import { asciiTrim } from './values.js';

/** Environment variables, e.g. `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The first non-empty value among `keys` with ASCII whitespace and NUL trimmed (like PHP `trim()`),
 * or `''`. @internal
 */
export function envFirst(env: EnvSource, ...keys: string[]): string {
  for (const key of keys) {
    const value = asciiTrim(env[key] ?? '');
    if (value !== '') {
      return value;
    }
  }
  return '';
}

/**
 * A gateway's options read from the environment without validating them: each option names its
 * variable, a value is trimmed of ASCII whitespace, and an unset or blank variable leaves its option
 * out. @internal
 */
export function envOptions<T>(
  env: EnvSource,
  variables: Readonly<Record<keyof T & string, string>>,
): Partial<T> {
  const options: Record<string, string> = {};
  for (const [option, variable] of Object.entries<string>(variables)) {
    const value = envFirst(env, variable);
    if (value !== '') {
      options[option] = value;
    }
  }
  return options as Partial<T>;
}

/** The largest whole number a setting may hold, the same in every Laranex SDK (2^31 - 1). */
const MAX_INTEGER = 2147483647;

/** Whether a setting is unset or blank text. @internal */
export function isUnset(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && asciiTrim(value) === '')
  );
}

/**
 * A whole number given as an integer or integer text such as `'300'`, or `undefined` when it is
 * anything else or outside -2147483648 to 2147483647. @internal
 */
export function toInteger(value: unknown): number | undefined {
  let integer: number | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    integer = value;
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(asciiTrim(value))) {
    integer = Number.parseInt(asciiTrim(value), 10);
  }
  return integer !== undefined && integer >= -MAX_INTEGER - 1 && integer <= MAX_INTEGER
    ? integer
    : undefined;
}

/**
 * A required whole number of seconds: an integer from 1 to 2147483647, or its text such as
 * `'300'`. Unset or blank throws the missing {@link ConfigurationError}; anything else throws the
 * invalid one.
 *
 * @internal
 */
export function requireSeconds(gateway: string, key: string, value: unknown): number {
  if (isUnset(value)) {
    throw new ConfigurationError(gateway, key);
  }
  const seconds = toInteger(value);
  if (seconds === undefined || seconds <= 0) {
    throw new ConfigurationError(gateway, key, true);
  }
  return seconds;
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
  if (isUnset(value)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return requireSeconds(gateway, 'timeout_in_seconds', value);
}

/**
 * The value as given (not trimmed), or throws a {@link ConfigurationError} naming `key` when it is
 * missing or blank. A safe integer becomes its decimal text (`200123` becomes `'200123'`); floats,
 * booleans and other values count as missing.
 *
 * @internal
 */
export function requireSetting(gateway: string, key: string, value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || asciiTrim(text) === '') {
    throw new ConfigurationError(gateway, key);
  }
  return text;
}

/** Removes trailing slashes. @internal */
export function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The default environment: `process.env`. @internal */
export function defaultEnv(): EnvSource {
  return process.env;
}
