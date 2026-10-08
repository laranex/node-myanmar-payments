import { Amount } from './amount.js';
import { InvalidPaymentDataError } from './errors.js';

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

  required(field: string, value: unknown): this {
    if (typeof value !== 'string' || value.trim() === '') {
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
        this.fail(field, `The ${field} field must be between ${min} and ${max} characters.`);
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
    if (typeof value !== 'string' || value === '') {
      return this;
    }
    let valid: boolean;
    try {
      const parsed = new URL(value);
      valid = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '';
    } catch {
      valid = false;
    }
    if (!valid) {
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
