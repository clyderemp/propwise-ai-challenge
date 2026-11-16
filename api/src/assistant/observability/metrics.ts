import { AssistantRunStatus, RunDiagnostics, TraceEntry } from '../assistant.types';
import { estimateCostUsd } from './assistant-telemetry';

/** What the aggregation needs from one stored run. */
export interface RunMetricRow {
  status: AssistantRunStatus;
  model: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  error: string | null;
  diagnostics: RunDiagnostics | null;
  trace: Pick<TraceEntry, 'tool' | 'error'>[] | TraceEntry[];
}

export interface AssistantMetrics {
  totals: { runs: number; completed: number; failed: number; running: number };
  /** cacheHitRatio = cache-read input tokens / all input tokens; null when no run reported cache fields. */
  /** completed / (completed + failed); null when no run has finished. */
  successRate: number | null;
  /** Over finished runs. Nearest-rank percentiles. */
  latencyMs: { p50: number | null; p90: number | null; max: number | null; samples: number };
  /** Estimated from stored token usage and list prices; runs on unpriced models count as 0. */
  cost: { totalUsd: number; averageUsd: number | null; runsWithUsage: number };
  tokens: { input: number; output: number; total: number; cacheRead: number; cacheWrite: number; cacheHitRatio: number | null };
  failureKinds: Record<string, number>;
  toolErrors: Record<string, number>;
  models: Record<string, { runs: number; completed: number; failed: number }>;
  lastFailureAt: string | null;
}

const INTERRUPTED_PREFIX = 'The run was interrupted';

/** Nearest-rank percentile; null for an empty set. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function latencyOf(row: RunMetricRow): number | null {
  const stored = row.diagnostics?.timings?.latencyMs;
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  if (!row.finishedAt) return null;
  return Math.max(0, row.finishedAt.getTime() - row.createdAt.getTime());
}

function failureKindOf(row: RunMetricRow): string {
  if (row.diagnostics?.failureKind) return row.diagnostics.failureKind;
  if (row.error?.startsWith(INTERRUPTED_PREFIX)) return 'interrupted';
  return 'unknown';
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export function computeAssistantMetrics(rows: readonly RunMetricRow[]): AssistantMetrics {
  const totals = { runs: rows.length, completed: 0, failed: 0, running: 0 };
  const latencies: number[] = [];
  const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  let totalUsd = 0;
  let runsWithUsage = 0;
  let cacheReported = false;
  const failureKinds: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  const models: AssistantMetrics['models'] = {};
  let lastFailure: Date | null = null;

  for (const row of rows) {
    totals[row.status] += 1;
    const modelKey = row.model ?? 'unknown';
    const model = (models[modelKey] ??= { runs: 0, completed: 0, failed: 0 });
    model.runs += 1;
    if (row.status === 'completed') model.completed += 1;
    if (row.status === 'failed') {
      model.failed += 1;
      const kind = failureKindOf(row);
      failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
      const at = row.finishedAt ?? row.createdAt;
      if (!lastFailure || at > lastFailure) lastFailure = at;
    }
    if (row.status !== 'running') {
      const latency = latencyOf(row);
      if (latency !== null) latencies.push(latency);
    }
    for (const entry of row.trace) {
      if (entry.error !== undefined) toolErrors[entry.tool] = (toolErrors[entry.tool] ?? 0) + 1;
    }
    const usage = row.diagnostics?.usage;
    if (usage) {
      runsWithUsage += 1;
      tokens.input += usage.inputTokens;
      tokens.output += usage.outputTokens;
      tokens.total += usage.totalTokens;
      if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) cacheReported = true;
      tokens.cacheRead += usage.cacheReadTokens ?? 0;
      tokens.cacheWrite += usage.cacheWriteTokens ?? 0;
      totalUsd += estimateCostUsd(row.model, usage) ?? 0;
    }
  }

  const finished = totals.completed + totals.failed;
  return {
    totals,
    successRate: finished === 0 ? null : totals.completed / finished,
    latencyMs: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      max: latencies.length === 0 ? null : Math.max(...latencies),
      samples: latencies.length,
    },
    cost: { totalUsd: round6(totalUsd), averageUsd: runsWithUsage === 0 ? null : round6(totalUsd / runsWithUsage), runsWithUsage },
    tokens: { ...tokens, cacheHitRatio: !cacheReported || tokens.input === 0 ? null : tokens.cacheRead / tokens.input },
    failureKinds,
    toolErrors,
    models,
    lastFailureAt: lastFailure ? (lastFailure as Date).toISOString() : null,
  };
}
