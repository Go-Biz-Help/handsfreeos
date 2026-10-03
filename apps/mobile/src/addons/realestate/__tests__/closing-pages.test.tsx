import type {
  ClientTasksView,
  FinancingView,
  InspectionsView,
} from '@hfos/core/addons/realestate/views/closing';
import type { WalkthroughView } from '@hfos/core/addons/realestate/views/field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { change, changes } from '@/changes';

import {
  addClientTask,
  addFinding,
  checkWalkthroughItem,
  finishWalkthrough,
  ITEM_CHECK_SQL,
  markStepDone,
  STEP_DONE_SQL,
  STEP_NEW_SQL,
} from '../closing-actions';
import {
  AddTaskSheet,
  ClientTasksBody,
  InviteSheet,
  MarkDoneSheet,
  taskLine,
} from '../client-tasks';
import { FinancingBody, lenderLine, StepSheet } from '../financing';
import { FindingSheet, findingLine, InspectionsBody } from '../inspections';
import { takeDealPhoto } from '../subpage';
import { ItemSheet, WalkthroughBody, type WalkthroughFacts } from '../walkthrough';

/**
 * The closing side on the phone (boards 85 and 86): the loan's steps ticked with no signal, findings added at the
 * inspection, the client's to-do and its portal, and the walkthrough from its list to its proof. Each part renders
 * core's view as the board draws it, and each change goes through the queue with the command and input the API takes.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(async () => ({ id: 'change-1', queued: true })),
    changes: { addPhoto: jest.fn(async () => ({ id: 'upload-1' })) },
    newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/changes/photo-device', () => ({
  takePhoto: jest.fn(async () => ({
    kind: 'kept',
    photo: { localName: 'photo.jpg', sizeBytes: 2048, width: 10, height: 10 },
  })),
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ME = '22222222-2222-4222-8222-222222222222';
const ANN = '11111111-1111-4111-8111-111111111111';
const BILL = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '99999999-9999-4999-8999-999999999999';
const TZ = 'America/Chicago';
const TODAY = '2026-10-03';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
  jest.mocked(changes.addPhoto).mockClear();
});

/** A transaction that keeps what the optimistic write ran. */
function recordingTx() {
  const ran: [string, unknown[]][] = [];
  return {
    ran,
    tx: {
      execute: jest.fn(async (sql: string, args: unknown[] = []) => void ran.push([sql, args])),
    },
  };
}

// ---------- financing ----------

type Step = FinancingView['steps'][number];
const step = (s: Partial<Step> & Pick<Step, 'step' | 'label'>): Step => ({
  status: 'not_started',
  startedOn: null,
  expectedOn: null,
  doneOn: null,
  amountCents: null,
  rate: null,
  expiresOn: null,
  note: null,
  proof: null,
  doneBy: null,
  line: 'Not started',
  warning: null,
  ...s,
});

const FINANCING: FinancingView = {
  full: true,
  lender: {
    lenderName: 'Summit Lending',
    officerName: 'Jo Park',
    officerEmail: 'jo@summit.test',
    officerPhone: '(512) 555-0100',
    loanType: 'conventional',
    loanAmountCents: 39_200_000,
  },
  closing: '2026-10-14',
  cdDeadline: '2026-10-09',
  steps: [
    step({
      step: 'application',
      label: 'Loan application',
      status: 'done',
      doneOn: '2026-09-18',
      line: 'Sent Sep 18',
    }),
    step({
      step: 'rate_lock',
      label: 'Rate lock',
      status: 'done',
      rate: 6.125,
      expiresOn: '2026-10-13',
      line: '6.125% until Oct 13',
    }),
    step({
      step: 'appraisal',
      label: 'Appraisal',
      status: 'in_progress',
      line: 'Ordered Sep 26',
      warning: null,
    }),
    step({ step: 'clear_to_close', label: 'Clear to close', line: 'Expected by Oct 8' }),
  ],
};

