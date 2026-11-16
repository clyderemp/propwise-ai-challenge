import { CandidateRecommendation, ExtractedRequirements } from '../assistant.types';
import { ListingRecord } from './listing-facts';
import { budgetBand, eligibleListings, factualReason, MAX_RECOMMENDATIONS, reconcileSummary, validateRecommendations } from './matching';
import { emptyExtractedRequirements } from './requirements';
import { byRef, DESERT_KEY_ID, loadSeedListings, MARINA_BAY_ID } from './seed-listings.fixture';

const all = loadSeedListings();
const marinaBay = all.filter((l) => l.agencyId === MARINA_BAY_ID);
const ref = (r: string) => byRef(all, r);
const id = (r: string) => ref(r).id;
const refsOf = (rows: Array<{ propertyId: string }>) =>
  rows.map((r) => all.find((l) => l.id === r.propertyId)?.reference ?? r.propertyId);

const req = (over: Partial<ExtractedRequirements>): ExtractedRequirements => ({ ...emptyExtractedRequirements(), ...over });

const karim = req({
  locations: ['Dubai Marina'],
  bedroomsMin: 2,
  bedroomsMax: 2,
  budgetMaxAed: 2_000_000,
  budgetIsApproximate: true,
  propertyType: 'apartment',
  intent: 'buy',
  preferences: ['good rental yield'],
  prioritiseYield: true,
});

const lina = req({
  locations: ['Dubai Marina'],
  bedroomsMin: 5,
  bedroomsMax: 5,
  budgetMaxAed: 900_000,
  propertyType: 'villa',
  intent: 'buy',
});

const yousef = req({
  locations: ['Dubai Marina'],
  bedroomsMin: 3,
  bedroomsMax: 3,
  budgetMaxAed: 4_000_000,
  propertyType: 'apartment',
  intent: 'buy',
});

const cands = (...refs: string[]): CandidateRecommendation[] => refs.map((r) => ({ propertyId: id(r), reason: `model says ${r}` }));

function run(candidates: CandidateRecommendation[], requirements: ExtractedRequirements, extra: Partial<Parameters<typeof validateRecommendations>[0]> = {}) {
  return validateRecommendations({
    candidates,
    requirements,
    agencyId: MARINA_BAY_ID,
    listings: all,
    agencyListings: marinaBay,
    ...extra,
  });
}

describe('budgetBand', () => {
  it('approximate max: 0.90x to 1.05x ("around 2M" -> 1.8M..2.1M)', () => {
    expect(budgetBand(karim)).toEqual({ floorAed: 1_800_000, ceilingAed: 2_100_000, approximate: true });
  });

  it('"up to" / "under": no tolerance and no floor', () => {
    expect(budgetBand(yousef)).toEqual({ floorAed: null, ceilingAed: 4_000_000, approximate: false });
  });

  it('a stated minimum is kept as the floor', () => {
    expect(budgetBand(req({ budgetMinAed: 1_000_000, budgetMaxAed: 1_500_000 }))).toEqual({
      floorAed: 1_000_000,
      ceilingAed: 1_500_000,
      approximate: false,
    });
    expect(budgetBand(req({ budgetMinAed: 1_000_000, budgetMaxAed: 2_000_000, budgetIsApproximate: true }))).toEqual({
      floorAed: 1_000_000,
      ceilingAed: 2_100_000,
      approximate: true,
    });
  });

  it('is null with no budget, and ignores invalid values', () => {
    expect(budgetBand(req({}))).toBeNull();
    expect(budgetBand(req({ budgetMaxAed: -1 }))).toBeNull();
  });
});

