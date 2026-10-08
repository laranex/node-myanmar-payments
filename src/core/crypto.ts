import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 of `message`, hex encoded. @internal */
export function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** HMAC-SHA256 of `message`, base64 encoded. @internal */
export function hmacSha256Base64(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('base64');
}

/** SHA-256 of `message`, hex encoded. @internal */
export function sha256Hex(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

/** Compares two strings in constant time (for equal lengths). @internal */
export function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `bytes` random bytes, hex encoded. @internal */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Escapes text like Go's `url.QueryEscape` and PHP's `urlencode`: everything except letters,
 * digits and `-_.~` is percent-encoded and spaces become `+`.
 *
 * @internal
 */
export function queryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** Decodes strict standard base64 (with padding), or `undefined`. @internal */
export function decodeBase64(value: string): string | undefined {
  if (value === '' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, 'base64').toString('utf8');
}
