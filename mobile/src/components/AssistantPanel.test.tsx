import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { api, ApiError, AssistantRun, LeadDetail, ProposedAction, Task } from '../lib/api';
import { AssistantPanel } from './AssistantPanel';

jest.mock('../lib/api', () => {
  const actual = jest.requireActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      listAssistantRuns: jest.fn(),
      startAssistantRun: jest.fn(),
      getAssistantRun: jest.fn(),
      approveAssistantAction: jest.fn(),
      rejectAssistantAction: jest.fn(),
    },
  };
});

const mocked = api as jest.Mocked<typeof api>;

const lead: LeadDetail = {
  id: 'lead-1',
  name: 'Karim',
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
      body: 'Looking for a 2-bed in Dubai Marina, around 2M. Follow up tomorrow?',
      sentAt: '2026-10-15T08:00:00.000Z',
    },
  ],
};

const pendingAction: ProposedAction = {
  id: 'act-1',
  type: 'create_follow_up_task',
  status: 'pending_approval',
  task: { title: 'Call Karim about Marina 2-beds', notes: 'Send MBR-1001 and MBR-1002', dueAt: '2026-10-16T10:00:00+04:00' },
  needsClarification: null,
};

function makeRun(overrides: Partial<AssistantRun> = {}): AssistantRun {
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
    },
    recommendations: [
      {
        propertyId: 'p-2',
        reason: 'Highest yield of the fits at 6.5%.',
        property: {
          reference: 'MBR-1002',
          title: 'Marina Gate 2BR',
          area: 'Dubai Marina',
          building: 'Marina Gate',
          type: 'apartment',
          bedrooms: 2,
          sizeSqft: 1200,
          priceAed: 1_950_000,
          annualRentAed: 126_750,
          grossYieldPct: 6.5,
          status: 'available',
          flags: [],
        },
      },
      { propertyId: 'p-1', reason: 'Within budget, rent unknown.' },
    ],
    summary: 'Two Marina 2-beds fit the budget.',
    proposedActions: [pendingAction],
    trace: [],
    createdAt: '2026-10-15T08:01:00.000Z',
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
  createdBy: { id: 'agent-1', name: 'Sara' },
  createdAt: '2026-10-15T09:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const onTaskCreated = jest.fn();
const onUnauthorized = jest.fn();

async function renderPanel(props: Partial<React.ComponentProps<typeof AssistantPanel>> = {}) {
  await render(
    <AssistantPanel
      lead={lead}
      token="tok"
      timeZone="Asia/Dubai"
      onTaskCreated={onTaskCreated}
      onUnauthorized={onUnauthorized}
      {...props}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.listAssistantRuns.mockResolvedValue([]);
});

