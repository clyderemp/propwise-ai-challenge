import { Entity, Enum, Index, ManyToOne, OneToOne, PrimaryKey, Property, OptionalProps } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import {
  FollowUpTaskDraft,
  PROPOSED_ACTION_STATUSES,
  PROPOSED_ACTION_TYPES,
  ProposedActionStatus,
  ProposedActionType,
} from '../assistant/assistant.types';
import { Agency } from './agency.entity';
import { Agent } from './agent.entity';
import { AssistantRun } from './assistant-run.entity';
import { Lead } from './lead.entity';
import { Task } from './task.entity';

/**
 * Something the assistant suggests doing. Nothing happens until an agent approves it; approving creates
 * exactly one Task (createdTask is unique), rejecting creates nothing.
 */
@Entity({ tableName: 'proposed_actions' })
@Index({ properties: ['run', 'createdAt'] })
export class ProposedAction {
  [OptionalProps]?: 'status' | 'needsClarification' | 'createdTask' | 'decidedBy' | 'decidedAt' | 'createdAt';

  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne({ entity: () => Agency })
  agency!: Agency;

  @ManyToOne({ entity: () => AssistantRun })
  run!: AssistantRun;

  @ManyToOne({ entity: () => Lead })
  lead!: Lead;

  @Enum({ items: [...PROPOSED_ACTION_TYPES] })
  type!: ProposedActionType;

  @Enum({ items: [...PROPOSED_ACTION_STATUSES] })
  status: ProposedActionStatus = 'pending_approval';

  /** The task to create on approval. dueAt keeps the offset, e.g. "2026-10-16T10:00:00+04:00". */
  @Property({ type: 'json' })
  task!: FollowUpTaskDraft;

  @Property({ type: 'text', nullable: true })
  needsClarification?: string | null = null;

  /** Set once, by the approval that won. Unique, so one action can never create two tasks. */
  @OneToOne({ entity: () => Task, owner: true, nullable: true, unique: true })
  createdTask?: Task | null = null;

  @ManyToOne({ entity: () => Agent, nullable: true })
  decidedBy?: Agent | null = null;

  @Property({ type: 'datetime', columnType: 'timestamptz', nullable: true })
  decidedAt?: Date | null = null;

  @Property({ type: 'datetime', columnType: 'timestamptz' })
  createdAt: Date = new Date();
}
