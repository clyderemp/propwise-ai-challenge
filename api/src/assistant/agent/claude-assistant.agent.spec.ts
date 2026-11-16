import { EntityManager } from '@mikro-orm/postgresql';
import { NotFoundException } from '@nestjs/common';
import { AgentRunContext } from '../assistant.types';
import { byRef, DESERT_KEY_ID, loadSeedListings, MARINA_BAY_ID } from '../domain/seed-listings.fixture';
import { ListingRecord } from '../domain/listing-facts';
import { PropertiesService } from '../../properties/properties.service';
import { TasksService } from '../../tasks/tasks.service';
import { ClaudeAssistantAgent } from './claude-assistant.agent';
import { FaultInjector } from './fault-injector';
import { AnthropicLlmGateway } from './llm.gateway';
import { ScriptedModel, scriptedGateway } from './testing/scripted-model';

const LEAD_ID = '310661c8-6de3-5b3f-80c8-ca4ef71e55b1';
const listings = loadSeedListings();

function asEntity(l: ListingRecord) {
  const { agencyId, ...rest } = l;
  return { ...rest, agency: { id: agencyId } };
}

function asDto(l: ListingRecord) {
  const { agencyId: _a, ...rest } = l;
  void _a;
  return { ...rest, bathrooms: 2, serviceChargeAedPerSqft: null, listedAt: l.listedAt.toISOString() };
}

function build(model: ScriptedModel) {
  const em = { find: jest.fn(async (_entity: unknown, where: { agency: string }) => listings.filter((l) => l.agencyId === where.agency).map(asEntity)) };
  const properties = {
    search: jest.fn(async (agencyId: string) => {
      const items = listings.filter((l) => l.agencyId === agencyId && l.area === 'Dubai Marina' && l.bedrooms === 2).map(asDto);
      return { items, total: items.length };
    }),
    get: jest.fn(async (agencyId: string, id: string) => {
      const found = listings.find((l) => l.agencyId === agencyId && l.id === id);
      if (!found) throw new NotFoundException('Property not found');
      return asDto(found);
    }),
  };
  const tasks = {
    listForLead: jest.fn(async () => ({
      items: [{ id: 't1', leadId: LEAD_ID, title: 'Chase Karim', notes: 'secret notes', dueAt: null, status: 'open', createdBy: { id: 'a', name: 'Sara' }, createdAt: '2026-10-01T00:00:00.000Z' }],
      total: 1,
    })),
  };
  const agent = new ClaudeAssistantAgent(
    em as unknown as EntityManager,
    properties as unknown as PropertiesService,
    tasks as unknown as TasksService,
    scriptedGateway(model),
    new FaultInjector({}),
  );
  return { em, properties, tasks, agent };
}

function ctx(): AgentRunContext {
  return {
    runId: 'run-1',
    agencyId: MARINA_BAY_ID,
    agentId: 'agent-sara',
    agentTimezone: 'Asia/Dubai',
    lead: { id: LEAD_ID, name: 'Karim' },
    message: { id: 'm1', direction: 'inbound', channel: 'whatsapp', body: '2BR in Dubai Marina around 2M', sentAt: new Date('2026-10-15T08:30:00Z') },
    thread: [],
    trace: { record: () => undefined },
  };
}

const EXTRACTION = {
  requirements: {
    locations: ['Dubai Marina'],
    bedroomsMin: 2,
    bedroomsMax: 2,
    budgetMinAed: null,
    budgetMaxAed: 2_000_000,
    budgetIsApproximate: true,
    propertyType: 'apartment',
    intent: 'buy',
    preferences: [],
    prioritiseYield: false,
    listingReferences: [],
  },
  followUp: { kind: 'none', days: null, weekday: null, month: null, day: null, year: null, time: null, quote: null, unclearReason: null },
  timeline: { kind: 'none', days: null, month: null, day: null, year: null, quote: null },
  leadAskedForFollowUp: false,
};

describe('ClaudeAssistantAgent (Nest adapter)', () => {
  it("reads only the authenticated agency's data through the real services", async () => {
    const dkp = byRef(listings, 'DKP-2001');
    const mbr = byRef(listings, 'MBR-1002');
    const model = new ScriptedModel([
      { json: EXTRACTION },
      {
        toolCalls: [
          { name: 'search_listings', input: { area: 'Dubai Marina', propertyType: null, minBedrooms: 2, maxBedrooms: 2, minPriceAed: null, maxPriceAed: null, status: 'available', reference: null } },
          { name: 'get_listing_details', input: { propertyId: dkp.id } },
          { name: 'get_listing_details', input: { propertyId: mbr.id } },
          { name: 'get_lead_tasks', input: {} },
        ],
      },
      { json: { recommendations: [{ propertyId: mbr.id, reason: 'fits' }], summary: 'ok', followUpTask: null } },
    ]);
    const { em, properties, tasks, agent } = build(model);

    const outcome = await agent.run(ctx());

    expect(em.find.mock.calls.every((c) => (c[1] as { agency: string }).agency === MARINA_BAY_ID)).toBe(true);
    expect(properties.search).toHaveBeenCalledWith(MARINA_BAY_ID, { area: 'Dubai Marina', status: 'available', minBedrooms: 2, maxBedrooms: 2, limit: 50 });
    expect(properties.get.mock.calls.map((c) => c[0])).toEqual([MARINA_BAY_ID, MARINA_BAY_ID]);
    expect(tasks.listForLead).toHaveBeenCalledWith(MARINA_BAY_ID, LEAD_ID);

    const byTool = (name: string) => outcome.trace.filter((e) => e.tool === name);
    const search = byTool('search_listings')[0].output as { items: Array<{ reference: string }> };
    expect(search.items.every((i) => i.reference.startsWith('MBR-'))).toBe(true);
    const details = byTool('get_listing_details').map((e) => e.output as { reference: string } | null);
    expect(details.map((d) => d?.reference ?? null).sort()).toEqual(['MBR-1002', null].sort());
    // Task notes are not exposed to the model.
    expect(byTool('get_lead_tasks')[0].output).toEqual({ total: 1, items: [{ title: 'Chase Karim', status: 'open', dueAt: null }] });
    expect(outcome.trace.every((e) => e.error === undefined)).toBe(true);
    expect(outcome.candidates.map((c) => c.propertyId)).toEqual([mbr.id]);
    expect(outcome.seenPropertyIds).not.toContain(dkp.id);
  });

  it('turns an unexpected service error into a failed tool call', async () => {
    const model = new ScriptedModel([
      { json: EXTRACTION },
      { toolCalls: [{ name: 'get_listing_details', input: { propertyId: byRef(listings, 'MBR-1002').id } }] },
      { json: { recommendations: [], summary: 'x', followUpTask: null } },
    ]);
    const { properties, agent } = build(model);
    properties.get.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(agent.run(ctx())).rejects.toMatchObject({ kind: 'tool', message: 'Tool get_listing_details failed: pool exhausted' });
  });

  it('defaults to the Anthropic gateway and an inert fault injector', () => {
    const agent = new ClaudeAssistantAgent({} as EntityManager, {} as PropertiesService, {} as TasksService);
    expect(agent.gateway).toBeInstanceOf(AnthropicLlmGateway);
    expect(agent.faults.enabled).toBe(process.env.NODE_ENV === 'test' || process.env.ASSISTANT_FAULTS_ENABLED === '1');
    expect(DESERT_KEY_ID).not.toBe(MARINA_BAY_ID);
  });
});
