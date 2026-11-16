import { AssistantRequirements, ExtractedRequirements, Requirements } from '../assistant.types';

/** The contract's requirements for a failed run (TASK.md). */
export function emptyRequirements(): Requirements {
  return {
    locations: [],
    bedrooms: null,
    budgetAed: { min: null, max: null },
    propertyType: null,
    intent: 'unknown',
    preferences: [],
  };
}

/** A Phase A extraction with nothing in it. */
export function emptyExtractedRequirements(): ExtractedRequirements {
  return {
    locations: [],
    bedroomsMin: null,
    bedroomsMax: null,
    budgetMinAed: null,
    budgetMaxAed: null,
    budgetIsApproximate: false,
    propertyType: null,
    intent: 'unknown',
    preferences: [],
    prioritiseYield: false,
    listingReferences: [],
  };
}

function validAmount(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Budget with invalid values nulled: negative, non-integer, or a minimum above the maximum. */
export function sanitizeBudget(minAed: number | null, maxAed: number | null): { min: number | null; max: number | null } {
  const max = validAmount(maxAed);
  let min = validAmount(minAed);
  if (min !== null && max !== null && min > max) min = null;
  return { min, max };
}

/** Maps the frozen extraction to the contract shape, plus the extra fields. */
export function toContractRequirements(x: ExtractedRequirements): AssistantRequirements {
  const single = x.bedroomsMin !== null && x.bedroomsMin === x.bedroomsMax;
  return {
    locations: [...x.locations],
    bedrooms: single ? x.bedroomsMin : null,
    budgetAed: sanitizeBudget(x.budgetMinAed, x.budgetMaxAed),
    propertyType: x.propertyType,
    intent: x.intent,
    preferences: [...x.preferences],
    bedroomsRange: { min: x.bedroomsMin, max: x.bedroomsMax },
    budgetIsApproximate: x.budgetIsApproximate,
    prioritiseYield: x.prioritiseYield,
  };
}

/**
 * True when there is anything to search listings with. When false, the agent skips the listing
 * search entirely and recommends nothing (plan section 7, ruling 4).
 */
export function hasSearchCriteria(x: ExtractedRequirements): boolean {
  return (
    x.locations.length > 0 ||
    x.bedroomsMin !== null ||
    x.bedroomsMax !== null ||
    x.budgetMinAed !== null ||
    x.budgetMaxAed !== null ||
    x.propertyType !== null ||
    x.listingReferences.length > 0
  );
}
