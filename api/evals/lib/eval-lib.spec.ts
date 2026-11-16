import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableId } from '../../src/db/stable-id';
import type { PropertyJson, RunJson } from './api';
import { checkSelfVerification, recommendationsWithin, costUsd, costWithoutCacheUsd, dubaiDate, expectedNextDayAt10, firstMondayAfterAt10, nextWorkingDayAt10, verdictOf, renderReport } from './eval-lib';

describe('eval helpers', () => {
  it('gives the Asia/Dubai calendar date of an instant', () => {
    expect(dubaiDate('2026-10-16T19:59:00Z')).toBe('2026-10-16');
    expect(dubaiDate('2026-10-16T20:00:00Z')).toBe('2026-10-17');
  });

  it('expects "tomorrow" as the next Dubai day at 10:00+04:00, also across UTC midnight', () => {
    expect(expectedNextDayAt10('2026-10-16T21:30:00Z')).toBe('2026-10-18T10:00:00+04:00');
    expect(expectedNextDayAt10('2026-11-16T09:00:00Z')).toBe('2026-11-17T10:00:00+04:00');
    expect(expectedNextDayAt10('2026-12-31T08:00:00Z')).toBe('2027-01-01T10:00:00+04:00');
  });

  it('expects "after the weekend" as the first Monday strictly after the Dubai sent date', () => {
    expect(firstMondayAfterAt10('2026-11-14T10:20:00Z')).toBe('2026-11-16T10:00:00+04:00'); // Saturday
    expect(firstMondayAfterAt10('2026-11-16T05:00:00Z')).toBe('2026-11-23T10:00:00+04:00'); // a Monday
    expect(firstMondayAfterAt10('2026-11-15T21:00:00Z')).toBe('2026-11-23T10:00:00+04:00'); // Monday 01:00 in Dubai
  });

  it('expects an urgent timeline follow-up on the next Monday-to-Friday Dubai date after the sent date', () => {
    expect(nextWorkingDayAt10('2026-11-16T06:00:00Z')).toBe('2026-11-17T10:00:00+04:00'); // Monday -> Tuesday
    expect(nextWorkingDayAt10('2026-11-20T06:00:00Z')).toBe('2026-11-23T10:00:00+04:00'); // Friday -> Monday
    expect(nextWorkingDayAt10('2026-11-21T06:00:00Z')).toBe('2026-11-23T10:00:00+04:00'); // Saturday -> Monday
    expect(nextWorkingDayAt10('2026-11-19T21:30:00Z')).toBe('2026-11-23T10:00:00+04:00'); // Friday 01:30 in Dubai
  });

  it('prices tokens per model and returns null for an unknown model', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3.0, 6);
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(4.0, 6);
    expect(costUsd('some-other-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('prices cache reads and writes, and the same tokens without a cache', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 800_000, cacheWriteTokens: 100_000 };
    // 0.1M uncached * $2 + 0.8M read * $0.10 + 0.1M written * $2.50
    expect(costUsd('claude-sonnet-5-5', usage)).toBeCloseTo(0.53, 9);
    expect(costWithoutCacheUsd('claude-sonnet-5-5', usage)).toBeCloseTo(2.0, 9);
  });

  it('passes a case only when every gating assertion passes; non-gating ones never decide', () => {
    expect(verdictOf([{ name: 'a', pass: true, gating: true }, { name: 'b', pass: false, gating: false }])).toBe('PASS');
    expect(verdictOf([{ name: 'a', pass: true, gating: true }, { name: 'b', pass: false, gating: true }])).toBe('FAIL');
    expect(verdictOf([])).toBe('FAIL');
  });

  it('renders a markdown report with one row per case and its assertions', () => {
    const md = renderReport({
      startedAt: '2026-11-16T10:00:00.000Z',
      model: 'claude-sonnet-5-5',
      results: [
        {
          id: '01-karim-extraction',
          title: 'Headline extraction',
          covers: '1',
          verdict: 'PASS',
          assertions: [{ name: 'bedrooms is 2', pass: true, gating: true }],
          latencyMs: 12_300,
          usage: { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000, cacheReadTokens: 6_000, cacheWriteTokens: 2_000 },
          costUsd: 0.03,
          costWithoutCacheUsd: 0.04,
          models: ['claude-sonnet-5-5'],
          quality: null,
        },
      ],
    });
    expect(md).toContain('| 01-karim-extraction | Headline extraction | 1 | PASS | 1/1 | 12.3 s | 11,000 | 6,000 | 2,000 | $0.0300 | $0.0100 (25%) | claude-sonnet-5-5 |');
    expect(md).toContain('- Prompt cache: 6,000 tokens read, 2,000 written (60% of input read from cache)');
    expect(md).toContain('- Cost: $0.0300 with the cache, $0.0400 without it: saved $0.0100 (25%)');
    expect(md).toContain('- PASS: bedrooms is 2');
    expect(md).toMatch(/1\/1 cases passed/);
  });

  it('checks recommendations are within the allowed set, and non-empty when required', () => {
    expect(recommendationsWithin(['MBR-1009'], ['MBR-1009'])).toBe(true);
    expect(recommendationsWithin(['MBR-1010'], ['MBR-1009'])).toBe(false);
    expect(recommendationsWithin([], ['MBR-1009'])).toBe(true);
    expect(recommendationsWithin([], ['MBR-1009'], { nonEmpty: true })).toBe(false);
    expect(recommendationsWithin(['MBR-1009'], ['MBR-1009'], { nonEmpty: true })).toBe(true);
  });
});

