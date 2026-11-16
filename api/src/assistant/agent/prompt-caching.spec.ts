/**
 * Prompt caching, checked on the bytes the Anthropic provider actually sends: a capturing fetch sits
 * under the real @ai-sdk/anthropic provider and the real two-phase loop, and replays canned responses.
 */
import { AgentMessage, AgentRunContext } from '../assistant.types';
import { stableId } from '../../db/stable-id';
import { DESERT_KEY_ID, MARINA_BAY_ID } from '../domain/seed-listings.fixture';
import { FaultInjector } from './fault-injector';
import { AnthropicLlmGateway } from './llm.gateway';
import { runAssistantAgent } from './run-agent';
import { FakeDataAccess } from './testing/fake-data-access';

type Body = Record<string, unknown> & { system?: unknown; tools?: unknown; messages: unknown[] };

interface CannedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

const USAGE: CannedUsage = { input_tokens: 50, output_tokens: 40, cache_creation_input_tokens: 700, cache_read_input_tokens: 1200 };

function message(content: unknown[], stopReason: string) {
  return { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stopReason, stop_sequence: null, usage: USAGE };
}

function extraction(location: string, bedrooms: number, name: string) {
  return {
    requirements: {
      locations: [location],
      bedroomsMin: bedrooms,
      bedroomsMax: bedrooms,
      budgetMinAed: null,
      budgetMaxAed: 2_000_000,
      budgetIsApproximate: false,
      propertyType: 'apartment',
      intent: 'buy',
      preferences: [],
      prioritiseYield: false,
      listingReferences: [],
    },
    followUp: { kind: 'none', days: null, weekday: null, month: null, day: null, year: null, time: null, quote: null, unclearReason: null },
    leadAskedForFollowUp: false,
    _name: name,
  };
}

function captureRun(input: { agencyId: string; leadName: string; body: string; location: string; bedrooms: number; finals?: unknown[] }) {
  const bodies: Body[] = [];
  const { _name, ...phaseA } = extraction(input.location, input.bedrooms, input.leadName);
  void _name;
  const responses = [
    message([{ type: 'text', text: JSON.stringify(phaseA) }], 'end_turn'),
    message(
      [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'search_listings',
          input: { area: input.location, propertyType: 'apartment', minBedrooms: input.bedrooms, maxBedrooms: input.bedrooms, minPriceAed: null, maxPriceAed: 2_000_000, status: 'available', reference: null },
        },
      ],
      'tool_use',
    ),
    ...(input.finals ?? [{ recommendations: [], summary: 'Nothing fits.', followUpTask: null }]).map((answer) =>
      message([{ type: 'text', text: JSON.stringify(answer) }], 'end_turn'),
    ),
  ];
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const next = responses.shift();
    if (!next) throw new Error('no canned response left');
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const gateway = new AnthropicLlmGateway({ ANTHROPIC_API_KEY: 'test-key' }, { fetch: fetchImpl as typeof fetch });
  const msg: AgentMessage = { id: `m-${input.leadName}`, direction: 'inbound', channel: 'whatsapp', body: input.body, sentAt: new Date('2026-11-10T08:00:00Z') };
  const ctx: AgentRunContext = {
    runId: `run-${input.leadName}`,
    agencyId: input.agencyId,
    agentId: 'agent-1',
    agentTimezone: 'Asia/Dubai',
    lead: { id: `lead-${input.leadName}`, name: input.leadName },
    message: msg,
    thread: [],
    trace: { record: () => undefined },
  };
  return { bodies, run: () => runAssistantAgent(ctx, { data: new FakeDataAccess(), gateway, faults: new FaultInjector({}) }) };
}

const PREFIX_KEYS = ['model', 'tools', 'system', 'thinking', 'output_config', 'tool_choice'] as const;

function stablePrefix(body: Body): string {
  return JSON.stringify(PREFIX_KEYS.map((k) => [k, body[k] ?? null]));
}

function systemBlocks(body: Body): Array<{ type: string; text: string; cache_control?: unknown }> {
  return body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
}

