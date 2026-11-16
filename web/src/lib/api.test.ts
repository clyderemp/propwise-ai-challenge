import { api, API_URL, ApiError } from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('assistant API client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts a run with POST and an empty body by default', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'run-1' }));
    await api.startAssistantRun('tok', 'lead-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_URL}/leads/lead-1/assistant/runs`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('sends the messageId when given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'run-1' }));
    await api.startAssistantRun('tok', 'lead-1', 'msg-9');
    expect(fetchMock.mock.calls[0]![1]?.body).toBe('{"messageId":"msg-9"}');
  });

  it('posts approve and reject to the contract paths', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { action: {} }));
    await api.approveAssistantAction('tok', 'lead-1', 'run-1', 'act-1');
    await api.rejectAssistantAction('tok', 'lead-1', 'run-1', 'act-1');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${API_URL}/leads/lead-1/assistant/runs/run-1/actions/act-1/approve`, 'POST'],
      [`${API_URL}/leads/lead-1/assistant/runs/run-1/actions/act-1/reject`, 'POST'],
    ]);
  });

  it('surfaces a 409 as an ApiError with status 409', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { message: 'Action is already rejected' }));
    const error = await api.approveAssistantAction('tok', 'l', 'r', 'a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Action is already rejected' });
  });

  it('reads the latest run from either a list or a page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 'run-a' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'run-b' }], total: 3 }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    expect(await api.latestAssistantRun('tok', 'lead-1')).toEqual({ id: 'run-a' });
    expect(await api.latestAssistantRun('tok', 'lead-1')).toEqual({ id: 'run-b' });
    expect(await api.latestAssistantRun('tok', 'lead-1')).toBeNull();
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API_URL}/leads/lead-1/assistant/runs?limit=1`);
  });

  it('treats a 404 for the latest run as no run, but rethrows other errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));
    expect(await api.latestAssistantRun('tok', 'lead-1')).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
    await expect(api.latestAssistantRun('tok', 'lead-1')).rejects.toMatchObject({ status: 500 });
  });

  it('starts a background run with ?async=true and returns the 202 body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { id: 'run-1', status: 'running' }));
    const run = await api.startBackgroundAssistantRun('tok', 'lead-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_URL}/leads/lead-1/assistant/runs?async=true`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(run).toEqual({ id: 'run-1', status: 'running' });
  });

  it('keeps the error body on an ApiError, so a 409 can name the running run', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { statusCode: 409, message: 'Already running', runId: 'run-7' }));
    const error = await api.startBackgroundAssistantRun('tok', 'lead-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: 'Already running', body: { runId: 'run-7' } });
  });
});
