import { isLosslessObject, JsonNumber, type LosslessObject } from './json.js';

/**
 * Returns a scalar as the text a gateway signs: strings as is, numbers exactly as sent, booleans as
 * `true`/`false`. Objects, arrays, `null` and `undefined` return `undefined`.
 *
 * @internal
 */
export function scalarString(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? String(value) : undefined;
    case 'bigint':
      return value.toString();
    default:
      return value instanceof JsonNumber ? value.text : undefined;
  }
}

/** The value at `key` as a string, or `''` when it is missing or not a scalar. @internal */
export function get(source: Record<string, unknown>, key: string): string {
  return scalarString(source[key]) ?? '';
}

/** The value at `key` as a string, or `undefined` when it is missing, `null` or not a scalar. @internal */
export function optional(source: Record<string, unknown>, key: string): string | undefined {
  return scalarString(source[key]);
}

/** ASCII whitespace and NUL, the characters PHP `trim()` removes. */
const TRIMMED = new Set([' ', '\t', '\n', '\r', '\0', '\v']);

/**
 * Removes ASCII whitespace and NUL (`" \t\n\r\0\x0B"`) from both ends, like PHP `trim()`. A
 * no-break space or a byte order mark is a character, not whitespace. @internal
 */
export function asciiTrim(value: string): string {
  let start = 0;
  while (start < value.length && TRIMMED.has(value.charAt(start))) {
    start++;
  }
  return asciiTrimEnd(value.slice(start));
}

/** Removes trailing ASCII whitespace and NUL, like PHP `rtrim()`. @internal */
export function asciiTrimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && TRIMMED.has(value.charAt(end - 1))) {
    end--;
  }
  return value.slice(0, end);
}

/** The value at `key` with surrounding ASCII whitespace removed. @internal */
export function trimmed(source: Record<string, unknown>, key: string): string {
  return asciiTrim(get(source, key));
}

/** The value at `key` when it is an object (not an array). @internal */
export function object(source: Record<string, unknown>, key: string): LosslessObject | undefined {
  const value = source[key];
  return isLosslessObject(value) ? value : undefined;
}

/** Whether `value` is an object or array, which a gateway never signs. @internal */
export function isNested(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !(value instanceof JsonNumber);
}
