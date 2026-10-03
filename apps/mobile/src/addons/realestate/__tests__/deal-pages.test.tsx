import type { ContingenciesView } from '@hfos/core/addons/realestate/views/closing';
import type { ContractReadView } from '@hfos/core/addons/realestate/views/contract-read';
import type { CopyTermEntry } from '@hfos/core/addons/realestate/views/deal-facts';
import type { DealDocument, DealSigning } from '@hfos/core/addons/realestate/views/documents';
import type { ClientUpdateView } from '@hfos/core/addons/realestate/views/drafts';
import type { HistoryLine } from '@hfos/core/addons/realestate/views/history';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import type * as ReactNative from 'react-native';

import { change, changes } from '@/changes';
import { describeRealestate } from '@/changes/describe-realestate';
import { openWebPath } from '@/home/open';
import { deviceStore } from '@/lib/device-store';

import { agoWords, ClientUpdateViewScreen } from '../client-update';
import { ContingenciesListView } from '../contingencies';
import { ContractView } from '../contract';
import { KeyDatesView, keyDateRows } from '../dates';
import { DealView, pagesOf, type DealCounts } from '../deal';
import { ExportSheetView, HoldBanner } from '../deal-more';
import type { ReChange } from '../deal-bits';
import { DocumentsView } from '../documents';
import { DutyView, keptKey } from '../duty-sheet';
import { HistoryView } from '../history';
import { ANN, checklist, DANA, id, NOW, page, risks, sheet, SMITH, TZ, WS } from './deal-fixtures';

