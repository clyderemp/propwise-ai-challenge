import { IsOptional, IsUUID } from 'class-validator';
import { AssistantRun as AssistantRunEntity, ProposedAction as ProposedActionEntity } from '../entities';
import { AssistantRun, ProposedAction } from './assistant.types';
import { emptyRequirements } from './domain/requirements';

export class CreateAssistantRunDto {
  /** One of the lead's messages. Default: the lead's latest inbound message. */
  @IsOptional()
  @IsUUID('all')
  messageId?: string;
}

/** The contract's ProposedAction, plus `taskId` (extra) once approved. */
export function toProposedActionDto(action: ProposedActionEntity): ProposedAction & { taskId: string | null } {
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    task: { title: action.task.title, notes: action.task.notes ?? null, dueAt: action.task.dueAt ?? null },
    needsClarification: action.needsClarification ?? null,
    taskId: action.createdTask?.id ?? null,
  };
}

/**
 * The contract's AssistantRun. A failed run always has the exact empty shape from TASK.md, whatever was
 * stored, so the failed shape cannot drift. The trace is kept for failed runs.
 */
export function toAssistantRunDto(run: AssistantRunEntity, actions: readonly ProposedActionEntity[]): AssistantRun {
  const failed = run.status === 'failed';
  return {
    id: run.id,
    leadId: run.lead.id,
    messageId: run.message.id,
    status: run.status,
    ...(failed ? { error: run.error ?? 'The assistant run failed.' } : {}),
    requirements: failed ? emptyRequirements() : run.requirements,
    recommendations: failed ? [] : run.recommendations,
    summary: run.summary,
    proposedActions: failed ? [] : actions.map(toProposedActionDto),
    trace: run.trace,
    createdAt: run.createdAt.toISOString(),
    model: run.model ?? null,
    diagnostics: run.diagnostics ?? undefined,
    dataWarnings: run.dataWarnings ?? [],
  };
}
