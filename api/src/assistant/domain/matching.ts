import {
  BudgetBand,
  CandidateRecommendation,
  DropReason,
  DroppedRecommendation,
  ExtractedRequirements,
  PropertySnapshot,
  Recommendation,
} from '../assistant.types';
import { computeListingFlags, grossYieldPct, isPossibleDuplicate, isPriceSuspect, ListingRecord, toPropertySnapshot } from './listing-facts';
import { hasSearchCriteria, sanitizeBudget } from './requirements';

/**
 * The rule that makes "only real, available, fitting listings" unbreakable (plan 2.7 + section 7).
 * The model only proposes ids; this decides. Pure: the service re-reads the rows from the database
 * (scoped to the agency) and passes them in.
 */

export const MAX_RECOMMENDATIONS = 5;
/** Approximate budgets ("around 2M"): 0.90x .. 1.05x of the stated maximum. */
export const APPROX_FLOOR_FACTOR = 0.9;
export const APPROX_CEILING_FACTOR = 1.05;

export interface ValidatedRecommendation extends Recommendation {
  property: PropertySnapshot;
}

export interface ValidateRecommendationsInput {
  /** The model's picks, best first. */
  candidates: readonly CandidateRecommendation[];
  /** The frozen Phase A requirements. */
  requirements: ExtractedRequirements;
  /** The authenticated agent's agency. */
  agencyId: string;
  /** Rows re-read from the database for (at least) the candidate ids. Rows of other agencies are rejected. */
  listings: readonly ListingRecord[];
  /** The agency's listings, for duplicate detection. Defaults to `listings` of `agencyId`. */
  agencyListings?: readonly ListingRecord[];
  /** Ids that appeared in a tool output this run. When given, any other id is dropped. */
  seenPropertyIds?: ReadonlySet<string> | readonly string[];
  /** Defaults to MAX_RECOMMENDATIONS. */
  cap?: number;
}

export interface ValidationResult {
  kept: ValidatedRecommendation[];
  dropped: DroppedRecommendation[];
  budgetBand: BudgetBand | null;
}

export function budgetBand(r: ExtractedRequirements): BudgetBand | null {
  const { min, max } = sanitizeBudget(r.budgetMinAed, r.budgetMaxAed);
  if (min === null && max === null) return null;
  if (!r.budgetIsApproximate) return { floorAed: min, ceilingAed: max, approximate: false };
  return {
    floorAed: min ?? (max !== null ? Math.round(max * APPROX_FLOOR_FACTOR) : null),
    ceilingAed: max !== null ? Math.round(max * APPROX_CEILING_FACTOR) : null,
    approximate: true,
  };
}

/** Why a listing does not fit the requirements, or null when it fits. Ignores status and agency. */
export function fitFailure(l: ListingRecord, r: ExtractedRequirements, band: BudgetBand | null = budgetBand(r)): DropReason | null {
  const named = r.listingReferences.map((x) => x.trim().toUpperCase());
  const otherCriteria = hasSearchCriteria({ ...r, listingReferences: [] });
  // A named code only finds the listing; when the same message states criteria, the listing must still fit them.
  if (named.includes(l.reference.toUpperCase()) && !otherCriteria) {
    return isPriceSuspect(l) ? 'price_suspect' : null;
  }
  if (named.length > 0 && !otherCriteria) return 'not_requested';

  if (r.locations.length > 0) {
    const area = l.area.trim().toLowerCase();
    if (!r.locations.some((loc) => loc.trim().toLowerCase() === area)) return 'area_mismatch';
  }
  if (r.bedroomsMin !== null && l.bedrooms < r.bedroomsMin) return 'bedrooms_mismatch';
  if (r.bedroomsMax !== null && l.bedrooms > r.bedroomsMax) return 'bedrooms_mismatch';
  if (r.propertyType !== null && l.type !== r.propertyType) return 'type_mismatch';
  if (band?.ceilingAed != null && l.priceAed > band.ceilingAed) return 'over_budget';
  if (band?.floorAed != null && l.priceAed < band.floorAed) return 'under_budget';
  if (isPriceSuspect(l)) return 'price_suspect';
  return null;
}

/** A plain, data-backed reason for when the model gave none. */
export function factualReason(l: ListingRecord): string {
  const beds = l.bedrooms === 0 ? 'Studio' : `${l.bedrooms}BR`;
  const where = l.building ? `${l.building}, ${l.area}` : l.area;
  const y = grossYieldPct(l.priceAed, l.annualRentAed);
  const yieldText = y === null ? 'rent estimate not available' : `gross yield ${y.toFixed(2)}%`;
  return `${beds} ${l.type} in ${where} at AED ${l.priceAed.toLocaleString('en-US')}, ${yieldText}.`;
}