describe('checkSelfVerification (eval 16, over the recorded Karim trace)', () => {
  const seed = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'seed', 'properties.json'), 'utf8')) as Array<Omit<PropertyJson, 'id'>>;
  // What GET /properties/:id returns, as the database holds it.
  const db = new Map(seed.map((p) => [stableId('property', p.reference), { ...p, id: stableId('property', p.reference) } as PropertyJson]));
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'traces', '02-karim-matching.json'), 'utf8')) as { runs: Array<{ run: RunJson }> };
  const SV = { checkedRecommendations: 3, issuesFound: [], revised: false, rounds: 0, fallbackReasons: [] };
  const withSv = (run: RunJson, selfVerification: unknown): RunJson =>
    ({ ...run, diagnostics: { ...run.diagnostics!, selfVerification } }) as RunJson;
  const props = (run: RunJson) => run.recommendations.map((r) => db.get(r.propertyId)!);
  const failed = (checks: Array<{ name: string; pass: boolean }>) => checks.filter((c) => !c.pass).map((c) => c.name);

  it('passes the recorded run once it carries a self-verification record', () => {
    const run = withSv(recorded.runs[0].run, SV);
    const checks = checkSelfVerification(run, props(run));
    expect(failed(checks)).toEqual([]);
    expect(checks.filter((c) => /reason passes claim-check/.test(c.name))).toHaveLength(3);
  });

  it('fails a run stored without the record', () => {
    // Strip the record explicitly so the test does not depend on how old the committed trace is.
    const stored = recorded.runs[0].run;
    const run: typeof stored = { ...stored, diagnostics: stored.diagnostics && { ...stored.diagnostics, selfVerification: undefined } };
    expect(failed(checkSelfVerification(run, props(run)))).toEqual(['diagnostics.selfVerification has the expected shape']);
  });

  it('fails a shipped reason that disagrees with the database', () => {
    const base = withSv(recorded.runs[0].run, SV);
    const run = { ...base, recommendations: base.recommendations.map((r, i) => (i === 0 ? { ...r, reason: r.reason.replace('7.32%', '8.4%') } : r)) };
    expect(failed(checkSelfVerification(run, props(run)))).toEqual(['MBR-1001: reason passes claim-check against the database']);
  });

  it('fails an inconsistent record: revised without a round, or issues with no revision and no reason why', () => {
    const run = recorded.runs[0].run;
    expect(failed(checkSelfVerification(withSv(run, { ...SV, revised: true }), props(run)))).toEqual(['diagnostics.selfVerification is consistent']);
    const issue = { propertyId: 'x', reference: null, kind: 'yield', claim: '8%', expected: '7.32%' };
    expect(failed(checkSelfVerification(withSv(run, { ...SV, issuesFound: [issue] }), props(run)))).toEqual(['diagnostics.selfVerification is consistent']);
  });
});
