import { priceUsage } from '../agent/pricing';
import { computeAssistantMetrics, percentile, RunMetricRow } from './metrics';

const T0 = new Date('2026-11-10T10:00:00Z');

function row(over: Partial<RunMetricRow> = {}): RunMetricRow {
  return {
    status: 'completed',
    model: 'claude-sonnet-5-5',
    createdAt: T0,
    finishedAt: new Date(T0.getTime() + 1000),
    error: null,
    diagnostics: null,
    trace: [],
    ...over,
  };
}

describe('percentile (nearest rank)', () => {
  it('returns null for an empty set', () => {
    expect(percentile([], 50)).toBeNull();
  });
  it('picks the nearest-rank value', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 90)).toBe(40);
    expect(percentile([7], 90)).toBe(7);
  });
});

describe('computeAssistantMetrics', () => {
  it('returns zeros and nulls for an empty set', () => {
    const m = computeAssistantMetrics([]);
    expect(m.totals).toEqual({ runs: 0, completed: 0, failed: 0, running: 0 });
    expect(m.successRate).toBeNull();
    expect(m.latencyMs).toEqual({ p50: null, p90: null, max: null, samples: 0 });
    expect(m.cost).toEqual({ totalUsd: 0, averageUsd: null, runsWithUsage: 0 });
    expect(m.tokens).toEqual({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cacheHitRatio: null });
    expect(m.failureKinds).toEqual({});
    expect(m.toolErrors).toEqual({});
    expect(m.models).toEqual({});
    expect(m.lastFailureAt).toBeNull();
  });

  it('aggregates status, latency, tokens, cost, failures, tool errors and models', () => {
    const failedAt = new Date('2026-11-10T12:00:00Z');
    const m = computeAssistantMetrics([
      row({
        diagnostics: {
          droppedRecommendations: [],
          budgetBand: null,
          searchSkipped: false,
          usage: priceUsage('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000, cacheReadTokens: 500_000, cacheWriteTokens: 0 }),
          timings: { startedAt: T0.toISOString(), finishedAt: T0.toISOString(), latencyMs: 3000, phaseAMs: 1000, phaseBMs: 2000 },
        },
        trace: [{ tool: 'search_listings', input: {}, output: [], durationMs: 5 }],
      }),
      // No timings stored: latency falls back to finishedAt - createdAt (1000ms).
      row({ model: 'fake-scripted' }),
      row({
        status: 'failed',
        createdAt: new Date(failedAt.getTime() - 2000),
        finishedAt: failedAt,
        error: 'Tool search_listings failed: boom',
        diagnostics: { droppedRecommendations: [], budgetBand: null, searchSkipped: false, failureKind: 'tool' },
        trace: [{ tool: 'search_listings', input: {}, error: 'boom', durationMs: 3 }],
      }),
      row({ status: 'failed', error: 'old run without a kind', finishedAt: T0 }),
      row({ status: 'running', finishedAt: null }),
    ]);

    expect(m.totals).toEqual({ runs: 5, completed: 2, failed: 2, running: 1 });
    expect(m.successRate).toBe(0.5);
    // latencies: 3000, 1000, 2000, 0
    expect(m.latencyMs).toEqual({ p50: 1000, p90: 3000, max: 3000, samples: 4 });
    expect(m.tokens).toEqual({ input: 1_000_000, output: 100_000, total: 1_100_000, cacheRead: 500_000, cacheWrite: 0, cacheHitRatio: 0.5 });
    // sonnet 5.5: 500k uncached * $2/M = 1.00, 500k cache read * $0.10/M = 0.05, 100k out * $10/M = 1.00
    expect(m.cost.totalUsd).toBeCloseTo(2.05, 6);
    expect(m.cost.averageUsd).toBeCloseTo(2.05, 6);
    expect(m.cost.runsWithUsage).toBe(1);
    expect(m.failureKinds).toEqual({ tool: 1, unknown: 1 });
    expect(m.toolErrors).toEqual({ search_listings: 1 });
    expect(m.models['claude-sonnet-5-5']).toEqual({ runs: 4, completed: 1, failed: 2 });
    expect(m.models['fake-scripted']).toEqual({ runs: 1, completed: 1, failed: 0 });
    expect(m.lastFailureAt).toBe(failedAt.toISOString());
  });

  it('classifies interrupted runs', () => {
    const m = computeAssistantMetrics([
      row({ status: 'failed', error: 'The run was interrupted (the API restarted or crashed before it finished). Start a new analysis.' }),
    ]);
    expect(m.failureKinds).toEqual({ interrupted: 1 });
  });
});
