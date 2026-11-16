import { api, ApiError, AssistantRun } from './api';

const run = { id: 'run-1', leadId: 'lead-1', status: 'completed' } as AssistantRun;

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

describe('api assistant calls', () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('asks for the latest run of the lead with the token', async () => {
    fetchMock.mockResolvedValue(respond(200, [run]));

    await expect(api.listAssistantRuns('tok', 'lead-1')).resolves.toEqual([run]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/leads\/lead-1\/assistant\/runs\?limit=1$/);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('unwraps a paged { items } body', async () => {
    fetchMock.mockResolvedValue(respond(200, { items: [run], total: 1 }));
    await expect(api.listAssistantRuns('tok', 'lead-1')).resolves.toEqual([run]);
  });

  it('treats a missing list endpoint (404) as no runs', async () => {
    fetchMock.mockResolvedValue(respond(404, { message: 'Cannot GET' }));
    await expect(api.listAssistantRuns('tok', 'lead-1')).resolves.toEqual([]);
  });

  it('still reports an expired session (401)', async () => {
    fetchMock.mockResolvedValue(respond(401, { message: 'Unauthorized' }));
    const error = await api.listAssistantRuns('tok', 'lead-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it('starts a run with an empty body by default (the API picks the latest inbound message)', async () => {
    fetchMock.mockResolvedValue(respond(201, run));
    await api.startAssistantRun('tok', 'lead-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/leads\/lead-1\/assistant\/runs$/);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });
});