describe('prompt caching: request shape sent to Anthropic', () => {
  const karim = captureRun({
    agencyId: MARINA_BAY_ID,
    leadName: 'Yousef',
    body: 'Looking for a 2-bedroom apartment in Dubai Marina under 2M AED.',
    location: 'Dubai Marina',
    bedrooms: 2,
  });
  const lina = captureRun({
    agencyId: DESERT_KEY_ID,
    leadName: 'Lina',
    body: 'Any 1-bed in Business Bay below 2M? Thanks!',
    location: 'Business Bay',
    bedrooms: 1,
  });
  let karimOutcome: Awaited<ReturnType<typeof karim.run>>;

  beforeAll(async () => {
    karimOutcome = await karim.run();
    await lina.run();
  });

  it('makes three model calls per run: Phase A, then two Phase B steps', () => {
    expect(karim.bodies).toHaveLength(3);
    expect(lina.bodies).toHaveLength(3);
  });

  it('marks a cache breakpoint on the last system block of every request (5-minute ephemeral)', () => {
    for (const body of [...karim.bodies, ...lina.bodies]) {
      const system = systemBlocks(body);
      expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  it('adds top-level automatic caching only to Phase B, so its tool loop reuses each previous step; Phase A ends in unique content and gets none', () => {
    expect(karim.bodies[0].cache_control).toBeUndefined();
    expect(karim.bodies[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(karim.bodies[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('keeps tools, system prompt and output schema byte-identical across two different leads and agencies', () => {
    for (const i of [0, 1, 2]) expect(stablePrefix(lina.bodies[i])).toBe(stablePrefix(karim.bodies[i]));
    // ...while the per-lead content really differs, in the messages.
    for (const i of [0, 1]) expect(JSON.stringify(lina.bodies[i].messages)).not.toBe(JSON.stringify(karim.bodies[i].messages));
  });

  it('keeps volatile data (lead name, message text, timestamps, agency areas) out of the cached prefix', () => {
    for (const body of karim.bodies) {
      const prefix = stablePrefix(body);
      expect(prefix).not.toContain('Yousef');
      expect(prefix).not.toContain('under 2M AED');
      expect(prefix).not.toContain('2026-11-10');
      expect(prefix).not.toContain('Palm Jumeirah');
    }
  });

  it('Phase B step 2 resends step 1 unchanged as its prefix (append-only), so the step-1 entry is read back', () => {
    const [, step1, step2] = karim.bodies;
    expect(stablePrefix(step2)).toBe(stablePrefix(step1));
    expect(step2.messages.slice(0, step1.messages.length)).toEqual(step1.messages);
    expect(step2.messages.length).toBeGreaterThan(step1.messages.length);
  });

  it('never sends sampling parameters or a forced tool choice', () => {
    for (const body of [...karim.bodies, ...lina.bodies]) {
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
      const choice = body.tool_choice as { type?: string } | undefined;
      expect(choice === undefined || choice.type === 'auto').toBe(true);
    }
  });

  it('sums cache read and write tokens over both phases into the run usage', () => {
    // Three calls, each 50 uncached + 700 written + 1200 read input tokens, 40 output.
    expect(karimOutcome.usage).toEqual({
      inputTokens: 3 * 1950,
      outputTokens: 120,
      totalTokens: 3 * 1950 + 120,
      cacheReadTokens: 3600,
      cacheWriteTokens: 2100,
    });
  });
});

describe('prompt caching: the self-verification revision turn', () => {
  const mbr1002 = stableId('property', 'MBR-1002');
  const shortlist = (reason: string) => ({ recommendations: [{ propertyId: mbr1002, reason }], summary: 'One fit.', followUpTask: null });
  const run = captureRun({
    agencyId: MARINA_BAY_ID,
    leadName: 'Karim',
    body: 'Looking for a 2-bedroom apartment in Dubai Marina under 2M AED.',
    location: 'Dubai Marina',
    bedrooms: 2,
    finals: [shortlist('MBR-1002 asks AED 1,890,000 with a 9.5% gross yield.'), shortlist('MBR-1002 asks AED 1,890,000 with a 6.61% gross yield.')],
  });

  beforeAll(async () => {
    const outcome = await run.run();
    expect(outcome.selfVerification).toMatchObject({ revised: true, rounds: 1 });
  });

  it('sends one extra request after Phase B', () => {
    expect(run.bodies).toHaveLength(4);
  });

  it('reuses the cached prefix: same tools, same cached system prompt, and Phase B messages resent unchanged', () => {
    const [, , lastPhaseB, revision] = run.bodies;
    expect(JSON.stringify(revision.tools)).toBe(JSON.stringify(lastPhaseB.tools));
    expect(revision.system).toEqual(lastPhaseB.system);
    expect(systemBlocks(revision).at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(revision.model).toBe(lastPhaseB.model);
    expect(revision.output_config).toEqual(lastPhaseB.output_config);
    expect(revision.thinking).toEqual(lastPhaseB.thinking);
    expect(revision.messages.slice(0, lastPhaseB.messages.length)).toEqual(lastPhaseB.messages);
  });

  it('offers no tool execution: tool_choice none (allowed), never a forced choice, no sampling parameters', () => {
    const revision = run.bodies[3];
    expect(revision.tool_choice).toEqual({ type: 'none' });
    expect(revision).not.toHaveProperty('temperature');
    expect(revision).not.toHaveProperty('top_p');
    expect(revision).not.toHaveProperty('top_k');
  });
});
