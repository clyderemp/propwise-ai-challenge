/**
 * Token pricing and the cache-aware cost estimate stored on every run (diagnostics.usage).
 *
 * USD per million tokens, from the claude-api skill (cached 2026-11-03) and its prompt-caching
 * economics: a 5-minute cache write costs 1.25x the input price; a cache read costs 0.05x on
 * Claude Sonnet 5.5 and Claude Opus 5.5 ($0.10 and $0.20) and ~0.1x on the other models listed.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Raw counts. inputTokens is the whole prompt: uncached + cache read + cache write. */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cacheReadTokens / inputTokens; 0 when there was no input. */
  cacheHitRatio: number;
  /** null for a model with no known price (e.g. the scripted fake agent). */
  estimatedCostUsd: number | null;
  /** The same tokens billed as if nothing were cached. */
  estimatedCostWithoutCacheUsd: number | null;
}

export function priceUsage(model: string | null | undefined, usage: RawUsage): PricedUsage {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const price = model ? MODEL_PRICES[model] : undefined;
  const uncached = Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRatio: usage.inputTokens > 0 ? cacheReadTokens / usage.inputTokens : 0,
    estimatedCostUsd: price
      ? (uncached * price.input + cacheReadTokens * price.cacheRead + cacheWriteTokens * price.cacheWrite + usage.outputTokens * price.output) / 1_000_000
      : null,
    estimatedCostWithoutCacheUsd: price ? (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000 : null,
  };
}
