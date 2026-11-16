import Constants from 'expo-constants';

// Types mirror the API's response shapes in api/src/common/dto.ts.

export interface Agent {
  id: string;
  name: string;
  email: string;
  timezone: string;
  agency: { id: string; name: string };
}

export interface Message {
  id: string;
  leadId: string;
  direction: 'inbound' | 'outbound';
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

export interface AssistantRequirements {
  locations: string[];
  bedrooms: number | null;
  budgetAed: { min: number | null; max: number | null };
  propertyType: Property['type'] | null;
  intent: 'buy' | 'rent' | 'unknown';
  preferences: string[];
}

export interface ProposedAction {
  id: string;
  type: 'create_follow_up_task';
  status: 'pending_approval' | 'approved' | 'rejected';
  task: { title: string; notes: string | null; dueAt: string | null };
  needsClarification: string | null;
}

export type ListingFlag = 'rent_missing' | 'price_suspect' | 'possible_duplicate' | 'instruction_like_text';

/** Extra field: the API attaches the listing's facts so the app needs no extra request per recommendation. */
export interface PropertySnapshot {
  reference: string;
  title: string;
  area: string;
  building: string | null;
  type: Property['type'];
  bedrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  grossYieldPct: number | null;
  status: Property['status'];
  flags: ListingFlag[];
}

export interface Recommendation {
  propertyId: string;
  reason: string;
  property?: PropertySnapshot;
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
  status: 'running' | 'completed' | 'failed';
  error?: string;
  requirements: AssistantRequirements;
  /** Best first; empty when nothing fits (or when the run failed). */
  recommendations: Recommendation[];
  summary: string;
  proposedActions: ProposedAction[];
  trace: Array<{ tool: string; input: unknown; output?: unknown; error?: string; durationMs: number }>;
  createdAt: string;
  model?: string | null;
  dataWarnings?: DataWarning[];
}

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * EXPO_PUBLIC_API_URL wins. Otherwise use the computer that serves the app (the same one runs the API),
 * so Expo Go on a phone, an emulator and the web build all work without setup.
 */
function resolveApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:3001`;
}

export const API_URL = resolveApiUrl();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    throw new ApiError(response.status, message ?? `Request failed with ${response.status}`);
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
  startAssistantRun: (token: string, leadId: string, messageId?: string) =>
    request<AssistantRun>(`/leads/${leadId}/assistant/runs`, token, {
      method: 'POST',
      body: JSON.stringify(messageId ? { messageId } : {}),
    }),
  getAssistantRun: (token: string, leadId: string, runId: string) =>
    request<AssistantRun>(`/leads/${leadId}/assistant/runs/${runId}`, token),
  /**
   * Newest runs first. This list endpoint is an extra beyond the required contract, so a 404/405 (not
   * deployed) reads as "no runs yet"; every other error, 401 included, is passed on.
   */
  listAssistantRuns: async (token: string, leadId: string, limit = 1): Promise<AssistantRun[]> => {
    try {
      const body = await request<AssistantRun[] | { items: AssistantRun[] }>(
        `/leads/${leadId}/assistant/runs?limit=${limit}`,
        token,
      );
      return Array.isArray(body) ? body : body.items;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return [];
      throw err;
    }
  },
  approveAssistantAction: (token: string, leadId: string, runId: string, actionId: string) =>
    request<{ action: ProposedAction; task: Task }>(
      `/leads/${leadId}/assistant/runs/${runId}/actions/${actionId}/approve`,
      token,
      { method: 'POST', body: '{}' },
    ),
  rejectAssistantAction: (token: string, leadId: string, runId: string, actionId: string) =>
    request<{ action: ProposedAction }>(
      `/leads/${leadId}/assistant/runs/${runId}/actions/${actionId}/reject`,
      token,
      { method: 'POST', body: '{}' },
    ),
};
