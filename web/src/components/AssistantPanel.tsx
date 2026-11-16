'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AssistantRequirements,
  type AssistantRun,
  type LeadDetail,
  type ListingFlag,
  type ProposedAction,
  type Recommendation,
  type Task,
} from '@/lib/api';
import { formatAed, formatDueDate } from '@/lib/format';

/** The calls the panel makes. Injected in tests; defaults to the real API client. */
export interface AssistantClient {
  latestRun(token: string, leadId: string): Promise<AssistantRun | null>;
  startRun(token: string, leadId: string): Promise<AssistantRun>;
  getRun(token: string, leadId: string, runId: string): Promise<AssistantRun>;
  approveAction(
    token: string,
    leadId: string,
    runId: string,
    actionId: string,
  ): Promise<{ action: ProposedAction; task: Task }>;
  rejectAction(token: string, leadId: string, runId: string, actionId: string): Promise<{ action: ProposedAction }>;
}

export const defaultAssistantClient: AssistantClient = {
  latestRun: api.latestAssistantRun,
  startRun: (token, leadId) => api.startAssistantRun(token, leadId),
  getRun: api.getAssistantRun,
  approveAction: api.approveAssistantAction,
  rejectAction: api.rejectAssistantAction,
};

interface Props {
  lead: LeadDetail;
  token: string;
  /** The agent's timezone; due dates are shown in it, never the browser's. */
  timeZone: string;
  /** Called with the task the API created, so the page can refresh its Tasks list. */
  onApproved: (task: Task) => void | Promise<void>;
  onUnauthorized?: () => void;
  client?: AssistantClient;
}

const POLL_MS = 1_500;

type Decision = { actionId: string; kind: 'approve' | 'reject' };

