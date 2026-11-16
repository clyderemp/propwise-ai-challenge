import { AssistantTelemetry, estimateCostUsd, TelemetrySink } from './assistant-telemetry';

const SECRET_BODY = 'Hi, I am Layla, call me on +971 50 123 4567, 2 bed in Marina under 2.5M';

function capture(): { sink: TelemetrySink; lines: string[] } {
  const lines: string[] = [];
  return { lines, sink: { log: (line: string) => void lines.push(line), warn: (line: string) => void lines.push(line) } };
}

describe('AssistantTelemetry', () => {
  const base = { runId: 'run-1', leadId: 'lead-1', agencyId: 'agency-1', model: 'claude-sonnet-5-5' };

  it('emits one JSON line per event with the expected fields', () => {
    const { sink, lines } = capture();
    const t = new AssistantTelemetry(sink);
    t.runStarted(base);
    t.toolCalled(base, { tool: 'search_listings', input: { area: 'Dubai Marina' }, output: [{ id: 'x' }], durationMs: 12 });
    t.toolCalled(base, { tool: 'get_listing_details', input: {}, error: 'boom', durationMs: 3 });
    t.runFinished(base, {
      status: 'completed',
      failureKind: null,
      latencyMs: 4200,
      steps: 2,
      toolCount: 2,
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    expect(lines).toHaveLength(4);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual(['run.started', 'tool.called', 'tool.called', 'run.completed']);
    expect(events[1]).toEqual({ event: 'tool.called', runId: 'run-1', leadId: 'lead-1', agencyId: 'agency-1', model: 'claude-sonnet-5-5', tool: 'search_listings', durationMs: 12, ok: true });
    expect(events[2]).toMatchObject({ tool: 'get_listing_details', ok: false, error: 'error' });
    expect(lines[2]).not.toContain('boom');
    expect(events[3]).toMatchObject({
      event: 'run.completed',
      status: 'completed',
      latencyMs: 4200,
      steps: 2,
      toolCount: 2,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      estimatedCostUsd: 0.003,
    });
  });

  it('emits run.failed with the failure kind', () => {
    const { sink, lines } = capture();
    new AssistantTelemetry(sink).runFinished(base, { status: 'failed', failureKind: 'timeout', latencyMs: 110000, steps: 0, toolCount: 0, usage: null });
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'run.failed', failureKind: 'timeout', estimatedCostUsd: null });
  });

  it('never logs the message body, tool inputs or tool outputs', () => {
    const { sink, lines } = capture();
    const t = new AssistantTelemetry(sink);
    t.runStarted({ ...base, message: SECRET_BODY } as never);
    t.toolCalled(base, { tool: 'search_listings', input: { q: SECRET_BODY }, output: { description: SECRET_BODY }, durationMs: 1 });
    t.toolCalled(base, { tool: 'search_listings', input: { q: SECRET_BODY }, error: `failed on ${SECRET_BODY}`, durationMs: 1 });
    t.runFinished({ ...base, summary: SECRET_BODY } as never, { status: 'completed', failureKind: null, latencyMs: 1, steps: 1, toolCount: 1, usage: null });
    const all = lines.join('\n');
    expect(all).not.toContain('Layla');
    expect(all).not.toContain('123 4567');
    expect(all).not.toContain('Marina under');
  });
});

describe('estimateCostUsd', () => {
  it('prices sonnet 5.5 with cache reads and writes', () => {
    // 1M in of which 200k cache read, 100k cache write: 700k*2 + 200k*0.1 + 100k*2.5 = 1.4 + 0.02 + 0.25; 10k out * 10 = 0.1
    expect(estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 10_000, totalTokens: 0, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 })).toBeCloseTo(1.77, 6);
  });
  it('returns null for unknown models or missing usage', () => {
    expect(estimateCostUsd('fake-scripted', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })).toBeNull();
    expect(estimateCostUsd('claude-sonnet-5-5', null)).toBeNull();
  });
});
