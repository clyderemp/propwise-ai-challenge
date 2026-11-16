import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  api,
  ApiError,
  AssistantRequirements,
  AssistantRun,
  AssistantTimeline,
  LeadDetail,
  ListingFlag,
  ProposedAction,
  Recommendation,
  Task,
} from '../lib/api';
import { formatAed, formatDateTime } from '../lib/format';

interface Props {
  lead: LeadDetail;
  token: string;
  /** The agent's timezone: due dates are shown in it, not in the phone's. */
  timeZone: string;
  /** Called with the task an approval created, so the screen can refresh its task list. */
  onTaskCreated: (task: Task) => void | Promise<void>;
  onUnauthorized: () => void;
}

/** How often a background ("running") run is re-read. */
export const RUN_POLL_INTERVAL_MS = 2_000;

const FLAG_LABELS: Record<ListingFlag, string> = {
  rent_missing: 'no rent recorded',
  price_suspect: 'price looks wrong',
  possible_duplicate: 'possible duplicate',
  instruction_like_text: 'text addressed to the assistant',
};

const ACTION_STATUS_LABELS: Record<ProposedAction['status'], string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

const INTENT_LABELS: Record<AssistantRequirements['intent'], string> = { buy: 'Buy', rent: 'Rent', unknown: 'Unknown' };

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function bedroomsLabel(r: AssistantRequirements): string {
  const one = (n: number) => (n === 0 ? 'Studio' : `${n} bed`);
  if (r.bedrooms !== null) return one(r.bedrooms);
  const range = r.bedroomsRange;
  if (range?.min != null && range.max != null) {
    if (range.min === range.max) return one(range.min);
    return range.min === 0 ? `Studio or ${range.max} bed` : `${range.min}–${range.max} bed`;
  }
  if (range?.min != null) return `${one(range.min)} or more`;
  if (range?.max != null) return `Up to ${one(range.max)}`;
  return 'Any';
}

function budgetLabel(r: AssistantRequirements): string {
  const { min, max } = r.budgetAed;
  if (min !== null && max !== null) return `${formatAed(min)} – ${formatAed(max)}`;
  if (max !== null) return `${r.budgetIsApproximate ? 'Around' : 'Up to'} ${formatAed(max)}`;
  if (min !== null) return `From ${formatAed(min)}`;
  return 'No budget given';
}

