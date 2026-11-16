import { APICallError, generateText, LoadAPIKeyError, NoObjectGeneratedError, NoOutputGeneratedError, Output, RetryError, stepCountIs, StepResult, ToolSet } from 'ai';
import type { LanguageModel, LanguageModelUsage, SystemModelMessage } from 'ai';
import {
  AgentFailureKind,
  AgentFollowUp,
  AgentOutcome,
  AgentRunContext,
  AgentRunError,
  CandidateRecommendation,
  Extraction,
  FollowUpIntent,
} from '../assistant.types';
import { budgetBand } from '../domain/matching';
import { hasSearchCriteria, sanitizeBudget, toContractRequirements } from '../domain/requirements';
import { FaultInjector } from './fault-injector';
import { LlmGateway, NOT_CONFIGURED_MESSAGE } from './llm.gateway';
import { ANALYSIS_SYSTEM, analysisPrompt, EXTRACTION_SYSTEM, extractionPrompt } from './prompts';
import { analysisSchema, extractionSchema, ExtractionOutput, MAX_REASON, MAX_SUMMARY, MAX_TASK_NOTES, MAX_TASK_TITLE } from './schemas';
import { AgentDataAccess, createAgentTools, ToolFailure, ToolRecorder } from './tools';

/**
 * The two-phase agent (plan 2.2, 2.6, section 7), independent of Nest so it can be tested with a
 * scripted model over the real AI SDK loop.
 *
 * Phase A: one call, no tools, structured extraction from the message, the earlier thread and the
 * agency's area names. No listing text exists in this context, so nothing a listing says can change
 * the requirements or the follow-up date. Its output is frozen.
 * Phase B: the tool loop with structured final output. When Phase A found no search criteria, the
 * listing tools are not offered at all (ruling 4), so the search is skipped deterministically.
 * Any tool failure ends the run as failed at once; it is never handed back to the model.
 */

export interface RunLimits {
  /** Whole run, both phases. */
  runTimeoutMs: number;
  /** One model request. */
  stepTimeoutMs: number;
  /** Phase B model requests. */
  maxSteps: number;
  maxRetries: number;
}

export const DEFAULT_LIMITS: RunLimits = { runTimeoutMs: 100_000, stepTimeoutMs: 45_000, maxSteps: 8, maxRetries: 1 };

const EXTRACTION_EFFORT = 'low';
const ANALYSIS_EFFORT = 'medium';
const EXTRACTION_MAX_TOKENS = 8_000;
const ANALYSIS_MAX_TOKENS = 16_000;

export interface RunAgentDeps {
  data: AgentDataAccess;
  gateway: LlmGateway;
  faults: FaultInjector;
  limits?: Partial<RunLimits>;
}

