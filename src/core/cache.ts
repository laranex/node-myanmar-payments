type MaybePromise<T> = T | Promise<T>;

/**
 * Stores access tokens between calls (used by Yoma MMQR). Implement it on top of Redis or similar
 * to share tokens between processes; every method may return a promise.
 */
export interface TokenCache {
  /** The cached value, or `undefined` when it is missing or expired. */
  get(key: string): MaybePromise<string | undefined | null>;
  /** Stores `value` for `ttlSeconds`; `0` or less never expires. */
  set(key: string, value: string, ttlSeconds: number): MaybePromise<unknown>;
  /** Removes `key`. */
  delete(key: string): MaybePromise<unknown>;
}

/**
 * The default {@link TokenCache}: a `Map` that lives as long as the process. Share one gateway (or
 * one cache) across requests so the token is reused.
 */
export class MemoryTokenCache implements TokenCache {
  private readonly items = new Map<string, { value: string; expiresAt: number | undefined }>();

  get(key: string): string | undefined {
    const item = this.items.get(key);
    if (item === undefined) {
      return undefined;
    }
    if (item.expiresAt !== undefined && Date.now() >= item.expiresAt) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string, value: string, ttlSeconds: number): void {
    this.items.set(key, {
      value,
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  /** Removes every entry. */
  clear(): void {
    this.items.clear();
  }
}
