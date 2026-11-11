import {
  phoneDayVisits,
  phoneJob,
  phoneJobList,
  phoneMaterials,
  phoneNotes,
  phoneTime,
  phoneWorkOrder,
  type PhoneJob,
  type PhoneWorkOrder,
} from '@hfos/core/addons/contractor/views/phone';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';
import type * as ReactNative from 'react-native';

import { change, changes } from '@/changes';
import { takePhoto } from '@/changes/photo-device';
import { DALE, LONE_STAR, phone, START, type Phone } from '@/changes/__tests__/harness';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';

import { useFieldActions } from '../field';
import { JobView, type JobActions, type JobWaiting, NOTHING_WAITING } from '../job';
import { JobsView, type JobsFilter } from '../jobs';
import { MaterialsCard } from '../materials';
import { ContractorMoreRow } from '../more';
import { NotesCard } from '../notes';
import { ContractorVisitPanelRow } from '../visit-panel';
import { VisitView, type VisitActions } from '../work-order';
import {
  ITEM_COIL,
  ITEM_PHOTO,
  JOB_AC,
  JOB_KITCHEN,
  MATERIAL_FILTER,
  NOTE_GATE,
  NOTE_VOICE,
  PHASE_ROUGH,
  readCopy,
  seed,
  TODAY,
  VISIT_NOW,
  ZONE,
} from './fixtures';