const AMOUNT_UNITS: Record<string, number> = { m: 1_000_000, million: 1_000_000, k: 1_000, thousand: 1_000 };
const AED_BEFORE = /\bAED\s*(\d[\d,]*(?:\.\d+)?)\s*(million|thousand|m|k)?\b/gi;
const AED_AFTER = /(\d[\d,]*(?:\.\d+)?)\s*(million|thousand|m|k)?\s*AED\b/gi;
const PERCENT = /(\d+(?:\.\d+)?)\s*%/g;
const LISTING_CODE = /\b[A-Z]{2,5}-\d{3,6}\b/gi;

/** A written figure and how far off it may be at the precision it was written ("2.1M" covers 2,050,000..2,150,000). */
function parseFigure(digits: string, unit: string | undefined): { value: number; slack: number } {
  const plain = digits.replace(/,/g, '');
  const decimals = plain.includes('.') ? plain.split('.')[1].length : 0;
  const mult = unit ? AMOUNT_UNITS[unit.toLowerCase()] : 1;
  return { value: Number(plain) * mult, slack: 0.5 * 10 ** -decimals * mult };
}

const near = (f: { value: number; slack: number }, target: number) => Math.abs(f.value - target) <= Math.max(f.slack, target * 0.005) + 1e-9;

/**
 * True when every AED amount, percentage and listing code in a model-written reason matches the
 * re-read row: an amount must be the price or the annual rent, a percentage the gross yield (none
 * when rent is unknown), and a code this listing's own reference.
 */
export function reasonMatchesListing(reason: string, l: ListingRecord): boolean {
  for (const code of reason.match(LISTING_CODE) ?? []) {
    if (code.toUpperCase() !== l.reference.toUpperCase()) return false;
  }
  const targets = [l.priceAed, ...(l.annualRentAed === null ? [] : [l.annualRentAed])];
  for (const re of [AED_BEFORE, AED_AFTER]) {
    for (const m of reason.matchAll(re)) {
      const figure = parseFigure(m[1], m[2]);
      if (!targets.some((t) => near(figure, t))) return false;
    }
  }
  const y = grossYieldPct(l.priceAed, l.annualRentAed);
  for (const m of reason.matchAll(PERCENT)) {
    const figure = parseFigure(m[1], undefined);
    if (y === null || Math.abs(figure.value - y) > figure.slack + 1e-9) return false;
  }
  return true;
}

/** Drops that do not make a summary misleading: the listing (or its twin) is still a valid option. */
const BENIGN_DROPS = new Set<DropReason>(['duplicate', 'over_cap', 'repeated']);

/**
 * When the model's summary names a listing the server dropped (sold, over budget, invented...), the
 * sentences naming it are removed and the options are restated from the re-read rows.
 */