describe('validateRecommendations: Karim (2BR apartment, Dubai Marina, around 2M, yield)', () => {
  it('eligible set over the whole seed is exactly MBR-1001, MBR-1002, MBR-1022, yield first', () => {
    const r = eligibleListings(all, karim, MARINA_BAY_ID);
    expect(r.map((l) => l.reference)).toEqual(['MBR-1001', 'MBR-1002', 'MBR-1022']);
  });

  it('keeps the fits and drops every trap with a reason', () => {
    const r = run(
      cands('MBR-1022', 'MBR-1024', 'MBR-1005', 'MBR-1006', 'MBR-1002', 'MBR-1023', 'MBR-1007', 'MBR-1003', 'MBR-1001', 'DKP-2001', 'MBR-1019'),
      karim,
    );
    expect(refsOf(r.kept)).toEqual(['MBR-1001', 'MBR-1002', 'MBR-1022']);
    const dropped = Object.fromEntries(r.dropped.map((d) => [d.reference ?? d.propertyId, d.reason]));
    expect(dropped).toEqual({
      'MBR-1024': 'duplicate',
      'MBR-1005': 'not_available',
      'MBR-1006': 'not_available',
      'MBR-1023': 'under_budget',
      'MBR-1007': 'under_budget',
      'MBR-1003': 'over_budget',
      'DKP-2001': 'other_agency',
      'MBR-1019': 'area_mismatch',
    });
    expect(r.budgetBand).toEqual({ floorAed: 1_800_000, ceilingAed: 2_100_000, approximate: true });
  });

  it('attaches a re-read snapshot with true numbers', () => {
    const r = run(cands('MBR-1001'), karim);
    expect(r.kept[0]).toEqual({
      propertyId: id('MBR-1001'),
      reason: 'model says MBR-1001',
      property: expect.objectContaining({ reference: 'MBR-1001', priceAed: 2_050_000, grossYieldPct: 7.32, status: 'available', flags: ['possible_duplicate'] }),
    });
  });

  it('MBR-1024 alone is replaced by the earlier-listed MBR-1001', () => {
    const r = run([{ propertyId: id('MBR-1024'), reason: 'MBR-1024 has a 7.32% yield' }], karim);
    expect(refsOf(r.kept)).toEqual(['MBR-1001']);
    expect(r.kept[0].reason).toBe('MBR-1001 has a 7.32% yield');
    expect(r.dropped).toEqual([expect.objectContaining({ reference: 'MBR-1024', reason: 'duplicate' })]);
  });

  it('flags a price typo even when it is inside the budget', () => {
    const typo: ListingRecord = { ...ref('MBR-1023'), priceAed: 1_900_000, annualRentAed: 900_000 }; // 47% yield
    const r = validateRecommendations({ candidates: [{ propertyId: typo.id, reason: 'r' }], requirements: karim, agencyId: MARINA_BAY_ID, listings: [typo] });
    expect(r.kept).toEqual([]);
    expect(r.dropped[0].reason).toBe('price_suspect');
  });

  it('orders known yields highest first and unknown yield last when the lead wants yield', () => {
    const r = run(cands('MBR-1022', 'MBR-1002', 'MBR-1001'), karim);
    expect(refsOf(r.kept)).toEqual(['MBR-1001', 'MBR-1002', 'MBR-1022']);
  });

  it("keeps the model's order when yield is not a priority", () => {
    const r = run(cands('MBR-1022', 'MBR-1002', 'MBR-1001'), { ...karim, prioritiseYield: false });
    expect(refsOf(r.kept)).toEqual(['MBR-1022', 'MBR-1002', 'MBR-1001']);
  });
});

describe('validateRecommendations: no fit', () => {
  it('Lina (5BR villa in Dubai Marina under 900k) gets nothing', () => {
    expect(eligibleListings(all, lina, MARINA_BAY_ID)).toEqual([]);
    const r = run(cands('MBR-1012', 'MBR-1019', 'MBR-1010'), lina);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(3);
  });

  it('rent intent drops everything: listings are for sale (Priya)', () => {
    const priya = req({ locations: ['Business Bay'], bedroomsMin: 2, bedroomsMax: 2, budgetMaxAed: 120_000, intent: 'rent' });
    const r = run(cands('MBR-1016'), priya);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0].reason).toBe('rent_intent');
    expect(eligibleListings(all, priya, MARINA_BAY_ID)).toEqual([]);
  });

  it('no criteria drops everything (Hassan: "Hi")', () => {
    const r = run(cands('MBR-1001'), req({}));
    expect(r.kept).toEqual([]);
    expect(r.dropped[0].reason).toBe('no_criteria');
    expect(r.budgetBand).toBeNull();
  });
});

