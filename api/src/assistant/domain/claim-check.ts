import type { ClaimIssue, ClaimIssueKind } from '../assistant.types';
import { grossYieldPct, ListingRecord, pricePerSqft } from './listing-facts';

/**
 * The one check of a model-written recommendation reason against the listing it belongs to. Used by
 * the agent's self-verification (issues -> one revision turn -> factual fallback) and by the
 * service's validateRecommendations (reasonMatchesListing -> factual fallback), so both sides agree.
 *
 * Pure and deterministic. It reports only clear contradictions of a fact about THIS listing: a wrong
 * price, rent, monthly rent or price per sqft; a wrong gross yield (or any yield when rent is unknown);
 * a bedroom count, status or place stated for the unit itself; or another listing's code. Figures that
 * describe the lead's request (budget, bedroom range), comparisons ("unlike a studio"), surroundings
 * ("close to JLT") and amenities ("reserved parking") are not claims about the listing and pass.
 */

export const YIELD_TOLERANCE_PP = 0.15;

export interface ClaimCheckContext {
  /** The agency's listings: their areas, buildings and codes are the names a reason could confuse. */
  otherListings?: readonly ListingRecord[];
  /** Figures a reason may quote besides the listing's own (budget, band floor and ceiling). */
  allowedAmountsAed?: readonly number[];
}

export interface ParsedAmount {
  text: string;
  valueAed: number;
  /** Half of the last stated digit's place value, in AED ("2.05M" -> 5,000; "2,050,000" -> 0.5). */
  halfUnitAed: number;
}

type AmountUnit = 'total' | 'month' | 'sqft' | 'size' | 'percent';

interface ScannedAmount extends ParsedAmount {
  unit: AmountUnit;
  /** "AED" written next to the figure. */
  explicitAed: boolean;
  index: number;
}

const AMOUNT_RE = /(?<![\w.,-])(AED\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(million|mn|m|k)\b)?(\s*AED\b)?/gi;
const PER_SQFT_AFTER = /^\s*(?:\/\s*(?:sq\.?\s*f(?:ee|oo)?t|sqft|square\s+f(?:ee|oo)t)|per\s+(?:sq\.?\s*f(?:ee|oo)?t|sqft|square\s+f(?:ee|oo)t)|psf\b)/i;
const SIZE_AFTER = /^\s*(?:sq\.?\s*f(?:ee|oo)?t|sqft|square\s+f(?:ee|oo)t)/i;
const MONTH_AFTER = /^\s*(?:\/\s*(?:mo|month)\b|per\s+month|a\s+month|each\s+month|monthly|pcm\b)/i;
const PERCENT_AFTER = /^\s*%/;
/** A per-sqft figure in such a clause is a running cost, not the listing's price per sqft. */
const SERVICE_CHARGE_BEFORE = /\b(service|charges?|fees?|maintenance)\b/i;

function scanAmounts(text: string): ScannedAmount[] {
  const out: ScannedAmount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [whole, aedBefore, digits, suffix, aedAfter] = m;
    const index = m.index ?? 0;
    const after = text.slice(index + whole.length);
    const unit: AmountUnit = PERCENT_AFTER.test(after)
      ? 'percent'
      : PER_SQFT_AFTER.test(after)
        ? 'sqft'
        : SIZE_AFTER.test(after)
          ? 'size'
          : MONTH_AFTER.test(after)
            ? 'month'
            : 'total';
    const explicitAed = !!aedBefore || !!aedAfter;
    if (!explicitAed && !suffix && !digits.includes(',')) continue;
    const n = Number(digits.replace(/,/g, ''));
    const scale = !suffix ? 1 : suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    out.push({ text: whole.trim(), valueAed: Math.round(n * scale), halfUnitAed: (scale * 10 ** -decimals) / 2, unit, explicitAed, index });
  }
  return out;
}

/** Whole-price AED figures in a text (AED 2,050,000 / 2.05M / AED 2m / 150k); not sizes, per-sqft or monthly figures. */
export function parseAedAmounts(text: string): ParsedAmount[] {
  return scanAmounts(text)
    .filter((a) => a.unit === 'total' && a.valueAed >= 10_000)
    .map(({ text: t, valueAed, halfUnitAed }) => ({ text: t, valueAed, halfUnitAed }));
}

