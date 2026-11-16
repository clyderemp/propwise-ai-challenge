import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RunFailureKind, TokenUsage, TraceEntry } from '../assistant.types';

/**
 * Structured logs for the assistant: one JSON line per event through the Nest Logger.
 *
 * Privacy rule: only ids, names of tools, counts, timings, token counts and costs are logged. Never a
 * message body, a summary, a tool input or a tool output (those hold lead PII and listing text). Tool
 * error strings are logged only after redaction to a short class, see `toolErrorClass`.
 */

/** USD per million tokens. Estimates from public list prices; cache write = 1.25x input (5-minute TTL). */
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Estimated cost of a run in USD, or null when the model has no known price or usage is unknown. */
export function estimateCostUsd(model: string | null | undefined, usage: TokenUsage | null | undefined): number | null {
  if (!model || !usage) return null;
  const price = PRICES[model];
  if (!price) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const usd = (uncached * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + usage.outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export interface TelemetrySink {
  log(line: string): void;
  warn(line: string): void;
}

export const ASSISTANT_TELEMETRY_SINK = Symbol('ASSISTANT_TELEMETRY_SINK');

export interface RunContextIds {
  runId: string;
  leadId: string;
  agencyId: string;
  model: string | null;
}

export interface RunFinishedFacts {
  status: 'completed' | 'failed';
  failureKind: RunFailureKind | null;
  latencyMs: number;
  /** Model requests made (Phase A + Phase B steps); null when unknown (e.g. a failed run). */
  steps: number | null;
  toolCount: number;
  usage: TokenUsage | null;
}

/** Tool errors can echo inputs; only a coarse, PII-free class is logged. */
export function toolErrorClass(message: string): string {
  if (/time(d)?\s?out|abort/i.test(message)) return 'timeout';
  if (/invalid|schema|unknown tool|validation/i.test(message)) return 'invalid_input';
  if (/not found/i.test(message)) return 'not_found';
  return 'error';
}

@Injectable()
export class AssistantTelemetry {
  private readonly sink: TelemetrySink;

  constructor(@Optional() @Inject(ASSISTANT_TELEMETRY_SINK) sink?: TelemetrySink) {
    this.sink = sink ?? new Logger('AssistantTelemetry');
  }

  runStarted(ids: RunContextIds): void {
    this.emit('log', { event: 'run.started', ...pickIds(ids) });
  }

  toolCalled(ids: RunContextIds, entry: TraceEntry): void {
    const ok = entry.error === undefined;
    this.emit(ok ? 'log' : 'warn', {
      event: 'tool.called',
      ...pickIds(ids),
      tool: entry.tool,
      durationMs: entry.durationMs,
      ok,
      ...(ok ? {} : { error: toolErrorClass(entry.error ?? '') }),
    });
  }

  runFinished(ids: RunContextIds, facts: RunFinishedFacts): void {
    const usage = facts.usage;
    this.emit(facts.status === 'completed' ? 'log' : 'warn', {
      event: facts.status === 'completed' ? 'run.completed' : 'run.failed',
      ...pickIds(ids),
      status: facts.status,
      failureKind: facts.failureKind,
      latencyMs: facts.latencyMs,
      steps: facts.steps,
      toolCount: facts.toolCount,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      estimatedCostUsd: estimateCostUsd(ids.model, usage),
    });
  }

  private emit(level: 'log' | 'warn', payload: Record<string, unknown>): void {
    try {
      this.sink[level](JSON.stringify(payload));
    } catch {
      // Telemetry never breaks a run.
    }
  }
}

/** Whitelist: callers may pass richer objects, only these fields are ever logged. */
function pickIds(ids: RunContextIds): RunContextIds {
  return { runId: ids.runId, leadId: ids.leadId, agencyId: ids.agencyId, model: ids.model };
}