describe('financing on the phone', () => {
  it('shows the lender with Call and Text, and each step ticked or not, as the board does', async () => {
    const onStep = jest.fn();
    await render(<FinancingBody view={FINANCING} onStep={onStep} />);
    expect(screen.getByText('Summit Lending · Jo Park')).toBeTruthy();
    expect(screen.getByText('Conventional · $392,000 loan · rate locked to Oct 13')).toBeTruthy();
    expect(screen.getByText('Call Jo')).toBeTruthy();
    expect(screen.getByText('Text')).toBeTruthy();
    expect(screen.getByText('Steps')).toBeTruthy();
    expect(screen.getByText('Sent Sep 18')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('financing-appraisal'));
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ step: 'appraisal' }));
    // A step already done isn't ticked again from here.
    expect(screen.getByTestId('financing-application').props.accessibilityRole).toBeUndefined();
  });

  it('says there’s no lender yet, and leaves the rate out until the lock is done', () => {
    expect(
      lenderLine({ ...FINANCING, steps: FINANCING.steps.filter((s) => s.step !== 'rate_lock') }),
    ).toBe('Conventional · $392,000 loan');
  });

  it('marks a step done with a document of the deal, today or yesterday', async () => {
    const onDone = jest.fn(async () => true);
    const onClose = jest.fn();
    await render(
      <StepSheet
        step={FINANCING.steps[2]!}
        today={TODAY}
        proofs={[{ kind: 'document', id: id(7), label: 'Appraisal report' }]}
        onClose={onClose}
        onDone={onDone}
      />,
    );
    expect(screen.getByText('Appraisal is done')).toBeTruthy();
    expect(screen.getByText('Take a photo of the letter')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('financing-day-yesterday'));
    await fireEvent.press(screen.getByTestId('financing-mark-done'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'appraisal' }),
      '2026-10-02',
      { kind: 'document', id: id(7), label: 'Appraisal report' },
    );
  });

  it('marks a step done with a photo of the lender’s letter when the deal has nothing yet', async () => {
    const onDone = jest.fn(async () => true);
    await render(
      <StepSheet
        step={FINANCING.steps[3]!}
        today={TODAY}
        proofs={[]}
        onClose={jest.fn()}
        onDone={onDone}
      />,
    );
    expect(
      screen.getByText('Nothing on the deal yet. Take a photo of the lender’s letter.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('financing-mark-done'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.anything(), TODAY, 'photo'));
  });

  it('queues the step with its proof, waiting for the photo, and ticks it on the phone at once', async () => {
    await markStepDone({
      workspaceId: WS,
      dealId: DEAL,
      userId: ME,
      step: 'clear_to_close',
      doneOn: TODAY,
      proof: { kind: 'file', id: id(8) },
      dependsOn: ['upload-1'],
    });
    const [name, input, options] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.financing.mark_done');
    expect(input).toEqual({
      workspaceId: WS,
      dealId: DEAL,
      step: 'clear_to_close',
      doneOn: TODAY,
      proof: { kind: 'file', id: id(8) },
    });
    expect(options?.dependsOn).toEqual(['upload-1']);
    const { ran, tx } = recordingTx();
    await options!.optimistic!(tx as never);
    expect(ran.map(([sql]) => sql)).toEqual([STEP_DONE_SQL, STEP_NEW_SQL]);
    expect(ran[0]![1]).toEqual([TODAY, 'file', id(8), ME, DEAL, 'clear_to_close']);
  });

  it('keeps a photo for the deal on the phone and sends it on its own track', async () => {
    const taken = await takeDealPhoto({
      workspaceId: WS,
      userId: ME,
      dealId: DEAL,
      source: 'camera',
      name: 'Letter.jpg',
    });
    expect(taken).toEqual({ kind: 'kept', fileId: NEW_ID, changeId: 'upload-1' });
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: WS, recordType: 'custom_record', recordId: DEAL },
      { localName: 'photo.jpg', sizeBytes: 2048 },
      { fileId: NEW_ID, name: 'Letter.jpg' },
    );
  });
});

// ---------- inspections ----------

