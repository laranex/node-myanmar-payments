import { AyaPay, AyaPayConfig, type AyaPayConfigOptions } from './aya-pay/aya-pay.js';
import type { TokenCache } from './core/cache.js';
import { MemoryTokenCache } from './core/cache.js';
import { defaultEnv, type EnvSource } from './core/env.js';
import { ConfigurationError } from './core/errors.js';
import type { GatewayOptions } from './core/http.js';
import {
  CyberSource,
  CyberSourceConfig,
  type CyberSourceConfigOptions,
} from './cyber-source/cyber-source.js';
import { KbzPay, KbzPayConfig, type KbzPayConfigOptions } from './kbz-pay/kbz-pay.js';
import {
  WaveMoney,
  WaveMoneyConfig,
  type WaveMoneyConfigOptions,
} from './wave-money/wave-money.js';
import { YomaMmqr, YomaMmqrConfig, type YomaMmqrConfigOptions } from './yoma-mmqr/yoma-mmqr.js';

/** The configuration of every gateway; configure only the ones you use. */
export interface MyanmarPaymentsConfig {
  kbzPay?: KbzPayConfig | KbzPayConfigOptions | undefined;
  waveMoney?: WaveMoneyConfig | WaveMoneyConfigOptions | undefined;
  ayaPay?: AyaPayConfig | AyaPayConfigOptions | undefined;
  yomaMmqr?: YomaMmqrConfig | YomaMmqrConfigOptions | undefined;
  cyberSource?: CyberSourceConfig | CyberSourceConfigOptions | undefined;
}

/** Options shared by every gateway the facade builds. */
export interface MyanmarPaymentsOptions extends GatewayOptions {
  /** Keeps Yoma MMQR's access token; defaults to a {@link MemoryTokenCache}. */
  tokenCache?: TokenCache | undefined;
}

type Source<T, O> = T | O | (() => T) | undefined;

/**
 * Builds each gateway from one configuration object (or the environment). Gateways are created
 * on first use and reused, so only the gateways you call need to be configured.
 */
export class MyanmarPayments {
  private kbzPayGateway: KbzPay | undefined;
  private waveMoneyGateway: WaveMoney | undefined;
  private ayaPayGateway: AyaPay | undefined;
  private yomaMmqrGateway: YomaMmqr | undefined;
  private cyberSourceGateway: CyberSource | undefined;
  private readonly options: MyanmarPaymentsOptions;
  private readonly sources: {
    kbzPay: Source<KbzPayConfig, KbzPayConfigOptions>;
    waveMoney: Source<WaveMoneyConfig, WaveMoneyConfigOptions>;
    ayaPay: Source<AyaPayConfig, AyaPayConfigOptions>;
    yomaMmqr: Source<YomaMmqrConfig, YomaMmqrConfigOptions>;
    cyberSource: Source<CyberSourceConfig, CyberSourceConfigOptions>;
  };

  constructor(config: MyanmarPaymentsConfig = {}, options: MyanmarPaymentsOptions = {}) {
    this.options = { ...options, tokenCache: options.tokenCache ?? new MemoryTokenCache() };
    this.sources = { ...config } as typeof this.sources;
  }

  /**
   * Reads every gateway's configuration from environment variables (`KBZ_PAY_*`, `WAVE_MONEY_*`,
   * `AYA_PAY_*`, `YOMA_MMQR_*`, `CYBER_SOURCE_*`) when the gateway is first used.
   */
  static fromEnv(
    env: EnvSource = defaultEnv(),
    options: MyanmarPaymentsOptions = {},
  ): MyanmarPayments {
    const payments = new MyanmarPayments({}, options);
    Object.assign(payments.sources, {
      kbzPay: () => KbzPayConfig.fromEnv(env),
      waveMoney: () => WaveMoneyConfig.fromEnv(env),
      ayaPay: () => AyaPayConfig.fromEnv(env),
      yomaMmqr: () => YomaMmqrConfig.fromEnv(env),
      cyberSource: () => CyberSourceConfig.fromEnv(env),
    });
    return payments;
  }

  /** The KBZ Pay gateway. Throws a `ConfigurationError` when it is not configured. */
  kbzPay(): KbzPay {
    return (this.kbzPayGateway ??= new KbzPay(
      resolve(this.sources.kbzPay, KbzPayConfig, 'kbz_pay', 'app_id'),
      this.options,
    ));
  }

  /** The Wave Money gateway. Throws a `ConfigurationError` when it is not configured. */
  waveMoney(): WaveMoney {
    return (this.waveMoneyGateway ??= new WaveMoney(
      resolve(this.sources.waveMoney, WaveMoneyConfig, 'wave_money', 'merchant_id'),
      this.options,
    ));
  }

  /** The AYA Payment Gateway. Throws a `ConfigurationError` when it is not configured. */
  ayaPay(): AyaPay {
    return (this.ayaPayGateway ??= new AyaPay(
      resolve(this.sources.ayaPay, AyaPayConfig, 'aya_pay', 'app_key'),
      this.options,
    ));
  }

  /** The Yoma MMQR gateway. Throws a `ConfigurationError` when it is not configured. */
  yomaMmqr(): YomaMmqr {
    return (this.yomaMmqrGateway ??= new YomaMmqr(
      resolve(this.sources.yomaMmqr, YomaMmqrConfig, 'yoma_mmqr', 'merchant_id'),
      this.options,
    ));
  }

  /** The CyberSource gateway. Throws a `ConfigurationError` when it is not configured. */
  cyberSource(): CyberSource {
    return (this.cyberSourceGateway ??= new CyberSource(
      resolve(this.sources.cyberSource, CyberSourceConfig, 'cyber_source', 'profile_id'),
    ));
  }
}

function resolve<T, O>(
  source: Source<T, O>,
  type: new (options: O) => T,
  gateway: string,
  firstKey: string,
): T {
  if (source === undefined || source === null) {
    throw new ConfigurationError(gateway, firstKey);
  }
  if (typeof source === 'function') {
    return (source as () => T)();
  }
  return source instanceof type ? source : new type(source as O);
}
