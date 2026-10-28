import { DOCUMENT_SCREEN_WORDS as W, PHONE_HAND_BACK } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { Share } from 'react-native';

import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { lockIfEnabled } from '@/lib/app-start';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';
import { workerPost } from '@/lib/worker';

import type {
  DocumentGetOut,
  DocumentPrefillOut,
  DocumentRow,
  DocumentTemplateRow,
} from '../calls';
import { DocumentsCard } from '../card';
import { DocumentBody, DocumentsScreen } from '../screens';
import { SendBody } from '../send';

/**
 * Documents on the phone (docs/documents.md, part 3): the list of what's been sent, filtered by where each one is; a
 * document's page, where the team reminds, voids with a reason, sends a corrected one again, sends a signer their
 * link, hands the phone over with Sign now (the app locks again after) and shares the signed copy; the Send screen,
 * which starts from HandsFreeOS and sends what the web's would; and a customer's documents on their page. It all
 * needs signal, so the API and the worker stand in.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/app-start', () => ({ lockIfEnabled: jest.fn(async () => undefined) }));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/inbox/storage', () => ({
  signedUrl: jest.fn(async () => 'https://storage.test/signed.pdf?token=t'),
}));
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(async () => ({ type: 'success', url: 'handsfreeos://x' })),
  openBrowserAsync: jest.fn(async () => ({ type: 'opened' })),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('@/calendar/use-calendar', () => ({
  useCustomers: () => [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Dana Smith',
      address: '12 Elm St, Austin',
      searchText: 'dana smith 12 elm st austin',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sam Lee',
      address: null,
      searchText: 'sam lee',
    },
  ],
}));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const fs = jest.requireMock('expo-file-system') as { File: { downloadFileAsync?: jest.Mock } };
fs.File.downloadFileAsync = jest.fn(async (_url: string, to: { uri: string }) => to);

const DALE = '11111111-1111-4111-8111-111111111111';
const DANA = '22222222-2222-4222-8222-222222222222';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEMPLATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SIGNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const US = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SENDS = ['records.read', 'records.write', 'documents.send'];

const business = (permissions: string[]): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
  permissions,
});
const me = (permissions: string[]): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(permissions)],
  organizations: [],
  fetchedAt: 0,
});

const post = api.POST as unknown as jest.Mock;
let answers: Record<string, unknown>;
const sent = (path: string) =>
  post.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as { body: unknown }).body);

function wrap(element: React.ReactElement, permissions = SENDS) {
  post.mockImplementation(async (path: string) => ({
    data: answers[path] ?? {},
    response: new Response(null, { status: 200 }),
  }));
  return render(
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(permissions),
        business: business(permissions),
        openSwitcher: () => undefined,
      }}
    >
      {element}
    </BusinessProvider>,
  );
}

const ROW: DocumentRow = {
  id: DOC,
  name: 'Service agreement',
  status: 'out',
  finishing: false,
  templateId: TEMPLATE,
  about: { kind: 'person', id: DANA, name: 'Dana Smith' },
  sentAt: '2026-10-20T15:00:00.000Z',
  expiresAt: '2026-11-19T15:00:00.000Z',
  completedAt: null,
  sentBy: { id: DALE, fullName: 'Dale Ramsey' },
  signers: [
    {
      id: SIGNER,
      kind: 'signer',
      name: 'Dana Smith',
      roleLabel: 'Customer',
      status: 'opened',
      position: 0,
      inPerson: false,
    },
  ],
};

const TEMPLATE_ROW: DocumentTemplateRow = {
  id: TEMPLATE,
  name: 'Service agreement',
  pageCount: 2,
  roles: [
    { key: 'customer', label: 'Customer', kind: 'customer' },
    { key: 'us', label: 'Us', kind: 'team' },
  ],
  fieldCount: 4,
  hasPdf: true,
  ready: true,
  documentsOut: 1,
  updatedAt: '2026-10-19T15:00:00.000Z',
  archivedAt: null,
};

const DEFINITION = {
  version: 1,
  pages: [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ],
  roles: [
    { key: 'customer', label: 'Customer', kind: 'customer' },
    { key: 'us', label: 'Us', kind: 'team' },
  ],
  fields: [
    { id: 'f_sign', type: 'signature', role: 'customer', page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
    {
      id: 'f_start',
      type: 'date',
      role: 'sender',
      page: 0,
      x: 0.1,
      y: 0.2,
      w: 0.2,
      h: 0.03,
      label: 'Start date',
    },
    {
      id: 'f_name',
      type: 'name',
      role: 'customer',
      page: 0,
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.03,
      fillFrom: 'customer.name',
    },
    { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.8, w: 0.3, h: 0.05 },
  ],
  edits: [],
  settings: {},
  presets: {},
};

const GOT: DocumentGetOut = {
  ...ROW,
  definition: DEFINITION,
  values: {},
  valuesBy: {},
  message: null,
  signingOrder: 'order',
  remindAfterDays: 2,
  remindEveryDays: 3,
  source: { fileId: DOC, name: 'agreement.pdf', bucket: 'attachments', objectPath: 'a/b.pdf' },
  signed: null,
  sourceSha256: null,
  signedSha256: null,
  voidedAt: null,
  voidReason: null,
  declinedAt: null,
  expiredAt: null,
  signers: [
    {
      ...ROW.signers[0]!,
      roleKey: 'customer',
      personId: DANA,
      userId: null,
      email: 'dana@example.test',
      phone: '+15125550100',
      askCode: false,
      sentAt: '2026-10-20T15:00:00.000Z',
      lastSentAt: '2026-10-20T15:00:00.000Z',
      reminders: 0,
      channels: ['email'],
      openedAt: '2026-10-21T15:00:00.000Z',
      codeCheckedAt: null,
      agreedAt: null,
      signedAt: null,
      declinedAt: null,
      declineReason: null,
      ip: null,
      device: null,
    },
  ],
  steps: [
    {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      kind: 'sent',
      at: '2026-10-20T15:00:00.000Z',
      signerId: SIGNER,
      channel: 'email',
      ip: null,
      device: null,
      detail: {},
      byUserId: DALE,
    },
  ],
  canSend: true,
};

const PREFILL: DocumentPrefillOut = {
  templateId: TEMPLATE,
  name: 'Service agreement',
  definition: DEFINITION,
  presets: { f_name: { kind: 'text', text: 'Dana Smith' } },
  signers: [
    {
      roleKey: 'customer',
      personId: DANA,
      userId: null,
      name: 'Dana Smith',
      email: 'dana@example.test',
      phone: null,
      inPerson: false,
    },
    {
      roleKey: 'us',
      personId: null,
      userId: DALE,
      name: 'Dale Ramsey',
      email: null,
      phone: null,
      inPerson: false,
    },
  ],
  copies: [],
  message: '',
  source: null,
  issues: [],
};

beforeEach(() => {
  answers = {};
  post.mockReset();
  jest.mocked(router.push).mockReset();
  jest.mocked(router.replace).mockReset();
  jest.mocked(openWeb).mockClear();
  jest.mocked(lockIfEnabled).mockClear();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockClear();
  jest.mocked(workerPost).mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the documents list', () => {
  it('shows what’s been sent and where each one is, filtered by state, and sends a new one', async () => {
    answers = {
      '/v1/queries/document.list': { documents: [ROW], more: false },
      '/v1/queries/document_template.list': { templates: [TEMPLATE_ROW] },
    };
    await wrap(<DocumentsScreen />);
    const row = await screen.findByTestId('document-row');
    expect(row).toHaveTextContent(/Service agreement/);
    expect(row).toHaveTextContent(/Dana Smith: opened/);
    expect(row).toHaveTextContent(/Out for signing/);
    await fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/documents/${DOC}`);

    await fireEvent.press(screen.getByTestId('documents-send'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/documents/send`);

    answers['/v1/queries/document.list'] = { documents: [], more: false };
    await fireEvent.press(screen.getByTestId('documents-filter-completed'));
    await waitFor(() =>
      expect(screen.getByTestId('documents-empty')).toHaveTextContent(W.noneHere, { exact: false }),
    );
    expect(sent('/v1/queries/document.list').at(-1)).toMatchObject({ status: 'completed' });

    // Templates are made on the web for now.
    await fireEvent.press(screen.getByTestId('documents-templates-web'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/documents?tab=templates`);
  });

  it('says no template is ready rather than offering to send', async () => {
    answers = {
      '/v1/queries/document.list': { documents: [], more: false },
      '/v1/queries/document_template.list': {
        templates: [{ ...TEMPLATE_ROW, ready: false }],
      },
    };
    await wrap(<DocumentsScreen />);
    expect(await screen.findByTestId('documents-no-template')).toHaveTextContent(W.noTemplateReady);
    expect(screen.queryByTestId('documents-send')).toBeNull();
    expect(screen.getByTestId('documents-empty')).toHaveTextContent(W.nothingSent, {
      exact: false,
    });
  });
});

describe('one document', () => {
  it('reminds, and voids it with the reason they’ll see', async () => {
    const onChanged = jest.fn();
    await wrap(<DocumentBody workspaceId={LONE_STAR} doc={GOT} onChanged={onChanged} />);
    expect(screen.getByTestId('document-signer')).toHaveTextContent(/Dana Smith/);
    expect(screen.getByTestId('document-steps')).toHaveTextContent(/Dana Smith/);

    await fireEvent.press(screen.getByTestId('document-remind'));
    await waitFor(() =>
      expect(sent('/v1/commands/document.remind')).toEqual([
        { workspaceId: LONE_STAR, documentId: DOC },
      ]),
    );
    expect(toast.show).toHaveBeenCalledWith(W.reminded);

    await fireEvent.press(screen.getByTestId('document-void-open'));
    await fireEvent.changeText(screen.getByTestId('document-void-reason'), ' Wrong start date. ');
    await fireEvent.press(screen.getByTestId('document-void'));
    await waitFor(() =>
      expect(sent('/v1/commands/document.void')).toEqual([
        { workspaceId: LONE_STAR, documentId: DOC, reason: 'Wrong start date.' },
      ]),
    );
    expect(toast.show).toHaveBeenCalledWith(W.voided);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('hands the phone to a signer who’s here with Sign now, then locks the app again', async () => {
    jest
      .mocked(workerPost)
      .mockResolvedValue({ url: 'https://app.handsfreeos.com/d/tok123' } as never);
    const onChanged = jest.fn();
    await wrap(<DocumentBody workspaceId={LONE_STAR} doc={GOT} onChanged={onChanged} />);
    await fireEvent.press(screen.getByTestId('document-sign-now'));
    expect(screen.getByTestId('document-sign-now-sheet')).toHaveTextContent(
      W.phone.signNowTitle('Dana Smith'),
      { exact: false },
    );
    await fireEvent.press(screen.getByTestId('document-sign-now-go'));
    await waitFor(() => expect(lockIfEnabled).toHaveBeenCalled());
    expect(sent('/v1/commands/document.sign_now')).toEqual([
      { workspaceId: LONE_STAR, signerId: SIGNER },
    ]);
    expect(workerPost).toHaveBeenCalledWith('/v1/documents/link', {
      workspaceId: LONE_STAR,
      signerId: SIGNER,
    });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      `https://app.handsfreeos.com/d/tok123#with=Dana&back=${encodeURIComponent(PHONE_HAND_BACK)}`,
      PHONE_HAND_BACK,
      { preferEphemeralSession: true },
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('doesn’t open the signing page, or lock, when Sign now is refused', async () => {
    post.mockImplementation(async (path: string) =>
      path === '/v1/commands/document.sign_now'
        ? { error: 'It’s not their turn yet.', response: new Response(null, { status: 409 }) }
        : { data: {}, response: new Response(null, { status: 200 }) },
    );
    await render(
      <BusinessProvider
        value={{
          userId: DALE,
          me: me(SENDS),
          business: business(SENDS),
          openSwitcher: () => undefined,
        }}
      >
        <DocumentBody workspaceId={LONE_STAR} doc={GOT} onChanged={() => undefined} />
      </BusinessProvider>,
    );
    await fireEvent.press(screen.getByTestId('document-sign-now'));
    await fireEvent.press(screen.getByTestId('document-sign-now-go'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('It’s not their turn yet.'));
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(lockIfEnabled).not.toHaveBeenCalled();
  });

  it('sends a signer their own link through the share sheet', async () => {
    jest
      .mocked(workerPost)
      .mockResolvedValue({ url: 'https://app.handsfreeos.com/d/tok123' } as never);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await wrap(<DocumentBody workspaceId={LONE_STAR} doc={GOT} onChanged={() => undefined} />);
    await fireEvent.press(screen.getByTestId('document-share-link'));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'https://app.handsfreeos.com/d/tok123' }),
      ),
    );
  });

  it('shares the signed copy once it’s filed, and sends a voided one again', async () => {
    const signed: DocumentGetOut = {
      ...GOT,
      status: 'completed',
      completedAt: '2026-10-22T15:00:00.000Z',
      signed: {
        fileId: DOC,
        name: 'Service agreement (signed).pdf',
        bucket: 'attachments',
        objectPath: 'a/signed.pdf',
      },
    };
    const { rerender } = await wrap(
      <DocumentBody workspaceId={LONE_STAR} doc={signed} onChanged={() => undefined} />,
    );
    expect(screen.getByTestId('document-note')).toHaveTextContent(W.completedNote);
    expect(screen.queryByTestId('document-remind')).toBeNull();
    await fireEvent.press(screen.getByTestId('document-share-signed'));
    await waitFor(() =>
      expect(Sharing.shareAsync).toHaveBeenCalledWith(
        'file:///cache/Service-agreement-signed-.pdf',
        { mimeType: 'application/pdf', dialogTitle: 'Service agreement' },
      ),
    );

    const voided: DocumentGetOut = {
      ...GOT,
      status: 'voided',
      voidedAt: '2026-10-22T15:00:00.000Z',
      voidReason: 'Wrong start date.',
    };
    await rerender(
      <BusinessProvider
        value={{
          userId: DALE,
          me: me(SENDS),
          business: business(SENDS),
          openSwitcher: () => undefined,
        }}
      >
        <DocumentBody workspaceId={LONE_STAR} doc={voided} onChanged={() => undefined} />
      </BusinessProvider>,
    );
    expect(screen.getByTestId('document-note')).toHaveTextContent(/Wrong start date\./);
    expect(screen.queryByTestId('document-sign-now')).toBeNull();
    await fireEvent.press(screen.getByTestId('document-send-again'));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/documents/send?template=${TEMPLATE}&from=${DOC}&person=${DANA}`,
    );
  });
});

describe('sending one', () => {
  it('starts from HandsFreeOS for the customer picked, and sends what the web’s Send screen would', async () => {
    answers = {
      '/v1/queries/document.prefill': PREFILL,
      '/v1/commands/document.send': {
        documentId: DOC,
        name: 'Service agreement',
        expiresAt: '2026-11-19T15:00:00.000Z',
        signers: [
          {
            signerId: SIGNER,
            kind: 'signer',
            roleKey: 'customer',
            name: 'Dana Smith',
            status: 'sent',
          },
          { signerId: US, kind: 'signer', roleKey: 'us', name: 'Dale Ramsey', status: 'waiting' },
        ],
      },
    };
    await wrap(
      <SendBody
        workspaceId={LONE_STAR}
        templates={[TEMPLATE_ROW]}
        members={[{ id: DALE, fullName: 'Dale Ramsey' }]}
        initialTemplate={null}
        initialAbout={null}
        fromDocumentId={null}
      />,
    );
    // One template ready: it's picked already. Who it's for, from the phone's copy.
    expect(screen.getByTestId('send-template')).toHaveTextContent(/Service agreement/);
    await fireEvent.changeText(screen.getByTestId('send-about-search'), 'dana');
    const options = screen.getAllByTestId('send-about-search-option');
    expect(options).toHaveLength(1);
    await fireEvent.press(options[0]!);
    await waitFor(() =>
      expect(sent('/v1/queries/document.prefill')).toEqual([
        { workspaceId: LONE_STAR, templateId: TEMPLATE, about: { personId: DANA } },
      ]),
    );

    // The business's own part has to be filled in first.
    await screen.findByTestId('send-signers');
    await fireEvent.press(screen.getByTestId('send-submit'));
    expect(screen.getByTestId('send-error')).toHaveTextContent('Fill in Start date.');
    expect(sent('/v1/commands/document.send')).toHaveLength(0);

    expect(screen.getByTestId('send-value-f_name')).toHaveProp('value', 'Dana Smith');
    await fireEvent.changeText(screen.getByTestId('send-value-f_start'), '2026-11-01');
    await fireEvent.press(screen.getByTestId('signer-in-person-customer'));
    await fireEvent.changeText(screen.getByTestId('send-message'), ' Here it is. ');
    await fireEvent.press(screen.getByTestId('send-submit'));
    await waitFor(() => expect(sent('/v1/commands/document.send')).toHaveLength(1));
    expect(sent('/v1/commands/document.send')[0]).toEqual({
      workspaceId: LONE_STAR,
      templateId: TEMPLATE,
      about: { personId: DANA },
      name: 'Service agreement',
      signers: [
        { roleKey: 'customer', personId: DANA, inPerson: true },
        { roleKey: 'us', userId: DALE },
      ],
      copies: [],
      values: {
        f_name: { kind: 'text', text: 'Dana Smith' },
        f_start: { kind: 'date', date: '2026-11-01' },
      },
      edits: [],
      message: 'Here it is.',
      settings: {
        order: 'order',
        askCode: false,
        remindAfterDays: 2,
        remindEveryDays: 3,
        expireDays: 30,
      },
    });
    expect(toast.show).toHaveBeenCalledWith(W.sentMany);
    expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/documents/${DOC}`);
  });

  it('asks who signs when a role has nobody, and corrects a voided one for the same customer', async () => {
    answers = {
      '/v1/queries/document.prefill': {
        ...PREFILL,
        signers: PREFILL.signers.map((s) =>
          s.roleKey === 'us' ? { ...s, userId: null, name: '' } : s,
        ),
      },
    };
    await wrap(
      <SendBody
        workspaceId={LONE_STAR}
        templates={[TEMPLATE_ROW]}
        members={[{ id: DALE, fullName: 'Dale Ramsey' }]}
        initialTemplate={TEMPLATE}
        initialAbout={{ kind: 'person', id: DANA, name: 'Dana Smith' }}
        fromDocumentId={DOC}
      />,
    );
    await waitFor(() =>
      expect(sent('/v1/queries/document.prefill')).toEqual([
        {
          workspaceId: LONE_STAR,
          templateId: TEMPLATE,
          about: { personId: DANA },
          fromDocumentId: DOC,
        },
      ]),
    );
    // A corrected one keeps its customer.
    expect(screen.queryByTestId('send-about-change')).toBeNull();
    await screen.findByTestId('send-signers');
    await fireEvent.changeText(screen.getByTestId('send-value-f_start'), '2026-11-01');
    await fireEvent.press(screen.getByTestId('send-submit'));
    expect(screen.getByTestId('send-error')).toHaveTextContent(W.pickSigner('Us'));
    await fireEvent.press(screen.getByTestId('signer-us-pick'));
    await fireEvent.press(screen.getByTestId('send-team-option'));
    expect(screen.getByTestId('signer-us')).toHaveTextContent(/Dale Ramsey/);
  });
});

describe('a customer’s documents', () => {
  it('lists the ones sent to them for whoever sends documents', async () => {
    answers = { '/v1/queries/document.list': { documents: [ROW], more: false } };
    await wrap(<DocumentsCard workspaceId={LONE_STAR} personId={DANA} />);
    const card = await screen.findByTestId('person-documents');
    expect(card).toHaveTextContent(/Service agreement/);
    expect(sent('/v1/queries/document.list')).toEqual([
      { workspaceId: LONE_STAR, limit: 5, personId: DANA },
    ]);
  });

  it('stays out of the way for someone who can’t send them', async () => {
    answers = { '/v1/queries/document.list': { documents: [ROW], more: false } };
    await wrap(<DocumentsCard workspaceId={LONE_STAR} personId={DANA} />, ['records.read']);
    await waitFor(() => expect(post).not.toHaveBeenCalled());
    expect(screen.queryByTestId('person-documents')).toBeNull();
  });
});