type Finding = InspectionsView['inspections'][number]['findings'][number];
const finding = (f: Partial<Finding> & Pick<Finding, 'id' | 'title'>): Finding => ({
  location: null,
  severity: 'minor',
  estimateCents: null,
  clientPriority: null,
  ask: 'not_asked',
  creditCents: null,
  note: null,
  photoFileIds: [],
  ...f,
});
const INSPECTIONS: InspectionsView = {
  full: true,
  periodEnds: '2026-10-03',
  inspections: [
    {
      id: id(20),
      kind: 'general',
      label: 'General inspection',
      inspector: 'Lone Star Inspections',
      scheduledAt: '2026-09-30T14:00:00.000Z',
      reportExpectedOn: null,
      status: 'report_in',
      reportDocument: null,
      reportInOn: '2026-09-30',
      pages: 40,
      note: null,
      findings: [
        finding({
          id: id(21),
          photoFileIds: [id(31), id(32)],
          title: 'Roof flashing loose',
          location: 'Over the back porch',
          severity: 'repair',
          ask: 'repair',
        }),
        finding({
          id: id(22),
          title: 'GFCI missing in kitchen',
          severity: 'safety',
          ask: 'repair',
        }),
        finding({ id: id(23), title: 'Water heater 14 years old', note: 'Note for the buyers' }),
      ],
    },
  ],
  repairs: [],
  draft: { words: 'The buyers ask the seller for the following…', creditCents: 0, items: 2 },
};

describe('inspections on the phone', () => {
  it('shows the inspection and its findings with how serious each is and what to ask for', async () => {
    await render(
      <InspectionsBody view={INSPECTIONS} timeZone={TZ} onAdd={jest.fn()} onDraft={jest.fn()} />,
    );
    expect(screen.getByText('Lone Star Inspections')).toBeTruthy();
    expect(screen.getByText('Report in')).toBeTruthy();
    expect(screen.getByText('Sep 30, 9:00 AM · 3 findings · period ends Oct 3')).toBeTruthy();
    expect(screen.getByText('Over the back porch · ask for repair')).toBeTruthy();
    expect(screen.getByText('Ask for repair')).toBeTruthy();
    expect(screen.getByText('Note for the buyers')).toBeTruthy();
    expect(screen.getByText('Repair')).toBeTruthy();
    expect(screen.getByText('Safety')).toBeTruthy();
    expect(screen.getByText('Minor')).toBeTruthy();
    expect(screen.getByText('Add a finding')).toBeTruthy();
    expect(screen.getByText('Draft the repair request')).toBeTruthy();
    // The roof's two photos; the others have none.
    expect(screen.getByTestId(`finding-photos-${id(21)}`)).toHaveTextContent('2');
    expect(screen.queryByTestId(`finding-photos-${id(22)}`)).toBeNull();
  });

  it('adds a finding with no signal, but the repair request needs it', async () => {
    mockOnline = false;
    const onAdd = jest.fn();
    await render(
      <InspectionsBody view={INSPECTIONS} timeZone={TZ} onAdd={onAdd} onDraft={jest.fn()} />,
    );
    await fireEvent.press(screen.getByTestId('inspection-add-finding'));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: id(20) }));
    expect(screen.getByTestId('inspection-draft')).toHaveTextContent('Needs signal');
    expect(screen.getByText('Sending the repair request needs signal.')).toBeTruthy();
  });

  it('says what a finding is, from where it is and what’s asked', () => {
    expect(findingLine(INSPECTIONS.inspections[0]!.findings[0]!)).toBe(
      'Over the back porch · ask for repair',
    );
  });

  it('asks what was found before adding it, and adds it with where and how serious', async () => {
    const onAdd = jest.fn(async () => undefined);
    const onClose = jest.fn();
    await render(
      <FindingSheet
        inspection={INSPECTIONS.inspections[0]!}
        onClose={onClose}
        onPhoto={jest.fn(async () => ({ fileId: id(30), localName: 'p.jpg', sizeBytes: 10 }))}
        onAdd={onAdd}
      />,
    );
    await fireEvent.press(screen.getByTestId('finding-add'));
    expect(screen.getByTestId('finding-error')).toHaveTextContent('Say what was found.');
    await fireEvent.press(screen.getByTestId('finding-photo'));
    await fireEvent.changeText(
      screen.getByTestId('finding-what'),
      'Garage door won’t close all the way',
    );
    await fireEvent.changeText(screen.getByTestId('finding-where'), 'Garage');
    await fireEvent.press(screen.getByTestId('finding-severity-minor'));
    await fireEvent.press(screen.getByTestId('finding-add'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdd).toHaveBeenCalledWith(
      { title: 'Garage door won’t close all the way', location: 'Garage', severity: 'minor' },
      [{ fileId: id(30), localName: 'p.jpg', sizeBytes: 10 }],
    );
  });

  it('queues the finding with the phone’s id and its photos, waiting for them, and shows it at once', async () => {
    const made = await addFinding({
      workspaceId: WS,
      dealId: DEAL,
      inspectionId: id(20),
      title: 'Garage door',
      location: 'Garage',
      severity: 'minor',
      position: 3,
      photoFileIds: [id(30)],
      dependsOn: ['upload-1'],
    });
    expect(made).toBe(NEW_ID);
    const [name, input, options] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.finding.add');
    expect(input).toEqual({
      workspaceId: WS,
      id: NEW_ID,
      inspectionId: id(20),
      title: 'Garage door',
      severity: 'minor',
      location: 'Garage',
      photoFileIds: [id(30)],
    });
    expect(options?.dependsOn).toEqual(['upload-1']);
    const { ran, tx } = recordingTx();
    await options!.optimistic!(tx as never);
    expect(ran[0]![1].slice(0, 4)).toEqual([
      `inspection_findings:${NEW_ID}`,
      WS,
      'inspection_findings',
      DEAL,
    ]);
    expect(JSON.parse(String(ran[0]![1][4]))).toMatchObject({ photo_file_ids: [id(30)] });
  });

  it('leaves photos out of a finding taken without any', async () => {
    await addFinding({
      workspaceId: WS,
      dealId: DEAL,
      inspectionId: id(20),
      title: 'Loose rail',
      location: null,
      severity: 'repair',
      position: 4,
    });
    expect(jest.mocked(change).mock.calls[0]![1]).toEqual({
      workspaceId: WS,
      id: NEW_ID,
      inspectionId: id(20),
      title: 'Loose rail',
      severity: 'repair',
    });
  });
});

