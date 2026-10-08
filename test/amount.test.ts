import { describe, expect, it } from 'vitest';

import { Amount, InvalidPaymentDataError } from '../src/index.js';
import { caught } from './helpers.js';

describe('Amount.parse', () => {
  it.each([
    ['1000', '1000', 0, false],
    ['1000.50', '1000.50', 2, false],
    ['0.5', '0.5', 1, false],
    ['0', '0', 0, true],
    ['0.00', '0.00', 2, true],
    ['007', '7', 0, false],
    ['00.10', '0.10', 2, false],
    ['10.505', '10.505', 3, false],
  ])('parses %s exactly', (input, text, places, zero) => {
    const amount = Amount.parse(input);
    expect(amount.toString()).toBe(text);
    expect(amount.decimalPlaces()).toBe(places);
    expect(amount.isZero()).toBe(zero);
    expect(amount.isPositive()).toBe(!zero);
  });

  it.each([
    '',
    '1e5',
    '-1',
    '+1',
    '1,000',
    ' 10',
    '10 ',
    '10.',
    '.5',
    '1.2.3',
    'NaN',
    'Infinity',
    '0x10',
    '١٠٠',
  ])('rejects %j', (input) => {
    const error = caught(() => Amount.parse(input));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors.amount).toContain('must be a number');
  });

  it('rejects values that are not strings', () => {
    expect(() => Amount.parse(1000 as unknown as string)).toThrow(InvalidPaymentDataError);
  });
});

describe('Amount.kyat', () => {
  it('builds whole amounts from numbers and bigints', () => {
    expect(Amount.kyat(1000).toString()).toBe('1000');
    expect(Amount.kyat(1000).isPositive()).toBe(true);
    expect(Amount.kyat(0).isZero()).toBe(true);
    expect(Amount.kyat(9007199254740993n).toString()).toBe('9007199254740993');
  });

  it.each([1000.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '1000' as unknown as number])(
    'rejects %s, which is not a safe integer',
    (input) => {
      const error = caught(() => Amount.kyat(input));
      expect(error).toBeInstanceOf(InvalidPaymentDataError);
      expect((error as InvalidPaymentDataError).errors.amount).toContain('whole number');
    },
  );

  it.each([-5, -1n])('rejects the negative %s', (input) => {
    const error = caught(() => Amount.kyat(input));
    expect((error as InvalidPaymentDataError).errors).toEqual({
      amount: 'The amount field must not be negative.',
    });
  });
});

describe('Amount', () => {
  it('converts inputs with from()', () => {
    const amount = Amount.parse('10.50');
    expect(Amount.from(amount)).toBe(amount);
    expect(Amount.from(25).toString()).toBe('25');
    expect(Amount.from(25n).toString()).toBe('25');
    expect(Amount.isAmount(amount)).toBe(true);
    expect(Amount.isAmount('10.50')).toBe(false);
  });

  it('serializes to a JSON string and never a float', () => {
    expect(JSON.stringify({ total: Amount.parse('1000.50') })).toBe('{"total":"1000.50"}');
    expect(`${Amount.parse('1000.50')}`).toBe('1000.50');
  });

  it('reads the whole part and compares values ignoring trailing zeros', () => {
    expect(Amount.parse('1000.50').wholePart()).toBe('1000');
    expect(Amount.parse('1000').equals(Amount.parse('1000.00'))).toBe(true);
    expect(Amount.parse('1000.50').equals('1000.5')).toBe(true);
    expect(Amount.parse('1000.50').equals('1000.05')).toBe(false);
    expect(Amount.parse('100').equals('1000')).toBe(false);
    expect(Amount.parse('100').equals(undefined)).toBe(false);
    expect(Amount.parse('100').equals(null)).toBe(false);
  });
});
