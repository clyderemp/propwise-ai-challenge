import { RequestContext } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConflictException,
  Inject,
  Injectable,
  BeforeApplicationShutdown,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnprocessableEntityException,
} from '@nestjs/common';
import { toTaskDto } from '../common/dto';
import { AuthAgent } from '../auth/decorators';
import {
  Agency,
  Agent,
  AssistantRun as AssistantRunEntity,
  Lead,
  Message,
  Property,
  ProposedAction as ProposedActionEntity,
  Task,
} from '../entities';
import { priceUsage } from './agent/pricing';
import { CreateAssistantRunDto, toAssistantRunDto, toProposedActionDto } from './assistant.dto';
import {
  AgentMessage,
  AgentOutcome,
  AgentPort,
  AgentRunError,
  ASSISTANT_AGENT,
  AssistantRun,
  DataWarning,
  DropReason,
  DroppedRecommendation,
  FollowUpTaskDraft,
  RunFailureKind,
  RunTimings,
  TraceEntry,
} from './assistant.types';
import { AssistantTelemetry, RunContextIds } from './observability/assistant-telemetry';
import { AssistantMetrics, computeAssistantMetrics } from './observability/metrics';
import { resolveDueAt } from './domain/follow-up-date';
import { computeListingFlags, ListingRecord, toListingRecord } from './domain/listing-facts';
import { reconcileSummary, validateRecommendations } from './domain/matching';
import { emptyRequirements } from './domain/requirements';

/** Newest messages before the analysed one that the agent sees as context. */
const THREAD_LIMIT = 20;
/** TASK.md: a run answers within 2 minutes. Override with ASSISTANT_RUN_TIMEOUT_MS. */
const DEFAULT_RUN_TIMEOUT_MS = 110_000;
const MAX_TITLE = 200; // CreateTaskDto limits
const MAX_NOTES = 5000;
const MAX_ERROR = 500;
/** Slack after the deadline before a 'running' run is treated as orphaned (the run's own failure write). */
const OVERDUE_GRACE_MS = 15_000;
/** The error of a run cut off by a restart, a crash or a shutdown. */
export const RESTART_ERROR = 'The API restarted while this run was in progress, so it did not finish.';
/** How long a shutdown waits for in-flight runs to store their failure. */
const SHUTDOWN_WAIT_MS = 5_000;

/** The abort reason of a run cut off because the API is shutting down. */
class RunInterruptedError extends Error {
  constructor() {
    super(RESTART_ERROR);
    this.name = 'RunInterruptedError';
  }
}

/** What a run needs besides its row: loaded once, before the agent starts. */
interface RunInputs {
  auth: AuthAgent;
  agent: Agent;
  lead: Lead;
  message: Message;
  thread: Message[];
}

