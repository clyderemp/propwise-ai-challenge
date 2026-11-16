import { MODEL_PRICES, priceUsage } from './pricing';

describe('priceUsage (USD per MTok, claude-api skill pricing 2026-11)', () => {
  it('prices Sonnet 5.5 at $2 in / $10 out, cache read $0.10 (0.05x) and 5-minute cache write $2.50 (1.25x)', () => {
    expect(MODEL_PRICES['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  });

  it('bills uncached, cache-read and cache-write input separately and compares with the no-cache price', () => {
    // 1,000,000 input tokens in total: 600k read from cache, 100k written, 300k uncached; 100k output.
    const u = priceUsage('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 });
    // 0.3 * 2 + 0.6 * 0.1 + 0.1 * 2.5 + 0.1 * 10 = 0.6 + 0.06 + 0.25 + 1.0
    expect(u.estimatedCostUsd).toBeCloseTo(1.91, 9);
    // 1.0 * 2 + 0.1 * 10
    expect(u.estimatedCostWithoutCacheUsd).toBeCloseTo(3.0, 9);
    expect(u.cacheHitRatio).toBeCloseTo(0.6, 9);
    expect(u).toMatchObject({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 });
  });

  it('a cache write alone costs more than no cache (the 1.25x premium is only repaid by later reads)', () => {
    const u = priceUsage('claude-sonnet-5-5', { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 1_000 });
    expect(u.estimatedCostUsd).toBeCloseTo(0.0025, 12);
    expect(u.estimatedCostWithoutCacheUsd).toBeCloseTo(0.002, 12);
  });

  it('treats missing cache fields as zero, gives a 0 hit ratio for zero input and null cost for an unknown model', () => {
    expect(priceUsage('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 })).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRatio: 0,
      estimatedCostUsd: 0.004,
      estimatedCostWithoutCacheUsd: 0.004,
    });
    expect(priceUsage('fake-scripted', { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRatio: 0,
      estimatedCostUsd: null,
      estimatedCostWithoutCacheUsd: null,
    });
  });
});