export function AssistantPanel({
  lead,
  token,
  timeZone,
  onApproved,
  onUnauthorized,
  client = defaultAssistantClient,
}: Props) {
  const titleId = useId();
  const hasInbound = lead.messages.some((message) => message.direction === 'inbound');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  // Once Sara starts a run, a late answer for the "latest run" must not replace it.
  const userStarted = useRef(false);

  function reportError(cause: unknown, fallback: string) {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized?.();
    setError(cause instanceof Error && cause.message ? cause.message : fallback);
  }

  // Load the lead's latest run so a finished analysis survives a page reload.
  useEffect(() => {
    let cancelled = false;
    client
      .latestRun(token, lead.id)
      .then((latest) => {
        if (!cancelled && !userStarted.current && latest) setRun(latest);
      })
      .catch((cause: unknown) => {
        if (!cancelled && !userStarted.current) reportError(cause, 'Could not load the latest analysis.');
      });
    return () => {
      cancelled = true;
    };
  }, [client, token, lead.id]);

  // A background run (status 'running') is polled until it finishes.
  const runningId = run?.status === 'running' ? run.id : null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .getRun(token, lead.id, runningId)
        .then((next) => {
          if (!cancelled) setRun(next);
        })
        .catch((cause: unknown) => {
          if (!cancelled) reportError(cause, 'Lost track of the running analysis.');
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, token, lead.id, runningId, run]);

  async function analyse() {
    userStarted.current = true;
    setStarting(true);
    setError(null);
    try {
      setRun(await client.startRun(token, lead.id));
    } catch (cause) {
      setRun(null);
      reportError(cause, 'The analysis could not be started.');
    } finally {
      setStarting(false);
    }
  }

  async function decide(action: ProposedAction, kind: Decision['kind']) {
    if (!run) return;
    const runId = run.id;
    setDecision({ actionId: action.id, kind });
    setError(null);
    try {
      if (kind === 'approve') {
        const result = await client.approveAction(token, lead.id, runId, action.id);
        replaceAction(result.action);
        try {
          await onApproved(result.task);
        } catch {
          setError('The task was created, but the Tasks list could not be refreshed. Reload the page.');
        }
      } else {
        replaceAction((await client.rejectAction(token, lead.id, runId, action.id)).action);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError('This follow-up was already decided elsewhere. Showing its current status.');
        try {
          setRun(await client.getRun(token, lead.id, runId));
        } catch (reloadCause) {
          reportError(reloadCause, 'Could not reload the analysis.');
        }
      } else {
        reportError(cause, `Could not ${kind} the follow-up.`);
      }
    } finally {
      setDecision(null);
    }
  }

  function replaceAction(action: ProposedAction) {
    setRun((current) =>
      current
        ? { ...current, proposedActions: current.proposedActions.map((a) => (a.id === action.id ? action : a)) }
        : current,
    );
  }

  const analysing = starting || run?.status === 'running';

  return (
    <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200" aria-labelledby={titleId}>
      <h2 id={titleId} className="font-semibold">
        AI assistant
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        Reads the lead&apos;s latest message, finds listings that fit and drafts a follow-up for you to approve.
      </p>

      <button
        type="button"
        onClick={analyse}
        disabled={!hasInbound || analysing}
        className="mt-3 rounded-md bg-gray-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {analysing ? 'Analysing…' : 'Analyse latest message'}
      </button>
      {!hasInbound && <p className="mt-2 text-xs text-gray-500">This lead has not sent a message yet.</p>}

      {analysing && (
        <p role="status" className="mt-3 text-sm text-gray-600">
          Analysing… this can take up to a minute.
          {run?.status === 'running' && run.trace.length > 0 && ` ${run.trace.length} tool call(s) so far.`}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {run && !starting && run.status === 'failed' && (
        <div role="alert" className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
          <p className="font-medium">The analysis failed. Nothing was saved; try again.</p>
          {run.error && <p className="mt-1">{run.error}</p>}
        </div>
      )}

      {run && !starting && run.status === 'completed' && (
        <CompletedRun run={run} lead={lead} timeZone={timeZone} decision={decision} onDecide={decide} />
      )}
    </section>
  );
}

function CompletedRun({
  run,
  lead,
  timeZone,
  decision,
  onDecide,
}: {
  run: AssistantRun;
  lead: LeadDetail;
  timeZone: string;
  decision: Decision | null;
  onDecide: (action: ProposedAction, kind: Decision['kind']) => void;
}) {
  const requirementsId = useId();
  const recommendationsId = useId();
  const followUpId = useId();
  const message = lead.messages.find((m) => m.id === run.messageId);
  const warnings = run.dataWarnings ?? [];

  return (
    <div className="mt-4 space-y-4 text-sm">
      {message && (
        <p className="text-xs text-gray-500">
          Analysed: <q>{message.body}</q>
        </p>
      )}

      <section aria-labelledby={requirementsId}>
        <h3 id={requirementsId} className="font-medium">
          What the lead wants
        </h3>
        <RequirementsList requirements={run.requirements} />
      </section>

      <section aria-labelledby={recommendationsId}>
        <h3 id={recommendationsId} className="font-medium">
          Recommendations
        </h3>
        {run.recommendations.length === 0 ? (
          <p className="mt-1 text-gray-600">No listing fits what the lead asked for.</p>
        ) : (
          <ol aria-label="Recommended listings" className="mt-1 space-y-2">
            {run.recommendations.map((rec) => (
              <RecommendationItem key={rec.propertyId} rec={rec} />
            ))}
          </ol>
        )}
      </section>

      {run.summary && (
        <section aria-label="Summary">
          <h3 className="font-medium">Summary</h3>
          <p className="mt-1 text-gray-700">{run.summary}</p>
        </section>
      )}

      {warnings.length > 0 && (
        <section aria-label="Data warnings" className="rounded-md bg-amber-50 p-2">
          <h3 className="font-medium text-amber-900">Data warnings</h3>
          <ul className="mt-1 list-disc pl-5 text-amber-900">
            {warnings.map((w) => (
              <li key={w.propertyId}>
                {w.reference}: {w.flags.map(flagLabel).join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.proposedActions.length > 0 && (
        <section aria-labelledby={followUpId}>
          <h3 id={followUpId} className="font-medium">
            Proposed follow-up
          </h3>
          {run.proposedActions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              timeZone={timeZone}
              decision={decision?.actionId === action.id ? decision.kind : null}
              anyDeciding={decision !== null}
              onDecide={onDecide}
            />
          ))}
        </section>
      )}

      {run.trace.length > 0 && (
        <details className="text-xs text-gray-500">
          <summary>Tool calls ({run.trace.length})</summary>
          <ol className="mt-1 list-decimal pl-5">
            {run.trace.map((entry, index) => (
              <li key={index}>
                {entry.tool} · {entry.durationMs} ms{entry.error ? ` · failed: ${entry.error}` : ''}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function RequirementsList({ requirements: r }: { requirements: AssistantRequirements }) {
  const rows: Array<[string, string]> = [
    ['Areas', r.locations.length ? r.locations.join(', ') : 'Not stated'],
    ['Bedrooms', bedroomsLabel(r)],
    ['Budget', budgetLabel(r)],
    ['Type', r.propertyType ? capitalise(r.propertyType) : 'Not stated'],
    ['Buy or rent', r.intent === 'unknown' ? 'Not stated' : capitalise(r.intent)],
    ['Also wants', r.preferences.length ? r.preferences.join(', ') : 'Nothing else'],
  ];
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-gray-500">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecommendationItem({ rec }: { rec: Recommendation }) {
  const p = rec.property;
  return (
    <li className="rounded-md bg-gray-50 p-2 ring-1 ring-gray-200">
      <p className="font-medium">{p ? `${p.reference} · ${p.title}` : `Listing ${rec.propertyId}`}</p>
      {p && (
        <p className="text-xs text-gray-600">
          {[
            p.building ? `${p.building}, ${p.area}` : p.area,
            p.bedrooms === 0 ? 'Studio' : `${p.bedrooms} bed`,
            formatAed(p.priceAed),
            p.grossYieldPct === null ? 'yield unknown' : `${p.grossYieldPct}% gross yield`,
          ].join(' · ')}
        </p>
      )}
      {p && p.flags.length > 0 && (
        <p className="text-xs text-amber-800">Check: {p.flags.map(flagLabel).join(', ')}</p>
      )}
      <p className="mt-1 text-gray-700">{rec.reason}</p>
    </li>
  );
}

function ActionCard({
  action,
  timeZone,
  decision,
  anyDeciding,
  onDecide,
}: {
  action: ProposedAction;
  timeZone: string;
  decision: Decision['kind'] | null;
  anyDeciding: boolean;
  onDecide: (action: ProposedAction, kind: Decision['kind']) => void;
}) {
  const open = action.status === 'pending_approval' && !anyDeciding;
  return (
    <div className="mt-1 rounded-md p-2 ring-1 ring-gray-200">
      <p className="font-medium">{action.task.title}</p>
      {action.task.notes && <p className="text-gray-700">{action.task.notes}</p>}
      <p className="text-xs text-gray-600">
        {action.task.dueAt ? `Due ${formatDueDate(action.task.dueAt, timeZone)} (${timeZone})` : 'No due date'}
      </p>
      {action.needsClarification && (
        <div role="note" className="mt-2 rounded-md bg-amber-50 p-2 text-amber-900 ring-1 ring-amber-300">
          <p className="font-semibold">Date needs clarification</p>
          <p>{action.needsClarification}</p>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-600">{statusLabel(action.status)}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!open}
          onClick={() => onDecide(action, 'approve')}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {decision === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          disabled={!open}
          onClick={() => onDecide(action, 'reject')}
          className="rounded-md px-3 py-1.5 ring-1 ring-gray-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {decision === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

function statusLabel(status: ProposedAction['status']): string {
  if (status === 'approved') return 'Approved: the task is in the Tasks list.';
  if (status === 'rejected') return 'Rejected: no task was created.';
  return 'Pending approval: nothing is saved until you approve.';
}

function bedroomsLabel(r: AssistantRequirements): string {
  const one = (n: number) => (n === 0 ? 'Studio' : `${n} bedroom${n === 1 ? '' : 's'}`);
  if (r.bedrooms !== null) return one(r.bedrooms);
  const range = r.bedroomsRange;
  if (range?.min != null && range.max != null) return `${range.min}–${range.max} bedrooms`;
  if (range?.min != null) return `${one(range.min)} or more`;
  if (range?.max != null) return `Up to ${one(range.max)}`;
  return 'Not stated';
}

function budgetLabel(r: AssistantRequirements): string {
  const { min, max } = r.budgetAed;
  if (min !== null && max !== null) return `${formatAed(min)} – ${formatAed(max)}`;
  if (max !== null) return `${r.budgetIsApproximate ? 'around' : 'up to'} ${formatAed(max)}`;
  if (min !== null) return `from ${formatAed(min)}`;
  return 'Not stated';
}

const FLAG_LABELS: Record<ListingFlag, string> = {
  rent_missing: 'rent missing, yield unknown',
  price_suspect: 'price looks wrong',
  possible_duplicate: 'possible duplicate listing',
  instruction_like_text: 'description contains instructions (ignored)',
};

function flagLabel(flag: ListingFlag): string {
  return FLAG_LABELS[flag] ?? flag;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
