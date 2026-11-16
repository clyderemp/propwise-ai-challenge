/**
 * Shared types for the AI lead assistant.
 *
 * Framework-light on purpose: the service, the agent, the DTO mappers and the evals all import
 * from here. The contract part mirrors TASK.md ("The API contract") exactly; everything marked
 * "extra" is an additive field the contract allows.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ASSISTANT_PROPERTY_TYPES = ['apartment', 'villa', 'townhouse', 'penthouse'] as const;
export type AssistantPropertyType = (typeof ASSISTANT_PROPERTY_TYPES)[number];

export const LEAD_INTENTS = ['buy', 'rent', 'unknown'] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

/** 'running' is only used by the async stretch goal; synchronous runs end completed or failed. */
export const ASSISTANT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type AssistantRunStatus = (typeof ASSISTANT_RUN_STATUSES)[number];

export const PROPOSED_ACTION_STATUSES = ['pending_approval', 'approved', 'rejected'] as const;
export type ProposedActionStatus = (typeof PROPOSED_ACTION_STATUSES)[number];

export const PROPOSED_ACTION_TYPES = ['create_follow_up_task'] as const;
export type ProposedActionType = (typeof PROPOSED_ACTION_TYPES)[number];

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const FOLLOW_UP_KINDS = ['relative_days', 'weekday', 'after_weekend', 'absolute_date', 'none', 'unclear'] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const LISTING_FLAGS = ['rent_missing', 'price_suspect', 'possible_duplicate', 'instruction_like_text'] as const;
export type ListingFlag = (typeof LISTING_FLAGS)[number];

export const DROP_REASONS = [
  'not_seen_in_run', // the id never appeared in a tool output of this run
  'not_found', // no such listing (or not re-read from the database)
  'other_agency', // belongs to another agency
  'not_available', // reserved or sold
  'rent_intent', // the lead wants to rent; every listing is for sale
  'no_criteria', // nothing was extracted to match against
  'not_requested', // the lead only named listing codes, and this is not one of them
  'area_mismatch',
  'bedrooms_mismatch',
  'type_mismatch',
  'over_budget',
  'under_budget',
  'price_suspect',
  'duplicate', // a duplicate of a listing kept earlier in the list
  'repeated', // the same id recommended twice
  'over_cap', // beyond the maximum number of recommendations
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

// ---------------------------------------------------------------------------
// Contract (TASK.md)
// ---------------------------------------------------------------------------

export interface Requirements {
  /** Area names as stored in the listings, e.g. "Dubai Marina". */
  locations: string[];
  /** 0 = studio. null when not stated or when a range was given (see bedroomsRange). */
  bedrooms: number | null;
  budgetAed: { min: number | null; max: number | null };
  propertyType: AssistantPropertyType | null;
  intent: LeadIntent;
  preferences: string[];
}

/** Extra requirement fields the response may carry next to the contract ones. */
export interface RequirementsExtras {
  bedroomsRange: { min: number | null; max: number | null };
  budgetIsApproximate: boolean;
  prioritiseYield: boolean;
}

export type AssistantRequirements = Requirements & Partial<RequirementsExtras>;

export interface FollowUpTaskDraft {
  title: string;
  notes: string | null;
  /** ISO 8601 with an offset, e.g. "2026-10-16T10:00:00+04:00". */
  dueAt: string | null;
}

export interface ProposedAction {
  id: string;
  type: ProposedActionType;
  status: ProposedActionStatus;
  task: FollowUpTaskDraft;
  /** Why the date is unclear, when it is. Invariant: task.dueAt === null iff this is non-null. */
  needsClarification: string | null;
}

export interface TraceEntry {
  tool: string;
  input: unknown;
  /** Present (possibly null) on every call that succeeded. */
  output?: unknown;
  /** Present on every call that failed. */
  error?: string;
  durationMs: number;
}

/** Facts about a recommended listing, re-read from the database (extra). */
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
  /** Extra: true numbers for the UI, so it needs no extra request. */
  property?: PropertySnapshot;
}

export interface DroppedRecommendation {
  propertyId: string;
  reference: string | null;
  reason: DropReason;
  detail: string;
}

/** The price window actually applied when matching (extra, for transparency). */
export interface BudgetBand {
  floorAed: number | null;
  ceilingAed: number | null;
  approximate: boolean;
}

export interface RunDiagnostics {
  droppedRecommendations: DroppedRecommendation[];
  budgetBand: BudgetBand | null;
  /** True when Phase A extracted no search criteria, so no listing search was run. */
  searchSkipped: boolean;
}

export interface DataWarning {
  propertyId: string;
  reference: string;
  flags: ListingFlag[];
}

