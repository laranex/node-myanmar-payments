import { describe, expect, it } from 'vitest';

import { decodeBase64, queryEscape, safeEqual } from '../src/core/crypto.js';
import { envFirst, envInt, envSandbox, requireSetting, trimUrl } from '../src/core/env.js';
import { JsonNumber, parseJson, parseJsonObject, toPlain } from '../src/core/json.js';
import { Validator } from '../src/core/validate.js';
import { get, object, optional, scalarString, trimmed } from '../src/core/values.js';
import { Amount, ConfigurationError, InvalidPaymentDataError } from '../src/index.js';
import { caught } from './helpers.js';

function failures(validator: Validator): Record<string, string> {
  const error = caught(() => validator.validate());
  expect(error).toBeInstanceOf(InvalidPaymentDataError);
  return { ...(error as InvalidPaymentDataError).errors };
}

describe('lossless JSON', () => {
  it('keeps numbers exactly as written', () => {
    const value = parseJsonObject('{"amount": 1000.50, "big": 9007199254740993, "exp": -1.5e+3}');
    expect(value?.amount).toEqual(new JsonNumber('1000.50'));
    expect(value?.big).toEqual(new JsonNumber('9007199254740993'));
    expect(value?.exp).toEqual(new JsonNumber('-1.5e+3'));
  });

  it('parses every JSON value', () => {
    const text =
      ' {"s":"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00","t":true,"f":false,"n":null,"a":[1,[],{}],"o":{"x":[ ]}} ';
    expect(toPlain(parseJson(text) as never)).toEqual({
      s: 'a"b\\c/d\b\f\n\r\té😀',
      t: true,
      f: false,
      n: null,
      a: [1, [], {}],
      o: { x: [] },
    });
  });

  it.each([
    '',
    '{',
    '{"a":1,}',
    '[1,]',
    '{"a" 1}',
    '{a:1}',
    '"unterminated',
    '"bad \\x escape"',
    '"bad \\u12 escape"',
    '"control \u0001"',
    'tru',
    '01',
    '1.',
    '{"a":1} extra',
    'NaN',
  ])('rejects %j', (text) => {
    expect(parseJson(text)).toBeUndefined();
  });

  it('returns only objects from parseJsonObject', () => {
    expect(parseJsonObject('[1]')).toBeUndefined();
    expect(parseJsonObject('null')).toBeUndefined();
    expect(parseJsonObject('"x"')).toBeUndefined();
    expect(parseJsonObject('{}')).toEqual({});
  });

  it('never lets __proto__ change the prototype', () => {
    const value = parseJsonObject('{"__proto__":{"polluted":true},"a":1}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value ?? {})).toEqual(['__proto__', 'a']);
    const plain = toPlain(value as never) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
  });
});

describe('values', () => {
  it('converts scalars to the text gateways sign', () => {
    expect(scalarString('ORDER_1')).toBe('ORDER_1');
    expect(scalarString(new JsonNumber('1000.50'))).toBe('1000.50');
    expect(scalarString(true)).toBe('true');
    expect(scalarString(false)).toBe('false');
    expect(scalarString(42)).toBe('42');
    expect(scalarString(1000.5)).toBe('1000.5');
    expect(scalarString(9007199254740993n)).toBe('9007199254740993');
    expect(scalarString(Number.NaN)).toBeUndefined();
    expect(scalarString(null)).toBeUndefined();
    expect(scalarString(undefined)).toBeUndefined();
    expect(scalarString({ a: 1 })).toBeUndefined();
    expect(scalarString(['a'])).toBeUndefined();
  });

  it('reads decoded payloads', () => {
    const payload = {
      order_id: '  ORDER_1  ',
      amount: new JsonNumber('1000'),
      nested: { status: 'SUCCESS' },
      list: ['a'],
      nothing: null,
    };
    expect(get(payload, 'order_id')).toBe('  ORDER_1  ');
    expect(trimmed(payload, 'order_id')).toBe('ORDER_1');
    expect(get(payload, 'amount')).toBe('1000');
    expect(get(payload, 'missing')).toBe('');
    expect(get(payload, 'nested')).toBe('');
    expect(optional(payload, 'nothing')).toBeUndefined();
    expect(optional(payload, 'amount')).toBe('1000');
    expect(object(payload, 'nested')).toEqual({ status: 'SUCCESS' });
    expect(object(payload, 'list')).toBeUndefined();
    expect(object(payload, 'missing')).toBeUndefined();
  });
});

describe('Validator', () => {
  it('passes when every check passes', () => {
    expect(() =>
      new Validator()
        .required('order_id', 'ORDER_1')
        .length('order_id', 'ORDER_1', 1, 20)
        .max('note', 'short', 10)
        .pattern('order_id', 'ORDER_1', /^[A-Z_0-9]+$/, 'letters, numbers and underscores')
        .between('expires', undefined, 1, 60)
        .between('expires', 30, 1, 60)
        .string('title', undefined)
        .string('title', 'x')
        .amount('amount', Amount.kyat(1000), { gateway: 'KBZ Pay', maxDecimals: 2 })
        .url('callback_url', 'https://shop.test/callback')
        .when(false, 'items', 'never')
        .validate(),
    ).not.toThrow();
  });

  it('reports the string rules', () => {
    expect(
      failures(
        new Validator()
          .required('order_id', '   ')
          .required('missing', undefined)
          .length('short', 'ab', 3, 10)
          .length('long', 'abcdefghijkl', 3, 10)
          .length('empty_skipped', '', 3, 10)
          .max('note', '0123456789x', 10)
          .max('bytes', 'ကကက', 8)
          .pattern('digits', '12a', /^[0-9]+$/, 'digits')
          .pattern('digits_skipped', '', /^[0-9]+$/, 'digits')
          .between('expires', 61, 1, 60)
          .between('fraction', 1.5, 1, 60)
          .between('text', '30' as unknown as number, 1, 60)
          .string('title', 5)
          .when(true, 'items', 'The items field needs at least one item.'),
      ),
    ).toEqual({
      order_id: 'The order_id field is required.',
      missing: 'The missing field is required.',
      short: 'The short field must be between 3 and 10 characters.',
      long: 'The long field must be between 3 and 10 characters.',
      note: 'The note field must not be greater than 10 characters.',
      bytes: 'The bytes field must not be greater than 8 characters.',
      digits: 'The digits field may only contain digits.',
      expires: 'The expires field must be between 1 and 60.',
      fraction: 'The fraction field must be between 1 and 60.',
      text: 'The text field must be between 1 and 60.',
      title: 'The title field must be a string.',
      items: 'The items field needs at least one item.',
    });
  });

  it('keeps only the first failure per field', () => {
    expect(failures(new Validator().required('order_id', '').max('order_id', 'x', 0))).toEqual({
      order_id: 'The order_id field is required.',
    });
  });

  it('accepts absolute http and https URLs only', () => {
    const errors = failures(
      new Validator()
        .url('relative', '/callback')
        .url('ftp', 'ftp://shop.test/callback')
        .url('broken', 'http://[::1')
        .url('no_host', 'http:')
        .url('http_ok', 'http://shop.test/callback')
        .url('upper_ok', 'HTTPS://shop.test/callback')
        .url('port_ok', 'https://shop.test:8443/callback')
        .url('skipped', '')
        .url('undefined_skipped', undefined),
    );
    expect(Object.keys(errors).sort()).toEqual(['broken', 'ftp', 'no_host', 'relative']);
    expect(errors.ftp).toBe('The ftp field must be a valid http or https URL.');
  });

  const whole = { gateway: 'Wave Money', maxDecimals: 0 };
  const twoPlaces = { gateway: 'KBZ Pay', maxDecimals: 2 };
  const cyberSource = { gateway: 'CyberSource', maxDecimals: null, maxLength: 15, allowZero: true };

  it.each([
    ['unset', undefined, whole, 'The amount field is required.'],
    ['null', null, whole, 'The amount field is required.'],
    [
      'negative number',
      -1,
      whole,
      'The amount field must be a non-negative number such as 1000 or 1000.50.',
    ],
    [
      'negative bigint',
      -1n,
      whole,
      'The amount field must be a non-negative number such as 1000 or 1000.50.',
    ],
    [
      'unsafe number',
      2 ** 60,
      whole,
      'The amount field must be a non-negative number such as 1000 or 1000.50.',
    ],
    [
      'float',
      10.5,
      whole,
      "The amount field must be a whole number of kyat or an Amount; use Amount.parse('10.50') for decimal amounts.",
    ],
    [
      'string',
      '1000',
      whole,
      "The amount field must be an Amount, e.g. Amount.kyat(1000) or Amount.parse('1000.50').",
    ],
    [
      'decimal where whole required',
      Amount.parse('10.5'),
      whole,
      'Wave Money does not accept decimal amounts; the amount field must be a whole number.',
    ],
    [
      'too many decimals',
      Amount.parse('10.555'),
      twoPlaces,
      'KBZ Pay accepts at most 2 decimal places; the amount field has 3.',
    ],
    ['zero', Amount.kyat(0), twoPlaces, 'The amount field must be greater than 0.'],
    [
      'too long',
      Amount.parse('1234567890.123456'),
      cyberSource,
      'The amount field must not be greater than 15 characters.',
    ],
  ])('rejects an amount: %s', (_name, amount, rule, message) => {
    expect(failures(new Validator().amount('amount', amount, rule)).amount).toBe(message);
  });

  it.each([
    ['whole', Amount.kyat(1000), whole],
    ['whole number', 1000, whole],
    ['bigint', 1000n, whole],
    ['two decimals', Amount.parse('1000.50'), twoPlaces],
    ['zero allowed', Amount.kyat(0), cyberSource],
    ['unlimited decimals', Amount.parse('1.123456'), cyberSource],
  ])('accepts an amount: %s', (_name, amount, rule) => {
    expect(() => new Validator().amount('amount', amount, rule).validate()).not.toThrow();
  });
});

describe('environment', () => {
  it('reads the first non-empty trimmed value', () => {
    const env = { A: '  ', B: ' second ', C: 'third' };
    expect(envFirst(env, 'A', 'B', 'C')).toBe('second');
    expect(envFirst(env, 'A', 'MISSING')).toBe('');
    expect(envFirst(env)).toBe('');
  });

  it.each([
    ['', true],
    ['  ', true],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['garbage', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['f', false],
    ['no', false],
    ['NO', false],
    ['off', false],
    [' off ', false],
  ])('treats *_SANDBOX=%j as sandbox=%s', (value, sandbox) => {
    expect(envSandbox({ GATEWAY_SANDBOX: value }, 'GATEWAY_SANDBOX')).toBe(sandbox);
  });

  it('defaults to sandbox when the variable is unset', () => {
    expect(envSandbox({}, 'GATEWAY_SANDBOX')).toBe(true);
  });

  it('reads integers', () => {
    const env = { TIMEOUT: ' 30 ', BAD: 'thirty', NEG: '-5' };
    expect(envInt(env, 'TIMEOUT')).toBe(30);
    expect(envInt(env, 'NEG')).toBe(-5);
    expect(envInt(env, 'BAD')).toBeUndefined();
    expect(envInt(env, 'MISSING')).toBeUndefined();
  });

  it('names a missing setting and trims URLs', () => {
    expect(requireSetting('kbz_pay', 'app_id', 'kp123')).toBe('kp123');
    const error = caught(() => requireSetting('kbz_pay', 'app_key', '  '));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ gateway: 'kbz_pay', key: 'app_key' });
    expect(() => requireSetting('kbz_pay', 'app_key', 123)).toThrow(ConfigurationError);
    expect(trimUrl('https://api.test///')).toBe('https://api.test');
    expect(trimUrl('https://api.test')).toBe('https://api.test');
  });
});

describe('crypto helpers', () => {
  it('escapes like Go url.QueryEscape and PHP urlencode', () => {
    expect(queryEscape("title=iphone x!'()*~")).toBe('title%3Diphone+x%21%27%28%29%2A~');
  });

  it('decodes strict base64 only', () => {
    expect(decodeBase64(Buffer.from('{"a":1}').toString('base64'))).toBe('{"a":1}');
    expect(decodeBase64('')).toBeUndefined();
    expect(decodeBase64('abc')).toBeUndefined();
    expect(decodeBase64('ab$=')).toBeUndefined();
  });

  it('compares strings of different lengths safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