// ---------- the client's to-do ----------

type Task = ClientTasksView['tasks'][number];
const task = (t: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  kind: 'do',
  detail: null,
  signOffWords: null,
  forPersonId: null,
  dueOn: null,
  status: 'open',
  doneAt: null,
  waiting: 'Waiting on Ann and Bill',
  completions: [],
  ...t,
});
const TODO: ClientTasksView = {
  full: true,
  tasks: [
    task({ id: id(40), title: 'Send the insurance binder', dueOn: TODAY, kind: 'upload' }),
    task({
      id: id(41),
      title: 'Wire the down payment',
      dueOn: '2026-10-12',
      detail: 'call Capitol Title to confirm the instructions first',
    }),
    task({ id: id(42), title: 'Book movers' }),
    task({
      id: id(43),
      title: 'Upload the pre-approval letter',
      kind: 'upload',
      status: 'done',
      doneAt: '2026-09-22T16:00:00.000Z',
      waiting: null,
      completions: [
        {
          personId: ANN,
          name: 'Ann Smith',
          at: '2026-09-22T16:00:00.000Z',
          file: null,
          signedWords: null,
          recordedBy: null,
          note: null,
        },
      ],
    }),
  ],
  clients: [
    {
      personId: ANN,
      name: 'Ann Smith',
      email: 'ann@example.test',
      portal: 'signed_in',
      portalSince: '2026-09-01T00:00:00.000Z',
    },
    {
      personId: BILL,
      name: 'Bill Smith',
      email: 'bill@example.test',
      portal: 'none',
      portalSince: null,
    },
  ],
};