function runTimeoutMs(): number {
  const value = Number(process.env.ASSISTANT_RUN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RUN_TIMEOUT_MS;
}

function toAgentMessage(m: Message): AgentMessage {
  return { id: m.id, direction: m.direction, channel: m.channel, body: m.body, sentAt: m.sentAt };
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A readable reason for a failed run. Never "no matching properties". */
export function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof RunInterruptedError) return RESTART_ERROR;
  if (error instanceof AgentRunError) {
    if (error.kind === 'timeout') return `The assistant timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
    return clamp(error.message, MAX_ERROR);
  }
  if (error instanceof RangeError) return clamp(`Could not compute the follow-up date: ${error.message}`, MAX_ERROR);
  const message = error instanceof Error ? error.message : String(error);
  return clamp(`The assistant failed: ${message}`, MAX_ERROR);
}

@Injectable()
export class AssistantService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AssistantService.name);
  /** Runs executing in this process (sync and background), so a shutdown can fail them cleanly. */
  private readonly inFlight = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

  constructor(
    private readonly em: EntityManager,
    @Inject(ASSISTANT_AGENT) private readonly agent: AgentPort,
    private readonly telemetry: AssistantTelemetry,
  ) {}

  /** Runs the assistant on one message. Model and tool failures give a failed run (201), never an exception. */
  async createRun(auth: AuthAgent, leadId: string, dto: CreateAssistantRunDto): Promise<AssistantRun> {
    const lead = await this.findLead(auth.agencyId, leadId);
    const message = await this.pickMessage(lead, dto.messageId);
    const inputs = await this.loadInputs(this.em, auth, lead, message);
    const run = this.newRun(this.em, inputs);
    await this.em.flush();
    const actions = await this.execute(this.em, run, inputs);
    return toAssistantRunDto(run, actions);
  }

  /**
   * Background run (?async=true). Validates exactly like createRun, stores the run as 'running' and returns it
   * at once; the agent then runs in this process on its own EntityManager, detached from the request.
   * A lead runs at most one background analysis at a time: a second start is a 409 that names the running run.
   */
  async startBackgroundRun(auth: AuthAgent, leadId: string, dto: CreateAssistantRunDto): Promise<AssistantRun> {
    const lead = await this.findLead(auth.agencyId, leadId);
    const message = await this.pickMessage(lead, dto.messageId);
    await this.failOverdueRunsOfLead(auth.agencyId, lead.id);

    const runId = await this.em.transactional(async (tx) => {
      // Serialises concurrent starts on one lead, so the check below and the insert cannot interleave.
      await tx.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`assistant-run:${lead.id}`]);
      const running = await tx.findOne(
        AssistantRunEntity,
        { lead: lead.id, agency: auth.agencyId, status: 'running' },
        { orderBy: { createdAt: 'desc', id: 'desc' }, fields: ['id'] },
      );
      if (running) {
        throw new ConflictException({
          statusCode: 409,
          message: 'An analysis is already running for this lead. Follow that run instead of starting another.',
          runId: running.id,
        });
      }
      const inputs = await this.loadInputs(tx, auth, tx.getReference(Lead, lead.id), tx.getReference(Message, message.id));
      const run = this.newRun(tx, inputs);
      await tx.flush();
      return run.id;
    });

    const em = this.em.fork({ clear: true });
    const run = await em.findOneOrFail(AssistantRunEntity, { id: runId }, { populate: ['lead', 'message'] });
    const response = toAssistantRunDto(run, []);

    // Detached from the request: its own EntityManager and context, so nothing depends on the request living on.
    void RequestContext.create(em, async () => {
      try {
        const inputs = await this.loadInputs(em, auth, run.lead, run.message);
        await this.execute(em, run, inputs);
      } catch (error) {
        // Only storing the outcome can land here (the agent's own failures end the run as failed).
        // The row stays 'running' until the on-read expiry or the next boot fails it.
        this.logger.error(`Background run ${runId} could not be stored: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return response;
  }

  /** The agent who asked, and the messages before the analysed one (oldest first). */
  private async loadInputs(em: EntityManager, auth: AuthAgent, lead: Lead, message: Message): Promise<RunInputs> {
    const agent = await em.findOneOrFail(Agent, { id: auth.id, agency: auth.agencyId });
    const loadedLead = await em.findOneOrFail(Lead, { id: lead.id, agency: auth.agencyId });
    const loadedMessage = await em.findOneOrFail(Message, { id: message.id, lead: lead.id });
    const thread = await em.find(
      Message,
      { lead: lead.id, sentAt: { $lte: loadedMessage.sentAt }, id: { $ne: loadedMessage.id } },
      { orderBy: { sentAt: 'desc', id: 'desc' }, limit: THREAD_LIMIT },
    );
    return { auth, agent, lead: loadedLead, message: loadedMessage, thread: thread.reverse() };
  }

  private newRun(em: EntityManager, { auth, agent, lead, message }: RunInputs): AssistantRunEntity {
    return em.create(AssistantRunEntity, {
      agency: em.getReference(Agency, auth.agencyId),
      lead,
      message,
      requestedBy: agent,
      status: 'running',
      requirements: emptyRequirements(),
      recommendations: [],
      trace: [],
      model: this.agent.modelId ?? null,
    });
  }

  /**
   * Runs the agent under the deadline and stores the run as completed or failed. Never throws for an agent
   * failure. Every tool call is written to the row as it happens, so GET shows the calls made so far.
   */
  private async execute(em: EntityManager, run: AssistantRunEntity, inputs: RunInputs): Promise<ProposedActionEntity[]> {
    const { auth, agent, lead, message, thread } = inputs;
    const ids: RunContextIds = { runId: run.id, leadId: lead.id, agencyId: auth.agencyId, model: this.agent.modelId ?? null };
    const startedAt = new Date();
    const started = performance.now();
    this.telemetry.runStarted(ids);

    const recorded: TraceEntry[] = [];
    const timeoutMs = runTimeoutMs();
    const controller = new AbortController();
    // Rejects with the abort reason: the deadline (AgentRunError 'timeout') or a shutdown (RunInterruptedError).
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(new AgentRunError('timeout', 'Deadline reached.', [...recorded])), timeoutMs);

    let traceWrites: Promise<void> = Promise.resolve();
    const persistTrace = (): Promise<void> => {
      const snapshot = [...recorded];
      traceWrites = traceWrites
        .then(() => this.storeTrace(run.id, snapshot))
        .catch((error: unknown) => this.logger.warn(`Could not store the trace of run ${run.id}: ${error instanceof Error ? error.message : String(error)}`));
      return traceWrites;
    };

    let settle!: () => void;
    this.inFlight.set(run.id, { controller, done: new Promise<void>((resolve) => (settle = resolve)) });

    let actions: ProposedActionEntity[] = [];
    try {
      const outcome = await Promise.race([
        this.agent.run({
          runId: run.id,
          agencyId: auth.agencyId,
          agentId: agent.id,
          agentTimezone: agent.timezone,
          lead: { id: lead.id, name: lead.name },
          message: toAgentMessage(message),
          thread: thread.map(toAgentMessage),
          trace: {
            record: (entry) => {
              recorded.push(entry);
              this.telemetry.toolCalled(ids, entry);
              return persistTrace();
            },
          },
          signal: controller.signal,
          deadlineAt,
        }),
        aborted,
      ]);
      await traceWrites;
      const timings = timingsOf(startedAt, started, outcome.timings);
      actions = await this.complete(em, run, outcome, recorded, auth, agent.timezone, message, lead, timings);
      this.telemetry.runFinished(
        { ...ids, model: run.model ?? ids.model },
        { status: 'completed', failureKind: null, latencyMs: timings.latencyMs, steps: outcome.steps ?? null, toolCount: run.trace.length, usage: outcome.usage ?? null },
      );
    } catch (caught) {
      // Once aborted, the abort reason is the cause, whatever the agent threw while unwinding.
      const error: unknown = controller.signal.aborted ? controller.signal.reason : caught;
      this.logger.warn(`Assistant run ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      await traceWrites;
      const runError = error instanceof AgentRunError ? error : caught instanceof AgentRunError ? caught : null;
      run.status = 'failed';
      run.error = describeFailure(error, timeoutMs);
      run.requirements = emptyRequirements();
      run.recommendations = [];
      run.trace = longest(runError?.trace ?? [], recorded);
      run.model = this.agent.modelId ?? null;
      const failureKind: RunFailureKind = error instanceof RunInterruptedError ? 'interrupted' : (runError?.kind ?? 'internal');
      const usage = runError?.usage ?? null;
      const timings = timingsOf(startedAt, started);
      run.diagnostics = {
        droppedRecommendations: [],
        budgetBand: null,
        searchSkipped: false,
        usage: usage ? priceUsage(run.model, usage) : null,
        failureKind,
        timings,
      };
      run.finishedAt = new Date(timings.finishedAt);
      actions = [];
      await em.flush();
      this.telemetry.runFinished(ids, { status: 'failed', failureKind, latencyMs: timings.latencyMs, steps: null, toolCount: run.trace.length, usage });
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(run.id);
      settle();
    }
    return actions;
  }

  /** Writes the trace so far, only while the run is still running (the final write always wins). */
  private async storeTrace(runId: string, trace: TraceEntry[]): Promise<void> {
    await this.em.fork().nativeUpdate(AssistantRunEntity, { id: runId, status: 'running' }, { trace });
  }

  /** Fails every run still executing in this process with RESTART_ERROR, and waits for those writes. */
  async beforeApplicationShutdown(): Promise<void> {
    const runs = [...this.inFlight.values()];
    if (runs.length === 0) return;
    this.logger.warn(`Shutting down: failing ${runs.length} assistant run(s) in progress.`);
    for (const { controller } of runs) controller.abort(new RunInterruptedError());
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(runs.map((r) => r.done)),
      new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_WAIT_MS))),
    ]);
    clearTimeout(timer);
  }

  /**
   * At startup no run of this process exists yet, so every run still 'running' was cut off by a restart or
   * crash and will never finish: fail them all. Assumes one API process per database (see NOTES.md).
   */
  async failInterruptedRuns(): Promise<number> {
    return this.em.fork().nativeUpdate(
      AssistantRunEntity,
      { status: 'running' },
      { status: 'failed', error: RESTART_ERROR, finishedAt: new Date() },
    );
  }

  /**
   * Expire on read, the second guard: every live run fails itself at the deadline, so a lead's run still
   * 'running' after the deadline plus a grace period has no process behind it (e.g. a crash whose boot sweep
   * failed, or a second process sharing the database). Without this the panels would show it running forever.
   */
  private failOverdueRunsOfLead(agencyId: string, leadId: string): Promise<number> {
    return this.failRunningOlderThan(runTimeoutMs() + OVERDUE_GRACE_MS, { agency: agencyId, lead: leadId });
  }

  private failRunningOlderThan(ageMs: number, scope: { agency?: string; lead?: string }): Promise<number> {
    const cutoff = new Date(Date.now() - ageMs);
    return this.em.fork().nativeUpdate(
      AssistantRunEntity,
      { ...scope, status: 'running', createdAt: { $lt: cutoff } },
      { status: 'failed', error: RESTART_ERROR, finishedAt: new Date() },
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const swept = await this.failInterruptedRuns();
      if (swept > 0) this.logger.warn(`Marked ${swept} interrupted assistant run(s) as failed.`);
    } catch (error) {
      this.logger.error(`Could not sweep interrupted assistant runs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The lead's runs, newest first. */
  async listRuns(agencyId: string, leadId: string, limit: number): Promise<AssistantRun[]> {
    const lead = await this.findLead(agencyId, leadId);
    await this.failOverdueRunsOfLead(agencyId, lead.id);
    const runs = await this.em.find(
      AssistantRunEntity,
      { lead, agency: agencyId },
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit, refresh: true },
    );
    if (runs.length === 0) return [];
    const actions = await this.em.find(
      ProposedActionEntity,
      { run: { $in: runs.map((r) => r.id) } },
      { orderBy: { createdAt: 'asc', id: 'asc' }, refresh: true },
    );
    return runs.map((run) => toAssistantRunDto(run, actions.filter((a) => a.run.id === run.id)));
  }

  async getRun(agencyId: string, leadId: string, runId: string): Promise<AssistantRun> {
    let run = await this.findRun(agencyId, leadId, runId);
    if (run.status === 'running' && (await this.failOverdueRunsOfLead(agencyId, run.lead.id)) > 0) {
      run = await this.em.findOneOrFail(AssistantRunEntity, { id: run.id, agency: agencyId }, { refresh: true });
    }
    return toAssistantRunDto(run, await this.actionsOf(run));
  }

  /**
   * Compare-and-set from pending_approval to approved, and the task insert, in one transaction. Postgres
   * row locking makes concurrent approvals wait for the winner and then see it, so only one task is created.
   */
  async approve(auth: AuthAgent, leadId: string, runId: string, actionId: string) {
    const action = await this.findAction(auth.agencyId, leadId, runId, actionId);
    return this.em.transactional(async (tx) => {
      const won = await tx.nativeUpdate(
        ProposedActionEntity,
        { id: action.id, agency: auth.agencyId, status: 'pending_approval' },
        { status: 'approved', decidedBy: auth.id, decidedAt: new Date() },
      );
      if (won === 1) {
        const draft: FollowUpTaskDraft = action.task;
        const task = tx.create(Task, {
          agency: tx.getReference(Agency, auth.agencyId),
          lead: tx.getReference(Lead, action.lead.id),
          title: clamp(draft.title, MAX_TITLE),
          notes: draft.notes === null ? null : clamp(draft.notes, MAX_NOTES),
          dueAt: draft.dueAt ? new Date(draft.dueAt) : null,
          status: 'open',
          createdBy: tx.getReference(Agent, auth.id),
        });
        await tx.flush();
        await tx.nativeUpdate(ProposedActionEntity, { id: action.id }, { createdTask: task.id });
      }

      const current = await tx.findOneOrFail(ProposedActionEntity, { id: action.id }, { refresh: true, populate: ['createdTask'] });
      if (current.status === 'rejected') throw new ConflictException('This action was rejected and cannot be approved.');
      const task = await tx.findOneOrFail(Task, { id: current.createdTask!.id }, { populate: ['createdBy'], refresh: true });
      return { action: toProposedActionDto(current), task: toTaskDto(task) };
    });
  }

  /** Compare-and-set from pending_approval to rejected. Saves nothing else. */
  async reject(auth: AuthAgent, leadId: string, runId: string, actionId: string) {
    const action = await this.findAction(auth.agencyId, leadId, runId, actionId);
    await this.em.nativeUpdate(
      ProposedActionEntity,
      { id: action.id, agency: auth.agencyId, status: 'pending_approval' },
      { status: 'rejected', decidedBy: auth.id, decidedAt: new Date() },
    );
    const current = await this.em.findOneOrFail(ProposedActionEntity, { id: action.id }, { refresh: true });
    if (current.status === 'approved') throw new ConflictException('This action was approved and cannot be rejected.');
    return { action: toProposedActionDto(current) };
  }

  /**
   * Aggregate health of the agency's runs created in the last `sinceHours` hours. Scoped by agency in the
   * query itself, so no other agency's run is ever loaded.
   */
  async metrics(agencyId: string, sinceHours: number): Promise<AssistantMetrics & { window: { sinceHours: number; from: string; to: string } }> {
    const to = new Date();
    const from = new Date(to.getTime() - sinceHours * 3_600_000);
    const runs = await this.em.fork().find(
      AssistantRunEntity,
      { agency: agencyId, createdAt: { $gte: from } },
      { fields: ['status', 'model', 'createdAt', 'finishedAt', 'error', 'diagnostics', 'trace'] },
    );
    const rows = runs.map((r) => ({
      status: r.status,
      model: r.model ?? null,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      error: r.error ?? null,
      diagnostics: r.diagnostics ?? null,
      trace: r.trace ?? [],
    }));
    return { window: { sinceHours, from: from.toISOString(), to: to.toISOString() }, ...computeAssistantMetrics(rows) };
  }

  // ---------------------------------------------------------------------------------------------

  /** Validates the agent's picks against the database and stores the completed run with its action. */
  private async complete(
    em: EntityManager,
    run: AssistantRunEntity,
    outcome: AgentOutcome,
    recorded: TraceEntry[],
    auth: AuthAgent,
    timeZone: string,
    message: Message,
    lead: Lead,
    timings: RunTimings,
  ): Promise<ProposedActionEntity[]> {
    // Re-read every listing from the database, scoped to the agency: nothing the model says about a
    // listing is trusted, and ids of other agencies are simply not found.
    const listings: ListingRecord[] = (await em.find(Property, { agency: auth.agencyId }, { refresh: true })).map(toListingRecord);
    const requirements = outcome.extraction.requirements;
    const validation = validateRecommendations({
      candidates: outcome.candidates,
      requirements,
      agencyId: auth.agencyId,
      listings,
      agencyListings: listings,
      seenPropertyIds: outcome.seenPropertyIds,
    });

    const seen = new Set(outcome.seenPropertyIds);
    const dataWarnings: DataWarning[] = listings
      .filter((l) => seen.has(l.id))
      .map((l) => ({ propertyId: l.id, reference: l.reference, flags: computeListingFlags(l, listings) }))
      .filter((w) => w.flags.length > 0);

    // At most one follow-up per run. The date is always computed here, never taken from the model.
    let draft: { task: FollowUpTaskDraft; needsClarification: string | null } | null = null;
    const followUp =
      outcome.followUp ??
      (outcome.extraction.leadAskedForFollowUp
        ? { title: `Follow up with ${lead.name}`, notes: null, intent: outcome.extraction.followUp }
        : null);
    if (followUp) {
      const due = resolveDueAt(followUp.intent, message.sentAt, timeZone);
      draft = {
        task: {
          title: clamp(followUp.title.trim() || `Follow up with ${lead.name}`, MAX_TITLE),
          notes: followUp.notes === null ? null : clamp(followUp.notes, MAX_NOTES),
          dueAt: due.dueAt,
        },
        needsClarification: due.needsClarification,
      };
    }

    run.status = 'completed';
    run.error = null;
    run.model = outcome.model;
    run.requirements = outcome.requirements;
    run.recommendations = validation.kept;
    run.summary = withDroppedNote(reconcileSummary(outcome.summary, validation.kept, validation.dropped), validation.dropped);
    run.trace = longest(outcome.trace, recorded);
    run.diagnostics = {
      droppedRecommendations: validation.dropped,
      budgetBand: validation.budgetBand,
      searchSkipped: outcome.searchSkipped,
      usage: outcome.usage ? priceUsage(outcome.model, outcome.usage) : null,
      failureKind: null,
      timings,
      selfVerification: outcome.selfVerification ?? null,
    };
    run.dataWarnings = dataWarnings;
    run.finishedAt = new Date(timings.finishedAt);

    const actions: ProposedActionEntity[] = [];
    if (draft) {
      actions.push(
        em.create(ProposedActionEntity, {
          agency: em.getReference(Agency, auth.agencyId),
          run,
          lead,
          type: 'create_follow_up_task',
          status: 'pending_approval',
          task: draft.task,
          needsClarification: draft.needsClarification,
        }),
      );
    }
    await em.flush(); // one transaction: the run and its action together
    return actions;
  }

  /** Any lead outside the agency is a 404, never a 403, so ids do not leak. */
  private async findLead(agencyId: string, leadId: string): Promise<Lead> {
    const lead = await this.em.findOne(Lead, { id: leadId, agency: agencyId });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async pickMessage(lead: Lead, messageId: string | undefined): Promise<Message> {
    if (messageId) {
      const message = await this.em.findOne(Message, { id: messageId, lead });
      if (!message) throw new NotFoundException('Message not found');
      return message;
    }
    const latest = await this.em.findOne(Message, { lead, direction: 'inbound' }, { orderBy: { sentAt: 'desc', id: 'desc' } });
    if (!latest) throw new UnprocessableEntityException('This lead has no inbound message to analyse.');
    return latest;
  }

  private async findRun(agencyId: string, leadId: string, runId: string): Promise<AssistantRunEntity> {
    const lead = await this.findLead(agencyId, leadId);
    const run = await this.em.findOne(AssistantRunEntity, { id: runId, lead, agency: agencyId });
    if (!run) throw new NotFoundException('Assistant run not found');
    return run;
  }

  private async findAction(agencyId: string, leadId: string, runId: string, actionId: string): Promise<ProposedActionEntity> {
    const run = await this.findRun(agencyId, leadId, runId);
    const action = await this.em.findOne(ProposedActionEntity, { id: actionId, run, agency: agencyId });
    if (!action) throw new NotFoundException('Proposed action not found');
    return action;
  }

  private actionsOf(run: AssistantRunEntity): Promise<ProposedActionEntity[]> {
    return this.em.find(ProposedActionEntity, { run }, { orderBy: { createdAt: 'asc', id: 'asc' }, refresh: true });
  }
}

const DROP_LABELS: Record<DropReason, string> = {
  not_seen_in_run: 'not returned by a search in this run',
  not_found: 'not found',
  other_agency: 'not found',
  not_available: 'not available',
  rent_intent: 'the lead wants to rent',
  no_criteria: 'no criteria to match',
  not_requested: 'not the listing the lead asked about',
  area_mismatch: 'wrong area',
  bedrooms_mismatch: 'wrong bedrooms',
  type_mismatch: 'wrong property type',
  over_budget: 'over budget',
  under_budget: 'under budget',
  price_suspect: 'suspect price',
  duplicate: 'duplicate listing',
  repeated: 'repeated',
  over_cap: 'over the limit of recommendations',
};

/**
 * The model writes its summary before the server checks its picks. When the checks removed any, say so,
 * so the summary never presents a removed listing as a recommendation.
 */
export function withDroppedNote(summary: string, dropped: readonly DroppedRecommendation[]): string {
  if (dropped.length === 0) return summary;
  const items = dropped.map((d) => `${d.reference ?? 'an unknown listing'} (${DROP_LABELS[d.reason]})`);
  const note = `Server checks removed ${dropped.length} suggested listing${dropped.length === 1 ? '' : 's'}: ${items.join(', ')}.`;
  return [summary.trim(), note].filter(Boolean).join(' ');
}

/** Wall-clock timings of a run; phase timings come from the agent when it reports them. */
function timingsOf(startedAt: Date, started: number, phases?: { extractionMs: number; analysisMs: number }): RunTimings {
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(startedAt.getTime() + latencyMs).toISOString(),
    latencyMs,
    phaseAMs: phases?.extractionMs ?? null,
    phaseBMs: phases?.analysisMs ?? null,
  };
}

/** The fuller of two traces of the same run (the agent's own list, or what the sink received). */
function longest(a: readonly TraceEntry[], b: readonly TraceEntry[]): TraceEntry[] {
  return [...(a.length >= b.length ? a : b)];
}
