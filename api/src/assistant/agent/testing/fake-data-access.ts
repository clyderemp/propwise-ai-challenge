/** Test-only: an in-memory AgentDataAccess over the real seed listings, scoped like the services. */
import { loadSeedListings } from '../../domain/seed-listings.fixture';
import type { ListingRecord } from '../../domain/listing-facts';
import type { AgentDataAccess, LeadTaskSummary, ListingQuery } from '../tools';

export class FakeDataAccess implements AgentDataAccess {
  readonly listings: ListingRecord[] = loadSeedListings();
  readonly calls: Array<{ method: keyof AgentDataAccess; agencyId: string; arg?: unknown }> = [];
  tasksByLead = new Map<string, LeadTaskSummary[]>();
  failWith: Partial<Record<keyof AgentDataAccess, Error>> = {};

  async agencyListings(agencyId: string): Promise<ListingRecord[]> {
    this.track('agencyListings', agencyId);
    return this.listings.filter((l) => l.agencyId === agencyId);
  }

  async searchListings(agencyId: string, query: ListingQuery): Promise<{ items: ListingRecord[]; total: number }> {
    this.track('searchListings', agencyId, query);
    const all = this.listings
      .filter((l) => l.agencyId === agencyId)
      .filter((l) => query.area === undefined || l.area.toLowerCase() === query.area.toLowerCase())
      .filter((l) => query.type === undefined || l.type === query.type)
      .filter((l) => query.status === undefined || l.status === query.status)
      .filter((l) => query.minBedrooms === undefined || l.bedrooms >= query.minBedrooms)
      .filter((l) => query.maxBedrooms === undefined || l.bedrooms <= query.maxBedrooms)
      .filter((l) => query.minPriceAed === undefined || l.priceAed >= query.minPriceAed)
      .filter((l) => query.maxPriceAed === undefined || l.priceAed <= query.maxPriceAed)
      .sort((a, b) => a.priceAed - b.priceAed || a.id.localeCompare(b.id));
    return { items: all.slice(0, query.limit), total: all.length };
  }

  async getListing(agencyId: string, propertyId: string): Promise<ListingRecord | null> {
    this.track('getListing', agencyId, propertyId);
    return this.listings.find((l) => l.id === propertyId && l.agencyId === agencyId) ?? null;
  }

  async leadTasks(agencyId: string, leadId: string): Promise<LeadTaskSummary[]> {
    this.track('leadTasks', agencyId, leadId);
    return this.tasksByLead.get(leadId) ?? [];
  }

  private track(method: keyof AgentDataAccess, agencyId: string, arg?: unknown): void {
    this.calls.push({ method, agencyId, arg });
    const err = this.failWith[method];
    if (err) throw err;
  }
}