describe('the client’s to-do on the phone', () => {
  it('lists what the clients still have to do, as their portal shows it', async () => {
    await render(
      <ClientTasksBody
        view={TODO}
        today={TODAY}
        timeZone={TZ}
        onTask={jest.fn()}
        onAdd={jest.fn()}
        onInvite={jest.fn()}
      />,
    );
    expect(screen.getByText('Ann and Bill’s to-do')).toBeTruthy();
    expect(screen.getByText('3 open')).toBeTruthy();
    expect(screen.getByText('Due today')).toBeTruthy();
    expect(
      screen.getByText('Oct 12 · call Capitol Title to confirm the instructions first'),
    ).toBeTruthy();
    expect(screen.getByText('No date')).toBeTruthy();
    expect(screen.getByText('Done Sep 22 in the portal')).toBeTruthy();
    expect(screen.getByText('Add one for them')).toBeTruthy();
    expect(
      screen.getByText(
        'A new one reaches their portal; with no signal it waits and asks again after 30 minutes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Bill isn’t in the portal yet')).toBeTruthy();
  });

  it('says a task the agent marked done, not in the portal', () => {
    const done = TODO.tasks[3]!;
    expect(
      taskLine(
        {
          ...done,
          completions: [
            { ...done.completions[0]!, recordedBy: { id: ME, fullName: 'Dana Reyes' } },
          ],
        },
        TODAY,
        TZ,
      ),
    ).toBe('Done Sep 22');
  });

  it('adds one of the usual tasks, with the agent’s name in its words, for one client by a day', async () => {
    const onAdd = jest.fn(async () => undefined);
    await render(
      <AddTaskSheet
        open
        side="buyer"
        agentFirstName="Dana"
        clients={TODO.clients}
        today={TODAY}
        onClose={jest.fn()}
        onAdd={onAdd}
      />,
    );
    await fireEvent.press(screen.getByTestId('client-task-preset-repair_sign_off'));
    await fireEvent.press(screen.getByTestId(`client-task-for-${BILL}`));
    await fireEvent.press(screen.getByTestId('client-task-due-tomorrow'));
    await fireEvent.press(screen.getByTestId('client-task-save'));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        preset: 'repair_sign_off',
        kind: 'sign_off',
        title: 'Sign off on the repair request',
        detail: 'Read the repair request, then sign off so Dana can send it.',
        forPersonId: BILL,
        dueOn: '2026-10-04',
      }),
    );
  });

  it('asks what they do for one in their own words', async () => {
    const onAdd = jest.fn(async () => undefined);
    await render(
      <AddTaskSheet
        open
        side="buyer"
        agentFirstName="Dana"
        clients={TODO.clients}
        today={TODAY}
        onClose={jest.fn()}
        onAdd={onAdd}
      />,
    );
    await fireEvent.press(screen.getByTestId('client-task-preset-other'));
    await fireEvent.press(screen.getByTestId('client-task-save'));
    expect(screen.getByText('Say what they do.')).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('queues a new task with the phone’s id; it reaches their portal', async () => {
    await addClientTask({
      workspaceId: WS,
      dealId: DEAL,
      preset: null,
      kind: 'do',
      title: 'Book movers',
      detail: null,
      forPersonId: null,
      dueOn: null,
    });
    expect(jest.mocked(change).mock.calls[0]!.slice(0, 2)).toEqual([
      'realestate.client_task.add',
      { workspaceId: WS, dealId: DEAL, id: NEW_ID, kind: 'do', title: 'Book movers' },
    ]);
  });

  it('marks a task done for a client who did it another way, saying how', async () => {
    const onDone = jest.fn(async () => undefined);
    await render(
      <MarkDoneSheet
        task={TODO.tasks[2]!}
        clients={TODO.clients}
        onClose={jest.fn()}
        onDone={onDone}
      />,
    );
    await fireEvent.press(screen.getByTestId(`client-task-done-for-${BILL}`));
    await fireEvent.changeText(
      screen.getByTestId('client-task-done-how'),
      'They booked on the phone',
    );
    await fireEvent.press(screen.getByTestId('client-task-done-save'));
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(TODO.tasks[2], BILL, 'They booked on the phone'),
    );
  });

  it('asks a client into the portal only with signal', async () => {
    mockOnline = false;
    const onSend = jest.fn(async () => undefined);
    await render(
      <InviteSheet
        client={TODO.clients[1]!}
        agentFirstName="Dana"
        onClose={jest.fn()}
        onSend={onSend}
      />,
    );
    expect(screen.getByText('Invite Bill to the portal?')).toBeTruthy();
    expect(screen.getByTestId('client-invite-send')).toHaveTextContent('Needs signal');
    expect(screen.getByText('Inviting someone to the portal needs signal.')).toBeTruthy();
  });
});

// ---------- the walkthrough ----------