/** "Ready to buy this week (16-22 Nov 2026) · urgent", plus "window already passed" when stale. */
function timelineLabel(t: AssistantTimeline): string {
  const phrase = t.quote ? `${t.quote}${t.window ? ` (${t.window})` : ''}` : capitalise(t.label);
  return [phrase, t.urgent ? 'urgent' : null, t.stale ? 'window already passed' : null].filter(Boolean).join(' · ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function AssistantPanel({ lead, token, timeZone, onTaskCreated, onUnauthorized }: Props) {
  const hasInbound = lead.messages.some((message) => message.direction === 'inbound');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);
  const [starting, setStarting] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  /** Bumped whenever a newer run replaces the shown one, so late answers for an older one are dropped. */
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(errorMessage(err));
    },
    [onUnauthorized],
  );

  // Show the latest run for this lead, if there is one.
  useEffect(() => {
    const started = generation.current;
    setLoadingLatest(true);
    api
      .listAssistantRuns(token, lead.id, 1)
      .then((runs) => {
        if (mounted.current && generation.current === started) setRun(runs[0] ?? null);
      })
      .catch(handleError)
      .finally(() => {
        if (mounted.current) setLoadingLatest(false);
      });
  }, [token, lead.id, handleError]);

  // A background run: re-read it until it is no longer running. A failed read is retried with
  // backoff (up to 8x the interval); only a 401 (handled by logging out) or unmounting stops it.
  const runningId = run?.status === 'running' ? run.id : null;
  const [pollFailures, setPollFailures] = useState(0);
  useEffect(() => {
    if (!runningId) return;
    const started = generation.current;
    const timer = setTimeout(() => {
      api
        .getAssistantRun(token, lead.id, runningId)
        .then((next) => {
          if (!mounted.current || generation.current !== started) return;
          if (pollFailures > 0) {
            setPollFailures(0);
            setError(null);
          }
          setRun(next);
        })
        .catch((err: unknown) => {
          if (!mounted.current || generation.current !== started) return;
          if (err instanceof ApiError && err.status === 401) {
            handleError(err);
            return;
          }
          setError('Lost contact with the server while the analysis runs. Retrying…');
          setPollFailures((n) => n + 1);
        });
    }, RUN_POLL_INTERVAL_MS * Math.min(2 ** pollFailures, 8));
    return () => clearTimeout(timer);
  }, [runningId, run, token, lead.id, handleError, pollFailures]);

  async function analyse() {
    const mine = ++generation.current;
    setPollFailures(0);
    setStarting(true);
    setError(null);
    try {
      const result = await api.startAssistantRun(token, lead.id);
      if (mounted.current && generation.current === mine) setRun(result);
    } catch (err) {
      handleError(err);
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  function replaceAction(action: ProposedAction) {
    setRun((current) =>
      current && {
        ...current,
        proposedActions: current.proposedActions.map((item) => (item.id === action.id ? action : item)),
      },
    );
  }

  async function decide(action: ProposedAction, decision: 'approve' | 'reject') {
    if (!run) return;
    const runId = run.id;
    setDecidingId(action.id);
    setError(null);
    try {
      if (decision === 'approve') {
        const result = await api.approveAssistantAction(token, lead.id, runId, action.id);
        if (!mounted.current) return;
        replaceAction(result.action);
        await onTaskCreated(result.task);
      } else {
        const result = await api.rejectAssistantAction(token, lead.id, runId, action.id);
        if (mounted.current) replaceAction(result.action);
      }
    } catch (err) {
      handleError(err);
      // Decided elsewhere (another device or tab): show the action's real state.
      if (err instanceof ApiError && err.status === 409) {
        try {
          const fresh = await api.getAssistantRun(token, lead.id, runId);
          if (mounted.current) setRun((current) => (current?.id === runId ? fresh : current));
        } catch (reloadErr) {
          handleError(reloadErr);
        }
      }
    } finally {
      if (mounted.current) setDecidingId(null);
    }
  }

  const analysing = starting || run?.status === 'running';
  const canStart = hasInbound && !analysing;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>AI assistant</Text>

      <Pressable
        style={({ pressed }) => [styles.primaryButton, !canStart && styles.disabled, pressed && styles.pressed]}
        disabled={!canStart}
        onPress={() => void analyse()}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canStart, busy: analysing }}
      >
        {analysing && <ActivityIndicator color="#ffffff" />}
        <Text style={styles.primaryButtonText}>
          {analysing ? 'Analysing…' : run ? 'Analyze again' : 'Analyze latest message'}
        </Text>
      </Pressable>

      {!hasInbound && <Text style={styles.muted}>This lead has no inbound message to analyse.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {loadingLatest && !run && <ActivityIndicator />}
      {!loadingLatest && !run && !starting && <Text style={styles.muted}>No analysis yet.</Text>}

      {run?.status === 'failed' && (
        <Text style={styles.error}>Analysis failed: {run.error ?? 'the assistant did not finish.'}</Text>
      )}

      {run?.status === 'completed' && (
        <CompletedRun
          run={run}
          timeZone={timeZone}
          decidingId={decidingId}
          onDecide={(action, decision) => void decide(action, decision)}
        />
      )}
    </View>
  );
}

interface CompletedRunProps {
  run: AssistantRun;
  timeZone: string;
  decidingId: string | null;
  onDecide: (action: ProposedAction, decision: 'approve' | 'reject') => void;
}

