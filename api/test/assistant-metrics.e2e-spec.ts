// The scripted, deterministic agent: no API key, no model calls, no spend.
process.env.ASSISTANT_AGENT_IMPL = 'fake';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { stableId } from '../src/db/stable-id';
import { bearer, bootApp, login, OMAR, SARA } from './helpers';

const KARIM = stableId('lead', 'karim'); // Sara's agency
const NADIA = stableId('lead', 'nadia'); // Omar's agency

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('GET /assistant/metrics', () => {
  let app: INestApplication<App>;
  let sara: string;
  let omar: string;
  const http = () => request(app.getHttpServer());
  const metrics = async (token: string, query = ''): Promise<Json> =>
    (await http().get(`/assistant/metrics${query}`).set(bearer(token)).expect(200)).body;

  beforeAll(async () => {
    app = await bootApp();
    sara = await login(app, SARA);
    omar = await login(app, OMAR);
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    await http().get('/assistant/metrics').expect(401);
  });

  it('rejects an invalid window', async () => {
    await http().get('/assistant/metrics?sinceHours=0').set(bearer(sara)).expect(400);
    await http().get('/assistant/metrics?sinceHours=abc').set(bearer(sara)).expect(400);
  });

  it("counts only the caller's agency runs, with the documented shape", async () => {
    const saraBefore = await metrics(sara);
    const omarBefore = await metrics(omar);

    await http().post(`/leads/${KARIM}/assistant/runs`).set(bearer(sara)).send({}).expect(201);
    // A failing run in Sara's agency: a lead whose message makes the scripted tool fail.
    const lead = await http().post('/leads').set(bearer(sara)).send({ name: 'Metrics Probe', source: 'whatsapp' }).expect(201);
    await http()
      .post(`/leads/${lead.body.id}/messages`)
      .set(bearer(sara))
      .send({ direction: 'inbound', channel: 'whatsapp', body: '2 bed in Dubai Marina under 3M [fake:fail-tool]' })
      .expect(201);
    const failed = await http().post(`/leads/${lead.body.id}/assistant/runs`).set(bearer(sara)).send({}).expect(201);
    expect(failed.body.status).toBe('failed');

    const saraAfter = await metrics(sara);
    const omarAfter = await metrics(omar);

    expect(saraAfter.totals.runs).toBe(saraBefore.totals.runs + 2);
    expect(saraAfter.totals.completed).toBe(saraBefore.totals.completed + 1);
    expect(saraAfter.totals.failed).toBe(saraBefore.totals.failed + 1);
    expect(saraAfter.failureKinds.tool).toBe((saraBefore.failureKinds.tool ?? 0) + 1);
    expect(saraAfter.toolErrors.search_listings).toBe((saraBefore.toolErrors.search_listings ?? 0) + 1);
    expect(saraAfter.models['fake-scripted'].runs).toBe((saraBefore.models['fake-scripted']?.runs ?? 0) + 2);
    expect(saraAfter.lastFailureAt).toEqual(expect.any(String));
    expect(saraAfter.latencyMs.samples).toBeGreaterThanOrEqual(2);
    expect(saraAfter.latencyMs.p50).toEqual(expect.any(Number));
    expect(saraAfter.tokens.input).toBeGreaterThanOrEqual(saraBefore.tokens.input + 1500);
    expect(saraAfter).toMatchObject({
      window: { sinceHours: 168, from: expect.any(String), to: expect.any(String) },
      successRate: expect.any(Number),
      cost: { totalUsd: expect.any(Number), runsWithUsage: expect.any(Number) },
    });

    // Omar's agency sees none of it.
    expect(omarAfter).toMatchObject({ totals: omarBefore.totals, failureKinds: omarBefore.failureKinds, toolErrors: omarBefore.toolErrors });

    // And Omar's runs never show up for Sara.
    await http().post(`/leads/${NADIA}/assistant/runs`).set(bearer(omar)).send({}).expect(201);
    expect((await metrics(sara)).totals).toEqual(saraAfter.totals);
    expect((await metrics(omar)).totals.runs).toBe(omarAfter.totals.runs + 1);
  });

  it('honours sinceHours', async () => {
    const body = await metrics(sara, '?sinceHours=24');
    expect(body.window.sinceHours).toBe(24);
    expect(new Date(body.window.to).getTime() - new Date(body.window.from).getTime()).toBe(24 * 3_600_000);
  });

  it('stores run timings in diagnostics', async () => {
    const run = (await http().post(`/leads/${KARIM}/assistant/runs`).set(bearer(sara)).send({}).expect(201)).body;
    expect(run.diagnostics?.timings).toMatchObject({ startedAt: expect.any(String), finishedAt: expect.any(String), latencyMs: expect.any(Number) });
  });
});