describe('validateRecommendations: Yousef (3BR, same area, up to 4M)', () => {
  it('eligible is exactly MBR-1011', () => {
    expect(eligibleListings(all, yousef, MARINA_BAY_ID).map((l) => l.reference)).toEqual(['MBR-1011']);
    expect(eligibleListings(all, { ...yousef, propertyType: null }, MARINA_BAY_ID).map((l) => l.reference)).toEqual(['MBR-1011']);
  });
});

describe('validateRecommendations: other leads', () => {
  it('James (1-bed in JLT or the Marina, up to 1.5M) -> MBR-1009', () => {
    const james = req({ locations: ['Jumeirah Lake Towers', 'Dubai Marina'], bedroomsMin: 1, bedroomsMax: 1, budgetMaxAed: 1_500_000, intent: 'buy' });
    expect(eligibleListings(all, james, MARINA_BAY_ID).map((l) => l.reference)).toEqual(['MBR-1009']);
  });

  it('Alex (studio or 1-bed in JVC under 900k) -> nothing for Marina Bay (DKP-2003 is another agency)', () => {
    const alex = req({ locations: ['Jumeirah Village Circle'], bedroomsMin: 0, bedroomsMax: 1, budgetMaxAed: 900_000, intent: 'buy' });
    expect(eligibleListings(all, alex, MARINA_BAY_ID)).toEqual([]);
    expect(eligibleListings(all, alex, DESERT_KEY_ID).map((l) => l.reference)).toEqual(['DKP-2003']);
  });

  it('Nadia (Desert Key, 2BR Dubai Marina, budget 2M exactly) sees only Desert Key listings', () => {
    const nadia = req({ locations: ['Dubai Marina'], bedroomsMin: 2, bedroomsMax: 2, budgetMaxAed: 2_000_000, intent: 'buy' });
    expect(eligibleListings(all, nadia, DESERT_KEY_ID).map((l) => l.reference)).toEqual(['DKP-2001']);
  });

  it('matches area names case-insensitively', () => {
    expect(eligibleListings(all, { ...karim, locations: ['dubai marina'] }, MARINA_BAY_ID)).toHaveLength(3);
  });

  it('a lead naming only a listing code gets that listing if it is available', () => {
    const ask = req({ listingReferences: ['MBR-1009'] });
    const r = run(cands('MBR-1009', 'MBR-1010'), ask);
    expect(refsOf(r.kept)).toEqual(['MBR-1009']);
    expect(r.dropped).toEqual([expect.objectContaining({ reference: 'MBR-1010', reason: 'not_requested' })]);
    expect(run(cands('MBR-1005'), req({ listingReferences: ['MBR-1005'] })).dropped[0].reason).toBe('not_available');
  });

  it('a named listing code still has to fit the criteria stated in the same message', () => {
    // "Is MBR-1009 available? I need a 2-bed under AED 1M": MBR-1009 is a 1BR at AED 1.45M.
    const ask = req({ listingReferences: ['MBR-1009'], bedroomsMin: 2, bedroomsMax: 2, budgetMaxAed: 1_000_000, intent: 'buy' });
    const r = run(cands('MBR-1009'), ask);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([expect.objectContaining({ reference: 'MBR-1009', reason: 'bedrooms_mismatch' })]);
  });

  it('a named listing code that fits the stated criteria is kept', () => {
    const ask = req({ listingReferences: ['MBR-1009'], bedroomsMin: 1, bedroomsMax: 1, budgetMaxAed: 1_500_000, intent: 'buy' });
    expect(refsOf(run(cands('MBR-1009'), ask).kept)).toEqual(['MBR-1009']);
  });
});

