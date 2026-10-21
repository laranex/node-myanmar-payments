import { hmacSha256Hex, safeEqual } from '../core/crypto.js';

/**
 * Wave's mini app hash (Wave Money JS SDK spec v1.8): lowercase hex HMAC-SHA256, keyed with the
 * secret key, over `<amount><orderID><miniAppID><merchantRefID><callBackUrl>` with no separator.
 * The payment and its callback use the same hash.
 */
export class WavePayMiniAppSigner {
  constructor(private readonly secretKey: string) {}

  /** The hash; `amount` is the amount's exact whole-number text, e.g. `"5000"`. */
  hash(
    amount: string,
    orderId: string,
    miniAppId: string,
    merchantReferenceId: string,
    callbackUrl: string,
  ): string {
    return hmacSha256Hex(
      this.secretKey,
      `${amount}${orderId}${miniAppId}${merchantReferenceId}${callbackUrl}`,
    );
  }

  /**
   * Whether `hashValue` is the expected hash, compared in constant time and ignoring the case of
   * the hex digits.
   */
  verify(
    hashValue: string,
    amount: string,
    orderId: string,
    miniAppId: string,
    merchantReferenceId: string,
    callbackUrl: string,
  ): boolean {
    return safeEqual(
      this.hash(amount, orderId, miniAppId, merchantReferenceId, callbackUrl),
      hashValue.toLowerCase(),
    );
  }
}
