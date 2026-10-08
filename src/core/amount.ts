import { InvalidPaymentDataError } from './errors.js';

const PATTERN = /^\d+(\.\d+)?$/;

/**
 * An exact, non-negative money amount, kept as decimal text so it is never rounded through a
 * floating-point number. Build one with {@link Amount.kyat} for whole amounts or
 * {@link Amount.parse} for decimal ones; each gateway then checks it against that gateway's
 * documented rules (Wave Money, AYA and Yoma MMQR only accept whole kyat, KBZ Pay up to 2 decimal
 * places, CyberSource any).
 *
 * Amounts are immutable. `JSON.stringify` writes them as strings, e.g. `"1000.50"`.
 */
export class Amount {
  private constructor(private readonly value: string) {}

  /**
   * A whole amount, e.g. `Amount.kyat(1000)` for 1000 MMK. Works for whole units of any currency.
   *
   * Takes a safe integer `number` or a `bigint`. Fractions, negative values, `NaN` and integers
   * beyond `Number.MAX_SAFE_INTEGER` (pass a `bigint` instead) throw an
   * {@link InvalidPaymentDataError} for the `amount` field.
   */
  static kyat(amount: number | bigint): Amount {
    if (typeof amount === 'bigint') {
      if (amount < 0n) {
        throw invalid('The amount field must not be negative.');
      }
      return new Amount(amount.toString());
    }
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
      throw invalid(
        `The amount field must be a whole number of kyat; use Amount.parse('10.50') for decimal amounts, got ${String(amount)}.`,
      );
    }
    if (amount < 0) {
      throw invalid('The amount field must not be negative.');
    }
    return new Amount(String(amount));
  }

  /**
   * A decimal amount written as plain digits, e.g. `Amount.parse('1000.50')`. Signs, exponents,
   * spaces and thousands separators are rejected with an {@link InvalidPaymentDataError}. Leading
   * zeros of the whole part are removed; the fractional digits are kept exactly as given.
   */
  static parse(amount: string): Amount {
    if (typeof amount !== 'string' || !PATTERN.test(amount)) {
      throw invalid(
        `The amount field must be a number such as 1000 or 1000.50, got ${JSON.stringify(amount)}.`,
      );
    }
    const [whole = '', fraction] = amount.split('.');
    const trimmedWhole = whole.replace(/^0+/, '') || '0';
    return new Amount(fraction === undefined ? trimmedWhole : `${trimmedWhole}.${fraction}`);
  }

  /**
   * Returns `amount` when it is already an `Amount`, or {@link Amount.kyat} of a whole number.
   */
  static from(amount: Amount | number | bigint): Amount {
    return amount instanceof Amount ? amount : Amount.kyat(amount);
  }

  /** Whether `value` is an `Amount`. */
  static isAmount(value: unknown): value is Amount {
    return value instanceof Amount;
  }

  /** The amount exactly as it is sent to the gateway, e.g. `"1000.50"`. */
  toString(): string {
    return this.value;
  }

  /** The amount as a JSON string, e.g. `"1000.50"`, so no consumer parses it as a float. */
  toJSON(): string {
    return this.value;
  }

  /** The number of fractional digits, e.g. `2` for `1000.50`. */
  decimalPlaces(): number {
    const dot = this.value.indexOf('.');
    return dot === -1 ? 0 : this.value.length - dot - 1;
  }

  /** The digits before the decimal point, e.g. `"1000"` for `1000.50`. */
  wholePart(): string {
    return this.value.split('.')[0] as string;
  }

  /** Whether the amount equals zero, e.g. `0` or `0.00`. */
  isZero(): boolean {
    return /^[0.]+$/.test(this.value);
  }

  /** Whether the amount is greater than zero. */
  isPositive(): boolean {
    return !this.isZero();
  }

  /**
   * Whether both amounts have the same value, ignoring trailing fractional zeros
   * (`1000`, `1000.0` and `1000.00` are equal). `undefined` is never equal, so a gateway amount
   * that was not sent never matches.
   */
  equals(other: Amount | string | null | undefined): boolean {
    if (other === undefined || other === null) {
      return false;
    }
    const normalize = (value: string): string =>
      value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
    const text = other instanceof Amount ? other.value : other;
    return normalize(this.value) === normalize(text);
  }
}

function invalid(message: string): InvalidPaymentDataError {
  return new InvalidPaymentDataError({ amount: message });
}

/**
 * What payment data accepts as an amount: an {@link Amount} or a whole number of kyat
 * (a safe integer `number` or a `bigint`). Decimal amounts must be an `Amount`, e.g.
 * `Amount.parse('1000.50')`.
 */
export type AmountInput = Amount | number | bigint;