describe('validateRecommendations: integrity', () => {
  it('drops ids never seen in a tool output of this run', () => {
    const r = run(cands('MBR-1001', 'MBR-1002'), karim, { seenPropertyIds: new Set([id('MBR-1002')]) });
    expect(refsOf(r.kept)).toEqual(['MBR-1002']);
    expect(r.dropped).toEqual([expect.objectContaining({ propertyId: id('MBR-1001'), reason: 'not_seen_in_run' })]);
  });

  it('drops invented ids and repeats', () => {
    const r = run([{ propertyId: 'not-a-real-id', reason: 'x' }, ...cands('MBR-1001', 'MBR-1001')], karim);
    expect(refsOf(r.kept)).toEqual(['MBR-1001']);
    expect(r.dropped.map((d) => d.reason)).toEqual(['not_found', 'repeated']);
    expect(r.dropped[0].reference).toBeNull();
  });

  it(`caps at ${MAX_RECOMMENDATIONS}`, () => {
    const wide = req({ locations: ['Dubai Marina'], intent: 'buy' });
    const r = run(cands('MBR-1001', 'MBR-1002', 'MBR-1003', 'MBR-1004', 'MBR-1007', 'MBR-1008', 'MBR-1009'), wide);
    expect(r.kept).toHaveLength(MAX_RECOMMENDATIONS);
    expect(r.dropped.map((d) => d.reason)).toEqual(['over_cap', 'over_cap']);
  });

  it('fills an empty model reason with a factual one', () => {
    const r = run([{ propertyId: id('MBR-1002'), reason: '  ' }], karim);
    expect(r.kept[0].reason).toMatch(/Princess Tower|1,890,000|6\.61/);
  });

  it('every kept listing is available, in the agency, and passes the fit', () => {
    const r = run(all.map((l) => ({ propertyId: l.id, reason: 'r' })), karim);
    for (const k of r.kept) {
      const l = all.find((x) => x.id === k.propertyId)!;
      expect(l.agencyId).toBe(MARINA_BAY_ID);
      expect(l.status).toBe('available');
    }
  });
});

describe('validateRecommendations: reasons are checked against the re-read row', () => {
  it('replaces a reason whose figures do not match the listing with the factual one', () => {
    const r = run([{ propertyId: id('MBR-1022'), reason: '7.1% yield at AED 1.9M, available.' }], karim);
    expect(r.kept[0].reason).toBe(factualReason(ref('MBR-1022')));
  });

  it('keeps a reason whose figures match', () => {
    const reason = 'MBR-1002 asks AED 1,890,000 with a 6.61% gross yield.';
    expect(run([{ propertyId: id('MBR-1002'), reason }], karim).kept[0].reason).toBe(reason);
  });

  it('keeps a correct reason that also quotes the budget, the monthly rent and the price per sqft', () => {
    const reason = 'MBR-1002 asks AED 1,890,000, AED 110,000 under the AED 2M budget, with rent of about AED 10,400 a month (AED 1,340/sqft).';
    expect(run([{ propertyId: id('MBR-1002'), reason }], karim).kept[0].reason).toBe(reason);
  });

  it('uses the same claim check as self-verification, so a wrong bedroom count is replaced too', () => {
    const r = run([{ propertyId: id('MBR-1002'), reason: 'A 3BR asking AED 1,890,000.' }], karim);
    expect(r.kept[0].reason).toBe(factualReason(ref('MBR-1002')));
  });
});

describe('reconcileSummary', () => {
  const kept = run(cands('MBR-1001', 'MBR-1002'), karim).kept;

  it('leaves the summary alone when nothing proposed was dropped for a fit or data reason', () => {
    expect(reconcileSummary('Karim wants a 2BR. MBR-1024 duplicates MBR-1001.', kept, [{ propertyId: 'x', reference: 'MBR-1024', reason: 'duplicate', detail: '' }])).toBe(
      'Karim wants a 2BR. MBR-1024 duplicates MBR-1001.',
    );
  });

  it('removes sentences that name a dropped listing and lists the kept ones from the data', () => {
    const out = reconcileSummary(
      'Karim wants a 2BR in Dubai Marina around AED 2M. MBR-1007 is the best value at AED 1.65M. MBR-1001 has a 7.32% yield.',
      kept,
      [{ propertyId: id('MBR-1007'), reference: 'MBR-1007', reason: 'under_budget', detail: '' }],
    );
    expect(out).not.toContain('best value');
    expect(out).toContain('Karim wants a 2BR in Dubai Marina around AED 2M.');
    expect(out).toContain('MBR-1001 has a 7.32% yield.');
    expect(out).toContain('Recommended after server checks: MBR-1001 (AED 2,050,000, gross yield 7.32%), MBR-1002 (AED 1,890,000, gross yield 6.61%).');
  });

  it('says plainly when no listing survived', () => {
    const out = reconcileSummary('MBR-1007 is perfect.', [], [{ propertyId: id('MBR-1007'), reference: 'MBR-1007', reason: 'under_budget', detail: '' }]);
    expect(out).toBe('No suggested listing passed the server checks.');
  });
});
