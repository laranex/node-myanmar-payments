import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AyaPay,
  AyaPayConfig,
  ConfigurationError,
  CyberSource,
  CyberSourceConfig,
  KbzPay,
  KbzPayConfig,
  MemoryTokenCache,
  MyanmarPayments,
  WavePay,
  WavePayConfig,
  YomaMmqr,
  YomaMmqrConfig,
} from '../src/index.js';
import * as api from '../src/index.js';
import { caught, FakeFetch, fixture, gatewayConfig } from './helpers.js';

const full = {
  kbzPay: gatewayConfig.kbzPay(),
  wavePay: gatewayConfig.wavePay(),
  ayaPay: gatewayConfig.ayaPay(),
  yomaMmqr: gatewayConfig.yomaMmqr(),
  cyberSource: gatewayConfig.cyberSource(),
};

describe('MyanmarPayments', () => {
  it('builds every gateway once from one configuration object', () => {
    const payments = new MyanmarPayments(full);
    expect(payments.kbzPay()).toBeInstanceOf(KbzPay);
    expect(payments.kbzPay()).toBe(payments.kbzPay());
    expect(payments.wavePay()).toBeInstanceOf(WavePay);
    expect(payments.wavePay()).toBe(payments.wavePay());
    expect(payments.ayaPay()).toBeInstanceOf(AyaPay);
    expect(payments.ayaPay()).toBe(payments.ayaPay());
    expect(payments.yomaMmqr()).toBeInstanceOf(YomaMmqr);
    expect(payments.yomaMmqr()).toBe(payments.yomaMmqr());
    expect(payments.cyberSource()).toBeInstanceOf(CyberSource);
    expect(payments.cyberSource()).toBe(payments.cyberSource());
  });

  it('accepts config instances', () => {
    const config = new KbzPayConfig(full.kbzPay);
    expect(new MyanmarPayments({ kbzPay: config }).kbzPay().config).toBe(config);
  });

  it.each([
    ['kbzPay', 'kbz_pay', 'app_id'],
    ['wavePay', 'wave_pay', 'merchant_id'],
    ['ayaPay', 'aya_pay', 'app_key'],
    ['yomaMmqr', 'yoma_mmqr', 'merchant_id'],
    ['cyberSource', 'cyber_source', 'profile_id'],
  ] as const)(
    'reports the missing key when %s is used without configuration',
    (method, gateway, key) => {
      const payments = new MyanmarPayments();
      const error = caught(() => payments[method]());
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({
        gateway,
        key,
        message: `The ${gateway} configuration is missing [${key}].`,
      });
    },
  );

  it('reads the environment lazily, only for the gateways used', () => {
    const { env } = fixture<{ config: { env: Record<string, string> } }>(
      'parity/vectors.json',
    ).config;
    const withoutCyberSource = Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.startsWith('CYBER_SOURCE_')),
    );
    const payments = MyanmarPayments.fromEnv(withoutCyberSource);
    expect(payments.kbzPay().config.appId).toBe('kp123');
    expect(payments.wavePay().config.merchantName).toBe('Shop');
    expect(payments.ayaPay().config.appKey).toBe('app-key');
    expect(payments.yomaMmqr().config.clientId).toBe('client');
    expect(caught(() => payments.cyberSource())).toMatchObject({
      gateway: 'cyber_source',
      key: 'profile_id',
    });
    expect(MyanmarPayments.fromEnv()).toBeInstanceOf(MyanmarPayments);
  });

  it('passes the HTTP options and token cache to the gateways', async () => {
    const fake = new FakeFetch(
      { body: { access_token: 't', expires_in: 3600 } },
      { body: { paymentStatus: 'SUCCESS' } },
      { body: { paymentStatus: 'SUCCESS' } },
    );
    const tokenCache = new MemoryTokenCache();
    const payments = new MyanmarPayments(
      { yomaMmqr: { ...full.yomaMmqr, baseUrl: 'https://yoma.test' } },
      { fetch: fake.fetch, tokenCache },
    );
    await payments.yomaMmqr().status('1');
    await new MyanmarPayments(
      { yomaMmqr: { ...full.yomaMmqr, baseUrl: 'https://yoma.test' } },
      { fetch: fake.fetch, tokenCache },
    )
      .yomaMmqr()
      .status('1');
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/token',
      '/payment-gateway/v1rc/api/payment/check-status',
      '/payment-gateway/v1rc/api/payment/check-status',
    ]);
  });
});