export interface AgentUsage {
  /** Whole prompt: uncached + cache read + cache write. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Prompt caching (claude-api skill, shared/prompt-caching.md). Render order is tools -> system ->
 * messages, and both system prompts and all tool definitions are constants, so that prefix is
 * byte-identical for every lead and agency; everything per-lead lives in the messages. One explicit
 * breakpoint on the system block makes tools + system a guaranteed read point (shared across runs).
 * Phase B also turns on top-level automatic caching, whose breakpoint moves to the newest message on
 * every step, so step N reads what step N-1 wrote. Phase A gets no automatic breakpoint: its prompt
 * ends in the unique message, and caching it would only pay the 1.25x write premium.
 */
const EPHEMERAL = { type: 'ephemeral' } as const;

function cachedSystem(text: string): SystemModelMessage {
  return { role: 'system', content: text, providerOptions: { anthropic: { cacheControl: EPHEMERAL } } };
}

export interface ClaudeAgentOutcome extends AgentOutcome {
  usage: AgentUsage;
  timings: { extractionMs: number; analysisMs: number; totalMs: number };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function nonNegativeInt(n: number | null): number | null {
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function uniqueTrimmed(values: readonly string[], map: (s: string) => string = (s) => s): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = map(raw.trim());
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Deterministic clean-up of the Phase A output (plan 2.4). */
export function normalizeExtraction(raw: ExtractionOutput, agencyAreas: readonly string[]): Extraction {
  const r = raw.requirements;
  const canonical = new Map(agencyAreas.map((a) => [a.trim().toLowerCase(), a]));
  let bedroomsMin = nonNegativeInt(r.bedroomsMin);
  let bedroomsMax = nonNegativeInt(r.bedroomsMax);
  if (bedroomsMin !== null && bedroomsMax !== null && bedroomsMin > bedroomsMax) [bedroomsMin, bedroomsMax] = [bedroomsMax, bedroomsMin];
  const budget = sanitizeBudget(r.budgetMinAed, r.budgetMaxAed);
  return {
    requirements: {
      locations: uniqueTrimmed(r.locations, (s) => canonical.get(s.toLowerCase()) ?? s),
      bedroomsMin,
      bedroomsMax,
      budgetMinAed: budget.min,
      budgetMaxAed: budget.max,
      budgetIsApproximate: r.budgetIsApproximate,
      propertyType: r.propertyType,
      intent: r.intent,
      preferences: uniqueTrimmed(r.preferences),
      prioritiseYield: r.prioritiseYield,
      listingReferences: uniqueTrimmed(r.listingReferences, (s) => s.toUpperCase()),
    },
    followUp: { ...raw.followUp, time: raw.followUp.time !== null && TIME_RE.test(raw.followUp.time.trim()) ? raw.followUp.time.trim() : null },
    leadAskedForFollowUp: raw.leadAskedForFollowUp,
  };
}

function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function addUsage(total: AgentUsage, u: LanguageModelUsage): void {
  total.inputTokens += u.inputTokens ?? 0;
  total.outputTokens += u.outputTokens ?? 0;
  total.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  total.cacheReadTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
  total.cacheWriteTokens += u.inputTokenDetails?.cacheWriteTokens ?? 0;
}

function describeApiError(e: APICallError): string {
  const status = e.statusCode;
  if (status === 401 || status === 403) return `The model API rejected the API key (HTTP ${status}).`;
  if (status === 429) return 'The model API rate limit or spend limit was reached (HTTP 429). Try again shortly.';
  return status ? `The model API failed (HTTP ${status}): ${e.message}` : `The model API could not be reached: ${e.message}`;
}

class RunState {
  readonly started = performance.now();
  readonly deadline: AbortSignal;
  readonly signal: AbortSignal;

  constructor(
    readonly limits: RunLimits,
    readonly recorder: ToolRecorder,
    readonly usage: AgentUsage,
    external?: AbortSignal,
  ) {
    this.deadline = AbortSignal.timeout(limits.runTimeoutMs);
    this.signal = external ? AbortSignal.any([this.deadline, external]) : this.deadline;
  }

  fail(kind: AgentFailureKind, message: string): AgentRunError {
    return new AgentRunError(kind, message, [...this.recorder.trace], { ...this.usage });
  }

  /** Maps anything thrown by a phase to an AgentRunError carrying the trace so far. */
  toRunError(error: unknown): AgentRunError {
    const { recorder } = this;
    if (recorder.failure) return this.fail('tool', `Tool ${recorder.failure.tool} failed: ${recorder.failure.message}`);
    if (error instanceof AgentRunError) return this.fail(error.kind, error.message);
    if (error instanceof ToolFailure) return this.fail('tool', `Tool ${error.tool} failed: ${error.message}`);
    if (this.deadline.aborted) return this.fail('timeout', `The assistant timed out after ${Math.round(this.limits.runTimeoutMs / 1000)} seconds.`);
    if (this.signal.aborted) return this.fail('timeout', 'The assistant run was cancelled.');
    const cause = RetryError.isInstance(error) && error.lastError !== undefined ? error.lastError : error;
    if (LoadAPIKeyError.isInstance(cause)) return this.fail('model', NOT_CONFIGURED_MESSAGE);
    if (APICallError.isInstance(cause)) return this.fail('model', describeApiError(cause));
    if (NoObjectGeneratedError.isInstance(cause) || NoOutputGeneratedError.isInstance(cause)) {
      return this.fail('invalid_output', 'The model did not return a valid structured answer.');
    }
    if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
      return this.fail('timeout', `The model did not answer within ${Math.round(this.limits.stepTimeoutMs / 1000)} seconds.`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return this.fail('model', `The model call failed: ${message}`);
  }

  async phase<T>(fn: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.toRunError(this.signal.reason);
    try {
      return await fn();
    } catch (error) {
      throw this.toRunError(error);
    }
  }
}

/** Records tool calls the SDK rejected before they reached an executor (unknown tool, invalid input). */
async function recordRejectedCalls(step: StepResult<ToolSet>, recorder: ToolRecorder): Promise<void> {
  for (const part of step.content) {
    if (part.type !== 'tool-error' || recorder.executedCallIds.has(part.toolCallId)) continue;
    const message = part.error instanceof Error ? part.error.message : String(part.error);
    await recorder.recordRejected(part.toolName, part.input, message);
  }
}

export async function runAssistantAgent(ctx: AgentRunContext, deps: RunAgentDeps): Promise<ClaudeAgentOutcome> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const recorder = new ToolRecorder(ctx.trace);
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const state = new RunState(limits, recorder, usage, ctx.signal);
  const common = { maxRetries: limits.maxRetries, abortSignal: state.signal, timeout: { stepMs: limits.stepTimeoutMs } };

  const model: LanguageModel = await state.phase(async () => deps.gateway.languageModel());

  // Phase A: extraction. No tools, no listing text.
  const extractionStarted = performance.now();
  const extraction = await state.phase(async () => {
    const listings = await deps.data.agencyListings(ctx.agencyId);
    const agencyAreas = [...new Set(listings.map((l) => l.area))].sort();
    const result = await generateText({
      ...common,
      model,
      system: cachedSystem(EXTRACTION_SYSTEM),
      prompt: extractionPrompt({ message: ctx.message, thread: ctx.thread, agencyAreas }),
      output: Output.object({ schema: extractionSchema }),
      maxOutputTokens: EXTRACTION_MAX_TOKENS,
      providerOptions: { anthropic: { effort: EXTRACTION_EFFORT } },
    });
    addUsage(usage, result.totalUsage);
    if (result.finishReason === 'content-filter') throw state.fail('model', 'The model declined to analyse this message.');
    return normalizeExtraction(result.output, agencyAreas);
  });
  const extractionMs = performance.now() - extractionStarted;

  // Phase B: tools + structured shortlist.
  const searchSkipped = !hasSearchCriteria(extraction.requirements);
  const tools = createAgentTools({
    scope: { agencyId: ctx.agencyId, leadId: ctx.lead.id },
    data: deps.data,
    recorder,
    faults: deps.faults,
    includeListingTools: !searchSkipped,
  });
  const analysisStarted = performance.now();
  const analysis = await state.phase(async () => {
    const result = await generateText({
      ...common,
      model,
      system: cachedSystem(ANALYSIS_SYSTEM),
      prompt: analysisPrompt({
        leadName: ctx.lead.name,
        message: ctx.message,
        requirements: extraction.requirements,
        budgetBand: budgetBand(extraction.requirements),
        listingToolsAvailable: !searchSkipped,
      }),
      tools,
      stopWhen: [stepCountIs(limits.maxSteps), () => recorder.failure !== null],
      onStepFinish: (step) => recordRejectedCalls(step, recorder),
      output: Output.object({ schema: analysisSchema }),
      maxOutputTokens: ANALYSIS_MAX_TOKENS,
      providerOptions: { anthropic: { effort: ANALYSIS_EFFORT, cacheControl: EPHEMERAL } },
    });
    addUsage(usage, result.totalUsage);
    if (recorder.failure) throw state.toRunError(null);
    if (result.finishReason === 'content-filter') throw state.fail('model', 'The model declined to analyse this message.');
    if (result.finishReason === 'tool-calls') throw state.fail('invalid_output', `The assistant did not finish within ${limits.maxSteps} steps.`);
    if (result.finishReason === 'length') throw state.fail('invalid_output', 'The model ran out of output tokens before answering.');
    return result.output;
  });
  const analysisMs = performance.now() - analysisStarted;

  const candidates: CandidateRecommendation[] = [];
  if (!searchSkipped) {
    for (const rec of analysis.recommendations) {
      const propertyId = rec.propertyId.trim();
      if (propertyId && !candidates.some((c) => c.propertyId === propertyId)) {
        candidates.push({ propertyId, reason: clamp(rec.reason, MAX_REASON) });
      }
    }
  }

  return {
    model: deps.gateway.modelId,
    extraction,
    requirements: toContractRequirements(extraction.requirements),
    candidates,
    seenPropertyIds: [...recorder.seenPropertyIds],
    summary: clamp(analysis.summary, MAX_SUMMARY),
    followUp: followUpFor(ctx.lead.name, extraction.followUp, extraction.leadAskedForFollowUp, analysis.followUpTask),
    trace: [...recorder.trace],
    searchSkipped,
    usage,
    timings: { extractionMs: Math.round(extractionMs), analysisMs: Math.round(analysisMs), totalMs: Math.round(performance.now() - state.started) },
  };
}

function followUpFor(
  leadName: string,
  intent: FollowUpIntent,
  leadAsked: boolean,
  drafted: { title: string; notes: string | null } | null,
): AgentFollowUp | null {
  if (drafted && drafted.title.trim()) {
    const notes = drafted.notes === null ? null : clamp(drafted.notes, MAX_TASK_NOTES) || null;
    return { title: clamp(drafted.title, MAX_TASK_TITLE), notes, intent };
  }
  if (leadAsked) return { title: clamp(`Follow up with ${leadName}`, MAX_TASK_TITLE), notes: null, intent };
  return null;
}
