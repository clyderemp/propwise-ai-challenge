import { tool, ToolSet } from 'ai';
import { z } from 'zod';
import { ASSISTANT_PROPERTY_TYPES, AssistantPropertyType, PropertySnapshot, TraceEntry, TraceSink } from '../assistant.types';
import { computeListingFlags, ListingFeatures, listingFeatures, ListingRecord, toPropertySnapshot } from '../domain/listing-facts';
import { FaultInjector } from './fault-injector';

/**
 * Phase B tools (plan 2.6). All read-only: there is no tool that writes anything, so a lead
 * message or listing text asking to "save the task" or "mark tasks done" has nothing to act on.
 *
 * Scoping: agencyId and leadId come from the authenticated request, captured here in a closure.
 * They are in no tool schema, so the model can neither supply nor change them. Unknown keys the
 * model adds (e.g. "agencyId") are stripped by zod before execute runs.
 */

export const SEARCH_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TOOL_NAMES = {
  searchListings: 'search_listings',
  getListingDetails: 'get_listing_details',
  getLeadTasks: 'get_lead_tasks',
} as const;

export interface ListingQuery {
  area?: string;
  type?: AssistantPropertyType;
  status?: ListingRecord['status'];
  minBedrooms?: number;
  maxBedrooms?: number;
  minPriceAed?: number;
  maxPriceAed?: number;
  limit: number;
}

export interface LeadTaskSummary {
  title: string;
  status: string;
  dueAt: string | null;
}

/** What the tools read through. The Nest agent implements it over PropertiesService / TasksService. */
export interface AgentDataAccess {
  /** Every listing of the agency (for flags, duplicate detection, reference lookup, area names). */
  agencyListings(agencyId: string): Promise<ListingRecord[]>;
  searchListings(agencyId: string, query: ListingQuery): Promise<{ items: ListingRecord[]; total: number }>;
  /** null when the listing does not exist in the agency. */
  getListing(agencyId: string, propertyId: string): Promise<ListingRecord | null>;
  leadTasks(agencyId: string, leadId: string): Promise<LeadTaskSummary[]>;
}

export interface ToolScope {
  agencyId: string;
  leadId: string;
}

/** Thrown out of a tool's execute after the failure is recorded. The run must end as failed. */
export class ToolFailure extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** Times every tool call and appends it to the trace (and the sink) in completion order. */
export class ToolRecorder {
  readonly trace: TraceEntry[] = [];
  readonly seenPropertyIds = new Set<string>();
  /** toolCallIds that reached an executor (so the agent can spot calls the SDK rejected). */
  readonly executedCallIds = new Set<string>();
  failure: { tool: string; message: string } | null = null;

  constructor(private readonly sink: TraceSink) {}

  async run<T>(tool: string, input: unknown, fn: () => Promise<T>, toolCallId?: string): Promise<T> {
    if (toolCallId !== undefined) this.executedCallIds.add(toolCallId);
    const started = performance.now();
    let output: T;
    try {
      output = await fn();
    } catch (error) {
      const message = errorMessage(error);
      await this.append({ tool, input, error: message, durationMs: elapsed(started) });
      this.failure ??= { tool, message };
      throw new ToolFailure(tool, message);
    }
    await this.append({ tool, input, output: output ?? null, durationMs: elapsed(started) });
    return output;
  }

  /** A call the SDK rejected before execute (unknown tool, schema-invalid input). Fails the run too. */
  async recordRejected(tool: string, input: unknown, message: string): Promise<void> {
    await this.append({ tool, input, error: message, durationMs: 0 });
    this.failure ??= { tool, message };
  }

