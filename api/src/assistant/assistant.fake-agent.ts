import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Property } from '../entities';
import {
  AgentFollowUp,
  AgentOutcome,
  AgentPort,
  AgentRunContext,
  AgentRunError,
  AssistantPropertyType,
  CandidateRecommendation,
  ExtractedRequirements,
  Extraction,
  FollowUpIntent,
  LeadIntent,
  TraceEntry,
} from './assistant.types';
import { emptyExtractedRequirements, hasSearchCriteria, toContractRequirements } from './domain/requirements';

export const FAKE_AGENT_MODEL = 'fake-scripted';

/**
 * A scripted, deterministic stand-in for the Claude agent (ASSISTANT_AGENT_IMPL=fake). It calls no model and
 * spends nothing, so the e2e tests can exercise the whole HTTP contract.
 *
 * It reads the message with a few regular expressions, searches the agency's listings with a read-only,
 * agency-scoped query, and proposes every listing it saw: deciding what really fits is the service's job.
 *
 * Test markers in the message body (only this fake reads them):
 *   [fake:fail-tool]       a search_listings call fails, then the run fails with that trace
 *   [fake:fail-model]      the "model" fails before any tool call
 *   [fake:throw]           a plain Error (not an AgentRunError)
 *   [fake:slow:<ms>]       waits, honouring the abort signal
 *   [fake:candidate:<id>]  also proposes <id>, as if a tool had returned it
 *   [fake:unseen:<id>]     also proposes <id>, without any tool having returned it
 */
@Injectable()
export class FakeAssistantAgent implements AgentPort {
  readonly modelId = FAKE_AGENT_MODEL;

  constructor(private readonly em: EntityManager) {}

  async run(ctx: AgentRunContext): Promise<AgentOutcome> {
    const body = ctx.message.body;
    const trace: TraceEntry[] = [];
    const record = async (entry: TraceEntry) => {
      trace.push(entry);
      await ctx.trace.record(entry);
    };

    const slow = /\[fake:slow:(\d+)\]/.exec(body);
    if (slow) await sleep(Number(slow[1]), ctx.signal);
    if (body.includes('[fake:throw]')) throw new Error('Unexpected failure inside the scripted agent.');
    if (body.includes('[fake:fail-model]')) throw new AgentRunError('model', 'The model request failed (scripted failure).', trace);

    const em = this.em.fork();
    const areas = (await em.find(Property, { agency: ctx.agencyId }, { fields: ['area'] })).map((p) => p.area);
    const extraction = extract(body, [...new Set(areas)]);
    const requirements = extraction.requirements;

    const candidates: CandidateRecommendation[] = [];
    const seen = new Set<string>();
    const searchSkipped = !hasSearchCriteria(requirements);

    if (!searchSkipped) {
      const input = {
        areas: requirements.locations,
        minBedrooms: requirements.bedroomsMin,
        maxBedrooms: requirements.bedroomsMax,
        type: requirements.propertyType,
        status: 'available',
      };
      const started = Date.now();
      if (body.includes('[fake:fail-tool]')) {
        const error = 'Scripted database failure.';
        await record({ tool: 'search_listings', input, error, durationMs: Date.now() - started });
        throw new AgentRunError('tool', `Tool search_listings failed: ${error}`, trace, { inputTokens: 500, outputTokens: 50, totalTokens: 550 });
      }
      const rows = await em.find(
        Property,
        {
          agency: ctx.agencyId,
          status: 'available',
          ...(requirements.locations.length ? { area: { $in: requirements.locations } } : {}),
          ...(requirements.bedroomsMin !== null ? { bedrooms: { $gte: requirements.bedroomsMin, $lte: requirements.bedroomsMax ?? 100 } } : {}),
          ...(requirements.propertyType ? { type: requirements.propertyType } : {}),
        },
        { orderBy: { priceAed: 'asc', id: 'asc' }, limit: 20 },
      );
      const items = rows.map((p) => ({ id: p.id, reference: p.reference, area: p.area, bedrooms: p.bedrooms, priceAed: p.priceAed }));
      await record({ tool: 'search_listings', input, output: items.length ? { items } : null, durationMs: Date.now() - started });
      for (const item of items) {
        seen.add(item.id);
        candidates.push({ propertyId: item.id, reason: `Scripted pick: ${item.reference} in ${item.area}.` });
      }
    }

    for (const [, id] of body.matchAll(/\[fake:candidate:([0-9a-f-]{36})\]/g)) {
      seen.add(id);
      candidates.push({ propertyId: id, reason: 'Scripted candidate.' });
    }
    for (const [, id] of body.matchAll(/\[fake:unseen:([0-9a-f-]{36})\]/g)) {
      candidates.push({ propertyId: id, reason: 'Scripted candidate no tool returned.' });
    }

    const followUp: AgentFollowUp | null = extraction.leadAskedForFollowUp
      ? { title: `Follow up with ${ctx.lead.name}`, notes: `Lead wrote: "${body.slice(0, 200)}"`, intent: extraction.followUp }
      : null;

    return {
      model: FAKE_AGENT_MODEL,
      extraction,
      requirements: toContractRequirements(requirements),
      candidates,
      seenPropertyIds: [...seen],
      summary: searchSkipped ? 'Nothing to search for in this message.' : `Scripted run: ${candidates.length} candidate listing(s).`,
      followUp,
      trace,
      searchSkipped,
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      // No model, so no revision turn: the record says nothing was checked wrong.
      selfVerification: { checkedRecommendations: candidates.length, issuesFound: [], revised: false, rounds: 0, fallbackReasons: [] },
    };
  }
}

