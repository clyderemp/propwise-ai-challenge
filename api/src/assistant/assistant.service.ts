import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
import { CreateAssistantRunDto, toAssistantRunDto, toProposedActionDto } from './assistant.dto';
import {
  AgentMessage,
  AgentOutcome,
  AgentPort,
  AgentRunError,
  ASSISTANT_AGENT,
  AssistantRun,
  DataWarning,
  FollowUpTaskDraft,
  TraceEntry,
} from './assistant.types';
import { resolveDueAt } from './domain/follow-up-date';
import { computeListingFlags, ListingRecord, toListingRecord } from './domain/listing-facts';
import { validateRecommendations } from './domain/matching';
import { emptyRequirements } from './domain/requirements';

/** Newest messages before the analysed one that the agent sees as context. */
const THREAD_LIMIT = 20;
/** TASK.md: a run answers within 2 minutes. Override with ASSISTANT_RUN_TIMEOUT_MS. */
const DEFAULT_RUN_TIMEOUT_MS = 110_000;
const MAX_TITLE = 200; // CreateTaskDto limits
const MAX_NOTES = 5000;
const MAX_ERROR = 500;

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
  if (error instanceof AgentRunError) {
    if (error.kind === 'timeout') return `The assistant timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
    return clamp(error.message, MAX_ERROR);
  }
  if (error instanceof RangeError) return clamp(`Could not compute the follow-up date: ${error.message}`, MAX_ERROR);
  const message = error instanceof Error ? error.message : String(error);
  return clamp(`The assistant failed: ${message}`, MAX_ERROR);
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(ASSISTANT_AGENT) private readonly agent: AgentPort,
  ) {}

  /** Runs the assistant on one message. Model and tool failures give a failed run (201), never an exception. */
  async createRun(auth: AuthAgent, leadId: string, dto: CreateAssistantRunDto): Promise<AssistantRun> {
    const lead = await this.findLead(auth.agencyId, leadId);
    const message = await this.pickMessage(lead, dto.messageId);
    const agent = await this.em.findOneOrFail(Agent, { id: auth.id, agency: auth.agencyId });
    const thread = await this.em.find(
      Message,
      { lead, sentAt: { $lte: message.sentAt }, id: { $ne: message.id } },
      { orderBy: { sentAt: 'desc', id: 'desc' }, limit: THREAD_LIMIT },
    );

    const run = this.em.create(AssistantRunEntity, {
      agency: this.em.getReference(Agency, auth.agencyId),
      lead,
      message,
      requestedBy: agent,
      status: 'running',
      requirements: emptyRequirements(),
      recommendations: [],
      trace: [],
    });
    await this.em.flush();

    const recorded: TraceEntry[] = [];
    const timeoutMs = runTimeoutMs();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentRunError('timeout', 'Deadline reached.', [...recorded]));
      }, timeoutMs);
    });

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
          thread: thread.reverse().map(toAgentMessage),
          trace: { record: (entry) => void recorded.push(entry) },
          signal: controller.signal,
        }),
        deadline,
      ]);
      actions = await this.complete(run, outcome, recorded, auth, agent.timezone, message, lead);
    } catch (error) {
      this.logger.warn(`Assistant run ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      const agentTrace = error instanceof AgentRunError ? error.trace : [];
      run.status = 'failed';
      run.error = describeFailure(error, timeoutMs);
      run.requirements = emptyRequirements();
      run.recommendations = [];
      run.trace = longest(agentTrace, recorded);
      run.finishedAt = new Date();
      actions = [];
      await this.em.flush();
    } finally {
      clearTimeout(timer);
    }
    return toAssistantRunDto(run, actions);
  }

  async getRun(agencyId: string, leadId: string, runId: string): Promise<AssistantRun> {
    const run = await this.findRun(agencyId, leadId, runId);
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

  // ---------------------------------------------------------------------------------------------

  /** Validates the agent's picks against the database and stores the completed run with its action. */
  private async complete(
    run: AssistantRunEntity,
    outcome: AgentOutcome,
    recorded: TraceEntry[],
    auth: AuthAgent,
    timeZone: string,
    message: Message,
    lead: Lead,
  ): Promise<ProposedActionEntity[]> {
    // Re-read every listing from the database, scoped to the agency: nothing the model says about a
    // listing is trusted, and ids of other agencies are simply not found.
    const listings: ListingRecord[] = (await this.em.find(Property, { agency: auth.agencyId }, { refresh: true })).map(toListingRecord);
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
    run.summary = outcome.summary;
    run.trace = longest(outcome.trace, recorded);
    run.diagnostics = {
      droppedRecommendations: validation.dropped,
      budgetBand: validation.budgetBand,
      searchSkipped: outcome.searchSkipped,
    };
    run.dataWarnings = dataWarnings;
    run.finishedAt = new Date();

    const actions: ProposedActionEntity[] = [];
    if (draft) {
      actions.push(
        this.em.create(ProposedActionEntity, {
          agency: this.em.getReference(Agency, auth.agencyId),
          run,
          lead,
          type: 'create_follow_up_task',
          status: 'pending_approval',
          task: draft.task,
          needsClarification: draft.needsClarification,
        }),
      );
    }
    await this.em.flush(); // one transaction: the run and its action together
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

/** The fuller of two traces of the same run (the agent's own list, or what the sink received). */
function longest(a: readonly TraceEntry[], b: readonly TraceEntry[]): TraceEntry[] {
  return [...(a.length >= b.length ? a : b)];
}
