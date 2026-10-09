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
 * Reads a `*_SANDBOX` variable. Only `false`, `0`, `f`, `no` and `off` (any case) select
 * production; unset or unrecognized values mean sandbox.
 *
 * @internal
 */
export function envSandbox(env: EnvSource, key: string): boolean {
  return parseSandbox(env[key] ?? '');
}

/**
 * A `sandbox` setting: booleans as is, text parsed like a `*_SANDBOX` variable (`false`, `0`, `f`,
 * `no` and `off` in any case select production; anything else means sandbox), unset means sandbox.
 *
 * @internal
 */
export function parseSandbox(value: boolean | string | undefined | null): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return !['false', '0', 'f', 'no', 'off'].includes((value ?? '').trim().toLowerCase());
}

/** An integer variable, or `undefined` when unset or not an integer. @internal */
export function envInt(env: EnvSource, key: string): number | undefined {
  const value = env[key]?.trim() ?? '';
  return /^[+-]?\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
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