/**
 * A deal on the phone (boards 78–81 and 93): its page and its More, a duty's proof checklist and doing it with no
 * signal, the dates, contingencies and the contract as read, documents, history and a client update. Each renders
 * core's view as the board draws it, says what needs signal, and makes its changes through the queue with the command
 * and input the API takes.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  changes: {
    addPhoto: jest.fn(async () => ({ id: 'upload-1' })),
    stillSend: jest.fn(async () => undefined),
    discard: jest.fn(async () => undefined),
  },
  newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
}));
jest.mock('@/changes/photo-device', () => ({
  takePhoto: jest.fn(async () => ({
    kind: 'kept',
    photo: { localName: 'binder.jpg', sizeBytes: 2048, width: 10, height: 10 },
  })),
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/lib/sync-status', () => ({
  ...jest.requireActual<object>('@/lib/sync-status'),
  useSyncStatus: () => ({ connection: 'inStep', waiting: 0, asOf: null }),
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/inbox/calls', () => ({ startCall: jest.fn() }));
jest.mock('@/inbox/storage', () => ({
  signedUrl: jest.fn(async () => 'https://storage.test/x.zip'),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('@/components/shell/screen', () => ({
  Screen: ({
    title,
    subtitle,
    trailing,
    header,
    children,
    testID,
  }: {
    title?: string;
    subtitle?: string;
    trailing?: React.ReactNode;
    header?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }) => {
    const RN = jest.requireActual<typeof ReactNative>('react-native');
    return (
      <RN.View testID={testID}>
        <RN.Text testID="screen-title">{title}</RN.Text>
        {subtitle ? <RN.Text testID="screen-subtitle">{subtitle}</RN.Text> : null}
        {trailing}
        {header}
        {children}
      </RN.View>
    );
  },
}));

const NEW_ID = '99999999-9999-4999-8999-999999999999';
const fs = jest.requireMock('expo-file-system') as { File: { downloadFileAsync?: jest.Mock } };
fs.File.downloadFileAsync = jest.fn(async (_url: string, to: { uri: string }) => to);

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
  jest.mocked(openWebPath).mockClear();
});

const COUNTS: DealCounts = {
  documents: 8,
  contingenciesOpen: 2,
  read: { readId: id(60), waiting: 2 },
  clients: [
    { personId: ANN, name: 'Ann Smith', portal: 'signed_in' },
    { personId: id(5), name: 'Bill Smith', portal: 'none' },
  ],
  listPrice: null,
};

describe('a deal (board 78)', () => {
  const renderDeal = (over: Partial<React.ComponentProps<typeof DealView>> = {}) =>
    render(
      <DealView
        page={page()}
        risks={risks()}
        counts={COUNTS}
        hold={null}
        onHoldChanged={jest.fn()}
        workspaceId={WS}
        timeZone={TZ}
        now={NOW}
        canExport
        canHold
        {...over}
      />,
    );

  it('leads with what could stop the closing, then the next move, dates, people and every page', async () => {
    await renderDeal();
    expect(screen.getByTestId('re-deal-name')).toHaveTextContent('Smith purchase');
    expect(screen.getByTestId('re-deal-line')).toHaveTextContent(
      '123 Main St · Buyer deal · closing Oct 14',
    );
    expect(screen.getByText('Three things could stop this closing')).toBeTruthy();
    expect(screen.getByText('Rate lock ends Oct 13, a day before closing')).toBeTruthy();
    expect(screen.getByText('Owner: Dana · Next: Start it now.')).toBeTruthy();
    expect(screen.getByText('Duties · 1')).toBeTruthy();
    expect(screen.getByTestId('re-deal-next')).toHaveTextContent(/Draft the repair request/);
    expect(screen.getByText('Ann & Bill Smith')).toBeTruthy();
    expect(screen.getByText('Clients · portal: signed in')).toBeTruthy();
    expect(screen.getByText('Summit Lending')).toBeTruthy();
    expect(screen.getByTestId('re-deal-date-closing')).toHaveTextContent(
      /Closing.*Amendment.*Oct 14/,
    );
    // A duty in the risks opens the duty on the phone; a page opens through the route map.
    await fireEvent.press(screen.getByTestId('re-deal-risk-1'));
    const { router } = jest.requireMock<{ router: { push: jest.Mock } }>('expo-router');
    expect(router.push).toHaveBeenLastCalledWith(
      `/app/w/${WS}/a/realestate/deals/${SMITH}?duty=${id(1)}`,
    );
    await fireEvent.press(screen.getByTestId('re-deal-page-documents'));
    expect(openWebPath).toHaveBeenLastCalledWith(
      `/app/w/${WS}/a/realestate/deals/${SMITH}/documents`,
    );
    await fireEvent.press(screen.getByTestId(`re-deal-page-contract-${id(60)}`));
    expect(openWebPath).toHaveBeenLastCalledWith(
      `/app/w/${WS}/a/realestate/deals/${SMITH}/contract/${id(60)}`,
    );
  });

  it('lists the side’s own pages', () => {
    const buyer = pagesOf(page(), COUNTS).map((p) => p.path);
    expect(buyer).toEqual(
      expect.arrayContaining([
        'buyer',
        'homes',
        'offers',
        'financing',
        'inspections',
        'client-tasks',
        'dates',
        'history',
      ]),
    );
    const listing = pagesOf(page({ side: 'listing' }), { ...COUNTS, listPrice: 48_900_000 });
    expect(listing.find((p) => p.path === 'price')?.detail).toBe('$489,000');
    expect(listing.map((p) => p.path)).toEqual(
      expect.arrayContaining(['facts', 'photos', 'net-sheet', 'showings']),
    );
  });

  it('keeps a deal the person isn’t on as its summary, and says so', async () => {
    await renderDeal({ page: page({}, false) });
    expect(screen.getByText('Summary, duties and dates on this phone')).toBeTruthy();
  });

  it('offers its More, and says what needs signal', async () => {
    mockOnline = false;
    await renderDeal();
    await fireEvent.press(screen.getByTestId('re-deal-more-button'));
    const more = within(screen.getByTestId('re-deal-more'));
    expect(more.getByText('Write a client update')).toBeTruthy();
    expect(more.getByText('Move to the next stage')).toBeTruthy();
    expect(more.getByText('Export the whole transaction')).toBeTruthy();
    expect(more.getByText('Put on legal hold')).toBeTruthy();
    expect(more.getByText('Open on the web')).toBeTruthy();
    expect(more.getAllByText('Needs signal').length).toBe(4);
    expect(
      more.getByText(
        'Export and holds need signal. The rest works with no signal and sends later.',
      ),
    ).toBeTruthy();
  });

  it('writes a note with no signal', async () => {
    await renderDeal();
    await fireEvent.press(screen.getByTestId('re-deal-note'));
    await fireEvent.changeText(
      screen.getByTestId('re-deal-note-body'),
      'Sellers leaving the shed.',
    );
    await fireEvent.press(screen.getByTestId('re-deal-note-save'));
    expect(change).toHaveBeenCalledWith('realestate.field_note.add', {
      workspaceId: WS,
      dealId: SMITH,
      id: NEW_ID,
      aboutKind: 'deal',
      body: 'Sellers leaving the shed.',
    });
  });

  it('says it’s on legal hold, and who placed it', async () => {
    await render(
      <HoldBanner
        hold={{
          id: id(50),
          placedAt: '2026-10-01T15:00:00.000Z',
          reason: 'Dispute over the earnest money',
          placedBy: { fullName: 'Dana Reyes' },
        }}
        timeZone={TZ}
      />,
    );
    expect(screen.getByTestId('re-hold-banner')).toHaveTextContent(
      'On legal hold since Oct 1. “Dispute over the earnest money.” Placed by Dana Reyes. Its files and history can’t be changed or deleted until an owner or admin lifts it; new ones can be added.',
    );
  });
});

describe('exporting the whole transaction (board 93)', () => {
  it('makes the file with signal, and shares it once it’s ready', async () => {
    const onMake = jest.fn();
    const { rerender } = await render(
      <ExportSheetView open onClose={jest.fn()} latest={null} file={null} onMake={onMake} />,
    );
    await fireEvent.press(screen.getByTestId('re-export-make'));
    expect(onMake).toHaveBeenCalled();
    await rerender(
      <ExportSheetView
        open
        onClose={jest.fn()}
        latest={{
          id: id(30),
          state: 'ready',
          fileId: id(31),
          counts: { files: 48 },
          failure: null,
        }}
        file={{
          name: 'transaction-123-main-st-2026-10-01.zip',
          bucket: 'files',
          object_path: 'ws/x.zip',
          size_bytes: 31 * 1024 * 1024,
        }}
        onMake={onMake}
      />,
    );
    expect(screen.getByText('transaction-123-main-st-2026-10-01.zip')).toBeTruthy();
    expect(screen.getByTestId('re-export-state')).toHaveTextContent('Ready');
    expect(screen.getByText('48 files · 31 MB · every file’s fingerprint checked')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-export-share'));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalled());
  });

  it('needs signal to make one', async () => {
    mockOnline = false;
    await render(
      <ExportSheetView open onClose={jest.fn()} latest={null} file={null} onMake={jest.fn()} />,
    );
    expect(screen.getByTestId('re-export-make')).toHaveTextContent('Needs signal');
  });
});

describe('a duty (board 79)', () => {
  const renderDuty = (over: Partial<React.ComponentProps<typeof DutyView>> = {}) =>
    render(
      <DutyView
        sheet={sheet()}
        checklist={checklist()}
        documents={[]}
        changes={[]}
        userId={DANA}
        workspaceId={WS}
        timeZone={TZ}
        now={NOW}
        canExcept
        {...over}
      />,
    );

  it('offers a vendor for a duty a vendor does, and not for the rest (board 89)', async () => {
    await renderDuty({ sheet: sheet({ title: 'Schedule the home inspection' }) });
    expect(screen.getByTestId('re-duty-vendor')).toHaveTextContent('Pick a vendor');
    await renderDuty({ sheet: sheet({ title: 'Send the buyers the HOA documents' }) });
    expect(screen.queryByTestId('re-duty-vendor')).toBeNull();
  });

  it('shows its proof checklist first, and Mark done waits for its proof', async () => {
    await renderDuty();
    expect(screen.getByTestId('re-duty-title')).toHaveTextContent(
      'Get the insurance binder to the lender',
    );
    expect(screen.getByTestId('re-duty-line')).toHaveTextContent(
      'Smith purchase · the client, you track · due today 11:59 PM',
    );
    expect(screen.getByTestId('re-duty-status')).toHaveTextContent('Due today');
    expect(screen.getByText('Waiting on Lone Oak Insurance')).toBeTruthy();
    expect(screen.getByText('What counts as done')).toBeTruthy();
    expect(screen.getByText('An Insurance binder')).toBeTruthy();
    expect(screen.getByText('A photo or a file')).toBeTruthy();
    expect(screen.getByText('Their email, or say you did')).toBeTruthy();
    expect(screen.getByText('Mark done turns on once each proof is there.')).toBeTruthy();
    expect(screen.getByTestId('re-duty-done')).toBeDisabled();
  });

  it('adds a photo as the binder document, and your word, with no signal', async () => {
    mockOnline = false;
    await renderDuty();
    await fireEvent.press(screen.getByTestId('re-duty-photo'));
    await fireEvent.press(screen.getByTestId('re-duty-camera'));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: WS, recordType: 'custom_record', recordId: SMITH },
      { localName: 'binder.jpg', sizeBytes: 2048 },
      { fileId: NEW_ID },
    );
    const [[docName, docInput, docOpts], [proofName, proofInput, proofOpts]] = jest.mocked(change)
      .mock.calls as [string, Record<string, unknown>, { dependsOn: string[] }][];
    expect([docName, docInput, docOpts.dependsOn]).toEqual([
      'realestate.document.add',
      {
        workspaceId: WS,
        dealId: SMITH,
        id: NEW_ID,
        fileId: NEW_ID,
        kind: 'insurance_binder',
        title: 'Insurance binder',
        status: 'draft',
      },
      ['upload-1'],
    ]);
    expect([proofName, proofInput, proofOpts.dependsOn]).toEqual([
      'realestate.duty.add_evidence',
      { workspaceId: WS, dutyId: id(1), id: NEW_ID, kind: 'document', documentId: NEW_ID },
      ['change-1'],
    ]);

    jest.mocked(change).mockClear();
    await fireEvent.press(screen.getByTestId('re-duty-other'));
    await fireEvent.press(screen.getByTestId('re-duty-attest'));
    expect(change).toHaveBeenCalledWith(
      'realestate.duty.add_evidence',
      {
        workspaceId: WS,
        dutyId: id(1),
        id: NEW_ID,
        kind: 'attestation',
        body: 'Sent to Summit Lending',
      },
      expect.objectContaining({ optimistic: expect.any(Function) }),
    );
  });

  it('marks it done with no signal once its proof is there, marked as waiting', async () => {
    mockOnline = false;
    const { rerender } = await renderDuty({ checklist: checklist([true, true]) });
    expect(screen.getByTestId('re-duty-done')).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId('re-duty-done'));
    expect(change).toHaveBeenCalledWith(
      'realestate.duty.complete',
      { workspaceId: WS, dutyId: id(1) },
      expect.objectContaining({ optimistic: expect.any(Function) }),
    );
    const waiting: ReChange = {
      id: 'c1',
      name: 'realestate.duty.complete',
      input: { workspaceId: WS, dutyId: id(1) },
      state: 'waiting',
      rule: null,
      madeAt: '2026-10-03T15:52:00.000Z',
    };
    await rerender(
      <DutyView
        sheet={sheet({ status: 'completed' })}
        checklist={checklist([true, true])}
        documents={[]}
        changes={[waiting]}
        userId={DANA}
        workspaceId={WS}
        timeZone={TZ}
        now={NOW}
        canExcept
      />,
    );
    expect(screen.getByTestId('re-duty-status')).toHaveTextContent('Done · waiting to send');
    expect(screen.getByTestId('re-duty-done-waits')).toHaveTextContent('Done · waits to send');
    expect(screen.getByTestId('re-wait-strip')).toHaveTextContent(
      /^No signal · 1 change waits on this phone/,
    );
  });

  it('marks it done without its proof only with signal, and keeps the reason for later', async () => {
    mockOnline = false;
    deviceStore.remove(keptKey(id(1)));
    await renderDuty();
    await fireEvent.press(screen.getByTestId('re-duty-except'));
    expect(
      screen.getByText(
        'An owner or admin can, with a reason that’s kept. HandsFreeOS checks it before it counts, so it needs signal.',
      ),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('re-duty-reason'),
      'Lender confirmed by phone; binder to follow Monday.',
    );
    expect(screen.getByTestId('re-duty-except-send')).toHaveTextContent('Needs signal');
    await fireEvent.press(screen.getByTestId('re-duty-keep'));
    expect(deviceStore.get(keptKey(id(1)))).toBe(
      'Lender confirmed by phone; binder to follow Monday.',
    );
    expect(screen.getByTestId('re-duty-kept')).toHaveTextContent(/Lender confirmed by phone/);
    expect(change).not.toHaveBeenCalled();
  });

  it('sends the kept reason once there’s signal', async () => {
    deviceStore.set(keptKey(id(1)), 'Signed on paper, scan Monday.');
    await renderDuty();
    await fireEvent.press(screen.getByTestId('re-duty-send-kept'));
    expect(change).toHaveBeenCalledWith('realestate.duty.complete_with_exception', {
      workspaceId: WS,
      dutyId: id(1),
      reason: 'Signed on paper, scan Monday.',
    });
    await waitFor(() => expect(deviceStore.get(keptKey(id(1)))).toBeUndefined());
  });

  it('waits for signal for a duty on a deal kept as its summary', async () => {
    await renderDuty({ sheet: sheet({}, false), checklist: checklist([false, false], false) });
    expect(screen.getByTestId('re-duty-summary')).toBeTruthy();
    expect(screen.getByTestId('re-duty-done')).toBeDisabled();
  });
});

describe('key dates (board 80)', () => {
  const ENTRIES = [
    {
      id: id(83),
      key: 'closing',
      valueDate: '2026-10-10',
      supersededAt: '2026-09-29T15:00:00.000Z',
      enteredAt: '2026-09-24T15:00:00.000Z',
    },
  ] as unknown as CopyTermEntry[];

  it('says where each came from, which moved, and what’s done', async () => {
    await render(
      <KeyDatesView page={page()} entries={ENTRIES} timeZone={TZ} now={NOW} onDuty={jest.fn()} />,
    );
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getByTestId('re-date-closing')).toHaveTextContent(
      'ClosingAmended Sep 29 from Oct 10Oct 14',
    );
    expect(screen.getByTestId('re-date-inspection_end')).toHaveTextContent(
      'Inspection period endsContract · §7Oct 3',
    );
    expect(screen.getByTestId('re-date-acceptance')).toHaveTextContent(
      'Contract acceptedContractSep 24',
    );
    const { comingUp, done } = keyDateRows(page(), ENTRIES, TZ, NOW);
    expect(comingUp.map((r) => r.key)).toEqual(['inspection_end', 'closing']);
    expect(done.map((r) => r.key)).toEqual(['acceptance']);
  });
});

describe('contingencies (board 80)', () => {
  const VIEW = {
    dealId: SMITH,
    full: true,
    contingencies: [
      {
        id: id(20),
        kind: 'inspection',
        label: 'Inspection',
        endKey: 'inspection_end',
        endsOn: '2026-10-05',
        endConfirmed: true,
        state: 'open',
        stateWords: 'Open · ends Oct 5',
        clock: 'ending',
        source: 'contract',
        resolvedAt: null,
        resolvedByName: null,
        document: null,
        note: null,
        overrideReason: null,
      },
      {
        id: id(21),
        kind: 'home_sale',
        label: 'Sale of the buyer’s home',
        endKey: 'home_sale_end',
        endsOn: '2026-10-20',
        endConfirmed: true,
        state: 'satisfied',
        stateWords: 'Satisfied Sep 30',
        clock: 'open',
        source: 'offer',
        resolvedAt: '2026-09-30T15:00:00.000Z',
        resolvedByName: 'Dana Reyes',
        document: { id: id(22), title: 'Notice from Kim Ortiz' },
        note: null,
        overrideReason: null,
      },
    ],
  } as ContingenciesView;
  const DOCS = [
    {
      documentId: id(23),
      fileId: id(24),
      fileName: 'amendment.pdf',
      kind: 'amendment',
      kindLabel: 'Amendment',
      title: 'Amendment signed Oct 2',
      lineageId: id(23),
      version: 1,
      status: 'signed',
      controlling: true,
      locked: true,
      signedAt: '2026-10-02T15:00:00.000Z',
      voidedAt: null,
      voidReason: null,
      createdAt: '2026-10-02T15:00:00.000Z',
    },
  ] as DealDocument[];

  it('reads each with when it ends, and resolves one with no signal with its signed form', async () => {
    mockOnline = false;
    await render(
      <ContingenciesListView
        dealName="Smith purchase"
        dealId={SMITH}
        view={VIEW}
        documents={DOCS}
        changes={[]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
      />,
    );
    const inspection = within(screen.getByTestId(`re-contingency-${id(20)}`));
    expect(inspection.getByTestId('re-contingency-state')).toHaveTextContent('Ends Oct 5 · 2 days');
    expect(inspection.getByText('From the contract')).toBeTruthy();
    expect(
      within(screen.getByTestId(`re-contingency-${id(21)}`)).getByTestId('re-contingency-state'),
    ).toHaveTextContent('Satisfied Sep 30');
    await fireEvent.press(inspection.getByTestId('re-contingency-resolve'));
    expect(screen.getByText('Resolve the inspection contingency')).toBeTruthy();
    expect(screen.getByText('How did it end?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-resolve-waived'));
    await fireEvent.press(screen.getByTestId(`re-resolve-document-${id(23)}`));
    await fireEvent.press(screen.getByTestId('re-resolve-save'));
    expect(change).toHaveBeenCalledWith(
      'realestate.contingency.resolve',
      { workspaceId: WS, contingencyId: id(20), how: 'waived', documentId: id(23) },
      expect.objectContaining({ dependsOn: [], optimistic: expect.any(Function) }),
    );
  });

  it('waits for signal on a deal kept as its summary', async () => {
    await render(
      <ContingenciesListView
        dealName="Okafor purchase"
        dealId={SMITH}
        view={{ dealId: SMITH, full: false, contingencies: [] }}
        documents={[]}
        changes={[]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('re-contingencies-summary')).toBeTruthy();
  });
});

describe('the contract as read (board 80)', () => {
  const READ = {
    readId: id(60),
    dealId: SMITH,
    dealName: 'Smith purchase',
    documentId: id(61),
    documentTitle: 'Purchase contract',
    fileId: id(62),
    kind: 'contract',
    state: 'read',
    scan: true,
    pages: 9,
    failure: null,
    requestedAt: '2026-09-24T15:00:00.000Z',
    readAt: '2026-09-24T15:02:00.000Z',
    requestedByName: 'Dana Reyes',
    values: [
      {
        id: id(63),
        key: 'price',
        label: 'Purchase price',
        value: '$412,000',
        date: null,
        cents: 41_200_000,
        text: null,
        worked: null,
        clause: '§3',
        page: 1,
        quote: '…',
        state: 'confirmed',
        decidedByName: 'Dana',
        decidedAt: null,
        reason: null,
      },
      {
        id: id(64),
        key: 'closing',
        label: 'Closing',
        value: 'Oct 14, 2026',
        date: '2026-10-14',
        cents: null,
        text: null,
        worked: null,
        clause: '§9',
        page: 3,
        quote: '…',
        state: 'waiting',
        decidedByName: null,
        decidedAt: null,
        reason: null,
      },
    ],
    unclear: [
      {
        what: 'Survey: who pays?',
        quote: '“Seller” on page 4, “Buyer” on the addendum',
        page: 4,
        clause: null,
      },
    ],
    dropped: 0,
    fileName: 'purchase-contract.pdf',
    version: 2,
  } as ContractReadView;

  it('reads each term with its page, says what needs a person, and confirms only with signal', async () => {
    mockOnline = false;
    await render(<ContractView read={READ} workspaceId={WS} />);
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('purchase-contract.pdf · v2');
    expect(screen.getByText('Read from a scan')).toBeTruthy();
    expect(screen.getByTestId('re-contract-count')).toHaveTextContent('1 of 2 confirmed');
    expect(screen.getByTestId('re-contract-value-price')).toHaveTextContent(
      'Purchase price$412,000Page 1 · §3',
    );
    expect(screen.getByText('Needs a person  1')).toBeTruthy();
    expect(screen.getByText('Survey: who pays?')).toBeTruthy();
    expect(screen.getByTestId('re-contract-confirm')).toHaveTextContent('Needs signal');
    mockOnline = true;
    await render(<ContractView read={READ} workspaceId={WS} />);
    await fireEvent.press(screen.getAllByTestId('re-contract-confirm').at(-1)!);
    expect(change).toHaveBeenCalledWith('realestate.contract.confirm', {
      workspaceId: WS,
      readId: id(60),
    });
  });
});

describe('documents (board 81)', () => {
  const doc = (over: Partial<DealDocument>): DealDocument => ({
    documentId: id(70),
    fileId: id(71),
    fileName: 'purchase-contract.pdf',
    kind: 'contract',
    kindLabel: 'Purchase contract',
    title: 'Purchase contract',
    lineageId: id(70),
    version: 1,
    status: 'superseded',
    controlling: false,
    locked: true,
    signedAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: '2026-09-20T15:00:00.000Z',
    ...over,
  });
  const DOCS = [
    doc({}),
    doc({
      documentId: id(72),
      version: 2,
      status: 'signed',
      controlling: true,
      signedAt: '2026-09-24T15:00:00.000Z',
    }),
    doc({
      documentId: id(73),
      lineageId: id(73),
      title: 'Repair amendment',
      kind: 'amendment',
      kindLabel: 'Amendment',
      status: 'sent',
      locked: false,
    }),
    doc({
      documentId: id(74),
      lineageId: id(74),
      title: 'Inspection report',
      kind: 'inspection_report',
      kindLabel: 'Inspection report',
      status: 'draft',
      locked: false,
      createdAt: '2026-09-30T15:00:00.000Z',
    }),
  ];
  const SIGNING = {
    id: id(75),
    documentId: id(73),
    provider: 'docusign',
    providerLabel: 'DocuSign',
    state: 'sent',
    stateLabel: 'Out for signing',
    signers: [],
    signersWords: 'Signed by 1 of 2',
    sentAt: '2026-10-02T15:00:00.000Z',
    completedAt: null,
    signedDocumentId: null,
    next: 'Bill Smith',
  } as DealSigning;
  const WAITING: ReChange = {
    id: 'c9',
    name: 'realestate.document.add',
    input: { dealId: SMITH, id: id(76), kind: 'insurance_binder', title: 'Insurance binder' },
    state: 'waiting',
    rule: null,
    madeAt: '2026-10-03T15:00:00.000Z',
  };

  it('groups signed, out for signing and not signed, with what this phone knows and opening it with signal', async () => {
    mockOnline = false;
    await render(
      <DocumentsView
        dealName="Smith purchase"
        dealId={SMITH}
        held
        whole
        documents={DOCS}
        summaryState={null}
        signings={[SIGNING]}
        pending={[WAITING]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
        esignId={null}
      />,
    );
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('Smith purchase · 4 documents');
    expect(screen.getByText('Signed  1')).toBeTruthy();
    expect(screen.getByText('v2 · signed Sep 24 · the one that counts')).toBeTruthy();
    expect(screen.getByText('Out for signing  1')).toBeTruthy();
    expect(screen.getByText('DocuSign · 1 of 2 signed · Bill Smith next')).toBeTruthy();
    expect(screen.getByText('Not signed  2')).toBeTruthy();
    expect(screen.getByText('Waiting to send · from this phone')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`re-document-${id(72)}`));
    expect(screen.getByTestId('re-document-needs-signal')).toHaveTextContent(
      'Opening it needs signal. It stays at HandsFreeOS, not on this phone.',
    );
    expect(screen.getByText('2 of 2 · the one that counts')).toBeTruthy();
    expect(screen.getByText('Can’t be deleted or renamed')).toBeTruthy();
  });

  it('opens the document a signing came back for (the web’s ?esign=)', async () => {
    await render(
      <DocumentsView
        dealName="Smith purchase"
        dealId={SMITH}
        held
        whole
        documents={DOCS}
        summaryState={null}
        signings={[SIGNING]}
        pending={[]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
        esignId={id(75)}
      />,
    );
    const sheet = within(screen.getByTestId('re-document-sheet'));
    expect(sheet.getByText('Repair amendment · v1')).toBeTruthy();
    expect(sheet.getByText('DocuSign · Out for signing')).toBeTruthy();
    expect(sheet.getByTestId('re-document-open')).toBeTruthy();
  });

  it('adds a document from a photo of a paper with no signal', async () => {
    mockOnline = false;
    await render(
      <DocumentsView
        dealName="Smith purchase"
        dealId={SMITH}
        held
        whole
        documents={[]}
        summaryState={null}
        signings={[]}
        pending={[]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
        esignId={null}
      />,
    );
    await fireEvent.press(screen.getByTestId('re-documents-add'));
    await fireEvent.press(screen.getByTestId('re-document-kind-amendment'));
    await fireEvent.changeText(screen.getByTestId('re-document-title'), 'Repair amendment');
    await fireEvent.press(screen.getByTestId('re-document-camera'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(change).toHaveBeenCalledWith(
      'realestate.document.add',
      {
        workspaceId: WS,
        dealId: SMITH,
        id: NEW_ID,
        fileId: NEW_ID,
        kind: 'amendment',
        title: 'Repair amendment',
        status: 'draft',
      },
      expect.objectContaining({ dependsOn: ['upload-1'] }),
    );
  });

  it('loads a summary deal’s documents with signal, and says so without', async () => {
    await render(
      <DocumentsView
        dealName="Okafor purchase"
        dealId={SMITH}
        held
        whole={false}
        documents={[]}
        summaryState={{ loading: false, error: null, retry: jest.fn() }}
        signings={[]}
        pending={[]}
        workspaceId={WS}
        userId={DANA}
        timeZone={TZ}
        now={NOW}
        esignId={null}
      />,
    );
    expect(screen.getByTestId('re-documents-summary')).toHaveTextContent(
      'This deal’s documents load with signal, because you’re not on it. Try again when you have signal.Try again',
    );
  });
});

describe('history (board 81)', () => {
  it('says who did what and when', async () => {
    const lines: HistoryLine[] = [
      {
        at: '2026-09-29T15:00:00.000Z',
        what: 'stage_changed',
        actorType: 'person',
        actor: { userId: DANA, name: 'Marcus Lee' },
        before: { stage: 'under_contract' },
        after: { stage: 'inspection' },
        note: 'amendment signed',
      },
    ];
    await render(
      <HistoryView
        dealName="Smith purchase"
        held
        whole
        lines={lines}
        summaryState={null}
        more={false}
        onMore={jest.fn()}
        timeZone={TZ}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('re-history-line')).toHaveTextContent(/by Marcus Lee/);
    expect(screen.getByText('Sep 29 · amendment signed')).toBeTruthy();
  });
});

describe('a client update (board 81)', () => {
  const UPDATE: ClientUpdateView = {
    draftId: id(90),
    dealId: SMITH,
    milestone: 'asked',
    status: 'ready',
    subject: 'Your inspection is in',
    body: 'Hi Ann and Bill, the inspection report is in.',
    to: { personId: ANN, name: 'Ann and Bill', email: 'ann@example.com' },
    sentAt: null,
    editedAt: null,
    acknowledged: false,
  };

  it('is checked and OK’d anywhere, and edited with no signal', async () => {
    mockOnline = false;
    await render(
      <ClientUpdateViewScreen
        dealName="Smith purchase"
        update={UPDATE}
        changes={[]}
        workspaceId={WS}
        timeZone={TZ}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('screen-subtitle')).toHaveTextContent('Smith purchase · draft');
    expect(screen.getByText('Fair housing: checks with signal')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-update-ok'));
    expect(change).toHaveBeenCalledWith(
      'realestate.status_email.send',
      { workspaceId: WS, draftId: id(90) },
      { dependsOn: [] },
    );
    await fireEvent.press(screen.getByTestId('re-update-edit'));
    await fireEvent.changeText(
      screen.getByTestId('re-update-body-input'),
      'Hi Ann and Bill, more tomorrow.',
    );
    await fireEvent.press(screen.getByTestId('re-update-save'));
    expect(change).toHaveBeenLastCalledWith(
      'realestate.status_email.save',
      {
        workspaceId: WS,
        draftId: id(90),
        subject: 'Your inspection is in',
        body: 'Hi Ann and Bill, more tomorrow.',
      },
      expect.objectContaining({ optimistic: expect.any(Function) }),
    );
  });

  it('asks “Still send?” when an OK waited more than 30 minutes', async () => {
    const stale: ReChange = {
      id: 'c7',
      name: 'realestate.status_email.send',
      input: { workspaceId: WS, draftId: id(90) },
      state: 'ask',
      rule: 'stale_action',
      madeAt: new Date(NOW - 50 * 60_000).toISOString(),
    };
    await render(
      <ClientUpdateViewScreen
        dealName="Smith purchase"
        update={UPDATE}
        changes={[stale]}
        workspaceId={WS}
        timeZone={TZ}
        now={NOW}
      />,
    );
    expect(screen.getByText('Still send?')).toBeTruthy();
    expect(
      screen.getByText(
        'You OK’d this update to Ann and Bill 50 minutes ago, with no signal. Anything to a client that waits more than 30 minutes checks with you first.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-update-send-now'));
    expect(changes.stillSend).toHaveBeenCalledWith('c7');
    expect(agoWords(2 * 60 * 60_000)).toBe('2 hours ago');
  });
});

describe('what Real Estate’s changes say on Changes (board 79)', () => {
  const names = {
    deal: (dealId: string | null) => (dealId === SMITH ? 'Smith purchase' : null),
    row: (source: string, rowId: string | null) =>
      source === 'duties' && rowId === id(1)
        ? { dealId: SMITH, data: { title: 'Insurance binder' } }
        : source === 'contingencies' && rowId === id(20)
          ? { dealId: SMITH, data: { kind: 'inspection' } }
          : null,
  };

  it('names the duty and its deal', () => {
    expect(describeRealestate('realestate.duty.complete', { dutyId: id(1) }, names)).toMatchObject({
      title: 'Marked done: insurance binder',
      deal: { id: SMITH, name: 'Smith purchase' },
    });
    expect(
      describeRealestate('realestate.duty.add_evidence', { dutyId: id(1), kind: 'note' }, names),
    ).toMatchObject({ title: 'Note on “Insurance binder”' });
    expect(
      describeRealestate('realestate.contingency.resolve', { contingencyId: id(20) }, names),
    ).toMatchObject({ title: 'Inspection contingency resolved', deal: { name: 'Smith purchase' } });
    expect(describeRealestate('task.complete', {}, names)).toBeNull();
  });
});