describe('agent skill', () => {
  it('only names API that exists', () => {
    const skill = readFileSync(
      new URL('../skills/node-myanmar-payments/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(skill).toMatch(/^---\nname: node-myanmar-payments\n/);
    const names = [
      'MyanmarPayments',
      'KbzPay',
      'KbzPayConfig',
      'YomaMmqr',
      'AyaPayMethod',
      'AyaPayService',
      'Amount',
      'CallbackRequest',
      'PaymentCallback',
      'PaymentStatusResult',
      'RedirectPayment',
      'FormPayment',
      'QrPayment',
      'AppPayment',
      'PaymentStatus',
      'MemoryTokenCache',
      'ConfigurationError',
      'InvalidPaymentDataError',
      'SignatureVerificationError',
      'ApiError',
      'PaymentError',
    ];
    for (const name of names) {
      expect(skill).toContain(name);
      expect(api, name).toHaveProperty(name);
    }
  });
});

describe('optionsFromEnv', () => {
  const env = fixture<{ config: { env: Record<string, string> } }>('parity/vectors.json').config
    .env;

  it("reads each gateway's options from the environment without validating them", () => {
    expect(
      KbzPayConfig.optionsFromEnv({ KBZ_PAY_APP_ID: ' kp123\t', KBZ_PAY_APP_KEY: ' ' }),
    ).toEqual({ appId: 'kp123' });
    expect(KbzPayConfig.optionsFromEnv({ KBZ_PAY_TIME_TO_LIVE_IN_MINUTES: '500' })).toEqual({
      timeToLiveMinutes: '500',
    });
    expect(WavePayConfig.optionsFromEnv({})).toEqual({});
    expect(AyaPayConfig.optionsFromEnv({ MYANMAR_PAYMENTS_HTTP_TIMEOUT: 'abc' })).toEqual({
      timeoutSeconds: 'abc',
    });
    expect(Object.keys(YomaMmqrConfig.optionsFromEnv(env))).toEqual([
      'merchantId',
      'clientId',
      'clientSecret',
      'webhookHashKey',
      'apiVersion',
      'webhookSecret',
      'baseUrl',
      'timeoutSeconds',
    ]);
    expect(CyberSourceConfig.optionsFromEnv(env)).toEqual({
      profileId: env.CYBER_SOURCE_PROFILE_ID,
      accessKey: env.CYBER_SOURCE_ACCESS_KEY,
      secretKey: env.CYBER_SOURCE_SECRET_KEY,
      baseUrl: env.CYBER_SOURCE_BASE_URL,
    });
  });

  it('builds the same configuration as fromEnv, and merges per key', () => {
    for (const config of [KbzPayConfig, WavePayConfig, AyaPayConfig, YomaMmqrConfig]) {
      expect(new (config as typeof KbzPayConfig)(config.optionsFromEnv(env) as never)).toEqual(
        config.fromEnv(env),
      );
    }
    const merged = new KbzPayConfig({
      ...KbzPayConfig.optionsFromEnv(env),
      appId: 'override',
    } as never);
    expect(merged.appId).toBe('override');
    expect(merged.appKey).toBe(env.KBZ_PAY_APP_KEY);
  });

  it('reads process.env by default', () => {
    expect(CyberSourceConfig.optionsFromEnv()).toBeTypeOf('object');
  });
});