function amountMatches(a: ParsedAmount, target: number, minPct = 0.005): boolean {
  const tolerance = Math.max(minPct * target, Math.min(a.halfUnitAed, 0.025 * target));
  return Math.abs(a.valueAed - target) <= tolerance;
}

const aed = (n: number) => `AED ${Math.round(n).toLocaleString('en-US')}`;

/** Clauses split on , ; . ( ) but never inside a number (2,050,000 or 7.32). */
function clauses(text: string): string[] {
  return text.split(/[;,](?!\d)|\.(?!\d)|\(|\)/);
}

const YIELD_WORD = /\b(yield\w*|return|roi)\b/i;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g;
/** "5% under budget" is a percentage of something else, even next to a yield. */
const NOT_A_YIELD_AFTER = /^\s*(below|under|above|over|less|more|off|cheaper|lower|higher|discount|of\s+the\s+(budget|price)|down)\b/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const BEDROOM_RE = /\b(\d+|one|two|three|four|five|six|seven)\s*-?\s*(?:br|bed(?:room)?s?|bd)\b|\bstudio\b/gi;
/** A bedroom count in such a clause describes the request or a comparison, not this unit. */
const BEDROOM_NOT_ABOUT_UNIT =
  /\b(requests?|requested|asked|wants?|wanted|wished|looking\s+for|range|unlike|than|instead|rather|compared|versus|vs|prefers?|preferred)\b/i;
