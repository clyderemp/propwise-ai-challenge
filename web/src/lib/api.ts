// Types mirror the API's response shapes in api/src/common/dto.ts.

export interface Agent {
  id: string;
  name: string;
  email: string;
  timezone: string;
  agency: { id: string; name: string };
}

export type MessageDirection = 'inbound' | 'outbound';

export interface Message {
  id: string;
  leadId: string;
  direction: MessageDirection;
  channel: 'whatsapp' | 'email' | 'sms';
  body: string;
  sentAt: string;
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'viewing' | 'negotiating' | 'won' | 'lost';

export interface Lead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: 'whatsapp' | 'website' | 'portal' | 'referral' | 'email';
  status: LeadStatus;
  notes: string | null;
  assignedAgent: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadSummary extends Lead {
  lastMessage: Message | null;
}

export interface LeadDetail extends Lead {
  /** The newest messages (up to 200), oldest first. */
  messages: Message[];
  messageCount: number;
}

export interface Property {
  id: string;
  reference: string;
  title: string;
  area: string;
  building: string | null;
  type: 'apartment' | 'villa' | 'townhouse' | 'penthouse';
  bedrooms: number;
  bathrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  serviceChargeAedPerSqft: number | null;
  status: 'available' | 'reserved' | 'sold';
  description: string;
  listedAt: string;
}

export interface Task {
  id: string;
  leadId: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  status: 'open' | 'done';
  createdBy: { id: string; name: string };
  createdAt: string;
}

// AI assistant: mirrors TASK.md's contract plus the API's optional extra fields
// (api/src/assistant/assistant.types.ts). Extras are optional so the panel works without them.

export type AssistantPropertyType = 'apartment' | 'villa' | 'townhouse' | 'penthouse';
export type ListingFlag = 'rent_missing' | 'price_suspect' | 'possible_duplicate' | 'instruction_like_text';

export interface AssistantRequirements {
  locations: string[];
  /** 0 = studio. */
  bedrooms: number | null;
  budgetAed: { min: number | null; max: number | null };
  propertyType: AssistantPropertyType | null;
  intent: 'buy' | 'rent' | 'unknown';
  preferences: string[];
  bedroomsRange?: { min: number | null; max: number | null };
  budgetIsApproximate?: boolean;
  prioritiseYield?: boolean;
}

export interface PropertySnapshot {
  reference: string;
  title: string;
  area: string;
  building: string | null;
  type: AssistantPropertyType;
  bedrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  grossYieldPct: number | null;
  status: 'available' | 'reserved' | 'sold';
  flags: ListingFlag[];
}

export interface Recommendation {
  propertyId: string;
  reason: string;
  property?: PropertySnapshot;
}

export interface ProposedAction {
  id: string;
  type: 'create_follow_up_task';
  status: 'pending_approval' | 'approved' | 'rejected';
  task: { title: string; notes: string | null; dueAt: string | null };
  needsClarification: string | null;
}

export interface TraceEntry {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface DataWarning {
  propertyId: string;
  reference: string;
  flags: ListingFlag[];
}

export interface AssistantRun {
  id: string;
  leadId: string;
  messageId: string;
  /** 'running' only for background runs. */
  status: 'running' | 'completed' | 'failed';
  error?: string;
  requirements: AssistantRequirements;
  recommendations: Recommendation[];
  summary: string;
  proposedActions: ProposedAction[];
  trace: TraceEntry[];
  createdAt: string;
  model?: string | null;
  dataWarnings?: DataWarning[];
}

export interface Page<T> {
  items: T[];
  total: number;
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed error body, e.g. { runId } on a 409 from a background start. */
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

async function send(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new ApiError(response.status, message ?? `Request failed with ${response.status}`, body);
  }
  return response;
}

async function request<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  return (await (await send(path, token, init)).json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; agent: Agent }>('/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  listLeads: (token: string, params: { limit: number; offset: number }) =>
    request<Page<LeadSummary>>(`/leads?limit=${params.limit}&offset=${params.offset}`, token),
  getLead: (token: string, leadId: string) => request<LeadDetail>(`/leads/${leadId}`, token),
  /** Up to 100 tasks; the API sends the total in the X-Total-Count header. */
  listTasks: async (token: string, leadId: string): Promise<Page<Task>> => {
    const response = await send(`/leads/${leadId}/tasks`, token);
    const items = (await response.json()) as Task[];
    return { items, total: Number(response.headers.get('X-Total-Count') ?? items.length) };
  },
  updateTask: (token: string, taskId: string, changes: Partial<Pick<Task, 'status'>>) =>
    request<Task>(`/tasks/${taskId}`, token, { method: 'PATCH', body: JSON.stringify(changes) }),
  getProperty: (token: string, propertyId: string) => request<Property>(`/properties/${propertyId}`, token),

  /** Synchronous run: the API answers when the run has completed or failed (up to ~2 minutes). */
  startAssistantRun: (token: string, leadId: string, messageId?: string) =>
    request<AssistantRun>(`/leads/${enc(leadId)}/assistant/runs`, token, {
      method: 'POST',
      body: JSON.stringify(messageId ? { messageId } : {}),
    }),
  /**
   * Background run (`?async=true`): 202 with the run in status 'running'; poll getAssistantRun until it ends.
   * A 409 means the lead already has a run in progress: its id is in the ApiError body as `runId`.
   */
  startBackgroundAssistantRun: (token: string, leadId: string, messageId?: string) =>
    request<AssistantRun>(`/leads/${enc(leadId)}/assistant/runs?async=true`, token, {
      method: 'POST',
      body: JSON.stringify(messageId ? { messageId } : {}),
    }),
  getAssistantRun: (token: string, leadId: string, runId: string) =>
    request<AssistantRun>(`/leads/${enc(leadId)}/assistant/runs/${enc(runId)}`, token),
  /**
   * The lead's newest run, or null when there is none. Uses the extra endpoint
   * `GET /leads/:id/assistant/runs?limit=1`; a 404 (no runs, or endpoint absent) means null.
   */
  latestAssistantRun: async (token: string, leadId: string): Promise<AssistantRun | null> => {
    try {
      const body = await request<AssistantRun[] | Page<AssistantRun>>(
        `/leads/${enc(leadId)}/assistant/runs?limit=1`,
        token,
      );
      const runs = Array.isArray(body) ? body : body.items;
      return runs[0] ?? null;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  },
  approveAssistantAction: (token: string, leadId: string, runId: string, actionId: string) =>
    request<{ action: ProposedAction; task: Task }>(
      `/leads/${enc(leadId)}/assistant/runs/${enc(runId)}/actions/${enc(actionId)}/approve`,
      token,
      { method: 'POST' },
    ),
  rejectAssistantAction: (token: string, leadId: string, runId: string, actionId: string) =>
    request<{ action: ProposedAction }>(
      `/leads/${enc(leadId)}/assistant/runs/${enc(runId)}/actions/${enc(actionId)}/reject`,
      token,
      { method: 'POST' },
    ),
};

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
