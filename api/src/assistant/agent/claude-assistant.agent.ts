import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Property } from '../../entities';
import { PropertiesService } from '../../properties/properties.service';
import { TasksService } from '../../tasks/tasks.service';
import { AgentPort, AgentRunContext } from '../assistant.types';
import { ListingRecord, toListingRecord } from '../domain/listing-facts';
import { ASSISTANT_FAULT_INJECTOR, FaultInjector } from './fault-injector';
import { AnthropicLlmGateway, ASSISTANT_LLM_GATEWAY, LlmGateway } from './llm.gateway';
import { ClaudeAgentOutcome, runAssistantAgent } from './run-agent';
import { AgentDataAccess, LeadTaskSummary, ListingQuery } from './tools';

type PropertyDto = Awaited<ReturnType<PropertiesService['get']>>;

function dtoToRecord(agencyId: string, p: PropertyDto): ListingRecord {
  return {
    id: p.id,
    agencyId,
    reference: p.reference,
    title: p.title,
    area: p.area,
    building: p.building,
    type: p.type,
    bedrooms: p.bedrooms,
    sizeSqft: p.sizeSqft,
    priceAed: p.priceAed,
    annualRentAed: p.annualRentAed,
    status: p.status,
    description: p.description,
    listedAt: new Date(p.listedAt),
  };
}

/**
 * The real AgentPort: the two-phase Claude agent (run-agent.ts) over the existing services.
 * Every read is scoped by the agencyId (and leadId) of the authenticated request, passed in the
 * run context; the model never supplies them.
 */
@Injectable()
export class ClaudeAssistantAgent implements AgentPort {
  readonly gateway: LlmGateway;
  readonly faults: FaultInjector;
  private readonly data: AgentDataAccess;

  constructor(
    private readonly em: EntityManager,
    private readonly properties: PropertiesService,
    private readonly tasks: TasksService,
    @Optional() @Inject(ASSISTANT_LLM_GATEWAY) gateway?: LlmGateway,
    @Optional() @Inject(ASSISTANT_FAULT_INJECTOR) faults?: FaultInjector,
  ) {
    this.gateway = gateway ?? new AnthropicLlmGateway();
    this.faults = faults ?? new FaultInjector();
    this.data = {
      agencyListings: (agencyId) => this.agencyListings(agencyId),
      searchListings: (agencyId, query) => this.searchListings(agencyId, query),
      getListing: (agencyId, propertyId) => this.getListing(agencyId, propertyId),
      leadTasks: (agencyId, leadId) => this.leadTasks(agencyId, leadId),
    };
  }

  get modelId(): string {
    return this.gateway.modelId;
  }

  run(ctx: AgentRunContext): Promise<ClaudeAgentOutcome> {
    return runAssistantAgent(ctx, { data: this.data, gateway: this.gateway, faults: this.faults });
  }

  private async agencyListings(agencyId: string): Promise<ListingRecord[]> {
    const rows = await this.em.find(Property, { agency: agencyId }, { orderBy: { reference: 'asc' } });
    return rows.map(toListingRecord);
  }

  private async searchListings(agencyId: string, query: ListingQuery): Promise<{ items: ListingRecord[]; total: number }> {
    // Never passes `q`: the service's free-text filter ORs against the agency condition (plan 1.7).
    const { items, total } = await this.properties.search(agencyId, { ...query });
    return { items: items.map((p) => dtoToRecord(agencyId, p)), total };
  }

  private async getListing(agencyId: string, propertyId: string): Promise<ListingRecord | null> {
    try {
      return dtoToRecord(agencyId, await this.properties.get(agencyId, propertyId));
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async leadTasks(agencyId: string, leadId: string): Promise<LeadTaskSummary[]> {
    const { items } = await this.tasks.listForLead(agencyId, leadId);
    return items.map((t) => ({ title: t.title, status: t.status, dueAt: t.dueAt }));
  }
}
