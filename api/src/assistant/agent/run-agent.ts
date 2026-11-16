import { APICallError, generateText, LoadAPIKeyError, NoObjectGeneratedError, NoOutputGeneratedError, Output, RetryError, stepCountIs, StepResult, ToolSet } from 'ai';
import type { LanguageModel, LanguageModelUsage, ModelMessage, SystemModelMessage } from 'ai';
import {
  AgentFailureKind,
  AgentFollowUp,
  AgentOutcome,
  AgentRunContext,
  AgentRunError,
  CandidateRecommendation,
  ClaimIssue,
  ExtractedRequirements,
  Extraction,
  FollowUpIntent,
  SelfVerification,
} from '../assistant.types';
import { checkReasonClaims, ClaimCheckContext } from '../domain/claim-check';
import { ListingRecord } from '../domain/listing-facts';
import { budgetBand, claimContext, factualReason, validateRecommendations } from '../domain/matching';
import { hasSearchCriteria, sanitizeBudget, toContractRequirements } from '../domain/requirements';
import { FaultInjector } from './fault-injector';
import { LlmGateway, NOT_CONFIGURED_MESSAGE } from './llm.gateway';
import { ANALYSIS_SYSTEM, analysisPrompt, EXTRACTION_SYSTEM, extractionPrompt, revisionPrompt } from './prompts';
import { AnalysisOutput, analysisSchema, extractionSchema, ExtractionOutput, MAX_REASON, MAX_SUMMARY, MAX_TASK_NOTES, MAX_TASK_TITLE } from './schemas';
import { AgentDataAccess, createAgentTools, TOOL_NAMES, ToolFailure, ToolRecorder } from './tools';

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
/** The revision turn is skipped (and reasons fall back) when less than this is left before the deadline. */
const MIN_REVISION_MS = 8_000;
/** Kept free after the revision turn for the service to validate and store the run before its deadline. */
const REVISION_MARGIN_MS = 3_000;

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

/**
 * AI SDK OpenTelemetry spans for one phase. A no-op unless the host process registers an OTel tracer
 * provider (see NOTES.md, "Observability"). recordInputs/recordOutputs are off: prompts hold lead PII.
 */
function telemetryFor(functionId: string, runId: string, model: string) {
  return { isEnabled: true, functionId, recordInputs: false, recordOutputs: false, metadata: { runId, model } };
}

export interface ClaudeAgentOutcome extends AgentOutcome {
  usage: AgentUsage;
  steps: number;
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

  let steps = 0;
  const model: LanguageModel = await state.phase(async () => deps.gateway.languageModel());