const RANGE_BEFORE = /(?:\d|studio|one|two|three|four|five|six)\s*(?:-|–|to|or)\s*$/i;
const RANGE_AFTER = /^\s*(?:-|–|to|or)\s*(?:\d|studio|one|two|three|four|five|six|seven)/i;
const REFERENCE_RE = /\b[A-Z]{2,5}-\d{3,6}\b/g;
const NEGATION_BEFORE = /\b(no|not|never|rent|yield|estimate|figure|data|isn't|is not)\b/i;
/** A status stated for the unit: "it is sold", "MBR-1006 is reserved", "currently available", "status: sold". */
const UNIT_SUBJECT = String.raw`(?:it|unit|listing|apartment|flat|villa|townhouse|penthouse|property|home|this|[A-Z]{2,5}-\d{3,6})`;
const STATUS_CLAIMS = [
  new RegExp(String.raw`\b${UNIT_SUBJECT}\s+(?:is|was|has\s+been|remains)\s+(?:currently\s+|still\s+|now\s+|already\s+)?(available|reserved|sold)\b`, 'gi'),
  /\b(?:currently|still|already)\s+(available|reserved|sold)\b/gi,
  /\bstatus(?:\s+is)?\s*[:\s]\s*(available|reserved|sold)\b/gi,
  /^\s*(available|reserved|sold)(?:\s+now)?\s*$/gi,
];
/** Another place named as where the unit is ("in Princess Tower"), not as surroundings ("close to JLT"). */
const LOCATED_BEFORE = /\b(?:in|at|inside|located\s+in|based\s+in)\s+(?:the\s+)?$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRe(name: string): RegExp {
  return new RegExp(`(?<![\\w])${escapeRe(name.trim())}(?![\\w])`, 'gi');
}

/** The clause around a position (bounded like `clauses`). */
function clauseAround(text: string, index: number): string {
  const boundary = /[;,](?!\d)|\.(?!\d)|\(|\)/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    const at = m.index ?? 0;
    if (at < index) start = at + 1;
    else {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}

export function checkReasonClaims(reason: string, listing: ListingRecord, ctx: ClaimCheckContext = {}): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const add = (kind: ClaimIssueKind, claim: string, expected: string) => {
    if (!issues.some((i) => i.kind === kind && i.claim.toLowerCase() === claim.toLowerCase())) {
      issues.push({ propertyId: listing.id, reference: listing.reference, kind, claim, expected });
    }
  };

  // Listing codes other than this listing's (a reason is about one listing).
  for (const m of reason.matchAll(REFERENCE_RE)) {
    if (m[0].toUpperCase() !== listing.reference.toUpperCase()) add('other_listing', m[0], listing.reference);
  }

  // AED figures, by what they are written as.
  const rent = listing.annualRentAed;
  const monthly = rent === null ? null : rent / 12;
  const allowed = ctx.allowedAmountsAed ?? [];
  const totals = [listing.priceAed, ...(rent !== null ? [rent] : []), ...(monthly !== null ? [monthly] : []), ...allowed];
  totals.push(...allowed.map((a) => Math.abs(listing.priceAed - a)).filter((d) => d > 0));
  const priceFacts = `price ${aed(listing.priceAed)}, rent ${rent === null ? 'unknown' : aed(rent)}`;
  const ppsf = pricePerSqft(listing);
  for (const a of scanAmounts(reason)) {
    if (a.unit === 'total') {
      if (a.valueAed >= 10_000 && !totals.some((t) => amountMatches(a, t))) add('price', a.text, priceFacts);
    } else if (a.unit === 'month') {
      if (!a.explicitAed && a.halfUnitAed < 500) continue; // a bare small number before "a month" is not a sum of money
      if (monthly === null) add('price', a.text, 'rent unknown');
      else if (!amountMatches(a, monthly, 0.01)) add('price', a.text, `rent ${aed(monthly)} a month`);
    } else if (a.unit === 'sqft') {
      if (ppsf === null || SERVICE_CHARGE_BEFORE.test(clauseAround(reason, a.index))) continue;
      if (!amountMatches(a, ppsf, 0.01)) add('price', a.text, `${aed(ppsf)}/sqft`);
    }
  }

  // Percentages in a clause about yield, against the computed gross yield.
  const y = grossYieldPct(listing.priceAed, rent);
  for (const clause of clauses(reason)) {
    if (!YIELD_WORD.test(clause)) continue;
    for (const m of clause.matchAll(PERCENT_RE)) {
      if (NOT_A_YIELD_AFTER.test(clause.slice((m.index ?? 0) + m[0].length))) continue;
      const quoted = Number(m[1]);
      if (y === null) add('yield', `${m[1]}%`, 'no yield (rent unknown)');
      else if (Math.abs(quoted - y) > YIELD_TOLERANCE_PP + 1e-9) add('yield', `${m[1]}%`, `${y.toFixed(2)}%`);
    }
  }

  // Bedrooms stated for the unit (not the request, a range or a comparison).
  const expectedBeds = listing.bedrooms === 0 ? 'studio' : `${listing.bedrooms} bedrooms`;
  for (const m of reason.matchAll(BEDROOM_RE)) {
    const index = m.index ?? 0;
    if (BEDROOM_NOT_ABOUT_UNIT.test(clauseAround(reason, index))) continue;
    if (RANGE_BEFORE.test(reason.slice(0, index)) || RANGE_AFTER.test(reason.slice(index + m[0].length))) continue;
    const word = m[1]?.toLowerCase();
    const n = word === undefined ? 0 : (NUMBER_WORDS[word] ?? Number(word));
    if (n !== listing.bedrooms) add('bedrooms', m[0], expectedBeds);
  }

  // Places: an area or building of another listing named as where this unit is.
  const own = [listing.building, listing.area].filter((s): s is string => !!s && !!s.trim());
  let masked = reason;
  for (const name of [...own].sort((a, b) => b.length - a.length)) masked = masked.replace(nameRe(name), (s) => ' '.repeat(s.length));
  const ownLower = new Set(own.map((s) => s.trim().toLowerCase()));
  const names = new Set<string>();
  for (const o of ctx.otherListings ?? []) {
    for (const n of [o.area, o.building]) if (n && n.trim().length >= 4 && !ownLower.has(n.trim().toLowerCase())) names.add(n.trim());
  }
  const where = listing.building ? `${listing.building}, ${listing.area}` : listing.area;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    for (const m of masked.matchAll(nameRe(name))) {
      if (LOCATED_BEFORE.test(masked.slice(0, m.index ?? 0))) add('location', name, where);
    }
    masked = masked.replace(nameRe(name), (s) => ' '.repeat(s.length));
  }

  // Status stated for the unit, ignoring negated uses ("no yield figure is available") and amenities.
  for (const clause of clauses(reason)) {
    for (const re of STATUS_CLAIMS) {
      for (const m of clause.matchAll(re)) {
        if (NEGATION_BEFORE.test(clause.slice(0, m.index ?? 0))) continue;
        const word = m[1];
        if (word.toLowerCase() !== listing.status) add('status', word, listing.status);
      }
    }
  }

  return issues;
}

/** True when a reason states nothing about the listing that its row contradicts. */
export function reasonMatchesListing(reason: string, listing: ListingRecord, ctx: ClaimCheckContext = {}): boolean {
  return checkReasonClaims(reason, listing, ctx).length === 0;
}
