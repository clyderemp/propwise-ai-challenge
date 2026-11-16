/**
 * Pure helpers for the eval suite: expected dates, cost, verdicts and the markdown report.
 * No I/O here, so they are unit-tested (eval-lib.spec.ts) with the normal `pnpm test`.
 */
import { priceUsage } from '../../src/assistant/agent/pricing';

import { checkReasonClaims } from '../../src/assistant/domain/claim-check';
import type { ListingRecord } from '../../src/assistant/domain/listing-facts';
import type { PropertyJson, RunJson } from './api';

export interface Assertion {
  name: string;
  pass: boolean;
  /** Gating assertions decide the verdict. Non-gating ones (model-graded quality) are reported only. */
  gating: boolean;
  detail?: string;
}

export type Verdict = 'PASS' | 'FAIL';

export interface Usage {
  /** Whole prompt: uncached + cache read + cache write. */
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface QualityScore {
  /** Mean grader score, 1-5. */
  meanScore: number;
  /** Reasons the grader found supported by the listing's numbers, of all graded. */
  supported: number;
  graded: number;
  model: string;
  /** One line per graded reason. */
  notes?: string[];
}

export interface CaseResult {
  id: string;
  title: string;
  covers: string;
  verdict: Verdict;
  assertions: Assertion[];
  /** Wall time of the case's assistant runs (shared runs count in each case that uses them). */
  latencyMs: number;
  usage: Required<Usage>;
  costUsd: number | null;
  /** The same tokens billed with no prompt cache. */
  costWithoutCacheUsd: number | null;
  models: string[];
  quality: QualityScore | null;
}

export interface Report {
  startedAt: string;
  model: string;
  results: CaseResult[];
}

const DUBAI_OFFSET_MS = 4 * 3_600_000; // Asia/Dubai is UTC+4 all year (no DST).
const DAY_MS = 86_400_000;

/** The calendar date (YYYY-MM-DD) of an instant in Asia/Dubai. */
export function dubaiDate(iso: string): string {
  return new Date(new Date(iso).getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function at10(date: string): string {
  return `${date}T10:00:00+04:00`;
}

/** "Tomorrow": the Dubai calendar day after the message was sent, at the default 10:00. */
export function expectedNextDayAt10(sentAt: string): string {
  return at10(addDays(dubaiDate(sentAt), 1));
}

/** "After the weekend" (UAE weekend: Saturday and Sunday): the first Monday strictly after the sent date. */
export function firstMondayAfterAt10(sentAt: string): string {
  let date = addDays(dubaiDate(sentAt), 1);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = addDays(date, 1);
  return at10(date);
}

/** An urgent timeline with no contact timing: the first Monday-to-Friday Dubai date after the sent date, at 10:00. */
export function nextWorkingDayAt10(sentAt: string): string {
  let date = addDays(dubaiDate(sentAt), 1);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDays(date, 1);
  return at10(date);
}

function priced(model: string, usage: Usage) {
  return priceUsage(model, { ...usage, totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens });
}

/** Cache-aware cost in USD (prices in src/assistant/agent/pricing.ts); null for an unknown model. */
export function costUsd(model: string, usage: Usage): number | null {
  return priced(model, usage).estimatedCostUsd;
}

/** What the same tokens would cost with no prompt cache. */
export function costWithoutCacheUsd(model: string, usage: Usage): number | null {
  return priced(model, usage).estimatedCostWithoutCacheUsd;
}

export function verdictOf(assertions: readonly Assertion[]): Verdict {
  const gating = assertions.filter((a) => a.gating);
  return gating.length > 0 && gating.every((a) => a.pass) ? 'PASS' : 'FAIL';
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(n: number | null): string {
  return n === null ? 'n/a' : `$${n.toFixed(4)}`;
}

function fmtSaving(withCache: number | null, without: number | null): string {
  if (withCache === null || without === null) return 'n/a';
  const saved = without - withCache;
  return without > 0 ? `$${saved.toFixed(4)} (${Math.round((saved / without) * 100)}%)` : `$${saved.toFixed(4)}`;
}

function sumNullable(values: ReadonlyArray<number | null>): number | null {
  return values.some((v) => v === null) ? null : values.reduce<number>((s, v) => s + (v ?? 0), 0);
}

function fmtQuality(q: QualityScore | null): string {
  return q ? `${q.meanScore.toFixed(1)}/5 (${q.supported}/${q.graded} supported)` : '-';
}

export function renderTable(results: readonly CaseResult[]): string {
  const rows = results.map((r) => {
    const gating = r.assertions.filter((a) => a.gating);
    const passed = gating.filter((a) => a.pass).length;
    return `| ${r.id} | ${r.title} | ${r.covers} | ${r.verdict} | ${passed}/${gating.length} | ${(r.latencyMs / 1000).toFixed(1)} s | ${fmtInt(r.usage.totalTokens)} | ${fmtInt(r.usage.cacheReadTokens)} | ${fmtInt(r.usage.cacheWriteTokens)} | ${fmtCost(r.costUsd)} | ${fmtSaving(r.costUsd, r.costWithoutCacheUsd)} | ${r.models.join(', ') || '-'} |`;
  });
  return [
    '| Case | Title | Covers | Verdict | Gating assertions | Latency | Tokens | Cache read | Cache write | Cost | Cache saved | Model |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function renderReport(report: Report): string {
  const passed = report.results.filter((r) => r.verdict === 'PASS').length;
  const tokens = report.results.reduce((sum, r) => sum + r.usage.totalTokens, 0);
  const input = report.results.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  const cacheRead = report.results.reduce((sum, r) => sum + r.usage.cacheReadTokens, 0);
  const cacheWrite = report.results.reduce((sum, r) => sum + r.usage.cacheWriteTokens, 0);
  const cost = sumNullable(report.results.map((r) => r.costUsd));
  const costWithout = sumNullable(report.results.map((r) => r.costWithoutCacheUsd));
  const lines: string[] = [
    '# Assistant eval report',
    '',
    `- Started: ${report.startedAt}`,
    `- Model: ${report.model}`,
    `- Result: ${passed}/${report.results.length} cases passed`,
    `- Tokens (summed per case; shared runs count once per case that uses them): ${fmtInt(tokens)}`,
    `- Prompt cache: ${fmtInt(cacheRead)} tokens read, ${fmtInt(cacheWrite)} written (${input > 0 ? Math.round((cacheRead / input) * 100) : 0}% of input read from cache)`,
    `- Cost: ${fmtCost(cost)} with the cache, ${fmtCost(costWithout)} without it: saved ${fmtSaving(cost, costWithout)}`,
    '',
    'Verdicts come only from gating assertions: facts the code guarantees, and subset checks where the model has a choice.',
    'The quality column is a model-graded, non-gating score of whether each reason is supported by the listing data.',
    'Full runs, including each trace, are in `evals/traces/<case>.json`.',
    '',
    renderTable(report.results),
    '',
    '| Case | Reason quality (non-gating) |',
    '| --- | --- |',
    ...report.results.map((r) => `| ${r.id} | ${fmtQuality(r.quality)} |`),
    '',
    '## Assertions',
    '',
  ];
  for (const r of report.results) {
    lines.push(`### ${r.id}: ${r.title} (${r.verdict})`, '');
    for (const a of r.assertions) {
      const tag = a.gating ? (a.pass ? 'PASS' : 'FAIL') : a.pass ? 'info ok' : 'info no';
      lines.push(`- ${tag}: ${a.name}${a.detail ? ` (${a.detail})` : ''}`);
    }
    for (const note of r.quality?.notes ?? []) lines.push(`- grader (${r.quality?.model}): ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Every recommended reference is allowed; with nonEmpty, at least one listing must be recommended. */
export function recommendationsWithin(refs: readonly string[], allowed: readonly string[], opts: { nonEmpty?: boolean } = {}): boolean {
  if (opts.nonEmpty && refs.length === 0) return false;
  return refs.every((r) => allowed.includes(r));
}

// ---------------------------------------------------------------------------------------------
// Self-verification (eval 16)
// ---------------------------------------------------------------------------------------------

function toClaimListing(p: Pick<PropertyJson, 'id' | 'reference' | 'title' | 'area' | 'building' | 'sizeSqft' | 'bedrooms' | 'priceAed' | 'annualRentAed'> & { type: string; status: string }): ListingRecord {
  return {
    id: p.id,
    agencyId: '',
    reference: p.reference,
    title: p.title,
    area: p.area,
    building: p.building ?? null,
    type: p.type as ListingRecord['type'],
    bedrooms: p.bedrooms,
    sizeSqft: p.sizeSqft,
    priceAed: p.priceAed,
    annualRentAed: p.annualRentAed ?? null,
    status: p.status as ListingRecord['status'],
    description: '',
    listedAt: new Date(0),
  };
}

/** Listing facts the tools returned in this run (search_listings items, get_listing_details output). */
function listingsInTrace(run: RunJson): ListingRecord[] {
  const out: ListingRecord[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && typeof o.reference === 'string' && typeof o.area === 'string' && typeof o.priceAed === 'number') {
      out.push(toClaimListing(o as unknown as PropertyJson));
      return;
    }
    Object.values(o).forEach(visit);
  };
  for (const e of run.trace ?? []) visit((e as { output?: unknown }).output);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Deterministic checks for the self-verification loop: diagnostics.selfVerification has the
 * contract shape and is internally consistent, it is not in the trace, and every shipped reason
 * passes claim-check against the listing as the database holds it (`recommended`, fetched by id).
 */
export function checkSelfVerification(run: RunJson, recommended: readonly PropertyJson[]): Array<{ name: string; pass: boolean; detail: string }> {
  const out: Array<{ name: string; pass: boolean; detail: string }> = [];
  const sv: unknown = run.diagnostics?.selfVerification;
  const shapeOk =
    isObj(sv) &&
    typeof sv.checkedRecommendations === 'number' &&
    Array.isArray(sv.issuesFound) &&
    typeof sv.revised === 'boolean' &&
    (sv.rounds === 0 || sv.rounds === 1) &&
    Array.isArray(sv.fallbackReasons);
  out.push({ name: 'diagnostics.selfVerification has the expected shape', pass: shapeOk, detail: JSON.stringify(sv ?? null) });
  if (shapeOk) {
    const issues = (sv.issuesFound as unknown[]).length;
    const consistent =
      (!sv.revised || sv.rounds === 1) && (issues > 0 || (sv.rounds === 0 && !sv.revised)) && (issues === 0 || sv.rounds === 1 || typeof sv.revisionError === 'string');
    out.push({ name: 'diagnostics.selfVerification is consistent', pass: consistent, detail: `issues ${issues}, rounds ${String(sv.rounds)}, revised ${String(sv.revised)}` });
  }
  out.push({ name: 'the trace holds tool calls only (no selfVerification)', pass: !JSON.stringify(run.trace ?? []).includes('selfVerification'), detail: `${(run.trace ?? []).length} entries` });

  const band = run.diagnostics?.budgetBand;
  const allowedAmountsAed = [run.requirements?.budgetAed?.min, run.requirements?.budgetAed?.max, band?.floorAed, band?.ceilingAed].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  const db = new Map(recommended.map((p) => [p.id, toClaimListing(p)]));
  const otherListings = [...db.values(), ...listingsInTrace(run)];
  for (const r of run.recommendations) {
    const listing = db.get(r.propertyId);
    const issues = listing ? checkReasonClaims(r.reason, listing, { otherListings, allowedAmountsAed }) : null;
    out.push({
      name: `${listing?.reference ?? r.propertyId}: reason passes claim-check against the database`,
      pass: issues !== null && issues.length === 0,
      detail: issues === null ? 'listing not found' : issues.length === 0 ? 'ok' : JSON.stringify(issues),
    });
  }
  return out;
}