  // Phase A: extraction. No tools, no listing text.
  const extractionStarted = performance.now();
  let agencyListings: ListingRecord[] = [];
  const extraction = await state.phase(async () => {
    const listings = await deps.data.agencyListings(ctx.agencyId);
    agencyListings = listings;
    const agencyAreas = [...new Set(listings.map((l) => l.area))].sort();
    const result = await generateText({
      ...common,
      model,
      system: cachedSystem(EXTRACTION_SYSTEM),
      prompt: extractionPrompt({ message: ctx.message, thread: ctx.thread, agencyAreas, lead: { status: ctx.lead.status ?? null, notes: ctx.lead.notes ?? null } }),
      output: Output.object({ schema: extractionSchema }),
      maxOutputTokens: EXTRACTION_MAX_TOKENS,
      providerOptions: { anthropic: { effort: EXTRACTION_EFFORT } },
      experimental_telemetry: telemetryFor('assistant.phaseA', ctx.runId, deps.gateway.modelId),
    });
    addUsage(usage, result.totalUsage);
    steps += result.steps.length;
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
  const analysisRequest = analysisPrompt({
    leadName: ctx.lead.name,
    message: ctx.message,
    requirements: extraction.requirements,
    budgetBand: budgetBand(extraction.requirements),
    listingToolsAvailable: !searchSkipped,
  });
  const analysisTurn = await state.phase(async () => {
    const result = await generateText({
      ...common,
      model,
      system: cachedSystem(ANALYSIS_SYSTEM),
      prompt: analysisRequest,
      tools,
      stopWhen: [stepCountIs(limits.maxSteps), () => recorder.failure !== null],
      onStepFinish: (step) => recordRejectedCalls(step, recorder),
      output: Output.object({ schema: analysisSchema }),
      maxOutputTokens: ANALYSIS_MAX_TOKENS,
      providerOptions: { anthropic: { effort: ANALYSIS_EFFORT, cacheControl: EPHEMERAL } },
      experimental_telemetry: telemetryFor('assistant.phaseB', ctx.runId, deps.gateway.modelId),
    });
    steps += result.steps.length;
    addUsage(usage, result.totalUsage);
    if (recorder.failure) throw state.toRunError(null);
    if (result.finishReason === 'content-filter') throw state.fail('model', 'The model declined to analyse this message.');
    if (result.finishReason === 'tool-calls') throw state.fail('invalid_output', `The assistant did not finish within ${limits.maxSteps} steps.`);
    if (result.finishReason === 'length') throw state.fail('invalid_output', 'The model ran out of output tokens before answering.');
    // "Nothing fits" must come from a search. A rent enquiry is exempt: every listing is for sale, so code drops them all anyway.
    const searched = recorder.trace.some((e) => e.tool === TOOL_NAMES.searchListings && e.error === undefined);
    if (!searchSkipped && extraction.requirements.intent !== 'rent' && !searched) {
      throw state.fail('invalid_output', 'The assistant answered without searching the listings, so it cannot say what fits.');
    }
    return { output: result.output, messages: result.response.messages };
  });

  // Self-verification: check every candidate's reason against the data, give the model one revision
  // turn when anything is wrong, then replace any reason still wrong with a factual one.
  let analysis = analysisTurn.output;
  let candidates = toCandidates(analysis, searchSkipped);
  let selfVerification: SelfVerification | undefined;
  if (!searchSkipped) {
    const check = verificationInput(extraction.requirements, ctx.agencyId, agencyListings, recorder.seenPropertyIds);
    const checked = candidates.length;
    const issuesFound = [...validationIssues(candidates, check), ...claimIssues(candidates, check)];
    let revised = false;
    let rounds = 0;
    let revisionError: string | undefined;
    if (issuesFound.length > 0) {
      // The nearer of the agent's own limit and the service deadline (ASSISTANT_RUN_TIMEOUT_MS).
      const agentLeftMs = limits.runTimeoutMs - (performance.now() - state.started);
      const leftMs = ctx.deadlineAt === undefined ? agentLeftMs : Math.min(agentLeftMs, ctx.deadlineAt - Date.now());
      if (leftMs < MIN_REVISION_MS || state.signal.aborted) {
        revisionError = 'Not enough time left before the run deadline for a revision turn.';
      } else {
        rounds = 1;
        const messages: ModelMessage[] = [
          { role: 'user', content: analysisRequest },
          ...analysisTurn.messages,
          { role: 'user', content: revisionPrompt(issuesFound) },
        ];
        try {
          const result = await generateText({
            ...common,
            // Exactly one extra request: no retries, one step, ending before the deadline with room to store the run.
            maxRetries: 0,
            abortSignal: AbortSignal.any([state.signal, AbortSignal.timeout(Math.min(limits.stepTimeoutMs, leftMs - REVISION_MARGIN_MS))]),
            model,
            // Same cached system prompt, same tool definitions, same effort as Phase B, and Phase B's messages
            // resent unchanged: the tools + system prefix is read from the cache (tool_choice only invalidates
            // the messages tier). tool_choice 'none' and tools without executors: the revision can only answer.
            system: cachedSystem(ANALYSIS_SYSTEM),
            messages,
            tools: answerOnly(tools),
            toolChoice: 'none',
            stopWhen: stepCountIs(1),
            output: Output.object({ schema: analysisSchema }),
            maxOutputTokens: ANALYSIS_MAX_TOKENS,
            providerOptions: { anthropic: { effort: ANALYSIS_EFFORT } },
            experimental_telemetry: telemetryFor('assistant.revision', ctx.runId, deps.gateway.modelId),
          });
          steps += result.steps.length;
          addUsage(usage, result.totalUsage);
          if (result.finishReason !== 'stop') {
            revisionError = `The revision turn ended with ${result.finishReason} instead of an answer.`;
          } else {
            analysis = result.output;
            candidates = toCandidates(analysis, searchSkipped);
            revised = true;
          }
        } catch (error) {
          revisionError = `The revision turn failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    const fallbackReasons: SelfVerification['fallbackReasons'] = [];
    if (issuesFound.length > 0) {
      candidates = candidates.map((c) => {
        const listing = check.byId.get(c.propertyId);
        if (!listing) return c;
        const remaining = checkReasonClaims(c.reason, listing, check.claimContext);
        if (remaining.length === 0) return c;
        fallbackReasons.push({ propertyId: c.propertyId, reference: listing.reference, issues: remaining });
        return { propertyId: c.propertyId, reason: clamp(factualReason(listing), MAX_REASON) };
      });
    }
    selfVerification = {
      checkedRecommendations: checked,
      issuesFound,
      revised,
      rounds,
      fallbackReasons,
      ...(revisionError !== undefined ? { revisionError } : {}),
    };
  }
  const analysisMs = performance.now() - analysisStarted;

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
    steps,
    ...(selfVerification ? { selfVerification } : {}),
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

/** The same tool definitions with no executors: offered for an identical (cached) prefix, never run. */
function answerOnly(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, { ...t, execute: undefined }]));
}

function toCandidates(analysis: AnalysisOutput, searchSkipped: boolean): CandidateRecommendation[] {
  const candidates: CandidateRecommendation[] = [];
  if (searchSkipped) return candidates;
  for (const rec of analysis.recommendations) {
    const propertyId = rec.propertyId.trim();
    if (propertyId && !candidates.some((c) => c.propertyId === propertyId)) {
      candidates.push({ propertyId, reason: clamp(rec.reason, MAX_REASON) });
    }
  }
  return candidates;
}

interface VerificationInput {
  requirements: ExtractedRequirements;
  agencyId: string;
  listings: ListingRecord[];
  byId: Map<string, ListingRecord>;
  seenPropertyIds: string[];
  claimContext: ClaimCheckContext;
}

function verificationInput(requirements: ExtractedRequirements, agencyId: string, listings: ListingRecord[], seen: ReadonlySet<string>): VerificationInput {
  return {
    requirements,
    agencyId,
    listings,
    byId: new Map(listings.map((l) => [l.id, l])),
    seenPropertyIds: [...seen],
    claimContext: claimContext(requirements, listings),
  };
}

/** The service's own recommendation validation, run early so the model can fix what it would drop. */
function validationIssues(candidates: CandidateRecommendation[], v: VerificationInput): ClaimIssue[] {
  const { dropped } = validateRecommendations({
    candidates,
    requirements: v.requirements,
    agencyId: v.agencyId,
    listings: v.listings,
    agencyListings: v.listings,
    seenPropertyIds: v.seenPropertyIds,
  });
  return dropped.map((d) => ({ propertyId: d.propertyId, reference: d.reference, kind: 'validation' as const, claim: d.reason, expected: d.detail }));
}

function claimIssues(candidates: CandidateRecommendation[], v: VerificationInput): ClaimIssue[] {
  return candidates.flatMap((c) => {
    const listing = v.byId.get(c.propertyId);
    return listing ? checkReasonClaims(c.reason, listing, v.claimContext) : [];
  });
}
