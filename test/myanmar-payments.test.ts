import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AyaPay,
  ConfigurationError,
  CyberSource,
  KbzPay,
  KbzPayConfig,
  MemoryTokenCache,
  MyanmarPayments,
  WaveMoney,
  YomaMmqr,
} from '../src/index.js';
import * as api from '../src/index.js';
import { caught, FakeFetch } from './helpers.js';

const full = {
  kbzPay: { appId: 'a', appKey: 'b', merchantCode: 'c', timeoutSeconds: 30 },
  waveMoney: {
    merchantId: 'm',
    secretKey: 's',
    merchantName: 'Shop',
    timeToLiveSeconds: 300,
    timeoutSeconds: 30,
  },
  ayaPay: { appKey: 'k', appSecret: 's', timeoutSeconds: 30 },
  yomaMmqr: {
    merchantId: 'm',
    clientId: 'c',
    clientSecret: 's',
    webhookHashKey: 'h',
    apiVersion: 'v1rc',
    timeoutSeconds: 30,
  },
  cyberSource: { profileId: 'p', accessKey: 'a', secretKey: 's' },
};

describe('MyanmarPayments', () => {
  it('builds every gateway once from one configuration object', () => {
    const payments = new MyanmarPayments(full);
    expect(payments.kbzPay()).toBeInstanceOf(KbzPay);
    expect(payments.kbzPay()).toBe(payments.kbzPay());
    expect(payments.waveMoney()).toBeInstanceOf(WaveMoney);
    expect(payments.waveMoney()).toBe(payments.waveMoney());
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
    ['waveMoney', 'wave_money', 'merchant_id'],
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
    const payments = MyanmarPayments.fromEnv({
      KBZ_PAY_APP_ID: 'kp',
      KBZ_PAY_APP_KEY: 'key',
      KBZ_PAY_MERCHANT_CODE: '1',
      WAVE_MONEY_MERCHANT_ID: 'm',
      WAVE_MONEY_SECRET_KEY: 's',
      WAVE_MONEY_MERCHANT_NAME: 'Shop',
      WAVE_MONEY_TIME_TO_LIVE_IN_SECONDS: '300',
      MYANMAR_PAYMENTS_HTTP_TIMEOUT: '30',
      AYA_PGW_APP_KEY: 'k',
      AYA_PGW_APP_SECRET: 's',
      YOMA_MMQR_MERCHANT_ID: 'm',
      YOMA_MMQR_CLIENT_ID: 'c',
      YOMA_MMQR_CLIENT_SECRET: 's',
      YOMA_MMQR_WEBHOOK_HASHKEY: 'h',
      YOMA_MMQR_API_VERSION: 'v1rc',
    });
    expect(payments.kbzPay().config.appId).toBe('kp');
    expect(payments.waveMoney().config.merchantName).toBe('Shop');
    expect(payments.ayaPay().config.appKey).toBe('k');
    expect(payments.yomaMmqr().config.clientId).toBe('c');
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
