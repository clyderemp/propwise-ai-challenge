import { AgentRunError, ExtractedRequirements } from '../assistant.types';
import { emptyExtractedRequirements, emptyRequirements, hasSearchCriteria, toContractRequirements } from './requirements';

const base = (over: Partial<ExtractedRequirements> = {}): ExtractedRequirements => ({
  ...emptyExtractedRequirements(),
  ...over,
});

describe('emptyRequirements', () => {
  it('is exactly the failed-run shape from TASK.md', () => {
    expect(emptyRequirements()).toEqual({
      locations: [],
      bedrooms: null,
      budgetAed: { min: null, max: null },
      propertyType: null,
      intent: 'unknown',
      preferences: [],
    });
  });

  it('returns a fresh object each time', () => {
    const a = emptyRequirements();
    a.locations.push('x');
    expect(emptyRequirements().locations).toEqual([]);
  });
});

describe('toContractRequirements', () => {
  it('maps a single bedroom count and an approximate budget (Karim)', () => {
    const r = toContractRequirements(
      base({
        locations: ['Dubai Marina'],
        bedroomsMin: 2,
        bedroomsMax: 2,
        budgetMaxAed: 2_000_000,
        budgetIsApproximate: true,
        propertyType: 'apartment',
        intent: 'buy',
        preferences: ['good rental yield'],
        prioritiseYield: true,
      }),
    );
    expect(r).toEqual({
      locations: ['Dubai Marina'],
      bedrooms: 2,
      budgetAed: { min: null, max: 2_000_000 },
      propertyType: 'apartment',
      intent: 'buy',
      preferences: ['good rental yield'],
      bedroomsRange: { min: 2, max: 2 },
      budgetIsApproximate: true,
      prioritiseYield: true,
    });
  });

  it('reports bedrooms null for a range but keeps the range (Alex: studio or 1-bed)', () => {
    const r = toContractRequirements(base({ bedroomsMin: 0, bedroomsMax: 1 }));
    expect(r.bedrooms).toBeNull();
    expect(r.bedroomsRange).toEqual({ min: 0, max: 1 });
  });

  it('treats a lone minimum as a single value only when max is null', () => {
    expect(toContractRequirements(base({ bedroomsMin: 3, bedroomsMax: null })).bedrooms).toBeNull();
    expect(toContractRequirements(base({ bedroomsMin: 0, bedroomsMax: 0 })).bedrooms).toBe(0);
  });

  it('nulls invalid budgets: negative, non-integer, or min > max', () => {
    expect(toContractRequirements(base({ budgetMinAed: -5, budgetMaxAed: 100 })).budgetAed).toEqual({ min: null, max: 100 });
    expect(toContractRequirements(base({ budgetMaxAed: 1.5 })).budgetAed).toEqual({ min: null, max: null });
    expect(toContractRequirements(base({ budgetMinAed: 300, budgetMaxAed: 200 })).budgetAed).toEqual({ min: null, max: 200 });
  });
});

describe('hasSearchCriteria', () => {
  it('is false when nothing was extracted (Hassan: "Hi")', () => {
    expect(hasSearchCriteria(base())).toBe(false);
  });

  it('is false for preferences or intent alone', () => {
    expect(hasSearchCriteria(base({ intent: 'buy', preferences: ['good rental yield'] }))).toBe(false);
  });

  it.each<[string, Partial<ExtractedRequirements>]>([
    ['location', { locations: ['Dubai Marina'] }],
    ['bedrooms', { bedroomsMin: 0, bedroomsMax: 0 }],
    ['budget max', { budgetMaxAed: 900_000 }],
    ['budget min', { budgetMinAed: 900_000 }],
    ['type', { propertyType: 'villa' }],
    ['listing reference', { listingReferences: ['MBR-1009'] }],
  ])('is true with a %s', (_name, over) => {
    expect(hasSearchCriteria(base(over))).toBe(true);
  });
});

describe('AgentRunError', () => {
  it('carries kind and the trace so far', () => {
    const trace = [{ tool: 'search_listings', input: {}, error: 'boom', durationMs: 3 }];
    const err = new AgentRunError('tool', 'search_listings failed: boom', trace);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentRunError');
    expect(err.kind).toBe('tool');
    expect(err.trace).toBe(trace);
    expect(err.message).toBe('search_listings failed: boom');
  });
});
