import type { AssistantRun, ProposedAction } from '../../src/assistant/assistant.types';

/** What the eval reads from the API. Extra fields beyond the contract are optional. */
export type RunJson = AssistantRun & {
  model?: string | null;
  diagnostics?: AssistantRun['diagnostics'];
  recommendations: Array<AssistantRun['recommendations'][number] & { property?: { reference: string } }>;
};

export interface TaskJson {
  id: string;
  leadId: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  status: string;
}

export interface PropertyJson {
  id: string;
  reference: string;
  title: string;
  area: string;
  building: string | null;
  sizeSqft: number;
  type: string;
  bedrooms: number;
  priceAed: number;
  annualRentAed: number | null;
  status: string;
}

export interface MessageJson {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  sentAt: string;
}

export interface Response<T> {
  status: number;
  body: T;
}

export interface TimedRun {
  label: string;
  status: number;
  latencyMs: number;
  run: RunJson;
}

/** A thin typed HTTP client over the running API (the eval talks to it exactly like the apps do). */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async request<T>(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<Response<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180_000), // TASK.md: the graders give up after 3 minutes
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async login(email: string, password: string): Promise<string> {
    const r = await this.request<{ accessToken: string }>('POST', '/auth/login', undefined, { email, password });
    if (r.status !== 200) throw new Error(`Login failed for ${email}: HTTP ${r.status}`);
    return r.body.accessToken;
  }

  async startRun(token: string, leadId: string, label: string, body: Record<string, unknown> = {}): Promise<TimedRun> {
    const started = performance.now();
    const r = await this.request<RunJson>('POST', `/leads/${leadId}/assistant/runs`, token, body);
    return { label, status: r.status, latencyMs: Math.round(performance.now() - started), run: r.body };
  }

  getRun(token: string, leadId: string, runId: string): Promise<Response<RunJson>> {
    return this.request('GET', `/leads/${leadId}/assistant/runs/${runId}`, token);
  }

  decide(token: string, leadId: string, runId: string, actionId: string, verb: 'approve' | 'reject') {
    return this.request<{ action: ProposedAction & { taskId?: string | null }; task?: TaskJson }>(
      'POST',
      `/leads/${leadId}/assistant/runs/${runId}/actions/${actionId}/${verb}`,
      token,
    );
  }

  async tasks(token: string, leadId: string): Promise<TaskJson[]> {
    const r = await this.request<TaskJson[]>('GET', `/leads/${leadId}/tasks`, token);
    if (r.status !== 200) throw new Error(`GET tasks failed: HTTP ${r.status}`);
    return r.body;
  }

  async messages(token: string, leadId: string): Promise<MessageJson[]> {
    const r = await this.request<{ messages: MessageJson[] }>('GET', `/leads/${leadId}`, token);
    if (r.status !== 200) throw new Error(`GET lead failed: HTTP ${r.status}`);
    return r.body.messages;
  }

  async property(token: string, id: string): Promise<PropertyJson> {
    const r = await this.request<PropertyJson>('GET', `/properties/${id}`, token);
    if (r.status !== 200) throw new Error(`GET property failed: HTTP ${r.status}`);
    return r.body;
  }

  /** Creates a lead with messages at fixed times, so expected dates are literal. */
  async newLead(token: string, name: string, messages: Array<{ body: string; sentAt?: string; direction?: 'inbound' | 'outbound' }>): Promise<string> {
    const lead = await this.request<{ id: string }>('POST', '/leads', token, { name, source: 'whatsapp' });
    if (lead.status !== 201) throw new Error(`POST /leads failed: HTTP ${lead.status}`);
    for (const m of messages) {
      const r = await this.request('POST', `/leads/${lead.body.id}/messages`, token, {
        direction: m.direction ?? 'inbound',
        channel: 'whatsapp',
        body: m.body,
        ...(m.sentAt ? { sentAt: m.sentAt } : {}),
      });
      if (r.status !== 201) throw new Error(`POST message failed: HTTP ${r.status}`);
    }
    return lead.body.id;
  }
}
