import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as subpath from '../src/cyber-source/index.js';
import {
  Amount,
  CallbackRequest,
  CyberSource,
  CyberSourceConfig,
  CyberSourceTransactionType,
  InvalidPaymentDataError,
  SignatureVerificationError,
  type CyberSourcePaymentData,
  type PaymentStatus,
} from '../src/index.js';
import { caught, hmacBase64 } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T09:30:00.123Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function gateway(): CyberSource {
  return new CyberSource({ profileId: 'profile', accessKey: 'access', secretKey: 'secret' });
}

function signature(fields: Record<string, string>): string {
  const names = (fields.signed_field_names ?? '').split(',');
  return hmacBase64(names.map((name) => `${name}=${fields[name] ?? ''}`).join(','), 'secret');
}

function callback(overrides: Record<string, string> = {}): CallbackRequest {
  const fields: Record<string, string> = {
    decision: 'ACCEPT',
    req_reference_number: 'ORDER-1',
    transaction_id: '7000000000000000000000',
    auth_amount: '1000.00',
    req_amount: '1000.00',
    signed_field_names:
      'decision,req_reference_number,transaction_id,auth_amount,signed_field_names',
    ...overrides,
  };
  fields.signature = signature(fields);
  return new CallbackRequest({ body: new URLSearchParams(fields).toString() });
}

const base: CyberSourcePaymentData = {
  orderId: 'ORDER-1',
  amount: Amount.kyat(1000),
  callbackUrl: 'https://shop.test/cb',
};