type Walkthrough = NonNullable<WalkthroughView['walkthrough']>;
type Item = Walkthrough['items'][number];
const item = (i: Partial<Item> & Pick<Item, 'id' | 'title' | 'source'>): Item => ({
  sourceRef: null,
  detail: null,
  state: 'unchecked',
  note: null,
  photoFileIds: [],
  checkedBy: null,
  checkedAt: null,
  dutyId: null,
  ...i,
});
const ITEMS: Item[] = [
  item({
    id: id(51),
    source: 'repair',
    title: 'Roof flashing over the back porch',
    detail: 'Repaired',
    state: 'ok',
    note: 'receipt from Hill Roofing',
    photoFileIds: [id(90)],
  }),
  item({
    id: id(52),
    source: 'repair',
    title: 'GFCI in the kitchen',
    detail: 'Repaired',
    state: 'ok',
  }),
  item({
    id: id(53),
    source: 'repair',
    title: 'Garage door closes all the way',
    detail: 'Repaired',
  }),
  item({
    id: id(54),
    source: 'included',
    title: 'Fridge',
    detail: 'Stays with the home',
    state: 'ok',
    note: 'works',
  }),
  item({ id: id(55), source: 'included', title: 'Washer', detail: 'Stays with the home' }),
  item({ id: id(56), source: 'included', title: 'Dryer', detail: 'Stays with the home' }),
  item({
    id: id(57),
    source: 'excluded',
    title: 'Dining room chandelier',
    detail: 'Goes with the sellers',
  }),
  item({ id: id(58), source: 'room', title: 'Kitchen', detail: 'As it was when you last saw it' }),
];
const walkthrough = (w: Partial<Walkthrough> = {}): Walkthrough => ({
  id: id(50),
  state: 'planned',
  appointmentId: null,
  scheduledAt: '2026-10-04T21:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  clientsAgreedAt: null,
  summary: '3 of 8 OK, 5 not checked',
  items: ITEMS,
  ...w,
});
const FACTS: WalkthroughFacts = {
  street: '123 Main St',
  clients: 'Ann and Bill',
  closing: '2026-10-14',
  duty: (dutyId) => (dutyId === id(70) ? { who: 'Dana', due: 'Oct 13' } : null),
};

