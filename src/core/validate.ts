import { isIPv6 } from 'node:net';

import { Amount } from './amount.js';
import { InvalidPaymentDataError } from './errors.js';
import { asciiTrim } from './values.js';

/** What a gateway's documentation allows for an amount. @internal */
export interface AmountRule {
  /** The gateway's display name, used in error messages. */
  gateway: string;
  /** The most fractional digits allowed: 0 means whole amounts only, `null` means no limit. */
  maxDecimals: number | null;
  /** Limits the amount's text length. */
  maxLength?: number;
  /** Accepts an amount of 0. */
  allowZero?: boolean;
}

/**
 * Converts an amount input to an {@link Amount}, or `undefined` when it is missing or not a valid
 * non-negative amount. Validation reports why.
 *
 * @internal
 */
export function toAmount(value: unknown): Amount | undefined {
  if (value instanceof Amount) {
    return value;
  }
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n)
  ) {
    return Amount.kyat(value);
  }
  return undefined;
}

/** One host label: letters, digits and inner dashes, 1 to 63 characters. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether `value` is an absolute http or https URL by PHP's `FILTER_VALIDATE_URL` rules, the same in
 * every Laranex SDK: printable ASCII only (no whitespace or control characters), `http://` or
 * `https://` in any case, then a host that is a bracketed IPv6 literal or dot-separated labels (1 to
 * 63 characters each, at most 253 in all, one trailing dot allowed), and an optional port of up to
 * five digits from 0 to 65535. User info holds letters, digits and `-._~!$&'()*+,;=:`; path, query
 * and fragment may hold any printable ASCII.
 *
 * @internal
 */
export function isHttpUrl(value: string): boolean {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!/^[\x21-\x7E]+$/.test(value) || authority === undefined) {
    return false;
  }
  const at = authority.lastIndexOf('@');
  const parts = /^(\[[^\]]*\]|[^:]*)(?::(\d{0,5}))?$/.exec(authority.slice(at + 1));
  if (
    parts === null ||
    !/^[A-Za-z0-9\-._~!$&'()*+,;=:]*$/.test(authority.slice(0, Math.max(at, 0))) ||
    Number(parts[2] ?? 0) > 65535
  ) {
    return false;
  }
  const host = parts[1] as string;
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    return !address.includes('%') && isIPv6(address);
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name !== '' && name.length <= 253 && name.split('.').every((label) => LABEL.test(label));
}

/** UTF-8 byte length, matching the byte limits in the gateway documentation. @internal */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Collects one error per field (the first one wins) and throws them together.
 *
 * @internal
 */
export class Validator {
  private readonly errors: Record<string, string> = {};

  /** Fails when the value is not a string or is blank (only ASCII whitespace and NUL count). */
  required(field: string, value: unknown): this {
    if (typeof value !== 'string' || asciiTrim(value) === '') {
      this.fail(field, `The ${field} field is required.`);
    }
    return this;
  }

  /** Fails when the value is set but not a string. */
  string(field: string, value: unknown): this {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      this.fail(field, `The ${field} field must be a string.`);
    }
    return this;
  }

  length(field: string, value: string | undefined, min: number, max: number): this {
    if (typeof value === 'string' && value !== '') {
      const size = byteLength(value);
      if (size < min || size > max) {
        this.fail(
          field,
          min === max
            ? `The ${field} field must be ${min} characters.`
            : `The ${field} field must be between ${min} and ${max} characters.`,
        );
      }
    }
    return this;
  }

  max(field: string, value: string | undefined, max: number): this {
    if (typeof value === 'string' && byteLength(value) > max) {
      this.fail(field, `The ${field} field must not be greater than ${max} characters.`);
    }
    return this;
  }

  pattern(field: string, value: string | undefined, pattern: RegExp, description: string): this {
    if (typeof value === 'string' && value !== '' && !pattern.test(value)) {
      this.fail(field, `The ${field} field may only contain ${description}.`);
    }
    return this;
  }

  /** Fails when a set value is not an integer within [min, max]. */
  between(field: string, value: unknown, min: number, max: number): this {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    ) {
      this.fail(field, `The ${field} field must be between ${min} and ${max}.`);
    }
    return this;
  }

  amount(field: string, value: unknown, rule: AmountRule): this {
    if (value === undefined || value === null) {
      return this.fail(field, `The ${field} field is required.`);
    }
    if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
      return this.fail(
        field,
        `The ${field} field must be a whole number of kyat or an Amount; use Amount.parse('10.50') for decimal amounts.`,
      );
    }
    if (!(value instanceof Amount) && typeof value !== 'number' && typeof value !== 'bigint') {
      return this.fail(
        field,
        `The ${field} field must be an Amount, e.g. Amount.kyat(1000) or Amount.parse('1000.50').`,
      );
    }
    if ((typeof value === 'bigint' || Number.isInteger(value)) && (value as number | bigint) < 0) {
      return this.fail(field, `The ${field} field must not be negative.`);
    }
    const amount = toAmount(value);
    if (amount === undefined) {
      return this.fail(
        field,
        `The ${field} field must be a non-negative number such as 1000 or 1000.50.`,
      );
    }
    const places = amount.decimalPlaces();
    if (rule.maxDecimals === 0 && places > 0) {
      return this.fail(
        field,
        `${rule.gateway} does not accept decimal amounts; the ${field} field must be a whole number.`,
      );
    }
    if (rule.maxDecimals !== null && rule.maxDecimals > 0 && places > rule.maxDecimals) {
      return this.fail(
        field,
        `${rule.gateway} accepts at most ${rule.maxDecimals} decimal places; the ${field} field has ${places}.`,
      );
    }
    if (rule.allowZero !== true && amount.isZero()) {
      return this.fail(field, `The ${field} field must be greater than 0.`);
    }
    if (rule.maxLength !== undefined && amount.toString().length > rule.maxLength) {
      return this.fail(
        field,
        `The ${field} field must not be greater than ${rule.maxLength} characters.`,
      );
    }
    return this;
  }

  /** Fails when a set value is not an absolute http or https URL. */
  url(field: string, value: string | undefined): this {
    if (typeof value === 'string' && value !== '' && !isHttpUrl(value)) {
      this.fail(field, `The ${field} field must be a valid http or https URL.`);
    }
    return this;
  }

  when(condition: boolean, field: string, message: string): this {
    if (condition) {
      this.fail(field, message);
    }
    return this;
  }

  /** Whether any check failed so far. */
  failed(): boolean {
    return Object.keys(this.errors).length > 0;
  }

  /** Throws an {@link InvalidPaymentDataError} when any check failed. */
  validate(): void {
    if (this.failed()) {
      throw new InvalidPaymentDataError(this.errors);
    }
  }

  private fail(field: string, message: string): this {
    if (!Object.prototype.hasOwnProperty.call(this.errors, field)) {
      this.errors[field] = message;
    }
    return this;
  }
}