const TYPES: readonly AssistantPropertyType[] = ['apartment', 'villa', 'townhouse', 'penthouse'];

function extract(body: string, agencyAreas: readonly string[]): Extraction {
  const text = body.replace(/\[fake:[^\]]*\]/g, ' ');
  const lower = text.toLowerCase();
  const r: ExtractedRequirements = emptyExtractedRequirements();

  r.locations = agencyAreas.filter((area) => lower.includes(area.toLowerCase())).sort();

  if (/\bstudio\b/i.test(text)) r.bedroomsMin = 0;
  const beds = /(\d+)\s*-?\s*(?:bed(?:room)?s?|br)\b/i.exec(text);
  if (beds) {
    const n = Number(beds[1]);
    r.bedroomsMin = r.bedroomsMin === null ? n : Math.min(r.bedroomsMin, n);
    r.bedroomsMax = Math.max(n, r.bedroomsMin);
  } else if (r.bedroomsMin !== null) {
    r.bedroomsMax = r.bedroomsMin;
  }

  const budget = /\b(around|about|approx\.?|~)?\s*(\d+(?:\.\d+)?)\s*(m|million|k)\b/i.exec(text);
  if (budget) {
    const unit = budget[3].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    r.budgetMaxAed = Math.round(Number(budget[2]) * unit);
    r.budgetIsApproximate = Boolean(budget[1]);
  }

  r.propertyType = TYPES.find((t) => new RegExp(`\\b${t}s?\\b`, 'i').test(text)) ?? null;
  const intent: LeadIntent = /\b(to rent|renting|rent a)\b/i.test(text) ? 'rent' : /\b(buy|buyer|budget|looking for|want)\b/i.test(text) ? 'buy' : 'unknown';
  r.intent = r.budgetMaxAed !== null || r.locations.length || r.bedroomsMin !== null ? (intent === 'unknown' ? 'buy' : intent) : intent;
  if (/\byield\b/i.test(text)) {
    r.preferences = ['good rental yield'];
    r.prioritiseYield = true;
  }
  r.listingReferences = [...new Set(text.match(/\b[A-Z]{2,4}-\d{3,5}\b/g) ?? [])];

  return { requirements: r, ...followUpOf(text) };
}

function followUpOf(text: string): { followUp: FollowUpIntent; leadAskedForFollowUp: boolean } {
  const base: FollowUpIntent = { kind: 'none', days: null, weekday: null, month: null, day: null, year: null, time: null, quote: null, unclearReason: null };
  if (/\btomorrow\b/i.test(text)) return { followUp: { ...base, kind: 'relative_days', days: 1, quote: 'tomorrow' }, leadAskedForFollowUp: true };
  if (/\bafter the weekend\b/i.test(text)) return { followUp: { ...base, kind: 'after_weekend', quote: 'after the weekend' }, leadAskedForFollowUp: true };
  if (/\b(call|follow up|follow-up|contact)\b/i.test(text)) {
    return {
      followUp: { ...base, kind: 'unclear', unclearReason: 'The lead asked for a follow-up but did not say when.' },
      leadAskedForFollowUp: true,
    };
  }
  return { followUp: base, leadAskedForFollowUp: false };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AgentRunError('timeout', 'Aborted.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AgentRunError('timeout', 'Aborted.'));
    });
  });
}
