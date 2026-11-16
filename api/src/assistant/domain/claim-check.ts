import type { ClaimIssue, ClaimIssueKind } from '../assistant.types';
import { grossYieldPct, ListingRecord } from './listing-facts';

/**
 * Checks the factual claims in a recommendation reason against the listing it belongs to (the
 * agent's self-verification, run after Phase B). Pure and deterministic: it reads numbers, bedroom
 * counts, place names, listing codes and status words, and reports any that disagree with the data.
 * It only reports what it can read with confidence; free prose is left alone.
 */

export const YIELD_TOLERANCE_PP = 0.15;

export interface ClaimCheckContext {
  /** The agency's listings: their areas, buildings and codes are the names a reason could confuse. */
  otherListings?: readonly ListingRecord[];
  /** Figures a reason may quote besides price and rent (budget, band floor and ceiling). */
  allowedAmountsAed?: readonly number[];
}

export interface ParsedAmount {
  text: string;
  valueAed: number;
  /** Half of the last stated digit's place value, in AED ("2.05M" -> 5,000; "2,050,000" -> 0.5). */
  halfUnitAed: number;
}

const AMOUNT_RE = /(?<![\w.,-])(AED\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(million|mn|m|k)\b)?/gi;
const AREA_UNIT_AFTER = /^\s*(?:\/\s*sq|per\s+sq|sq\.?\s*ft|sqft|square|%)/i;

/** AED figures in a text, in the formats reasons use: AED 2,050,000 / 2.05M / AED 2m / 150k. */
export function parseAedAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [whole, aed, digits, suffix] = m;
    const grouped = digits.includes(',');
    const after = text.slice((m.index ?? 0) + whole.length);
    if (AREA_UNIT_AFTER.test(after)) continue;
    if (!aed && !suffix && !grouped) continue;
    const n = Number(digits.replace(/,/g, ''));
    const scale = !suffix ? 1 : suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    const valueAed = Math.round(n * scale);
    if (valueAed < 10_000) continue;
    out.push({ text: whole.trim(), valueAed, halfUnitAed: (scale * 10 ** -decimals) / 2 });
  }
  return out;
}

function amountMatches(a: ParsedAmount, target: number): boolean {
  const tolerance = Math.max(0.005 * target, Math.min(a.halfUnitAed, 0.025 * target));
  return Math.abs(a.valueAed - target) <= tolerance;
}

const aed = (n: number) => `AED ${n.toLocaleString('en-US')}`;

/** Clauses split on , ; . but never inside a number (2,050,000 or 7.32). */
function clauses(text: string): string[] {
  return text.split(/[;,](?!\d)|\.(?!\d)|\(|\)/);
}

const YIELD_WORD = /\b(yield\w*|return|roi)\b/i;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const BEDROOM_RE = /\b(\d+|one|two|three|four|five|six|seven)\s*-?\s*(?:br|bed(?:room)?s?|bd)\b|\bstudio\b/gi;
const REFERENCE_RE = /\b[A-Z]{2,5}-\d{3,6}\b/g;
const NEGATION_BEFORE = /\b(no|not|never|rent|yield|estimate|figure|data|isn't|is not)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRe(name: string): RegExp {
  return new RegExp(`(?<![\\w])${escapeRe(name.trim())}(?![\\w])`, 'gi');
}

export function checkReasonClaims(reason: string, listing: ListingRecord, ctx: ClaimCheckContext = {}): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const add = (kind: ClaimIssueKind, claim: string, expected: string) => {
    if (!issues.some((i) => i.kind === kind && i.claim.toLowerCase() === claim.toLowerCase())) {
      issues.push({ propertyId: listing.id, reference: listing.reference, kind, claim, expected });
    }
  };

  // Listing codes other than this listing's.
  for (const m of reason.matchAll(REFERENCE_RE)) {
    if (m[0].toUpperCase() !== listing.reference.toUpperCase()) add('other_listing', m[0], listing.reference);
  }

  // AED amounts: price, rent, a budget figure, or the gap between the price and a budget figure.
  const allowed = ctx.allowedAmountsAed ?? [];
  const targets = [listing.priceAed, ...(listing.annualRentAed !== null ? [listing.annualRentAed] : []), ...allowed];
  targets.push(...allowed.map((a) => Math.abs(listing.priceAed - a)).filter((d) => d > 0));
  const priceFacts = `price ${aed(listing.priceAed)}, rent ${listing.annualRentAed === null ? 'unknown' : aed(listing.annualRentAed)}`;
  for (const a of parseAedAmounts(reason)) {
    if (!targets.some((t) => amountMatches(a, t))) add('price', a.text, priceFacts);
  }

  // Percentages in a clause about yield, against the computed gross yield.
  const y = grossYieldPct(listing.priceAed, listing.annualRentAed);
  for (const clause of clauses(reason)) {
    if (!YIELD_WORD.test(clause)) continue;
    for (const m of clause.matchAll(PERCENT_RE)) {
      const quoted = Number(m[1]);
      if (y === null) add('yield', `${m[1]}%`, 'no yield (rent unknown)');
      else if (Math.abs(quoted - y) > YIELD_TOLERANCE_PP + 1e-9) add('yield', `${m[1]}%`, `${y.toFixed(2)}%`);
    }
  }

  // Bedrooms.
  const expectedBeds = listing.bedrooms === 0 ? 'studio' : `${listing.bedrooms} bedrooms`;
  for (const m of reason.matchAll(BEDROOM_RE)) {
    const word = m[1]?.toLowerCase();
    const n = word === undefined ? 0 : (NUMBER_WORDS[word] ?? Number(word));
    if (n !== listing.bedrooms) add('bedrooms', m[0], expectedBeds);
  }

  // Places: an area or building of another listing, once this listing's own names are masked out.
  const own = [listing.building, listing.area].filter((s): s is string => !!s && !!s.trim());
  let masked = reason;
  for (const name of [...own].sort((a, b) => b.length - a.length)) masked = masked.replace(nameRe(name), ' ');
  const ownLower = new Set(own.map((s) => s.trim().toLowerCase()));
  const names = new Set<string>();
  for (const o of ctx.otherListings ?? []) {
    for (const n of [o.area, o.building]) if (n && n.trim().length >= 4 && !ownLower.has(n.trim().toLowerCase())) names.add(n.trim());
  }
  const where = listing.building ? `${listing.building}, ${listing.area}` : listing.area;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const re = nameRe(name);
    if (re.test(masked)) {
      add('location', name, where);
      masked = masked.replace(nameRe(name), ' ');
    }
  }

  // Status words, ignoring negated or unrelated uses ("no yield is available").
  for (const clause of clauses(reason)) {
    for (const m of clause.matchAll(/\b(available|reserved|sold)\b/gi)) {
      const before = clause.slice(0, m.index ?? 0);
      if (NEGATION_BEFORE.test(before)) continue;
      const word = m[1].toLowerCase();
      if (word !== listing.status) add('status', m[1], listing.status);
    }
  }

  return issues;
}
