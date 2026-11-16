/**
 * Test fixture: the real seed listings (seed/properties.json) as ListingRecords, with the same
 * stable ids the seeder writes. Test-only; not imported by production code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableId } from '../../db/stable-id';
import type { ListingRecord } from './listing-facts';

interface SeedProperty {
  agency: string;
  reference: string;
  title: string;
  area: string;
  building: string | null;
  type: ListingRecord['type'];
  bedrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  status: ListingRecord['status'];
  listedDaysAgo: number;
  description: string;
}

/** A fixed "now" so listedAt is deterministic. */
export const FIXTURE_NOW = new Date('2026-10-16T06:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

export const MARINA_BAY_ID = stableId('agency', 'marina-bay');
export const DESERT_KEY_ID = stableId('agency', 'desert-key');

export function loadSeedListings(): ListingRecord[] {
  const file = join(__dirname, '..', '..', '..', '..', 'seed', 'properties.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as SeedProperty[];
  return rows.map((p) => ({
    id: stableId('property', p.reference),
    agencyId: stableId('agency', p.agency),
    reference: p.reference,
    title: p.title,
    area: p.area,
    building: p.building,
    type: p.type,
    bedrooms: p.bedrooms,
    sizeSqft: p.sizeSqft,
    priceAed: p.priceAed,
    annualRentAed: p.annualRentAed,
    status: p.status,
    description: p.description,
    listedAt: new Date(FIXTURE_NOW.getTime() - p.listedDaysAgo * DAY_MS),
  }));
}

export function byRef(listings: ListingRecord[], reference: string): ListingRecord {
  const found = listings.find((l) => l.reference === reference);
  if (!found) throw new Error(`No seed listing ${reference}`);
  return found;
}