export function reconcileSummary(summary: string, kept: readonly ValidatedRecommendation[], dropped: readonly DroppedRecommendation[]): string {
  const removed = dropped
    .filter((d) => d.reference !== null && !BENIGN_DROPS.has(d.reason))
    .map((d) => new RegExp(`\\b${d.reference!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const sentences = summary.trim().split(/(?<=[.!?])\s+/);
  const keptSentences = sentences.filter((s) => !removed.some((re) => re.test(s)));
  if (keptSentences.length === sentences.length) return summary;
  const options = kept.map((k) => {
    const y = k.property.grossYieldPct;
    return `${k.property.reference} (AED ${k.property.priceAed.toLocaleString('en-US')}, ${y === null ? 'rent unknown' : `gross yield ${y.toFixed(2)}%`})`;
  });
  const restated = options.length > 0 ? `Recommended after server checks: ${options.join(', ')}.` : 'No suggested listing passed the server checks.';
  return [...keptSentences.filter((s) => s.trim()), restated].join(' ');
}

export function validateRecommendations(input: ValidateRecommendationsInput): ValidationResult {
  const { requirements: req, agencyId } = input;
  const band = budgetBand(req);
  const cap = input.cap ?? MAX_RECOMMENDATIONS;
  const byId = new Map(input.listings.map((l) => [l.id, l]));
  const agencyListings = input.agencyListings ?? input.listings.filter((l) => l.agencyId === agencyId);
  const seen = input.seenPropertyIds === undefined ? null : new Set(input.seenPropertyIds);
  const hasCriteria = hasSearchCriteria(req);

  const kept: Array<{ listing: ListingRecord; reason: string }> = [];
  const keptIds = new Set<string>();
  const proposed = new Set<string>();
  const dropped: DroppedRecommendation[] = [];

  const drop = (propertyId: string, l: ListingRecord | undefined, reason: DropReason, detail: string) =>
    dropped.push({ propertyId, reference: l?.reference ?? null, reason, detail });

  /** Why a listing of this agency cannot be recommended, or null. */
  const rejection = (l: ListingRecord): [DropReason, string] | null => {
    if (l.status !== 'available') return ['not_available', `Status is ${l.status}.`];
    if (req.intent === 'rent') return ['rent_intent', 'The lead wants to rent; listings are for sale.'];
    if (!hasCriteria) return ['no_criteria', 'No requirements were extracted to match against.'];
    const fit = fitFailure(l, req, band);
    return fit ? [fit, fitDetail(fit, l, req, band)] : null;
  };

  for (const c of input.candidates) {
    const l = byId.get(c.propertyId);
    if (proposed.has(c.propertyId)) {
      drop(c.propertyId, l, 'repeated', 'Recommended more than once.');
      continue;
    }
    proposed.add(c.propertyId);

    if (seen && !seen.has(c.propertyId)) {
      drop(c.propertyId, l, 'not_seen_in_run', 'Not returned by any tool in this run.');
      continue;
    }
    if (!l) {
      drop(c.propertyId, l, 'not_found', 'No such listing.');
      continue;
    }
    if (l.agencyId !== agencyId) {
      drop(c.propertyId, l, 'other_agency', "Not one of this agency's listings.");
      continue;
    }
    const rejected = rejection(l);
    if (rejected) {
      drop(c.propertyId, l, rejected[0], rejected[1]);
      continue;
    }

    // Duplicates collapse to the earliest-listed copy that is itself recommendable.
    const canonical = [l, ...agencyListings.filter((o) => isPossibleDuplicate(l, o) && rejection(o) === null)].sort(
      (a, b) => a.listedAt.getTime() - b.listedAt.getTime() || a.reference.localeCompare(b.reference),
    )[0];
    const reason = c.reason.trim();
    if (canonical.id !== l.id) {
      drop(l.id, l, 'duplicate', `Duplicate of ${canonical.reference}, listed earlier.`);
      if (!keptIds.has(canonical.id)) {
        keptIds.add(canonical.id);
        kept.push({ listing: canonical, reason: reason.split(l.reference).join(canonical.reference) });
      }
      continue;
    }
    if (keptIds.has(l.id)) continue; // already kept as the canonical copy of an earlier duplicate
    keptIds.add(l.id);
    kept.push({ listing: l, reason });
  }

  if (req.prioritiseYield) {
    const yieldOf = (l: ListingRecord) => grossYieldPct(l.priceAed, l.annualRentAed);
    const known = kept.filter((k) => yieldOf(k.listing) !== null);
    const unknown = kept.filter((k) => yieldOf(k.listing) === null);
    known.sort((a, b) => (yieldOf(b.listing) ?? 0) - (yieldOf(a.listing) ?? 0)); // stable for ties
    kept.splice(0, kept.length, ...known, ...unknown);
  }

  for (const k of kept.slice(cap)) drop(k.listing.id, k.listing, 'over_cap', `Only the best ${cap} are recommended.`);

  return {
    kept: kept.slice(0, cap).map(({ listing, reason }) => ({
      propertyId: listing.id,
      reason: reason && reasonMatchesListing(reason, listing) ? reason : factualReason(listing),
      property: toPropertySnapshot(listing, computeListingFlags(listing, agencyListings)),
    })),
    dropped,
    budgetBand: band,
  };
}

/** Every listing of the agency that may be recommended for these requirements, best first (no cap). */
export function eligibleListings(listings: readonly ListingRecord[], requirements: ExtractedRequirements, agencyId: string): ListingRecord[] {
  const own = listings.filter((l) => l.agencyId === agencyId);
  const byId = new Map(own.map((l) => [l.id, l]));
  const { kept } = validateRecommendations({
    candidates: own.map((l) => ({ propertyId: l.id, reason: '' })),
    requirements,
    agencyId,
    listings: own,
    cap: Number.POSITIVE_INFINITY,
  });
  return kept.map((k) => byId.get(k.propertyId)!);
}

function fitDetail(reason: DropReason, l: ListingRecord, r: ExtractedRequirements, band: BudgetBand | null): string {
  switch (reason) {
    case 'area_mismatch':
      return `In ${l.area}, not ${r.locations.join(' or ')}.`;
    case 'bedrooms_mismatch':
      return `${l.bedrooms} bedrooms, wanted ${r.bedroomsMin ?? '?'}-${r.bedroomsMax ?? '?'}.`;
    case 'type_mismatch':
      return `A ${l.type}, wanted ${r.propertyType}.`;
    case 'over_budget':
      return `AED ${l.priceAed} is above the ceiling of AED ${band?.ceilingAed}.`;
    case 'under_budget':
      return `AED ${l.priceAed} is below the floor of AED ${band?.floorAed}.`;
    case 'price_suspect':
      return 'The price looks like a data-entry error (implausible yield or price per sqft).';
    case 'not_requested':
      return `The lead asked only about ${r.listingReferences.join(', ')}.`;
    default:
      return reason;
  }
}