describe('AssistantPanel', () => {
  it('loads the latest run and shows requirements, ranked recommendations, summary and the follow-up', async () => {
    mocked.listAssistantRuns.mockResolvedValue([makeRun()]);
    await renderPanel();

    expect(await screen.findByText('Two Marina 2-beds fit the budget.')).toBeOnTheScreen();
    expect(mocked.listAssistantRuns).toHaveBeenCalledWith('tok', 'lead-1', 1);

    expect(screen.getByText('Dubai Marina')).toBeOnTheScreen();
    expect(screen.getByText('2 bed')).toBeOnTheScreen();
    expect(screen.getByText('Up to AED 2,000,000')).toBeOnTheScreen();
    expect(screen.getByText('Apartment')).toBeOnTheScreen();
    expect(screen.getByText('Buy')).toBeOnTheScreen();
    expect(screen.getByText('good rental yield')).toBeOnTheScreen();

    // Best first, as the API ordered them.
    const first = screen.getByText('1. MBR-1002 · Marina Gate 2BR');
    const second = screen.getByText('2. p-1');
    expect(first).toBeOnTheScreen();
    expect(second).toBeOnTheScreen();
    expect(screen.getByText('AED 1,950,000 · Yield 6.5%')).toBeOnTheScreen();
    expect(screen.getByText('Highest yield of the fits at 6.5%.')).toBeOnTheScreen();
    expect(screen.getByText('Within budget, rent unknown.')).toBeOnTheScreen();

    expect(screen.getByText('Call Karim about Marina 2-beds')).toBeOnTheScreen();
    expect(screen.getByText('Due 16 Oct, 10:00')).toBeOnTheScreen();
    expect(screen.getByText('Waiting for approval')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Analyze again' })).toBeEnabled();
  });

  it("shows the due time in the agent's timezone, not the phone's", async () => {
    mocked.listAssistantRuns.mockResolvedValue([
      makeRun({ proposedActions: [{ ...pendingAction, task: { ...pendingAction.task, dueAt: '2026-10-15T21:30:00.000Z' } }] }),
    ]);
    await renderPanel();
    expect(await screen.findByText('Due 16 Oct, 01:30')).toBeOnTheScreen();
  });

  it('starts a run, shows progress, then the result', async () => {
    const pending = deferred<AssistantRun>();
    mocked.startAssistantRun.mockReturnValue(pending.promise);
    await renderPanel();

    expect(await screen.findByText('No analysis yet.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Analyze latest message' }));

    expect(mocked.startAssistantRun).toHaveBeenCalledWith('tok', 'lead-1');
    expect(screen.getByText('Analysing…')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Analysing…' })).toBeDisabled();

    pending.resolve(makeRun());
    expect(await screen.findByText('Two Marina 2-beds fit the budget.')).toBeOnTheScreen();
    expect(screen.queryByText('Analysing…')).not.toBeOnTheScreen();
  });

  it('cannot start a run when the lead has no inbound message', async () => {
    await renderPanel({ lead: { ...lead, messages: [{ ...lead.messages[0], direction: 'outbound' }] } });
    expect(await screen.findByRole('button', { name: 'Analyze latest message' })).toBeDisabled();
    expect(screen.getByText('This lead has no inbound message to analyse.')).toBeOnTheScreen();
  });

  it('shows a failed run as a failure, never as "nothing fits"', async () => {
    mocked.listAssistantRuns.mockResolvedValue([
      makeRun({
        status: 'failed',
        error: 'The model did not answer in time.',
        recommendations: [],
        proposedActions: [],
        summary: '',
      }),
    ]);
    await renderPanel();

    expect(await screen.findByText('Analysis failed: The model did not answer in time.')).toBeOnTheScreen();
    expect(screen.queryByText('No listing fits these requirements.')).not.toBeOnTheScreen();
    expect(screen.queryByText('Recommendations')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Analyze again' })).toBeEnabled();
  });

  it('says so when a completed run has no fitting listing', async () => {
    mocked.listAssistantRuns.mockResolvedValue([makeRun({ recommendations: [], proposedActions: [] })]);
    await renderPanel();
    expect(await screen.findByText('No listing fits these requirements.')).toBeOnTheScreen();
    expect(screen.getByText('No follow-up proposed.')).toBeOnTheScreen();
  });

  it('shows why the date is unclear instead of a due time', async () => {
    mocked.listAssistantRuns.mockResolvedValue([
      makeRun({
        proposedActions: [
          {
            ...pendingAction,
            task: { ...pendingAction.task, dueAt: null },
            needsClarification: 'The lead said "sometime soon".',
          },
        ],
      }),
    ]);
    await renderPanel();
    expect(await screen.findByText('Needs clarification: The lead said "sometime soon".')).toBeOnTheScreen();
    expect(screen.getByText('No due date')).toBeOnTheScreen();
  });

  it('lists data warnings for flagged listings', async () => {
    mocked.listAssistantRuns.mockResolvedValue([
      makeRun({ dataWarnings: [{ propertyId: 'p-9', reference: 'MBR-1019', flags: ['instruction_like_text', 'rent_missing'] }] }),
    ]);
    await renderPanel();
    expect(
      await screen.findByText('Check listing MBR-1019: text addressed to the assistant, no rent recorded'),
    ).toBeOnTheScreen();
  });

  it('approves the follow-up, locks both buttons while saving, and refreshes the task list', async () => {
    mocked.listAssistantRuns.mockResolvedValue([makeRun()]);
    const pending = deferred<{ action: ProposedAction; task: Task }>();
    mocked.approveAssistantAction.mockReturnValue(pending.promise);
    await renderPanel();

    await fireEvent.press(await screen.findByRole('button', { name: 'Approve' }));
    expect(mocked.approveAssistantAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();

    pending.resolve({ action: { ...pendingAction, status: 'approved' }, task });
    expect(await screen.findByText('Approved')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeOnTheScreen();
    expect(onTaskCreated).toHaveBeenCalledWith(task);
  });

  it('rejects the follow-up without creating a task', async () => {
    mocked.listAssistantRuns.mockResolvedValue([makeRun()]);
    mocked.rejectAssistantAction.mockResolvedValue({ action: { ...pendingAction, status: 'rejected' } });
    await renderPanel();

    await fireEvent.press(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected')).toBeOnTheScreen();
    expect(mocked.rejectAssistantAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    expect(onTaskCreated).not.toHaveBeenCalled();
  });

  it('shows a conflict and reloads the run when the action was already decided elsewhere', async () => {
    mocked.listAssistantRuns.mockResolvedValue([makeRun()]);
    mocked.approveAssistantAction.mockRejectedValue(new ApiError(409, 'This action was already rejected.'));
    mocked.getAssistantRun.mockResolvedValue(makeRun({ proposedActions: [{ ...pendingAction, status: 'rejected' }] }));
    await renderPanel();

    await fireEvent.press(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This action was already rejected.')).toBeOnTheScreen();
    expect(await screen.findByText('Rejected')).toBeOnTheScreen();
    expect(mocked.getAssistantRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1');
    expect(onTaskCreated).not.toHaveBeenCalled();
  });

  it('shows the API message when the lead has no inbound message (422)', async () => {
    mocked.startAssistantRun.mockRejectedValue(new ApiError(422, 'This lead has no inbound message to analyse.'));
    await renderPanel();
    await fireEvent.press(await screen.findByRole('button', { name: 'Analyze latest message' }));
    expect(await screen.findByText('This lead has no inbound message to analyse.')).toBeOnTheScreen();
  });

  it('logs out when the session has expired', async () => {
    mocked.listAssistantRuns.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    await renderPanel();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it('polls a background run until it finishes', async () => {
    jest.useFakeTimers();
    try {
      mocked.listAssistantRuns.mockResolvedValue([makeRun({ status: 'running', recommendations: [], proposedActions: [] })]);
      mocked.getAssistantRun.mockResolvedValue(makeRun());
      await renderPanel();

      expect(await screen.findByText('Analysing…')).toBeOnTheScreen();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
      });
      expect(await screen.findByText('Two Marina 2-beds fit the budget.')).toBeOnTheScreen();
      expect(mocked.getAssistantRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1');
    } finally {
      jest.useRealTimers();
    }
  });
});
