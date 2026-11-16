import { costUsd, dubaiDate, expectedNextDayAt10, firstMondayAfterAt10, verdictOf, renderReport, yieldMentionsMatch } from './eval-lib';

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

  it('prices tokens per model and returns null for an unknown model', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(3.0, 6);
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(4.0, 6);
    expect(costUsd('some-other-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('passes a case only when every gating assertion passes; non-gating ones never decide', () => {
    expect(verdictOf([{ name: 'a', pass: true, gating: true }, { name: 'b', pass: false, gating: false }])).toBe('PASS');
    expect(verdictOf([{ name: 'a', pass: true, gating: true }, { name: 'b', pass: false, gating: true }])).toBe('FAIL');
    expect(verdictOf([])).toBe('FAIL');
  });

  it('checks that every percentage in a reason is the computed gross yield', () => {
    expect(yieldMentionsMatch('Gross yield 7.32% on AED 2,050,000.', 7.317)).toBe(true);
    expect(yieldMentionsMatch('Gross yield 7.5%.', 7.317)).toBe(false);
    expect(yieldMentionsMatch('Rent unknown.', null)).toBe(true);
    expect(yieldMentionsMatch('Yield 6%.', null)).toBe(false);
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
          usage: { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 },
          costUsd: 0.03,
          models: ['claude-sonnet-5-5'],
          quality: null,
        },
      ],
    });
    expect(md).toContain('| 01-karim-extraction | Headline extraction | 1 | PASS | 1/1 | 12.3 s | 11,000 | $0.0300 | claude-sonnet-5-5 |');
    expect(md).toContain('- PASS: bedrooms is 2');
    expect(md).toMatch(/1\/1 cases passed/);
  });
});
