import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, type AssistantRun, type LeadDetail, type ProposedAction, type Task } from '@/lib/api';
import { API_URL } from '@/lib/api';
import { AssistantPanel, type AssistantClient } from './AssistantPanel';

const lead: LeadDetail = {
  id: 'lead-1',
  name: 'Karim Haddad',
  phone: null,
  email: null,
  source: 'whatsapp',
  status: 'new',
  notes: null,
  assignedAgent: null,
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
  messageCount: 1,
  messages: [
    {
      id: 'msg-1',
      leadId: 'lead-1',
      direction: 'inbound',
      channel: 'whatsapp',
      body: 'Looking for a 2-bed in Dubai Marina around 2M. Follow up tomorrow?',
      sentAt: '2026-10-15T08:00:00.000Z',
    },
  ],
};

const pendingAction: ProposedAction = {
  id: 'act-1',
  type: 'create_follow_up_task',
  status: 'pending_approval',
  task: {
    title: 'Call Karim about Dubai Marina 2-beds',
    notes: 'Share MBR-1001 and MBR-1002',
    dueAt: '2026-10-16T10:00:00+04:00',
  },
  needsClarification: null,
};

function completedRun(overrides: Partial<AssistantRun> = {}): AssistantRun {
  return {
    id: 'run-1',
    leadId: 'lead-1',
    messageId: 'msg-1',
    status: 'completed',
    requirements: {
      locations: ['Dubai Marina'],
      bedrooms: 2,
      budgetAed: { min: null, max: 2_000_000 },
      propertyType: 'apartment',
      intent: 'buy',
      preferences: ['good rental yield'],
      budgetIsApproximate: true,
    },
    recommendations: [
      {
        propertyId: 'prop-1',
        reason: 'Highest yield of the Marina 2-beds inside the budget.',
        property: {
          reference: 'MBR-1001',
          title: 'Marina Gate 2BR',
          area: 'Dubai Marina',
          building: 'Marina Gate',
          type: 'apartment',
          bedrooms: 2,
          sizeSqft: 1200,
          priceAed: 1_950_000,
          annualRentAed: 119_000,
          grossYieldPct: 6.1,
          status: 'available',
          flags: [],
        },
      },
      { propertyId: 'prop-no-snapshot', reason: 'Fits the budget.' },
    ],
    summary: 'Karim wants a 2-bed Marina apartment around AED 2M; two listings fit.',
    proposedActions: [pendingAction],
    trace: [{ tool: 'search_listings', input: {}, output: [], durationMs: 12 }],
    createdAt: '2026-10-15T08:01:00.000Z',
    dataWarnings: [{ propertyId: 'prop-9', reference: 'MBR-1019', flags: ['instruction_like_text'] }],
    ...overrides,
  };
}

const task: Task = {
  id: 'task-1',
  leadId: 'lead-1',
  title: pendingAction.task.title,
  notes: pendingAction.task.notes,
  dueAt: '2026-10-16T06:00:00.000Z',
  status: 'open',
  createdBy: { id: 'agent-1', name: 'Sara Khan' },
  createdAt: '2026-10-15T08:02:00.000Z',
};

function fakeClient(overrides: Partial<AssistantClient> = {}): AssistantClient {
  return {
    latestRun: vi.fn().mockResolvedValue(null),
    startRun: vi.fn().mockResolvedValue(completedRun()),
    getRun: vi.fn().mockResolvedValue(completedRun()),
    approveAction: vi.fn().mockResolvedValue({ action: { ...pendingAction, status: 'approved' }, task }),
    rejectAction: vi.fn().mockResolvedValue({ action: { ...pendingAction, status: 'rejected' } }),
    ...overrides,
  };
}

function renderPanel(client: AssistantClient, onApproved = vi.fn()) {
  render(
    <AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" client={client} onApproved={onApproved} />,
  );
  return { onApproved };
}

async function analyse() {
  fireEvent.click(screen.getByRole('button', { name: 'Analyse latest message' }));
}

