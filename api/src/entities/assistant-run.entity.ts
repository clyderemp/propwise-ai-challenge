import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, OptionalProps } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_RUN_STATUSES,
  AssistantRequirements,
  AssistantRunStatus,
  DataWarning,
  Recommendation,
  RunDiagnostics,
  TraceEntry,
} from '../assistant/assistant.types';
import { Agency } from './agency.entity';
import { Agent } from './agent.entity';
import { Lead } from './lead.entity';
import { Message } from './message.entity';

/**
 * One analysis of one lead message by the AI assistant. Never changes the lead, the message or any listing;
 * the only thing it can lead to is a ProposedAction, which needs an agent's approval.
 */
@Entity({ tableName: 'assistant_runs' })
@Index({ properties: ['lead', 'createdAt'] })
export class AssistantRun {
  [OptionalProps]?: 'status' | 'error' | 'summary' | 'diagnostics' | 'dataWarnings' | 'model' | 'createdAt' | 'finishedAt';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne({ entity: () => Agency })
  agency!: Agency;

  @ManyToOne({ entity: () => Lead })
  lead!: Lead;

  /** The message that was analysed. */
  @ManyToOne({ entity: () => Message })
  message!: Message;

  /** The logged-in agent who started the run. Their timezone decides due dates. */
  @ManyToOne({ entity: () => Agent })
  requestedBy!: Agent;

  @Enum({ items: [...ASSISTANT_RUN_STATUSES] })
  status: AssistantRunStatus = 'running';

  @Property({ type: 'text', nullable: true })
  error?: string | null = null;

  @Property({ type: 'json' })
  requirements!: AssistantRequirements;

  @Property({ type: 'json' })
  recommendations!: Recommendation[];

  @Property({ type: 'text' })
  summary: string = '';

  /** Every tool call, in order. Kept for failed runs too. */
  @Property({ type: 'json' })
  trace!: TraceEntry[];

  @Property({ type: 'json', nullable: true })
  diagnostics?: RunDiagnostics | null = null;

  @Property({ type: 'json', nullable: true })
  dataWarnings?: DataWarning[] | null = null;

  /** The model that produced the run, e.g. "claude-sonnet-5-5". */
  @Property({ type: 'string', nullable: true })
  model?: string | null = null;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  finishedAt?: Date | null = null;
}
