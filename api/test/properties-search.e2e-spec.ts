import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bearer, bootApp, login, OMAR, SARA } from './helpers';

describe('GET /properties?q= stays inside the agency', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("never returns another agency's listings for a free-text search", async () => {
    const token = await login(app, SARA);
    const response = await request(app.getHttpServer()).get('/properties').query({ q: 'DKP', limit: 100 }).set(bearer(token)).expect(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.total).toBe(0);
  });

  it('matches title, area, building or reference within the agency', async () => {
    const token = await login(app, SARA);
    const response = await request(app.getHttpServer()).get('/properties').query({ q: 'marina', limit: 100 }).set(bearer(token)).expect(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    for (const item of response.body.items) expect(item.reference.startsWith('MBR-')).toBe(true);

    const byRef = await request(app.getHttpServer()).get('/properties').query({ q: 'MBR-1001' }).set(bearer(token)).expect(200);
    expect(byRef.body.items.map((p: { reference: string }) => p.reference)).toEqual(['MBR-1001']);
  });

  it('combines q with other filters as AND', async () => {
    const token = await login(app, OMAR);
    const response = await request(app.getHttpServer())
      .get('/properties')
      .query({ q: 'marina', status: 'sold', limit: 100 })
      .set(bearer(token))
      .expect(200);
    for (const item of response.body.items) {
      expect(item.status).toBe('sold');
      expect(item.reference.startsWith('DKP-')).toBe(true);
    }
  });
});