describe('AssistantPanel', () => {
  it('renders a completed run: requirements, recommendations, summary, warnings and follow-up', async () => {
    const client = fakeClient();
    renderPanel(client);
    await analyse();

    expect(await screen.findByText(/two listings fit/)).toBeInTheDocument();
    expect(client.startRun).toHaveBeenCalledWith('tok', 'lead-1');

    const understood = screen.getByRole('region', { name: 'What the lead wants' });
    expect(within(understood).getByText('Dubai Marina')).toBeInTheDocument();
    expect(within(understood).getByText('2 bedrooms')).toBeInTheDocument();
    expect(within(understood).getByText('around AED 2,000,000')).toBeInTheDocument();
    expect(within(understood).getByText('Buy')).toBeInTheDocument();
    expect(within(understood).getByText('good rental yield')).toBeInTheDocument();

    const recs = screen.getByRole('list', { name: 'Recommended listings' });
    const items = within(recs).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(/MBR-1001/)).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Marina Gate 2BR/)).toBeInTheDocument();
    expect(within(items[0]!).getByText(/AED 1,950,000/)).toBeInTheDocument();
    expect(within(items[0]!).getByText(/6\.1% gross yield/)).toBeInTheDocument();
    expect(within(items[0]!).getByText('Highest yield of the Marina 2-beds inside the budget.')).toBeInTheDocument();
    // No snapshot: falls back to the property id.
    expect(within(items[1]!).getByText(/prop-no-snapshot/)).toBeInTheDocument();

    expect(screen.getByText(/MBR-1019/)).toBeInTheDocument();

    const followUp = screen.getByRole('region', { name: 'Proposed follow-up' });
    expect(within(followUp).getByText(pendingAction.task.title)).toBeInTheDocument();
    expect(within(followUp).getByText('Share MBR-1001 and MBR-1002')).toBeInTheDocument();
    // Shown in the agent's timezone.
    expect(within(followUp).getByText(/16 Oct 2026.*10:00/)).toBeInTheDocument();
    expect(within(followUp).getByText(/Pending approval/i)).toBeInTheDocument();
  });

  it('shows a loading state while the run is in progress', async () => {
    let resolve!: (run: AssistantRun) => void;
    const client = fakeClient({ startRun: vi.fn(() => new Promise<AssistantRun>((r) => (resolve = r))) });
    renderPanel(client);
    await analyse();

    const button = screen.getByRole('button', { name: /Analysing/ });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Analysing/);

    await act(async () => resolve(completedRun()));
    expect(screen.getByRole('button', { name: 'Analyse latest message' })).toBeEnabled();
  });

  it('says nothing fits when a completed run has no recommendations', async () => {
    const client = fakeClient({ startRun: vi.fn().mockResolvedValue(completedRun({ recommendations: [] })) });
    renderPanel(client);
    await analyse();

    expect(await screen.findByText('No listing fits what the lead asked for.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Recommended listings' })).not.toBeInTheDocument();
  });

  it('shows the error of a failed run and never says nothing was found', async () => {
    const failed = completedRun({
      status: 'failed',
      error: 'The model did not answer in time.',
      recommendations: [],
      proposedActions: [],
      requirements: {
        locations: [],
        bedrooms: null,
        budgetAed: { min: null, max: null },
        propertyType: null,
        intent: 'unknown',
        preferences: [],
      },
      summary: '',
    });
    renderPanel(fakeClient({ startRun: vi.fn().mockResolvedValue(failed) }));
    await analyse();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The analysis failed');
    expect(alert).toHaveTextContent('The model did not answer in time.');
    expect(screen.queryByText(/No listing fits/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What the lead wants' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyse latest message' })).toBeEnabled();
  });

  it('shows the API error when starting the run fails', async () => {
    renderPanel(
      fakeClient({ startRun: vi.fn().mockRejectedValue(new ApiError(422, 'Lead has no inbound message')) }),
    );
    await analyse();
    expect(await screen.findByRole('alert')).toHaveTextContent('Lead has no inbound message');
    expect(screen.queryByText(/No listing fits/)).not.toBeInTheDocument();
  });

  it('approves: calls the API, reports the task and disables both buttons', async () => {
    let resolveApprove!: (value: { action: ProposedAction; task: Task }) => void;
    const client = fakeClient({
      approveAction: vi.fn(() => new Promise<{ action: ProposedAction; task: Task }>((r) => (resolveApprove = r))),
    });
    const { onApproved } = renderPanel(client);
    await analyse();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(client.approveAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    // Pending: both disabled.
    expect(screen.getByRole('button', { name: /Approving/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();

    await act(async () => resolveApprove({ action: { ...pendingAction, status: 'approved' }, task }));

    expect(onApproved).toHaveBeenCalledWith(task);
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('rejects: calls the API, does not report a task and disables both buttons', async () => {
    const client = fakeClient();
    const { onApproved } = renderPanel(client);
    await analyse();

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.getByText(/Rejected/)).toBeInTheDocument());
    expect(client.rejectAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('on 409 shows the conflict and reloads the run to show the real status', async () => {
    const client = fakeClient({
      approveAction: vi.fn().mockRejectedValue(new ApiError(409, 'Action is already rejected')),
      getRun: vi.fn().mockResolvedValue(completedRun({ proposedActions: [{ ...pendingAction, status: 'rejected' }] })),
    });
    const { onApproved } = renderPanel(client);
    await analyse();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already decided/i);
    await waitFor(() => expect(client.getRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1'));
    expect(await screen.findByText(/Rejected/)).toBeInTheDocument();
    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows needsClarification prominently instead of a due date', async () => {
    const unclear: ProposedAction = {
      ...pendingAction,
      task: { ...pendingAction.task, dueAt: null },
      needsClarification: 'The lead said "sometime soon" without a day.',
    };
    renderPanel(fakeClient({ startRun: vi.fn().mockResolvedValue(completedRun({ proposedActions: [unclear] })) }));
    await analyse();

    const followUp = await screen.findByRole('region', { name: 'Proposed follow-up' });
    const note = within(followUp).getByRole('note');
    expect(note).toHaveTextContent('Date needs clarification');
    expect(note).toHaveTextContent('The lead said "sometime soon" without a day.');
    expect(within(followUp).getByText('No due date')).toBeInTheDocument();
  });

  it('loads the latest run on mount', async () => {
    const client = fakeClient({ latestRun: vi.fn().mockResolvedValue(completedRun()) });
    renderPanel(client);
    expect(await screen.findByText(/two listings fit/)).toBeInTheDocument();
    expect(client.latestRun).toHaveBeenCalledWith('tok', 'lead-1');
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it('polls a running run until it finishes', async () => {
    const running = completedRun({ status: 'running', recommendations: [], proposedActions: [], summary: '' });
    const client = fakeClient({
      latestRun: vi.fn().mockResolvedValue(running),
      getRun: vi.fn().mockResolvedValue(completedRun()),
    });
    renderPanel(client);
    expect(await screen.findByRole('list', { name: 'Steps so far' })).toHaveTextContent('search_listings');
    expect(await screen.findByText(/two listings fit/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(client.getRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables analysis when the lead has no inbound message', () => {
    render(
      <AssistantPanel
        lead={{ ...lead, messages: [{ ...lead.messages[0]!, direction: 'outbound' }] }}
        token="tok"
        timeZone="Asia/Dubai"
        client={fakeClient()}
        onApproved={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Analyse latest message' })).toBeDisabled();
    expect(screen.getByText('This lead has not sent a message yet.')).toBeInTheDocument();
  });

  describe('background runs', () => {
    const running = (overrides: Partial<AssistantRun> = {}) =>
      completedRun({ status: 'running', requirements: completedRun().requirements, recommendations: [], proposedActions: [], summary: '', trace: [], ...overrides });
    const search = { tool: 'search_listings', input: { areas: ['Dubai Marina'], minBedrooms: 2, type: null }, output: { items: [] }, durationMs: 45 };
    const details = { tool: 'get_listing_details', input: { propertyId: 'prop-1' }, error: 'Database unavailable', durationMs: 12 };

    /** getRun answers one poll at a time, when the test says so. */
    function stepper() {
      const pending: Array<(run: AssistantRun) => void> = [];
      const getRun = vi.fn<AssistantClient['getRun']>(() => new Promise<AssistantRun>((resolve) => pending.push(resolve)));
      const answer = async (run: AssistantRun) => {
        await waitFor(() => expect(pending.length).toBeGreaterThan(0));
        await act(async () => pending.shift()!(run));
      };
      return { getRun, answer };
    }

    function renderPolling(client: AssistantClient) {
      render(
        <AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" client={client} onApproved={vi.fn()} pollIntervalMs={5} />,
      );
    }

    it('shows each tool step as it happens (tool, short input, duration, ok or error), then the result', async () => {
      const { getRun, answer } = stepper();
      const client = fakeClient({ startRun: vi.fn().mockResolvedValue(running()), getRun });
      renderPolling(client);
      await analyse();

      expect(await screen.findByRole('status')).toHaveTextContent(/Analysing/);
      expect(screen.getByRole('button', { name: /Analysing/ })).toBeDisabled();

      await answer(running({ trace: [search] }));
      let steps = screen.getByRole('list', { name: 'Steps so far' });
      expect(within(steps).getAllByRole('listitem')).toHaveLength(1);
      expect(steps).toHaveTextContent('search_listings');
      expect(steps).toHaveTextContent('areas: Dubai Marina, minBedrooms: 2');
      expect(steps).toHaveTextContent('45 ms');
      expect(steps).toHaveTextContent('ok');

      await answer(running({ trace: [search, details] }));
      steps = screen.getByRole('list', { name: 'Steps so far' });
      const items = within(steps).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[1]).toHaveTextContent('get_listing_details');
      expect(items[1]).toHaveTextContent('propertyId: prop-1');
      expect(items[1]).toHaveTextContent('failed: Database unavailable');

      await answer(completedRun());
      expect(screen.getByText(/two listings fit/)).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Steps so far' })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(getRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1');
      const calls = getRun.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getRun).toHaveBeenCalledTimes(calls);
    });

    it('ends on the failed view when the background run fails', async () => {
      const { getRun, answer } = stepper();
      const client = fakeClient({ startRun: vi.fn().mockResolvedValue(running()), getRun });
      renderPolling(client);
      await analyse();
      await answer({ ...running({ trace: [details] }), status: 'failed', error: 'Tool get_listing_details failed: Database unavailable' });
      expect(screen.getByText('The analysis failed. Nothing was saved; try again.')).toBeInTheDocument();
      expect(screen.getByText('Tool get_listing_details failed: Database unavailable')).toBeInTheDocument();
    });

    it('on 409 attaches to the run already in progress instead of failing', async () => {
      const { getRun, answer } = stepper();
      const conflict = new ApiError(409, 'An analysis is already running for this lead.', { statusCode: 409, runId: 'run-7' });
      const client = fakeClient({ startRun: vi.fn().mockRejectedValue(conflict), getRun });
      renderPolling(client);
      await analyse();

      await answer(running({ id: 'run-7', trace: [search] }));
      expect(getRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-7');
      expect(screen.getByRole('list', { name: 'Steps so far' })).toHaveTextContent('search_listings');
      expect(screen.getByRole('status')).toHaveTextContent(/already running/i);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await answer(completedRun({ id: 'run-7' }));
      expect(screen.getByText(/two listings fit/)).toBeInTheDocument();
      expect(getRun.mock.calls.every(([, , runId]) => runId === 'run-7')).toBe(true);
    });

    it('shows the error when a 409 does not name a run', async () => {
      const client = fakeClient({ startRun: vi.fn().mockRejectedValue(new ApiError(409, 'Conflict')) });
      renderPolling(client);
      await analyse();
      expect(await screen.findByRole('alert')).toHaveTextContent('Conflict');
      expect(client.getRun).not.toHaveBeenCalled();
    });

    it('stops polling when the panel unmounts', async () => {
      const getRun = vi.fn().mockResolvedValue(running({ trace: [search] }));
      const client = fakeClient({ latestRun: vi.fn().mockResolvedValue(running()), getRun });
      const { unmount } = render(
        <AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" client={client} onApproved={vi.fn()} pollIntervalMs={5} />,
      );
      await waitFor(() => expect(getRun.mock.calls.length).toBeGreaterThanOrEqual(2));
      unmount();
      const calls = getRun.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getRun).toHaveBeenCalledTimes(calls);
    });

    it('the default client starts runs in the background (?async=true)', async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('?async=true')) return new Response(JSON.stringify(completedRun()), { status: 202 });
        return new Response('[]', { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        render(<AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" onApproved={vi.fn()} />);
        await analyse();
        expect(await screen.findByText(/two listings fit/)).toBeInTheDocument();
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`${API_URL}/leads/lead-1/assistant/runs?async=true`);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
