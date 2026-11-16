import { checkReasonClaims, parseAedAmounts } from './claim-check';
import { factualReason } from './matching';
import { byRef, loadSeedListings, MARINA_BAY_ID } from './seed-listings.fixture';

const all = loadSeedListings();
const marina = all.filter((l) => l.agencyId === MARINA_BAY_ID);
const ctx = { otherListings: marina, allowedAmountsAed: [2_000_000, 1_800_000, 2_100_000] };
const kinds = (issues: Array<{ kind: string }>) => issues.map((i) => i.kind);

describe('parseAedAmounts', () => {
  it('reads the formats reasons use', () => {
    expect(parseAedAmounts('asking AED 2,050,000').map((a) => a.valueAed)).toEqual([2_050_000]);
    expect(parseAedAmounts('priced at 2.05M').map((a) => a.valueAed)).toEqual([2_050_000]);
    expect(parseAedAmounts('about AED 2m').map((a) => a.valueAed)).toEqual([2_000_000]);
    expect(parseAedAmounts('AED 1.9 million').map((a) => a.valueAed)).toEqual([1_900_000]);
    expect(parseAedAmounts('rent of AED 150k').map((a) => a.valueAed)).toEqual([150_000]);
  });

  it('ignores sizes, price per square foot, unit numbers and percentages', () => {
    expect(parseAedAmounts('1,250 sqft, AED 1,640/sqft, unit 2304, 7.32% yield')).toEqual([]);
  });
});

describe('checkReasonClaims', () => {
  const mbr1001 = byRef(marina, 'MBR-1001');
  const mbr1002 = byRef(marina, 'MBR-1002');
  const mbr1022 = byRef(marina, 'MBR-1022');
  const mbr1006 = byRef(marina, 'MBR-1006');

  it.each([
    ['MBR-1001', 'MBR-1001 is a 2BR apartment in Marina Gate 1, Dubai Marina, asking AED 2,050,000 with a 7.32% gross yield. It is available.'],
    ['MBR-1002', 'MBR-1002 is a 2-bedroom apartment in Dubai Marina asking AED 1,890,000, with a gross yield of 6.61%. It is available.'],
    ['MBR-1022', 'MBR-1022 is a 2BR apartment in Marina Quays West, Dubai Marina, asking AED 2,099,000. Its rent is unknown, so no yield is available. It is available.'],
    ['MBR-1009', 'MBR-1009 is a 1BR apartment in Marina Gate 2, Dubai Marina, asking AED 1,450,000 with a 7.24% gross yield (est. rent AED 105,000). It is available.'],
    ['MBR-1001', '2BR in Marina Gate 1 at 2.05M, within the ~AED 2m budget, yielding 7.3%.'],
  ])('accepts the real recorded reason for %s', (ref, reason) => {
    expect(checkReasonClaims(reason, byRef(marina, ref), ctx)).toEqual([]);
  });

  it('accepts the code-generated factual reason for every Karim listing', () => {
    for (const l of marina) expect(checkReasonClaims(factualReason(l), l, ctx)).toEqual([]);
  });

  it('flags a yield more than 0.15 pp from the computed gross yield', () => {
    const issues = checkReasonClaims('Asking AED 2,050,000 with an 8.1% gross yield.', mbr1001, ctx);
    expect(issues).toEqual([
      { propertyId: mbr1001.id, reference: 'MBR-1001', kind: 'yield', claim: '8.1%', expected: '7.32%' },
    ]);
    expect(checkReasonClaims('Gross yield 7.45%.', mbr1001, ctx)).toEqual([]);
    expect(kinds(checkReasonClaims('Gross yield 7.48%.', mbr1001, ctx))).toEqual(['yield']);
  });

  it('flags a yield quoted for a listing with no rent', () => {
    expect(checkReasonClaims('Gross yield 6.5%, available.', mbr1022, ctx)).toEqual([
      expect.objectContaining({ kind: 'yield', claim: '6.5%', expected: 'no yield (rent unknown)' }),
    ]);
  });

  it('ignores percentages that are not about yield', () => {
    expect(checkReasonClaims('About 5% under the budget, gross yield 7.32%.', mbr1001, ctx)).toEqual([]);
  });

  it('flags a wrong price in any format', () => {
    expect(checkReasonClaims('Asking AED 1,950,000.', mbr1001, ctx)).toEqual([
      expect.objectContaining({ kind: 'price', claim: 'AED 1,950,000', expected: 'price AED 2,050,000, rent AED 150,000' }),
    ]);
    expect(kinds(checkReasonClaims('Priced at 2.5M.', mbr1001, ctx))).toEqual(['price']);
    expect(kinds(checkReasonClaims('Priced at AED 3m.', mbr1001, ctx))).toEqual(['price']);
  });

  it('accepts rent, budget figures and the gap to the budget', () => {
    expect(checkReasonClaims('Rent AED 150,000; AED 110,000 under the AED 2,000,000 budget? No: 50,000 over.', mbr1001, ctx)).toEqual([
      expect.objectContaining({ kind: 'price', claim: 'AED 110,000' }),
    ]);
    expect(checkReasonClaims('AED 110,000 under the 2M budget.', mbr1002, ctx)).toEqual([]);
  });

  it('flags a wrong bedroom count, in digits, words or studio', () => {
    expect(kinds(checkReasonClaims('A 3BR apartment.', mbr1001, ctx))).toEqual(['bedrooms']);
    expect(kinds(checkReasonClaims('A three-bedroom apartment.', mbr1001, ctx))).toEqual(['bedrooms']);
    expect(kinds(checkReasonClaims('A studio.', mbr1001, ctx))).toEqual(['bedrooms']);
    expect(checkReasonClaims('A two-bedroom, 2 bed, 2BR home.', mbr1001, ctx)).toEqual([]);
  });

  it('flags a building or area that belongs to another listing', () => {
    expect(checkReasonClaims('A 2BR in Princess Tower.', mbr1001, ctx)).toEqual([
      expect.objectContaining({ kind: 'location', claim: 'Princess Tower', expected: 'Marina Gate 1, Dubai Marina' }),
    ]);
    expect(kinds(checkReasonClaims('A 2BR in Jumeirah Lake Towers.', mbr1001, ctx))).toEqual(['location']);
    expect(kinds(checkReasonClaims('A 2BR in Marina Gate 2.', mbr1001, ctx))).toEqual(['location']);
  });

  it('flags a claim about another listing reference', () => {
    expect(checkReasonClaims('Same as MBR-1024 but cheaper.', mbr1001, ctx)).toEqual([
      expect.objectContaining({ kind: 'other_listing', claim: 'MBR-1024', expected: 'MBR-1001' }),
    ]);
  });

  it('flags "available" for a listing that is not, but not negated uses', () => {
    expect(checkReasonClaims('MBR-1006 is a 2BR in Silverene Tower A. It is available.', mbr1006, ctx)).toEqual([
      expect.objectContaining({ kind: 'status', claim: 'available', expected: 'reserved' }),
    ]);
    expect(checkReasonClaims('It is reserved; no yield figure is available.', mbr1006, ctx)).toEqual([]);
    expect(kinds(checkReasonClaims('It is reserved.', mbr1002, ctx))).toEqual(['status']);
  });

  it('reports each distinct problem once', () => {
    const issues = checkReasonClaims('MBR-1002 is a 3BR in Princess Tower at AED 1,890,000 with a 9% yield.', mbr1001, ctx);
    expect(kinds(issues).sort()).toEqual(['bedrooms', 'location', 'other_listing', 'price', 'yield']);
  });
});