export interface AssistantRun {
  id: string;
  leadId: string;
  /** The message that was analysed. */
  messageId: string;
  status: AssistantRunStatus;
  /** Present when status is 'failed'. */
  error?: string;
  requirements: AssistantRequirements;
  /** Best first; [] when nothing fits. */
  recommendations: Recommendation[];
  summary: string;
  /** [] when no follow-up is needed. */
  proposedActions: ProposedAction[];
  /** Every tool call, in order. */
  trace: TraceEntry[];
  createdAt: string;
  // extras
  model?: string | null;
  diagnostics?: RunDiagnostics;
  dataWarnings?: DataWarning[];
}

// ---------------------------------------------------------------------------
// Phase A: extraction (frozen before any listing text is seen)
// ---------------------------------------------------------------------------

export interface FollowUpIntent {
  kind: FollowUpKind;
  /** relative_days: 0 = today, 1 = tomorrow. */
  days: number | null;
  /** weekday: the named day; resolved to the first such day strictly after the sent date. */
  weekday: Weekday | null;
  /** absolute_date: 1-12. */
  month: number | null;
  day: number | null;
  /** absolute_date: null = first occurrence on or after the sent date. */
  year: number | null;
  /** "HH:MM" (24h), only when the lead stated a time. */
  time: string | null;
  /** The words this was read from. */
  quote: string | null;
  /** unclear: why. */
  unclearReason: string | null;
}

export interface ExtractedRequirements {
  /** Canonical area names where one matches the agency's listings. */
  locations: string[];
  bedroomsMin: number | null;
  /** Equal to bedroomsMin for a single value. */
  bedroomsMax: number | null;
  budgetMinAed: number | null;
  /** The stated figure, not a padded one. */
  budgetMaxAed: number | null;
  /** "around", "about", "~", "حوالي". */
  budgetIsApproximate: boolean;
  propertyType: AssistantPropertyType | null;
  intent: LeadIntent;
  preferences: string[];
  prioritiseYield: boolean;
  /** Listing codes the lead named, e.g. "MBR-1009". */
  listingReferences: string[];
}

export interface Extraction {
  requirements: ExtractedRequirements;
  followUp: FollowUpIntent;
  leadAskedForFollowUp: boolean;
}

// ---------------------------------------------------------------------------
// Agent port: what the service calls. The agent lane implements it.
// ---------------------------------------------------------------------------

/** Nest injection token for the AgentPort implementation. */
export const ASSISTANT_AGENT = 'ASSISTANT_AGENT' as const;

export interface AgentMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  body: string;
  sentAt: Date;
}

/** Receives each tool call as it finishes, so a crash mid-run still leaves the trace. */
export interface TraceSink {
  record(entry: TraceEntry): void | Promise<void>;
}

export interface AgentRunContext {
  runId: string;
  /** From the authenticated request. Never part of any tool schema. */
  agencyId: string;
  agentId: string;
  /** IANA zone of the logged-in agent, e.g. "Asia/Dubai". */
  agentTimezone: string;
  lead: { id: string; name: string };
  /** The analysed message. */
  message: AgentMessage;
  /** Messages sent at or before the analysed one, oldest first, excluding it. */
  thread: AgentMessage[];
  trace: TraceSink;
  signal?: AbortSignal;
}

export interface CandidateRecommendation {
  propertyId: string;
  reason: string;
}

export interface AgentFollowUp {
  title: string;
  notes: string | null;
  intent: FollowUpIntent;
}

export interface AgentOutcome {
  /** The resolved model id that produced this run. */
  model: string;
  /** Frozen Phase A output. */
  extraction: Extraction;
  /** Contract-shaped requirements derived from the extraction. */
  requirements: AssistantRequirements;
  /** Model's ordered picks, NOT yet validated. The service validates them (domain/matching). */
  candidates: CandidateRecommendation[];
  /** Every property id that appeared in a tool output this run. */
  seenPropertyIds: string[];
  summary: string;
  /** null when no follow-up is needed. The due date is resolved in code from intent. */
  followUp: AgentFollowUp | null;
  /** All tool calls, in order (same entries the sink received). */
  trace: TraceEntry[];
  /** True when no search criteria were extracted and the listing search was skipped. */
  searchSkipped: boolean;
}

export interface AgentPort {
  /** Resolves with an outcome, or rejects with AgentRunError (or any Error) on model/tool failure. */
  run(ctx: AgentRunContext): Promise<AgentOutcome>;
}

export type AgentFailureKind = 'model' | 'tool' | 'timeout' | 'invalid_output';

/** Thrown by the agent when a run must end as failed. Carries the trace recorded so far. */
export class AgentRunError extends Error {
  readonly kind: AgentFailureKind;
  readonly trace: TraceEntry[];

  constructor(kind: AgentFailureKind, message: string, trace: TraceEntry[] = []) {
    super(message);
    this.name = 'AgentRunError';
    this.kind = kind;
    this.trace = trace;
  }
}
