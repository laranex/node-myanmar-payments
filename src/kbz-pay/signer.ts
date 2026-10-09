import { safeEqual, sha256Hex } from '../core/crypto.js';
import { isNested, scalarString } from '../core/values.js';

/**
 * KBZ Pay's signature: every non-empty scalar field except `sign` and `sign_type`, sorted by key,
 * joined as raw `key=value` pairs (not URL-encoded), with `&key=<app key>` appended, hashed with
 * SHA-256 and uppercased.
 */
export class KbzPaySigner {
  constructor(private readonly appKey: string) {}

  /** The sorted `key=value` string, without the app key. */
  signString(fields: Readonly<Record<string, unknown>>): string {
    return Object.keys(fields)
      .filter((key) => key !== 'sign' && key !== 'sign_type')
      .map((key) => [key, scalarString(fields[key])] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined && pair[1] !== '')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
  }

  /** The uppercase SHA-256 signature of `fields`. */
  sign(fields: Readonly<Record<string, unknown>>): string {
    return sha256Hex(`${this.signString(fields)}&key=${this.appKey}`).toUpperCase();
  }

  /**
   * Whether `fields.sign` matches, compared in constant time. Nested values are never signed, so
   * fields holding an object or array fail rather than being partly trusted.
   */
  verify(fields: Readonly<Record<string, unknown>>): boolean {
    const sign = fields.sign;
    return (
      typeof sign === 'string' &&
      !Object.values(fields).some(isNested) &&
      safeEqual(this.sign(fields), sign.toUpperCase())
    );
  }
}