/**
 * Contractor Operations on the phone (docs/contractor.md, "On the phone"): its one row in More and its row on a
 * Calendar visit; Jobs with the person's visits today; a job with its status (which needs signal), its % or phases,
 * visits, materials, time and notes; and a visit's work order with its checklist, photos, a count of what was used,
 * a break and notes. Each is drawn from the phone's own SQLite through the screens' SQL and core's views.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  let n = 0;
  return {
    change: jest.fn(async () => ({ id: `change-${++n}`, queued: true })),
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
jest.mock('@/lib/sync-status', () => ({
  ...jest.requireActual<object>('@/lib/sync-status'),
  useSyncStatus: () => ({
    connection: 'offline',
    waiting: 0,
    asOf: Date.parse('2026-09-16T19:41:00.000Z'),
  }),
}));
jest.mock('@/changes/photo-device', () => ({
  takePhoto: jest.fn(async () => ({
    kind: 'kept',
    photo: { localName: 'photo.jpg', sizeBytes: 2048, width: 10, height: 10 },
  })),
}));
jest.mock('@/lib/voice-note-recorder', () => ({
  ...jest.requireActual<object>('@/lib/voice-note-recorder'),
  keepRecording: jest.fn(() => ({ localName: 'note.m4a', sizeBytes: 4096 })),
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/calendar/visit-job', () => ({ VisitJob: () => null }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./fixtures').TestScreen,
}));

const NEW_ID = '99999999-9999-4999-8999-999999999999';
const at = { today: TODAY, now: START };
let p: Phone;

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
  jest.mocked(changes.addPhoto).mockClear();
  jest.mocked(takePhoto).mockClear();
  jest.mocked(openWebPath).mockClear();
  // A toast stays 2.6 seconds; the tests read what it says instead.
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  p = phone();
  seed(p);
});

const calls = () =>
  jest.mocked(change).mock.calls.map(([name, input]) => ({ name, input: input as unknown }));

describe('its row in More, and on a visit in Calendar', () => {
  it('has one row in More with what’s open and today’s visits, opening Jobs', async () => {
    await render(<ContractorMoreRow workspaceId={LONE_STAR} open={4} today={2} />);
    expect(screen.getByText('Contractor Operations')).toBeTruthy();
    expect(screen.getByText('4 open · 2 visits for you today')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-contractor-jobs'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/a/contractor`);
  });

  it('leaves today out when there’s nothing on it', async () => {
    await render(<ContractorMoreRow workspaceId={LONE_STAR} open={2} today={0} />);
    expect(screen.getByText('2 open')).toBeTruthy();
  });

  it('opens a visit’s work order from its page in Calendar', async () => {
    const onOpen = jest.fn();
    await render(<ContractorVisitPanelRow jobName="Lopez AC tune-up" onOpen={onOpen} />);
    expect(screen.getByText('Work order')).toBeTruthy();
    expect(
      screen.getByText('The checklist, materials and notes for Lopez AC tune-up'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('co-visit-panel-open'));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('Jobs', () => {
  function Jobs({
    start = 'mine',
    onOpenJob = jest.fn(),
    onOpenVisit = jest.fn(),
    waiting = 0,
  }: {
    start?: JobsFilter;
    onOpenJob?: (id: string) => void;
    onOpenVisit?: (id: string) => void;
    waiting?: number;
  }) {
    const copy = React.useMemo(() => readCopy(p), []);
    const [filter, setFilter] = React.useState<JobsFilter>(start);
    const [closedToo, setClosedToo] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const list = phoneJobList(copy, { filter, includeClosed: closedToo, search, me: DALE }, at);
    return (
      <JobsView
        businessName="Lone Star HVAC & Roofing"
        timeZone={ZONE}
        today={TODAY}
        waiting={waiting}
        visits={phoneDayVisits(copy, {
          from: Date.parse('2026-09-16T05:00:00.000Z'),
          to: Date.parse('2026-09-17T05:00:00.000Z'),
          me: DALE,
        })}
        filter={filter}
        onFilter={setFilter}
        closedToo={closedToo}
        onClosedToo={setClosedToo}
        search={search}
        onSearch={setSearch}
        jobs={list.jobs}
        truncated={list.truncated}
        onOpenJob={onOpenJob}
        onOpenVisit={onOpenVisit}
      />
    );
  }

  it('shows my visits today and my jobs, each opening its page', async () => {
    const onOpenJob = jest.fn();
    const onOpenVisit = jest.fn();
    await render(<Jobs onOpenJob={onOpenJob} onOpenVisit={onOpenVisit} />);
    const today = within(screen.getByTestId(`co-today-${VISIT_NOW}`));
    expect(today.getByText('2:00–4:00 PM')).toBeTruthy();
    expect(today.getByText('Lopez AC tune-up')).toBeTruthy();
    expect(today.getByText('Maria Lopez · 418 Maple Ave, Houston')).toBeTruthy();
    expect(today.getByText('0 of 3 done · 2 required left · 1 material missing')).toBeTruthy();
    expect(today.getByText('Started')).toBeTruthy();

    const kitchen = within(screen.getByTestId(`co-job-${JOB_KITCHEN}`));
    expect(kitchen.getByText('Hart kitchen remodel')).toBeTruthy();
    expect(kitchen.getByText(/1 of 3 phases done/)).toBeTruthy();
    expect(kitchen.getByText(/6 days late/)).toBeTruthy();
    expect(kitchen.getByText('In progress')).toBeTruthy();
    const ac = within(screen.getByTestId(`co-job-${JOB_AC}`));
    expect(ac.getByText(/40% done/)).toBeTruthy();
    expect(ac.getByText(/Due in 2 days/)).toBeTruthy();
    expect(ac.getByText('Next visit Wed, Sep 16 at 2:00 PM')).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`co-today-${VISIT_NOW}`));
    await fireEvent.press(screen.getByTestId(`co-job-${JOB_AC}`));
    expect(onOpenVisit).toHaveBeenCalledWith(VISIT_NOW);
    expect(onOpenJob).toHaveBeenCalledWith(JOB_AC);
    expect(screen.queryByTestId('co-kept-strip')).toBeNull();
  });

  it('filters to the late ones, finds a finished job by name, and says when nothing matches', async () => {
    await render(<Jobs />);
    await fireEvent.press(screen.getByTestId('co-jobs-late'));
    expect(screen.queryByTestId(`co-job-${JOB_AC}`)).toBeNull();
    expect(screen.getByTestId(`co-job-${JOB_KITCHEN}`)).toBeTruthy();
    // Late jobs are open ones: the chip for finished jobs has no place there.
    expect(screen.queryByTestId('co-jobs-closed')).toBeNull();

    await fireEvent.press(screen.getByTestId('co-jobs-all'));
    await fireEvent.changeText(screen.getByTestId('co-jobs-search'), 'roof');
    expect(screen.getByText('No jobs match “roof”. Try another search.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('co-jobs-closed'));
    expect(screen.getByText('Old roof patch')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('says what the phone holds with no signal, and how many changes wait', async () => {
    mockOnline = false;
    const { rerender } = await render(<Jobs />);
    expect(screen.getByText(/^No signal\. Kept on this phone as of /)).toBeTruthy();
    await rerender(<Jobs waiting={2} />);
    expect(
      screen.getByText('No signal. 2 changes wait on this phone and will send on their own.'),
    ).toBeTruthy();
  });
});

function jobActions(over: Partial<JobActions> = {}): jest.Mocked<JobActions> {
  return {
    openVisit: jest.fn(),
    openCustomer: jest.fn(),
    backToJobs: jest.fn(),
    call: jest.fn(),
    setStatus: jest.fn(async () => null),
    setPercent: jest.fn(async () => true),
    setPhase: jest.fn(async () => true),
    count: jest.fn(async () => true),
    notes: {
      addTyped: jest.fn(async () => true),
      addPhoto: jest.fn(async () => true),
      addVoice: jest.fn(async () => true),
      remove: jest.fn(async () => true),
    },
    ...over,
  } as jest.Mocked<JobActions>;
}

async function drawJob(
  jobId: string,
  actions: JobActions,
  over: { job?: PhoneJob | null; waiting?: JobWaiting } = {},
) {
  const copy = readCopy(p, { kind: 'job', jobId });
  const materials = phoneMaterials(copy, jobId);
  const time = phoneTime(copy, jobId, { me: DALE, now: START });
  const notes = phoneNotes(copy, jobId);
  const job = over.job === undefined ? phoneJob(copy, jobId, at) : over.job;
  const mine = time.entries.find((e) => e.id === time.mine?.entryId);
  await render(
    <JobView
      job={job}
      today={TODAY}
      timeZone={ZONE}
      online={mockOnline}
      me={DALE}
      manages={false}
      customerPhone={job?.customer ? (copy.phones.get(job.customer.personId) ?? null) : null}
      materials={materials.materials}
      materialsMissing={materials.missing}
      totals={time.totals}
      mine={mine ? { kind: mine.kind, startedAt: mine.startedAt } : null}
      notes={notes.notes}
      notesTruncated={notes.truncated}
      photosOf={new Map()}
      waiting={over.waiting ?? NOTHING_WAITING}
      actions={actions}
    />,
  );
}

describe('a job', () => {
  it('shows where a service call stands, who it’s for, its visit, materials, time and notes', async () => {
    const actions = jobActions();
    await drawJob(JOB_AC, actions);
    expect(screen.getByTestId('screen-title').props.children).toBe('Lopez AC tune-up');
    expect(screen.getByTestId('screen-subtitle').props.children).toBe('Service call');
    expect(within(screen.getByTestId('co-job-status')).getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Due in 2 days')).toBeTruthy();
    const about = within(screen.getByTestId('co-job-about'));
    expect(about.getByText('Maria Lopez')).toBeTruthy();
    expect(about.getByText('418 Maple Ave, Houston')).toBeTruthy();
    expect(about.getByText('Dale Carter')).toBeTruthy();
    expect(about.getByText('HVAC')).toBeTruthy();
    expect(about.getByText('Tune up the upstairs unit.')).toBeTruthy();
    expect(screen.getByTestId('co-job-percent')).toHaveTextContent('40% done');
    expect(screen.getByTestId(`co-visit-${VISIT_NOW}`)).toBeTruthy();
    expect(screen.getByText('Filter 20x25')).toBeTruthy();
    expect(screen.getByText('1 material isn’t all here yet.')).toBeTruthy();
    expect(screen.getByTestId('co-time-totals').props.children).toMatch(/^Work .* · Travel 30 min/);
    expect(screen.getByText('An owner or admin fixes time on the web.')).toBeTruthy();
    expect(screen.getByText('Gate code is 4410.')).toBeTruthy();
    expect(screen.getByTestId(`co-note-words-${NOTE_VOICE}`).props.children).toBe(
      'The drain line is clogged.',
    );
    expect(screen.getByText('Its estimate, costs and budget are on the web.')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('co-job-call'));
    expect(actions.call).toHaveBeenCalledWith('+17135550142');
    await fireEvent.press(screen.getByTestId('co-job-open-customer'));
    expect(actions.openCustomer).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId(`co-visit-${VISIT_NOW}`));
    expect(actions.openVisit).toHaveBeenCalledWith(VISIT_NOW);
  });

  it('sets a service call’s % done in one press', async () => {
    const actions = jobActions();
    await drawJob(JOB_AC, actions);
    await fireEvent.press(screen.getByTestId('co-job-set-percent'));
    await fireEvent.press(screen.getByTestId('co-percent-70'));
    await waitFor(() => expect(actions.setPercent).toHaveBeenCalledWith(70));
  });

  it('changes its status with signal: on hold says why, and a refusal is said in the sheet', async () => {
    const actions = jobActions({
      setStatus: jest
        .fn()
        .mockResolvedValueOnce('“Lopez AC tune-up” still has 2 required items left.')
        .mockResolvedValue(null),
    });
    await drawJob(JOB_AC, actions);
    await fireEvent.press(screen.getByTestId('co-job-change-status'));
    // Its own status isn't offered.
    expect(screen.queryByTestId('co-status-in_progress')).toBeNull();
    await fireEvent.press(screen.getByTestId('co-status-on_hold'));
    await fireEvent.press(screen.getByTestId('co-status-save'));
    expect(screen.getByTestId('co-status-problem').props.children).toBe('Say why it’s on hold.');
    expect(actions.setStatus).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('co-status-reason'), ' Waiting on the part ');
    await fireEvent.press(screen.getByTestId('co-status-save'));
    await waitFor(() =>
      expect(actions.setStatus).toHaveBeenCalledWith('on_hold', 'Waiting on the part'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('co-status-problem').props.children).toBe(
        '“Lopez AC tune-up” still has 2 required items left.',
      ),
    );
    await fireEvent.press(screen.getByTestId('co-status-done'));
    await fireEvent.press(screen.getByTestId('co-status-save'));
    await waitFor(() => expect(actions.setStatus).toHaveBeenLastCalledWith('done', ''));
  });

  it('says its status needs signal when there’s none', async () => {
    mockOnline = false;
    await drawJob(JOB_AC, jobActions());
    expect(screen.getByTestId('co-job-change-status').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(
      screen.getByText(
        'Changing a job’s status needs signal: it’s checked against every visit’s checklist.',
      ),
    ).toBeTruthy();
  });

  it('moves a project’s phase along, and marks one still waiting to send', async () => {
    const actions = jobActions();
    await drawJob(JOB_KITCHEN, actions, {
      waiting: { ...NOTHING_WAITING, total: 1, phases: new Set([PHASE_ROUGH]) },
    });
    expect(screen.getByTestId('screen-subtitle').props.children).toBe('Project');
    expect(within(screen.getByTestId('co-job-status')).getByText('6 days late')).toBeTruthy();
    const rough = within(screen.getByTestId(`co-phase-${PHASE_ROUGH}`));
    expect(rough.getByText('Rough-in')).toBeTruthy();
    expect(rough.getByText('50% done · 4 days late · Waiting to send')).toBeTruthy();
    expect(screen.getByTestId('co-job-percent')).toHaveTextContent('50% done');
    // A project's % comes from its phases: there's nothing to set by hand.
    expect(screen.queryByTestId('co-job-set-percent')).toBeNull();

    await fireEvent.press(screen.getByTestId(`co-phase-${PHASE_ROUGH}`));
    expect(screen.getByText('Where does “Rough-in” stand?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('co-phase-done'));
    await waitFor(() =>
      expect(actions.setPhase).toHaveBeenCalledWith(
        expect.objectContaining({ id: PHASE_ROUGH, name: 'Rough-in' }),
        'done',
      ),
    );
  });

  it('says so when the job isn’t on this phone', async () => {
    const actions = jobActions();
    await drawJob(JOB_AC, actions, { job: null });
    expect(screen.getByTestId('co-job-gone').props.children).toMatch(/isn’t on this phone/);
    await fireEvent.press(screen.getByTestId('co-job-back'));
    expect(actions.backToJobs).toHaveBeenCalled();
  });
});

function visitActions(over: Partial<VisitActions> = {}): jest.Mocked<VisitActions> {
  return {
    openJob: jest.fn(),
    backToJobs: jest.fn(),
    directions: jest.fn(),
    setItem: jest.fn(async () => true),
    takeItemPhoto: jest.fn(async () => true),
    setBreak: jest.fn(async () => true),
    count: jest.fn(async () => true),
    notes: {
      addTyped: jest.fn(async () => true),
      addPhoto: jest.fn(async () => true),
      addVoice: jest.fn(async () => true),
      remove: jest.fn(async () => true),
    },
    ...over,
  } as jest.Mocked<VisitActions>;
}

async function drawVisit(
  actions: VisitActions,
  change_: (order: PhoneWorkOrder) => PhoneWorkOrder | null = (o) => o,
) {
  const copy = readCopy(p, { kind: 'visit', appointmentId: VISIT_NOW });
  const order = phoneWorkOrder(copy, VISIT_NOW)!;
  const time = phoneTime(copy, JOB_AC, { appointmentId: VISIT_NOW, me: DALE, now: START });
  const notes = phoneNotes(copy, JOB_AC, VISIT_NOW);
  const mine = time.entries.find((e) => e.id === time.mine?.entryId);
  const { Text: T } = jest.requireActual<typeof ReactNative>('react-native');
  await render(
    <VisitView
      order={change_(order)}
      timeZone={ZONE}
      me={DALE}
      manages={false}
      materialsMissing={phoneMaterials(copy, JOB_AC, VISIT_NOW).missing}
      totals={time.totals}
      mine={mine ? { kind: mine.kind, startedAt: mine.startedAt } : null}
      notes={notes.notes}
      notesTruncated={notes.truncated}
      photosOf={new Map()}
      statusButtons={<T testID="status-buttons">On my way</T>}
      actions={actions}
    />,
  );
}

describe('a visit’s work order', () => {
  it('shows when and where, the work, who’s going and the checklist, and takes a tick and a photo', async () => {
    const actions = visitActions();
    await drawVisit(actions);
    expect(screen.getByTestId('screen-title').props.children).toBe('Work order');
    expect(screen.getByTestId('screen-subtitle').props.children).toBe('Lopez AC tune-up');
    const when = within(screen.getByTestId('co-visit-when'));
    expect(when.getByText('AC tune-up')).toBeTruthy();
    expect(when.getByText('Wed, Sep 16 · 2:00–4:00 PM')).toBeTruthy();
    expect(when.getByText('418 Maple Ave, Houston, TX 77002')).toBeTruthy();
    expect(when.getByText('Lopez AC tune-up · Maria Lopez')).toBeTruthy();
    expect(screen.getByTestId('status-buttons')).toBeTruthy();
    const work = within(screen.getByTestId('co-visit-work'));
    expect(work.getByText('Tune up the upstairs unit.')).toBeTruthy();
    expect(work.getByText('Park on the street.')).toBeTruthy();
    expect(work.getByText('A 20x25 filter and the gauges.')).toBeTruthy();
    expect(work.getByText('Crew A · Dale Carter')).toBeTruthy();
    expect(screen.getByTestId('co-checklist-progress').props.children).toBe(
      '0 of 3 done · 2 required left',
    );
    expect(screen.getByTestId('co-checklist-left').props.children).toBe(
      '2 required items left before the job can be marked done.',
    );
    expect(within(screen.getByTestId(`co-item-${ITEM_COIL}`)).getByText('Required')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('co-visit-directions'));
    expect(actions.directions).toHaveBeenCalledWith('418 Maple Ave, Houston, TX 77002');
    await fireEvent.press(screen.getByTestId('co-visit-job'));
    expect(actions.openJob).toHaveBeenCalledWith(JOB_AC);
    await fireEvent.press(screen.getByTestId(`co-item-tick-${ITEM_COIL}`));
    await waitFor(() =>
      expect(actions.setItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: ITEM_COIL }),
        true,
      ),
    );
    await fireEvent.press(screen.getByTestId(`co-item-photo-${ITEM_PHOTO}`));
    await waitFor(() =>
      expect(actions.takeItemPhoto).toHaveBeenCalledWith(
        expect.objectContaining({ id: ITEM_PHOTO }),
      ),
    );
  });

  it('shows this visit’s materials, the time with a break, and its notes', async () => {
    const actions = visitActions();
    await drawVisit(actions);
    const materials = within(screen.getByTestId('co-materials'));
    expect(materials.getByText('Materials for this visit')).toBeTruthy();
    expect(materials.getByText('Refrigerant')).toBeTruthy();
    expect(materials.getByText('2 lb short')).toBeTruthy();
    expect(screen.getByTestId('co-time-mine').props.children.join('')).toBe(
      'You: work since 2:05 PM',
    );
    await fireEvent.press(screen.getByTestId('co-break-start'));
    await waitFor(() => expect(actions.setBreak).toHaveBeenCalledWith(true));
    // Only this visit's notes: the voice note was taken on the job, not here.
    expect(screen.getByTestId(`co-note-${NOTE_GATE}`)).toBeTruthy();
    expect(screen.queryByTestId(`co-note-${NOTE_VOICE}`)).toBeNull();
    // Someone else's note isn't theirs to take off.
    expect(screen.queryByTestId(`co-note-remove-${NOTE_GATE}`)).toBeNull();
  });

  it('shows a done item with who did it, a photo still uploading, and a tick still waiting', async () => {
    await drawVisit(visitActions(), (o) => ({
      ...o,
      items: o.items.map((i) =>
        i.id === ITEM_PHOTO ? { ...i, done: true, doneBy: 'Dale Carter', file: null } : i,
      ),
    }));
    expect(screen.getByTestId(`co-item-line-${ITEM_PHOTO}`).props.children).toBe(
      'Done by Dale Carter · Photo waiting to upload',
    );
    expect(screen.getByTestId(`co-item-retake-${ITEM_PHOTO}`)).toBeTruthy();
  });

  it('is read-only once its job is done', async () => {
    const actions = visitActions();
    await drawVisit(actions, (o) => ({ ...o, job: { ...o.job, status: 'done' } }));
    expect(screen.getByTestId('co-visit-closed').props.children).toBe(
      'The job is done, so this work order can’t be changed.',
    );
    expect(screen.queryByTestId('status-buttons')).toBeNull();
    expect(screen.queryByTestId('co-break-start')).toBeNull();
    expect(screen.getByTestId(`co-item-tick-${ITEM_COIL}`).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.queryByTestId(`co-item-photo-${ITEM_PHOTO}`)).toBeNull();
  });

  it('says so when the work order isn’t on this phone', async () => {
    const actions = visitActions();
    await drawVisit(actions, () => null);
    expect(screen.getByTestId('co-visit-gone').props.children).toMatch(
      /work order isn’t on this phone yet/,
    );
    await fireEvent.press(screen.getByTestId('co-visit-back'));
    expect(actions.backToJobs).toHaveBeenCalled();
  });
});

describe('counting materials and adding notes', () => {
  it('adds what was used and wasted, and asks for a number', async () => {
    const onCount = jest.fn(async () => true);
    const copy = readCopy(p, { kind: 'job', jobId: JOB_AC });
    await render(
      <MaterialsCard
        title="Materials"
        materials={phoneMaterials(copy, JOB_AC).materials}
        missing={1}
        none="No materials listed yet."
        waiting={new Set([MATERIAL_FILTER])}
        canCount
        onCount={onCount}
      />,
    );
    expect(
      within(screen.getByTestId(`co-material-${MATERIAL_FILTER}`)).getByText(
        '2 of 2 here · Waiting to send',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`co-material-${MATERIAL_FILTER}`));
    expect(screen.getByText('What happened to the Filter 20x25?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('co-count-save'));
    expect(screen.getByTestId('co-count-problem').props.children).toBe('Enter an amount first.');
    await fireEvent.changeText(screen.getByTestId('co-count-used'), 'two');
    await fireEvent.press(screen.getByTestId('co-count-save'));
    expect(screen.getByTestId('co-count-problem').props.children).toBe(
      'Enter a number, like 2 or 0.5.',
    );
    await fireEvent.changeText(screen.getByTestId('co-count-used'), '1');
    await fireEvent.changeText(screen.getByTestId('co-count-wasted'), '0,5');
    await fireEvent.press(screen.getByTestId('co-count-save'));
    await waitFor(() =>
      expect(onCount).toHaveBeenCalledWith(expect.objectContaining({ id: MATERIAL_FILTER }), {
        used: 1,
        wasted: 0.5,
      }),
    );
  });

  function Notes({ appointmentId }: { appointmentId?: string }) {
    const field = useFieldActions({
      workspaceId: LONE_STAR,
      userId: DALE,
      jobId: JOB_AC,
      jobName: 'Lopez AC tune-up',
      appointmentId,
    });
    const copy = React.useMemo(() => readCopy(p, { kind: 'job', jobId: JOB_AC }), []);
    const notes = phoneNotes(copy, JOB_AC);
    return (
      <NotesCard
        title="Notes from the field"
        none="No notes yet."
        notes={notes.notes}
        truncated={notes.truncated}
        photosOf={new Map()}
        waiting={new Set()}
        jobName="Lopez AC tune-up"
        timeZone={ZONE}
        me={DALE}
        removeAny={false}
        actions={field.notes}
      />
    );
  }

  it('adds a typed note on the visit, and won’t add an empty one', async () => {
    await render(<Notes appointmentId={VISIT_NOW} />);
    await fireEvent.press(screen.getByTestId('co-note-type'));
    await fireEvent.press(screen.getByTestId('co-note-save'));
    expect(screen.getByTestId('co-note-problem').props.children).toBe('Type something first.');
    await fireEvent.changeText(screen.getByTestId('co-note-body'), 'Coil was filthy.');
    await fireEvent.press(screen.getByTestId('co-note-save'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(calls()).toEqual([
      {
        name: 'contractor.note.add',
        input: {
          workspaceId: LONE_STAR,
          jobId: JOB_AC,
          id: NEW_ID,
          appointmentId: VISIT_NOW,
          body: 'Coil was filthy.',
        },
      },
    ]);
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith('Note added.'));
  });

  it('takes a photo into a note that waits for its upload', async () => {
    await render(<Notes />);
    await fireEvent.press(screen.getByTestId('co-note-photo'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(takePhoto).toHaveBeenCalledWith({ userId: DALE, source: 'camera', fileId: NEW_ID });
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: LONE_STAR, recordType: 'custom_record', recordId: JOB_AC },
      { localName: 'photo.jpg', sizeBytes: 2048 },
      { fileId: NEW_ID, name: undefined, mimeType: undefined },
    );
    expect(calls()[0]).toEqual({
      name: 'contractor.note.add',
      input: { workspaceId: LONE_STAR, jobId: JOB_AC, id: NEW_ID, photoFileIds: [NEW_ID] },
    });
    expect(jest.mocked(change).mock.calls[0]![2]).toMatchObject({ dependsOn: ['upload-1'] });
  });

  it('says how to allow the camera, and adds nothing, when it isn’t allowed', async () => {
    jest.mocked(takePhoto).mockResolvedValueOnce({ kind: 'no-camera-permission' });
    await render(<Notes />);
    await fireEvent.press(screen.getByTestId('co-note-photo'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(jest.mocked(toast.error).mock.calls[0]![0]).toMatch(/Settings → HandsFreeOS → Camera/);
    expect(change).not.toHaveBeenCalled();
  });

  it('records a voice note with no signal, kept to send with its words to follow', async () => {
    mockOnline = false;
    await render(<Notes appointmentId={VISIT_NOW} />);
    await fireEvent.press(screen.getByTestId('co-note-voice'));
    await waitFor(() => expect(screen.getByTestId('co-voice-stop')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('co-voice-stop'));
    await waitFor(() =>
      expect(
        screen.getByText(
          'Recorded. No signal: it stays on this phone and sends on its own, and its words follow then.',
        ),
      ).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId('co-voice-keep'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: LONE_STAR, recordType: 'custom_record', recordId: JOB_AC },
      { localName: 'note.m4a', sizeBytes: 4096 },
      { fileId: NEW_ID, name: 'Voice note, Lopez AC tune-up.m4a', mimeType: 'audio/mp4' },
    );
    expect(calls()[0]).toEqual({
      name: 'contractor.note.add',
      input: {
        workspaceId: LONE_STAR,
        jobId: JOB_AC,
        id: NEW_ID,
        appointmentId: VISIT_NOW,
        audioFileId: NEW_ID,
      },
    });
  });

  it('takes my own note off with signal, and says it needs signal with none', async () => {
    const { rerender } = await render(<Notes />);
    // Dale's voice note is his; Rosa's typed note isn't.
    expect(screen.queryByTestId(`co-note-remove-${NOTE_GATE}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`co-note-remove-${NOTE_VOICE}`));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(calls()[0]).toEqual({
      name: 'contractor.note.remove',
      input: { workspaceId: LONE_STAR, noteId: NOTE_VOICE },
    });
    mockOnline = false;
    await rerender(<Notes appointmentId={undefined} />);
    expect(
      within(screen.getByTestId(`co-note-remove-${NOTE_VOICE}`)).getByText('Needs signal'),
    ).toBeTruthy();
  });
});
