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
  type CyberSourceConfigOptions,
  type CyberSourcePaymentData,
  type PaymentStatus,
} from '../src/index.js';
import { caught, gatewayConfig, hmacBase64 } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T09:30:00.123Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function gateway(): CyberSource {
  return new CyberSource(gatewayConfig.cyberSource());
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
  currency: 'MMK',
  transactionType: 'sale',
  locale: 'en-us',
};

describe('CyberSource', () => {
  it('signs the hosted checkout fields', () => {
    const payment = gateway().initiate({
      orderId: 'ORDER-1',
      amount: Amount.kyat(1000),
      callbackUrl: 'https://shop.test/cs/callback',
      returnUrl: 'https://shop.test/done',
      currency: 'MMK',
      transactionType: CyberSourceTransactionType.Authorization,
      locale: 'en-us',
    });
    const fields = payment.values();
    expect(payment.action).toBe(`${CyberSourceConfig.PRODUCTION_URL}/pay`);
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
    ['CANCEL', 'canceled'],
    ['accept', 'successful'],
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

  it('rejects the signed checkout form posted back with an unsigned decision', () => {
    const form = new URLSearchParams(gateway().initiate(base).values());
    form.set('decision', 'ACCEPT');
    form.set('req_reference_number', 'ORDER-1');
    form.set('auth_amount', '1000');
    expect(
      caught(() => gateway().handleCallback(new CallbackRequest({ body: form.toString() }))),
    ).toBeInstanceOf(SignatureVerificationError);
  });

  it('requires decision and req_reference_number to be signed', () => {
    for (const names of [
      'req_reference_number,transaction_id,auth_amount,signed_field_names',
      'decision,transaction_id,auth_amount,signed_field_names',
    ]) {
      expect(() => gateway().handleCallback(callback({ signed_field_names: names }))).toThrow(
        SignatureVerificationError,
      );
    }
  });

  it('reads only signed fields', () => {
    const fields: Record<string, string> = {
      decision: 'ACCEPT',
      req_reference_number: 'ORDER-3',
      req_amount: '5.00',
      signed_field_names: 'decision,req_reference_number,req_amount,signed_field_names',
    };
    fields.signature = signature(fields);
    const form = new URLSearchParams({
      ...fields,
      auth_amount: '1.00',
      transaction_id: 'forged',
    });
    const result = gateway().handleCallback(new CallbackRequest({ body: form.toString() }));
    expect(result).toMatchObject({ amount: '5.00', gatewayReference: undefined });
    expect(result.raw).toEqual(fields);
  });

  it('rejects a decision outside the documented values', () => {
    for (const decision of ['NEW', '', 'ACCEPTED']) {
      expect(() => gateway().handleCallback(callback({ decision }))).toThrow(
        SignatureVerificationError,
      );
    }
  });

  it.each([
    ['without signed_field_names', 'decision,req_reference_number,transaction_id,auth_amount'],
    [
      'with a repeated name',
      'decision,req_reference_number,decision,transaction_id,signed_field_names',
    ],
    ['with an empty name', 'decision,req_reference_number,,transaction_id,signed_field_names'],
    ['with a trailing comma', 'decision,req_reference_number,signed_field_names,'],
    ['with "=" in a name', 'decision,req_reference_number,a=b,signed_field_names'],
  ])('rejects a signed field list %s', (_name, names) => {
    const fields: Record<string, string> = {
      decision: 'ACCEPT',
      req_reference_number: 'ORDER-1',
      transaction_id: '7000',
      auth_amount: '1000.00',
      'a=b': 'c',
      signed_field_names: names,
    };
    fields.signature = signature(fields);
    expect(
      caught(() =>
        gateway().handleCallback(
          new CallbackRequest({ body: new URLSearchParams(fields).toString() }),
        ),
      ),
    ).toBeInstanceOf(SignatureVerificationError);
  });

  it.each([
    [
      'a list that leaves out signed_field_names',
      [
        'transaction_id',
        'decision',
        'req_reference_number',
        'req_amount',
        'req_bill_to_forename',
        'signed_field_names',
      ],
      (genuine: Record<string, string>) => ({
        transaction_id: '111,decision=DECLINE',
        req_reference_number: 'ORDER-1',
        req_amount: '1000',
        req_bill_to_forename: 'x',
        decision: `ACCEPT,signed_field_names=${genuine.signed_field_names}`,
        signed_field_names: [
          'transaction_id',
          'req_reference_number',
          'req_amount',
          'req_bill_to_forename',
          'decision',
        ].join(','),
        signature: genuine.signature as string,
      }),
    ],
    [
      'a list that hides signed_field_names in another value',
      [
        'transaction_id',
        'decision',
        'req_reference_number',
        'req_amount',
        'req_bill_to_forename',
        'req_bill_to_surname',
        'signed_field_names',
        'signed_date_time',
      ],
      (genuine: Record<string, string>) => ({
        transaction_id: '111,decision=DECLINE',
        req_reference_number: 'ORDER-1',
        req_amount: '1000',
        req_bill_to_forename: 'x',
        decision: 'ACCEPT',
        req_bill_to_surname: `y,signed_field_names=${genuine.signed_field_names}`,
        signed_date_time: genuine.signed_date_time as string,
        signed_field_names: [
          'transaction_id',
          'req_reference_number',
          'req_amount',
          'req_bill_to_forename',
          'decision',
          'req_bill_to_surname',
          'signed_date_time',
        ].join(','),
        signature: genuine.signature as string,
      }),
    ],
  ])('rejects a declined payment re-partitioned to read ACCEPT: %s', (_name, names, forge) => {
    // The customer typed "x,decision=ACCEPT" as their first name; CyberSource echoes it signed.
    const genuine: Record<string, string> = {
      transaction_id: '111',
      decision: 'DECLINE',
      req_reference_number: 'ORDER-1',
      req_amount: '1000',
      req_bill_to_forename: 'x,decision=ACCEPT',
      req_bill_to_surname: 'y',
      signed_date_time: '2026-10-12T00:00:00Z',
      signed_field_names: names.join(','),
    };
    genuine.signature = signature(genuine);
    const declined = gateway().handleCallback(
      new CallbackRequest({ body: new URLSearchParams(genuine).toString() }),
    );
    expect(declined.status).toBe('failed');

    const forged = forge(genuine);
    const forgedNames = forged.signed_field_names.split(',');
    // The forged list signs the very same string, so only the list rules can catch it.
    expect(
      hmacBase64(
        forgedNames
          .map((name) => `${name}=${(forged as Record<string, string>)[name] ?? ''}`)
          .join(','),
        'secret',
      ),
    ).toBe(genuine.signature);
    expect(
      caught(() =>
        gateway().handleCallback(
          new CallbackRequest({ body: new URLSearchParams(forged).toString() }),
        ),
      ),
    ).toBeInstanceOf(SignatureVerificationError);
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
    ['missing currency', { currency: '' }, 'currency'],
    ['missing locale', { locale: undefined as never }, 'locale'],
    ['missing type', { transactionType: undefined as never }, 'transactionType'],
    ['order id over 50', { orderId: 'A'.repeat(51) }, 'orderId'],
    ['unknown type', { transactionType: 'refund' as never }, 'transactionType'],
  ])('enforces the Secure Acceptance field rules: %s', (_name, change, field) => {
    const error = caught(() => CyberSource.validate({ ...base, ...change }));
    expect(error).toBeInstanceOf(InvalidPaymentDataError);
    expect((error as InvalidPaymentDataError).errors[field]).toBeTruthy();
  });
});

describe('CyberSource required payment fields', () => {
  it('has no defaults for currency, transaction type and locale', () => {
    const { currency: _c, transactionType: _t, locale: _l, ...rest } = base;
    const error = caught(() =>
      CyberSource.validate(rest as CyberSourcePaymentData),
    ) as InvalidPaymentDataError;
    expect(error.errors).toEqual({
      currency: 'The currency field is required.',
      transactionType: 'The transactionType field is required.',
      locale: 'The locale field is required.',
    });
  });
});

describe('CyberSourceConfig', () => {
  it('requires every setting and names the production URL', () => {
    expect(
      new CyberSourceConfig(
        gatewayConfig.cyberSource({ baseUrl: `${CyberSourceConfig.PRODUCTION_URL}/` }),
      ).baseUrl,
    ).toBe('https://secureacceptance.cybersource.com');
    expect(
      caught(() => new CyberSourceConfig(gatewayConfig.cyberSource({ profileId: '' }))),
    ).toMatchObject({
      gateway: 'cyber_source',
      key: 'profile_id',
    });
    for (const baseUrl of [undefined, '', '   ']) {
      const options = {
        ...gatewayConfig.cyberSource(),
        baseUrl,
      } as unknown as CyberSourceConfigOptions;
      expect(caught(() => new CyberSourceConfig(options))).toMatchObject({
        gateway: 'cyber_source',
        key: 'base_url',
        message: 'The cyber_source configuration is missing [base_url].',
      });
    }
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
      baseUrl: 'https://cs.test',
    });
    expect(CyberSource.fromEnv(env).initiate(base).action).toBe('https://cs.test/pay');
    const { CYBER_SOURCE_BASE_URL: _baseUrl, ...withoutBaseUrl } = env;
    expect(caught(() => CyberSourceConfig.fromEnv(withoutBaseUrl))).toMatchObject({
      gateway: 'cyber_source',
      key: 'base_url',
    });
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
      new CyberSource(new CyberSourceConfig(gatewayConfig.cyberSource({ profileId: 'p' }))).config
        .profileId,
    ).toBe('p');
  });
});