describe('CyberSource', () => {
  it('signs the hosted checkout fields', () => {
    const payment = gateway().initiate({
      orderId: 'ORDER-1',
      amount: Amount.kyat(1000),
      callbackUrl: 'https://shop.test/cs/callback',
      returnUrl: 'https://shop.test/done',
      transactionType: CyberSourceTransactionType.Authorization,
    });
    const fields = payment.values();
    expect(payment.action).toBe(`${CyberSourceConfig.SANDBOX_URL}/pay`);
    expect(payment.enctype).toBe('application/x-www-form-urlencoded');
    expect(fields).toMatchObject({
      access_key: 'access',
      profile_id: 'profile',
      reference_number: 'ORDER-1',
      amount: '1000',
      transaction_type: 'authorization',
      currency: 'MMK',
      locale: 'en-us',
      signed_date_time: '2026-10-08T09:30:00Z',
      override_custom_receipt_page: 'https://shop.test/done',
      override_backoffice_post_url: 'https://shop.test/cs/callback',
      override_custom_cancel_page: '',
    });
    expect(fields.transaction_uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(fields.signed_field_names?.split(',')).toEqual(
      payment.fields.map((field) => field.name).filter((name) => name !== 'signature'),
    );
    expect(fields.signature).toBe(signature(fields));
    expect(payment.fields.at(-1)?.name).toBe('signature');
  });

  it('accepts decimal amounts, other currencies and locales, as the Secure Acceptance spec allows', () => {
    const fields = gateway()
      .initiate({
        ...base,
        amount: Amount.parse('10.50'),
        currency: 'USD',
        locale: 'my-mm',
        transactionType: 'sale,create_payment_token',
      })
      .values();
    expect(fields).toMatchObject({
      amount: '10.50',
      currency: 'USD',
      locale: 'my-mm',
      transaction_type: 'sale,create_payment_token',
    });
  });

  it.each<[string, PaymentStatus]>([
    ['ACCEPT', 'successful'],
    ['REVIEW', 'pending'],
    ['DECLINE', 'failed'],
    ['ERROR', 'failed'],
    ['CANCEL', 'cancelled'],
    ['accept', 'successful'],
    ['NEW', 'unknown'],
  ])(
    'reads the order id from req_reference_number and maps the decision %s',
    (decision, status) => {
      const result = gateway().handleCallback(callback({ decision }));
      expect(result).toMatchObject({
        orderId: 'ORDER-1',
        gatewayReference: '7000000000000000000000',
        amount: '1000.00',
        status,
        gatewayStatus: decision.toUpperCase(),
      });
      expect(result.acknowledgement).toMatchObject({ status: 200, body: '' });
    },
  );

  it('falls back to req_amount and reads the query string too', () => {
    const fields: Record<string, string> = {
      decision: 'ACCEPT',
      req_reference_number: 'ORDER-2',
      req_amount: '5.00',
      signed_field_names: 'decision,req_reference_number,req_amount,signed_field_names',
    };
    fields.signature = signature(fields);
    const result = gateway().handleCallback(new CallbackRequest({ query: fields }));
    expect(result).toMatchObject({
      orderId: 'ORDER-2',
      amount: '5.00',
      gatewayReference: undefined,
    });
  });

  it('rejects a callback whose signed fields are missing', () => {
    const form = new URLSearchParams({
      decision: 'ACCEPT',
      signed_field_names: 'decision,req_amount,signed_field_names',
      signature: 'x',
    });
    expect(
      caught(() => gateway().handleCallback(new CallbackRequest({ body: form.toString() }))),
    ).toBeInstanceOf(SignatureVerificationError);
    expect(() =>
      gateway().handleCallback(new CallbackRequest({ body: 'signed_field_names=,&signature=x' })),
    ).toThrow('CyberSource callback signature verification failed.');
    expect(() => gateway().handleCallback(new CallbackRequest())).toThrow(
      SignatureVerificationError,
    );
  });

  it('rejects a tampered callback', () => {
    const form = new URLSearchParams(callback().body);
    form.set('auth_amount', '1.00');
    expect(
      caught(() => gateway().handleCallback(new CallbackRequest({ body: form.toString() }))),
    ).toBeInstanceOf(SignatureVerificationError);
  });

  it('accepts http URLs; the gateway may still require HTTPS in production', () => {
    expect(() =>
      CyberSource.validate({
        ...base,
        callbackUrl: 'http://shop.test/cb',
        returnUrl: 'http://shop.test/done',
        cancelUrl: 'http://shop.test/cancel',
      }),
    ).not.toThrow();
  });

  it('accepts a zero amount and any decimal places, as Secure Acceptance allows', () => {
    for (const amount of [Amount.kyat(0), Amount.parse('10.505'), 0]) {
      expect(() => CyberSource.validate({ ...base, amount })).not.toThrow();
    }
  });

  it.each<[string, Partial<CyberSourcePaymentData>, string]>([
    ['ftp callback', { callbackUrl: 'ftp://shop.test/cb' }, 'callbackUrl'],
    ['missing callback', { callbackUrl: '' }, 'callbackUrl'],
    ['callback over 255', { callbackUrl: `https://shop.test/${'a'.repeat(250)}` }, 'callbackUrl'],
    ['return url over 255', { returnUrl: `https://shop.test/${'a'.repeat(250)}` }, 'returnUrl'],
    ['relative cancel url', { cancelUrl: '/cancel' }, 'cancelUrl'],
    ['amount over 15 characters', { amount: Amount.parse('1234567890123.45') }, 'amount'],
    ['negative amount', { amount: -1 }, 'amount'],
    ['missing amount', { amount: undefined as never }, 'amount'],
    ['lowercase currency', { currency: 'usd' }, 'currency'],
    ['plain en locale', { locale: 'en' }, 'locale'],
    ['order id over 50', { orderId: 'A'.repeat(51) }, 'orderId'],
    ['unknown type', { transactionType: 'refund' as never }, 'transactionType'],
  ])('enforces the Secure Acceptance field rules: %s', (_name, change, field) => {
    const error = caught(() => CyberSource.validate({ ...base, ...change }));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });
});

describe('CyberSourceConfig', () => {
  it('selects endpoints and names a missing key', () => {
    expect(
      new CyberSourceConfig({ profileId: 'p', accessKey: 'a', secretKey: 's', sandbox: false })
        .baseUrl,
    ).toBe(CyberSourceConfig.PRODUCTION_URL);
    expect(
      caught(() => new CyberSourceConfig({ profileId: '', accessKey: 'a', secretKey: 's' })),
    ).toMatchObject({
      gateway: 'cyber_source',
      key: 'profile_id',
    });
  });

  it('reads the environment', () => {
    const env = {
      CYBER_SOURCE_PROFILE_ID: 'p',
      CYBER_SOURCE_ACCESS_KEY: 'a',
      CYBER_SOURCE_SECRET_KEY: 's',
      CYBER_SOURCE_BASE_URL: 'https://cs.test/',
    };
    expect(CyberSourceConfig.fromEnv(env)).toMatchObject({
      profileId: 'p',
      sandbox: true,
      baseUrl: 'https://cs.test',
    });
    expect(CyberSource.fromEnv(env).initiate(base).action).toBe('https://cs.test/pay');
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    try {
      expect(CyberSource.fromEnv().config.accessKey).toBe('a');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('exports the gateway from the cyber-source subpath', () => {
    expect(subpath.CyberSource).toBe(CyberSource);
    expect(subpath.CyberSourceTransactionType.Sale).toBe('sale');
    expect(
      new CyberSource(new CyberSourceConfig({ profileId: 'p', accessKey: 'a', secretKey: 's' }))
        .config.profileId,
    ).toBe('p');
  });
});
