import { AssistantPropertyType, ListingFlag, PropertySnapshot } from '../assistant.types';

/**
 * Facts computed from a listing row so the model never does arithmetic and code can judge
 * data quality. Pure; callers pass rows already loaded (and agency-scoped) from the database.
 */

export interface ListingRecord {
  id: string;
  agencyId: string;
  reference: string;
  title: string;
  area: string;
  building: string | null;
  type: AssistantPropertyType;
  /** 0 = studio. */
  bedrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  status: 'available' | 'reserved' | 'sold';
  /** Free text typed by whoever listed it: untrusted. */
  description: string;
  listedAt: Date;
}

/** The Property entity's shape, structurally (so this module does not import the ORM). */
export interface PropertyLike extends Omit<ListingRecord, 'agencyId' | 'building' | 'annualRentAed'> {
  agency: { id: string };
  building?: string | null;
  annualRentAed?: number | null;
}

export function toListingRecord(p: PropertyLike): ListingRecord {
  return {
    id: p.id,
    agencyId: p.agency.id,
    reference: p.reference,
    title: p.title,
    area: p.area,
    building: p.building ?? null,
    type: p.type,
    bedrooms: p.bedrooms,
    sizeSqft: p.sizeSqft,
    priceAed: p.priceAed,
    annualRentAed: p.annualRentAed ?? null,
    status: p.status,
    description: p.description,
    listedAt: p.listedAt,
  };
}

/** Gross yield, annualRentAed / priceAed, as a percentage rounded to 2 decimals. */
export function grossYieldPct(priceAed: number, annualRentAed: number | null): number | null {
  if (annualRentAed === null || !(priceAed > 0)) return null;
  return Math.round((annualRentAed / priceAed) * 10_000) / 100;
}

export function pricePerSqft(l: Pick<ListingRecord, 'priceAed' | 'sizeSqft'>): number | null {
  return l.sizeSqft > 0 ? l.priceAed / l.sizeSqft : null;
}

export const SUSPECT_YIELD_ABOVE_PCT = 20;
export const SUSPECT_YIELD_BELOW_PCT = 1;
export const SUSPECT_PRICE_PER_SQFT_BELOW = 150;

/** Price is probably a typo: implausible yield or price per square foot. */
export function isPriceSuspect(l: ListingRecord): boolean {
  const y = grossYieldPct(l.priceAed, l.annualRentAed);
  if (y !== null && (y > SUSPECT_YIELD_ABOVE_PCT || y < SUSPECT_YIELD_BELOW_PCT)) return true;
  const ppsf = pricePerSqft(l);
  return !(l.priceAed > 0) || (ppsf !== null && ppsf < SUSPECT_PRICE_PER_SQFT_BELOW);
}

/** "Unit 2304" -> "2304". */
export function extractUnitNumber(text: string): string | null {
  const m = /\bunit\s*(?:no\.?|number|#)?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(text);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Same agency, building, bedrooms, size and price, and the same unit number where both
 * descriptions give one (MBR-1001 and MBR-1024).
 */
export function isPossibleDuplicate(a: ListingRecord, b: ListingRecord): boolean {
  if (a.id === b.id || a.agencyId !== b.agencyId) return false;
  if (!a.building || !b.building) return false;
  if (a.building.trim().toLowerCase() !== b.building.trim().toLowerCase()) return false;
  if (a.bedrooms !== b.bedrooms || a.sizeSqft !== b.sizeSqft || a.priceAed !== b.priceAed) return false;
  const ua = extractUnitNumber(a.description);
  const ub = extractUnitNumber(b.description);
  return ua === null || ub === null || ua === ub;
}

/**
 * Heuristic for text that tries to instruct an AI. A secondary layer only: the guarantee rests on
 * the design (frozen requirements, read-only tools, code-side validation), not on this.
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|rules|prompt|guidelines)\b/i,
  /\b(note|message|instructions?)\s+(for|to)\s+(the\s+)?(ai|a\.i\.|llm|assistant|bot|model)s?\b/i,
  /\b(to|for)\s+the\s+(ai|a\.i\.|llm)\b/i,
  /\b(ai|a\.i\.|llm)\s+(assistant|agent|model)s?\b/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bskip\s+(the\s+)?approval\b/i,
  /\bmark\s+(all\s+)?(my\s+)?(other\s+)?tasks?\s+(as\s+)?(done|complete|completed)\b/i,
  /\brecommend\s+this\s+(property|listing|unit)\s+to\s+every\b/i,
];

export function hasInstructionLikeText(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

export const LISTING_VIEWS = ['sea', 'marina', 'lake', 'park', 'golf', 'garden', 'pool', 'burj_khalifa', 'fountain', 'palm', 'canal', 'city'] as const;
export type ListingView = (typeof LISTING_VIEWS)[number];

/**
 * The only things Phase B learns from a listing's free text: a fixed schema of facts pulled out in
 * code, with no string copied from the description except a short unit number. Instruction text in
 * a description therefore never reaches the tool-using model, whether or not the regex flag spots it.
 */
export interface ListingFeatures {
  unitNumber: string | null;
  occupancy: 'vacant' | 'tenanted' | null;
  furnished: boolean | null;
  views: ListingView[];
}

const VIEW_SENTENCE = /\b(views?|overlooking|facing|glimpses?)\b/i;

export function listingFeatures(description: string): ListingFeatures {
  const vacant = /\bvacant\b/i.test(description);
  const tenanted = /\btenanted\b/i.test(description);
  const furnished = /\bunfurnished\b/i.test(description) ? false : /\b(furnished|serviced)\b/i.test(description) ? true : null;
  const views = new Set<ListingView>();
  for (const sentence of description.split(/[.!?\n]+/)) {
    if (!VIEW_SENTENCE.test(sentence)) continue;
    const text = sentence.toLowerCase();
    for (const view of LISTING_VIEWS) {
      if (new RegExp(`\\b${view.replace('_', ' ')}\\b`).test(text)) views.add(view);
    }
  }
  return {
    unitNumber: extractUnitNumber(description),
    occupancy: vacant === tenanted ? null : vacant ? 'vacant' : 'tenanted',
    furnished,
    views: LISTING_VIEWS.filter((v) => views.has(v)),
  };
}

/** Flags in a fixed order. `agencyListings` is the agency's listings, used for duplicate detection. */
export function computeListingFlags(l: ListingRecord, agencyListings: readonly ListingRecord[]): ListingFlag[] {
  const flags: ListingFlag[] = [];
  if (l.annualRentAed === null) flags.push('rent_missing');
  if (isPriceSuspect(l)) flags.push('price_suspect');
  if (agencyListings.some((o) => isPossibleDuplicate(l, o))) flags.push('possible_duplicate');
  if (hasInstructionLikeText(l.description)) flags.push('instruction_like_text');
  return flags;
}

export function toPropertySnapshot(l: ListingRecord, flags: ListingFlag[]): PropertySnapshot {
  return {
    reference: l.reference,
    title: l.title,
    area: l.area,
    building: l.building,
    type: l.type,
    bedrooms: l.bedrooms,
    sizeSqft: l.sizeSqft,
    priceAed: l.priceAed,
    annualRentAed: l.annualRentAed,
    grossYieldPct: grossYieldPct(l.priceAed, l.annualRentAed),
    status: l.status,
    flags: [...flags],
  };
}