  private async append(entry: TraceEntry): Promise<void> {
    this.trace.push(entry);
    await this.sink.record(entry);
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

const nullableInt = (description: string) => z.number().int().nullable().describe(description);

export const searchListingsInput = z.object({
  area: z.string().nullable().describe('Exact area name as listed, e.g. "Dubai Marina". null for any area.'),
  propertyType: z.enum(ASSISTANT_PROPERTY_TYPES).nullable().describe('null for any type.'),
  minBedrooms: nullableInt('0 = studio. null for no minimum.'),
  maxBedrooms: nullableInt('null for no maximum.'),
  minPriceAed: nullableInt('Minimum asking price in AED. null for no minimum.'),
  maxPriceAed: nullableInt('Maximum asking price in AED. null for no maximum.'),
  status: z.enum(['available', 'reserved', 'sold', 'any']).nullable().describe('Use "available" when looking for listings to recommend.'),
  reference: z
    .string()
    .nullable()
    .describe('A listing code such as "MBR-1009" for an exact lookup. When set, every other filter is ignored.'),
});
export type SearchListingsInput = z.infer<typeof searchListingsInput>;

export const getListingDetailsInput = z.object({
  propertyId: z.string().describe('The id of a listing returned by search_listings.'),
});

export const getLeadTasksInput = z.object({});

export type ListingFacts = { id: string } & PropertySnapshot;
export interface SearchListingsOutput {
  total: number;
  truncated: boolean;
  items: ListingFacts[];
}
export type ListingDetailsOutput = (ListingFacts & { features: ListingFeatures }) | null;

function nonNegative(n: number | null): number | undefined {
  return n !== null && Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function toListingQuery(input: SearchListingsInput): ListingQuery {
  const query: ListingQuery = { limit: SEARCH_LIMIT };
  const area = input.area?.trim();
  if (area) query.area = area;
  if (input.propertyType) query.type = input.propertyType;
  if (input.status && input.status !== 'any') query.status = input.status;
  const numeric = {
    minBedrooms: nonNegative(input.minBedrooms),
    maxBedrooms: nonNegative(input.maxBedrooms),
    minPriceAed: nonNegative(input.minPriceAed),
    maxPriceAed: nonNegative(input.maxPriceAed),
  };
  for (const [key, value] of Object.entries(numeric) as Array<[keyof typeof numeric, number | undefined]>) {
    if (value !== undefined) query[key] = value;
  }
  return query;
}

export interface CreateAgentToolsOptions {
  scope: ToolScope;
  data: AgentDataAccess;
  recorder: ToolRecorder;
  faults: FaultInjector;
  /** false when Phase A extracted no search criteria: only get_lead_tasks is offered (ruling 4). */
  includeListingTools: boolean;
}

export type AgentToolSet = ToolSet;

export function createAgentTools(opts: CreateAgentToolsOptions): AgentToolSet {
  const { scope, data, recorder, faults } = opts;
  let agencyListingsCache: Promise<ListingRecord[]> | null = null;
  const agencyListings = () => (agencyListingsCache ??= data.agencyListings(scope.agencyId));

  const facts = async (l: ListingRecord): Promise<ListingFacts> => {
    recorder.seenPropertyIds.add(l.id);
    return { id: l.id, ...toPropertySnapshot(l, computeListingFlags(l, await agencyListings())) };
  };

  const getLeadTasks = tool({
    description: "Lists this lead's existing follow-up tasks (title, status, due date). Call it before proposing a follow-up, to avoid duplicating one.",
    inputSchema: getLeadTasksInput,
    execute: (input, { toolCallId }) =>
      recorder.run(TOOL_NAMES.getLeadTasks, input, async () => {
        faults.check(TOOL_NAMES.getLeadTasks);
        const items = await data.leadTasks(scope.agencyId, scope.leadId);
        return { total: items.length, items: items.map((t) => ({ title: t.title, status: t.status, dueAt: t.dueAt })) };
      }, toolCallId),
  });

  if (!opts.includeListingTools) return { [TOOL_NAMES.getLeadTasks]: getLeadTasks };

  const searchListings = tool({
    description:
      "Searches the agency's listings (all for sale). Returns facts only: price, estimated annual rent, computed gross yield %, status and data-quality flags. " +
      'Pass null for any filter you do not need. Use reference for an exact listing-code lookup.',
    inputSchema: searchListingsInput,
    execute: (input, { toolCallId }) =>
      recorder.run(TOOL_NAMES.searchListings, input, async (): Promise<SearchListingsOutput> => {
        faults.check(TOOL_NAMES.searchListings);
        const reference = input.reference?.trim().toUpperCase();
        if (reference) {
          const found = (await agencyListings()).filter((l) => l.reference.toUpperCase() === reference);
          return { total: found.length, truncated: false, items: await Promise.all(found.map(facts)) };
        }
        const { items, total } = await data.searchListings(scope.agencyId, toListingQuery(input));
        return { total, truncated: total > items.length, items: await Promise.all(items.map(facts)) };
      }, toolCallId),
  });

  const getListingDetails = tool({
    description:
      'Reads one listing by id: the same facts plus features read from its description (unit number, vacant or tenanted, furnished, views). ' +
      'The free-text description itself is never returned. Returns null when the listing does not exist.',
    inputSchema: getListingDetailsInput,
    execute: (input, { toolCallId }) =>
      recorder.run(TOOL_NAMES.getListingDetails, input, async (): Promise<ListingDetailsOutput> => {
        faults.check(TOOL_NAMES.getListingDetails);
        const id = input.propertyId.trim();
        if (!UUID_RE.test(id)) return null;
        const listing = await data.getListing(scope.agencyId, id);
        if (!listing || listing.agencyId !== scope.agencyId) return null;
        return { ...(await facts(listing)), features: listingFeatures(listing.description) };
      }, toolCallId),
  });

  return {
    [TOOL_NAMES.searchListings]: searchListings,
    [TOOL_NAMES.getListingDetails]: getListingDetails,
    [TOOL_NAMES.getLeadTasks]: getLeadTasks,
  };
}