function CompletedRun({ run, timeZone, decidingId, onDecide }: CompletedRunProps) {
  const { requirements } = run;
  const facts: Array<[string, string]> = [
    ['Area', requirements.locations.join(', ') || 'Any area'],
    ['Bedrooms', bedroomsLabel(requirements)],
    ['Budget', budgetLabel(requirements)],
    ['Type', requirements.propertyType ? capitalise(requirements.propertyType) : 'Any type'],
    ['Intent', INTENT_LABELS[requirements.intent]],
    ['Preferences', requirements.preferences.join(', ') || 'None'],
    ...(requirements.timeline ? [['Timeline', timelineLabel(requirements.timeline)] as [string, string]] : []),
  ];

  return (
    <View style={styles.results}>
      <View>
        <Text style={styles.sectionTitle}>What the lead wants</Text>
        {facts.map(([label, value]) => (
          <View key={label} style={styles.fact}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{value}</Text>
          </View>
        ))}
      </View>

      <View>
        <Text style={styles.sectionTitle}>Recommendations</Text>
        {run.recommendations.length === 0 ? (
          <Text style={styles.muted}>No listing fits these requirements.</Text>
        ) : (
          <View style={styles.list}>
            {run.recommendations.map((recommendation, index) => (
              <RecommendationRow key={recommendation.propertyId} rank={index + 1} recommendation={recommendation} />
            ))}
          </View>
        )}
        {run.dataWarnings?.map((warning) => (
          <Text key={warning.propertyId} style={styles.warning}>
            Check listing {warning.reference}: {warning.flags.map((flag) => FLAG_LABELS[flag] ?? flag).join(', ')}
          </Text>
        ))}
      </View>

      <View>
        <Text style={styles.sectionTitle}>Summary</Text>
        <Text style={styles.body}>{run.summary}</Text>
      </View>

      <View>
        <Text style={styles.sectionTitle}>Proposed follow-up</Text>
        {run.proposedActions.length === 0 && <Text style={styles.muted}>No follow-up proposed.</Text>}
        {run.proposedActions.map((action) => {
          const busy = decidingId === action.id;
          return (
            <View key={action.id} style={styles.action}>
              <Text style={styles.actionStatus}>{ACTION_STATUS_LABELS[action.status]}</Text>
              <Text style={styles.itemTitle}>{action.task.title}</Text>
              <Text style={styles.muted}>
                {action.task.dueAt ? `Due ${formatDateTime(action.task.dueAt, timeZone)}` : 'No due date'}
              </Text>
              {action.task.notes && <Text style={styles.body}>{action.task.notes}</Text>}
              {action.needsClarification && (
                <Text style={styles.clarification}>Needs clarification: {action.needsClarification}</Text>
              )}
              {action.status === 'pending_approval' && (
                <View style={styles.buttons}>
                  <Pressable
                    style={({ pressed }) => [styles.primaryButton, busy && styles.disabled, pressed && styles.pressed]}
                    disabled={busy}
                    onPress={() => onDecide(action, 'approve')}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                  >
                    <Text style={styles.primaryButtonText}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.secondaryButton, busy && styles.disabled, pressed && styles.pressed]}
                    disabled={busy}
                    onPress={() => onDecide(action, 'reject')}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                  >
                    <Text style={styles.secondaryButtonText}>Reject</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function RecommendationRow({ rank, recommendation }: { rank: number; recommendation: Recommendation }) {
  const property = recommendation.property;
  return (
    <View style={styles.recommendation}>
      <Text style={styles.itemTitle}>
        {property ? `${rank}. ${property.reference} · ${property.title}` : `${rank}. ${recommendation.propertyId}`}
      </Text>
      {property && (
        <Text style={styles.muted}>
          {`${formatAed(property.priceAed)} · ${
            property.grossYieldPct === null ? 'Yield unknown' : `Yield ${property.grossYieldPct}%`
          }`}
        </Text>
      )}
      <Text style={styles.body}>{recommendation.reason}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, backgroundColor: '#ffffff', padding: 16, gap: 12 },
  title: { fontWeight: '600', fontSize: 16, color: '#111827' },
  results: { gap: 16 },
  sectionTitle: { fontWeight: '600', fontSize: 14, color: '#111827', marginBottom: 6 },
  fact: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, marginBottom: 2 },
  label: { color: '#6b7280', width: 96, flexShrink: 0 },
  value: { color: '#111827', flex: 1, flexShrink: 1, minWidth: 140 },
  list: { gap: 10 },
  recommendation: { borderRadius: 10, backgroundColor: '#f9fafb', padding: 12, gap: 4 },
  action: { borderWidth: 1, borderColor: '#fde68a', borderRadius: 10, backgroundColor: '#fffbeb', padding: 12, gap: 4 },
  actionStatus: { color: '#92400e', fontSize: 12, fontWeight: '600' },
  itemTitle: { color: '#111827', fontWeight: '600' },
  body: { color: '#374151' },
  muted: { color: '#6b7280', fontSize: 12 },
  warning: { color: '#92400e', fontSize: 12, marginTop: 6 },
  clarification: { color: '#92400e', fontSize: 12 },
  error: { color: '#b91c1c' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  primaryButton: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    borderRadius: 8,
    backgroundColor: '#111827',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryButtonText: { color: '#ffffff', fontWeight: '600' },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryButtonText: { color: '#111827', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
});