describe('the walkthrough on the phone', () => {
  it('builds its list with signal when there’s none yet', async () => {
    mockOnline = false;
    await render(
      <WalkthroughBody
        walkthrough={null}
        facts={FACTS}
        today={TODAY}
        timeZone={TZ}
        onPlan={jest.fn()}
      />,
    );
    expect(screen.getByTestId('walkthrough-plan')).toHaveTextContent('Needs signal');
    expect(
      screen.getByText(
        'Building the list needs signal. Once it’s on the phone, the whole walkthrough works with no signal.',
      ),
    ).toBeTruthy();
  });

  it('shows the list built from the deal before it starts', async () => {
    const onStart = jest.fn();
    await render(
      <WalkthroughBody
        walkthrough={walkthrough()}
        facts={FACTS}
        today={TODAY}
        timeZone={TZ}
        onStart={onStart}
        onAdd={jest.fn()}
      />,
    );
    expect(screen.getByText('Final walkthrough')).toBeTruthy();
    expect(screen.getByText('Tomorrow 4:00 PM')).toBeTruthy();
    expect(screen.getByText('123 Main St · with Ann and Bill · closing Oct 14')).toBeTruthy();
    expect(screen.getByText('The list, built from the deal')).toBeTruthy();
    expect(screen.getByText('3 repairs agreed')).toBeTruthy();
    expect(screen.getByText('3 items that stay')).toBeTruthy();
    expect(screen.getByText('From the contract: fridge, washer, dryer')).toBeTruthy();
    expect(screen.getByText('1 item that goes')).toBeTruthy();
    expect(screen.getByText('Dining room chandelier')).toBeTruthy();
    expect(screen.getByText('1 room to check')).toBeTruthy();
    expect(
      screen.getByText(
        'The list is on the phone before you go; the whole walkthrough works with no signal.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('walkthrough-start'));
    expect(onStart).toHaveBeenCalled();
  });

  it('ticks each thing as it’s checked, counted by group', async () => {
    const onItem = jest.fn();
    await render(
      <WalkthroughBody
        walkthrough={walkthrough({ state: 'started' })}
        facts={FACTS}
        today={TODAY}
        timeZone={TZ}
        onItem={onItem}
        onFinish={jest.fn()}
      />,
    );
    expect(screen.getByText('Repairs agreed')).toBeTruthy();
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.getByText('Fixed · receipt from Hill Roofing')).toBeTruthy();
    expect(screen.getByText('Items that stay')).toBeTruthy();
    expect(screen.getByText('1 of 3')).toBeTruthy();
    expect(screen.getByText('OK · works')).toBeTruthy();
    expect(screen.getByText('Items that go')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`walkthrough-item-${id(53)}`));
    expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ id: id(53) }));
    expect(screen.getByText('Finish the walkthrough')).toBeTruthy();
  });

  it('marks a repair not fixed with a note, and says finishing adds a duty', async () => {
    const onSave = jest.fn(async () => undefined);
    await render(
      <ItemSheet
        item={ITEMS[2]!}
        onClose={jest.fn()}
        onPhoto={jest.fn(async () => null)}
        onSave={onSave}
      />,
    );
    expect(screen.getByText('Fixed')).toBeTruthy();
    expect(screen.getByText('Not fixed')).toBeTruthy();
    expect(screen.getByText('Not sure')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('walkthrough-state-not_ok'));
    expect(
      screen.getByText(
        'Finishing adds a duty: “Fix before closing: garage door closes all the way.”',
      ),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('walkthrough-note'),
      'Stops a foot short; sensor not replaced.',
    );
    await fireEvent.press(screen.getByTestId('walkthrough-save'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        ITEMS[2],
        'not_ok',
        'Stops a foot short; sensor not replaced.',
        [],
      ),
    );
  });

  it('says how it ended, what’s to fix and its proof once done', async () => {
    const done = walkthrough({
      state: 'done',
      finishedAt: '2026-10-03T21:31:00.000Z',
      clientsAgreedAt: '2026-10-03T21:31:00.000Z',
      items: [...ITEMS.slice(0, 2), { ...ITEMS[2]!, state: 'not_ok', dutyId: id(70) }],
    });
    await render(<WalkthroughBody walkthrough={done} facts={FACTS} today={TODAY} timeZone={TZ} />);
    expect(screen.getByText('Walkthrough done')).toBeTruthy();
    expect(screen.getByText('2 of 3 OK')).toBeTruthy();
    expect(screen.getByText('4:31 PM with Ann and Bill · 1 photo')).toBeTruthy();
    expect(screen.getByTestId('walkthrough-to-fix')).toHaveTextContent(
      '1 to fix before closing: garage door closes all the way (duty for Dana, due Oct 13)',
    );
    expect(screen.getByText('Final walkthrough · done')).toBeTruthy();
    expect(screen.getByText('Ann and Bill agree it’s as agreed')).toBeTruthy();
    expect(screen.getByText('Ticked on this phone at 4:31 PM')).toBeTruthy();
  });

  it('queues a check with its photos, waiting for them, and starts it on the phone', async () => {
    await checkWalkthroughItem({
      workspaceId: WS,
      walkthroughId: id(50),
      userId: ME,
      itemId: id(53),
      state: 'not_ok',
      note: 'Stops a foot short',
      photoFileIds: [id(91)],
      dependsOn: ['upload-1'],
    });
    const [name, input, options] = jest.mocked(change).mock.calls[0]!;
    expect(name).toBe('realestate.walkthrough.check_item');
    expect(input).toEqual({
      workspaceId: WS,
      itemId: id(53),
      state: 'not_ok',
      note: 'Stops a foot short',
      photoFileIds: [id(91)],
    });
    expect(options?.dependsOn).toEqual(['upload-1']);
    const { ran, tx } = recordingTx();
    await options!.optimistic!(tx as never);
    expect(ran[0]![0]).toBe(ITEM_CHECK_SQL);
    expect(ran[0]![1][5]).toBe(`walkthrough_items:${id(53)}`);
  });

  it('queues the finish with the clients’ OK', async () => {
    await finishWalkthrough({ workspaceId: WS, walkthroughId: id(50), clientsAgreed: true });
    expect(jest.mocked(change).mock.calls[0]!.slice(0, 2)).toEqual([
      'realestate.walkthrough.finish',
      { workspaceId: WS, walkthroughId: id(50), clientsAgreed: true },
    ]);
  });
});
