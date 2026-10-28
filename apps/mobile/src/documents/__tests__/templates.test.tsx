import {
  DOCUMENT_EDITOR_WORDS as E,
  DOCUMENT_SCREEN_WORDS as W,
  type DocumentDefinition,
} from '@hfos/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { workerPost } from '@/lib/worker';

import type {
  DocumentGetOut,
  DocumentPrefillOut,
  DocumentTemplateGetOut,
  DocumentTemplateRow,
  PageLine,
} from '../calls';
import { DocumentPagesScreen } from '../screens';
import { SendBody } from '../send';
import { TemplateBody, TemplateList } from '../templates';

/**
 * Templates on the phone (docs/documents.md, part 3, answer 24b): the list in use and archived, a new one from a PDF
 * picked from the phone's files, and the editor: fields placed where the page is tapped for whoever's chosen, their
 * settings, the PDF's own words typed over (26c), who signs, Place fields for me, saving with the revision it started
 * from and a conflict when someone saved in between. Then one customer's own word changes on the Send screen (27a),
 * and a sent document's pages. The API and the worker stand in; the worker draws the pages.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/auth', () => ({ session: { accessToken: async () => 'token-1' } }));
jest.mock('@/lib/config', () => {
  const actual = jest.requireActual<{ config: Record<string, unknown> }>('@/lib/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      supabaseUrl: 'https://hfos.test',
      supabasePublishableKey: 'sb_publishable_test',
    },
  };
});
jest.mock('@/calendar/use-calendar', () => ({ useCustomers: () => [] }));

const fs = jest.requireMock('expo-file-system') as {
  File: { pickFileAsync?: jest.Mock; prototype: { upload?: jest.Mock } };
};
fs.File.pickFileAsync = jest.fn();
fs.File.prototype.upload = jest.fn(async () => ({ status: 200, body: '' }));

const DALE = '11111111-1111-4111-8111-111111111111';
const DANA = '22222222-2222-4222-8222-222222222222';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEMPLATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FILE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COPY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MANAGES = ['records.read', 'records.write', 'documents.send', 'documents.manage'];
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
const worker = workerPost as unknown as jest.Mock;
/** What each path answers: a value, or a function of what was sent. */
let answers: Record<string, unknown>;
const sent = (path: string) =>
  post.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as { body: unknown }).body);
const savedDefinition = () =>
  (sent('/v1/commands/document_template.save').at(-1) as { definition: DocumentDefinition })
    .definition;

function wrap(element: React.ReactElement, permissions = MANAGES) {
  post.mockImplementation(async (path: string, init: { body: unknown }) => {
    const a = answers[path];
    const out = typeof a === 'function' ? (a as (b: unknown) => unknown)(init.body) : a;
    if (out instanceof Response) return { error: await out.json(), response: out };
    return { data: out ?? {}, response: new Response(null, { status: 200 }) };
  });
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

const LINE: PageLine = {
  text: 'Payment is due in 30 days.',
  x: 0.1,
  y: 0.4,
  w: 0.5,
  h: 0.02,
  size: 11,
  font: 'serif',
  bold: false,
  background: '#fffdf5',
  color: '#1a1a1a',
};

/** The worker drawing the pages asked for, with a line of words on the first. */
function drawsPages(count = 2) {
  worker.mockImplementation(async (path: string, body: { from?: number; count: number }) => {
    if (path !== '/v1/documents/pages') return {};
    const from = body.from ?? 0;
    const pages = [];
    for (let i = from; i < Math.min(count, from + body.count); i++)
      pages.push({
        page: i,
        width: 612,
        height: 792,
        picture: `https://storage.test/pages-v1/${i}.png`,
        pixelWidth: 1224,
        pixelHeight: 1584,
        lines: i === 0 ? [LINE] : [],
      });
    return { pageCount: count, pages };
  });
}

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
      id: 'f_name',
      type: 'name',
      role: 'customer',
      page: 0,
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.03,
    },
    { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.8, w: 0.3, h: 0.05 },
  ],
  edits: [],
  settings: {},
  presets: {},
};

const SOURCE = {
  fileId: FILE,
  name: 'agreement.pdf',
  bucket: 'attachments',
  objectPath: 'a/b.pdf',
};

const GOT: DocumentTemplateGetOut = {
  id: TEMPLATE,
  name: 'Service agreement',
  revision: 3,
  definition: DEFINITION,
  source: SOURCE,
  issues: [],
  documentsOut: 0,
  updatedAt: '2026-10-19T15:00:00.000Z',
  archivedAt: null,
};

const ROW: DocumentTemplateRow = {
  id: TEMPLATE,
  name: 'Service agreement',
  pageCount: 2,
  roles: DEFINITION.roles as DocumentTemplateRow['roles'],
  fieldCount: 3,
  hasPdf: true,
  ready: true,
  documentsOut: 1,
  updatedAt: '2026-10-19T15:00:00.000Z',
  archivedAt: null,
};

/** The pages laid out at 400 px wide, as the phone's screen would. */
async function layOut(testID: string) {
  await fireEvent(screen.getByTestId(testID), 'layout', {
    nativeEvent: { layout: { width: 424, height: 800, x: 0, y: 0 } },
  });
  await screen.findByTestId('document-page-0');
}

/** A tap on a page, at fractions of it. */
async function tapPage(index: number, x: number, y: number) {
  const height = Math.round((400 * 792) / 612);
  await fireEvent.press(screen.getByTestId(`document-page-press-${index}`), {
    nativeEvent: { locationX: x * 400, locationY: y * height },
  });
}

beforeEach(() => {
  answers = {};
  post.mockReset();
  worker.mockReset();
  drawsPages();
  fs.File.pickFileAsync!.mockReset();
  fs.File.prototype.upload!.mockClear();
  jest.mocked(router.push).mockReset();
  jest.mocked(router.replace).mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the templates', () => {
  it('lists the ones in use and archived, and opens one', async () => {
    answers['/v1/queries/document_template.list'] = (b: { archived: boolean }) => ({
      templates: b.archived ? [] : [ROW],
    });
    await wrap(<TemplateList workspaceId={LONE_STAR} />);
    const row = await screen.findByTestId('template-row');
    expect(row).toHaveTextContent(/Service agreement/);
    expect(row).toHaveTextContent(/2 pages · Customer, Us · 3 fields · 1 out for signing/);
    expect(row).toHaveTextContent(W.ready, { exact: false });
    await fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/documents/templates/${TEMPLATE}`);

    await fireEvent.press(screen.getByTestId('templates-archived'));
    expect(await screen.findByTestId('templates-empty')).toHaveTextContent(W.nothingArchived, {
      exact: false,
    });
    expect(sent('/v1/queries/document_template.list').at(-1)).toMatchObject({ archived: true });
  });

  it('asks an owner for templates when they can’t make them', async () => {
    answers['/v1/queries/document_template.list'] = { templates: [] };
    await wrap(<TemplateList workspaceId={LONE_STAR} />, SENDS);
    expect(await screen.findByTestId('templates-empty')).toHaveTextContent(W.askForTemplates, {
      exact: false,
    });
    expect(screen.queryByTestId('template-new')).toBeNull();
  });

  it('makes a new one from a PDF picked on the phone, and opens it', async () => {
    answers = {
      '/v1/queries/document_template.list': { templates: [] },
      '/v1/commands/document_template.create': { templateId: TEMPLATE, revision: 1 },
      '/v1/commands/document_template.begin_upload': {
        fileId: FILE,
        bucket: 'attachments',
        objectPath: `${LONE_STAR}/document/${TEMPLATE}/${FILE}/Lease.pdf`,
      },
      '/v1/commands/file.confirm': {},
      '/v1/commands/document_template.set_source': {
        revision: 2,
        removedFields: 0,
        removedEdits: 0,
      },
    };
    worker.mockImplementation(async () => ({
      pageCount: 2,
      sizes: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      pages: [],
    }));
    fs.File.pickFileAsync!.mockResolvedValue({
      canceled: false,
      result: { uri: 'file:///picked/Lease.pdf', name: 'Lease.pdf', size: 52_000, type: '' },
    });
    await wrap(<TemplateList workspaceId={LONE_STAR} />);
    await fireEvent.press(await screen.findByTestId('template-new'));
    await fireEvent.press(screen.getByTestId('template-new-file'));
    // Named from the file, which can be changed.
    await waitFor(() => expect(screen.getByTestId('template-new-name').props.value).toBe('Lease'));
    await fireEvent.changeText(screen.getByTestId('template-new-name'), 'Lease agreement');
    await fireEvent.press(screen.getByTestId('template-new-create'));

    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(
        `/app/w/${LONE_STAR}/documents/templates/${TEMPLATE}`,
      ),
    );
    expect(sent('/v1/commands/document_template.create')).toEqual([
      { workspaceId: LONE_STAR, name: 'Lease agreement' },
    ]);
    expect(sent('/v1/commands/document_template.begin_upload')).toEqual([
      {
        workspaceId: LONE_STAR,
        templateId: TEMPLATE,
        name: 'Lease.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 52_000,
      },
    ]);
    expect(fs.File.prototype.upload).toHaveBeenCalledWith(
      `https://hfos.test/storage/v1/object/attachments/${LONE_STAR}/document/${TEMPLATE}/${FILE}/Lease.pdf`,
      expect.objectContaining({
        httpMethod: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
      }),
    );
    // The worker reads the pages' sizes, since the phone can't read a PDF.
    expect(worker).toHaveBeenCalledWith('/v1/documents/pages', {
      workspaceId: LONE_STAR,
      templateId: TEMPLATE,
      fileId: FILE,
      count: 1,
    });
    expect(sent('/v1/commands/document_template.set_source')).toEqual([
      {
        workspaceId: LONE_STAR,
        templateId: TEMPLATE,
        fileId: FILE,
        pages: [
          { width: 612, height: 792 },
          { width: 612, height: 792 },
        ],
        baseRevision: 1,
      },
    ]);
  });

  it('says a file that isn’t a PDF can’t be one, before making anything', async () => {
    answers['/v1/queries/document_template.list'] = { templates: [] };
    fs.File.pickFileAsync!.mockResolvedValue({
      canceled: false,
      result: {
        uri: 'file:///picked/photo.jpg',
        name: 'photo.jpg',
        size: 9_000,
        type: 'image/jpeg',
      },
    });
    await wrap(<TemplateList workspaceId={LONE_STAR} />);
    await fireEvent.press(await screen.findByTestId('template-new'));
    await fireEvent.press(screen.getByTestId('template-new-file'));
    expect(await screen.findByText(E.notPdf('photo.jpg'))).toBeTruthy();
    expect(screen.getByTestId('template-new-file')).toHaveTextContent(E.choosePdf);
    expect(sent('/v1/commands/document_template.create')).toEqual([]);
  });
});

describe('a template’s editor', () => {
  const saves = (issues: unknown[] = []) => {
    let revision = 3;
    return () => ({ revision: ++revision, issues });
  };

  it('places a field where the page is tapped, for whoever’s chosen, and saves it on its revision', async () => {
    answers['/v1/commands/document_template.save'] = saves([
      { code: 'no_signature', message: 'Customer has nothing to sign.' },
    ]);
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    // The worker draws the first pages as they come near.
    await waitFor(() =>
      expect(worker).toHaveBeenCalledWith('/v1/documents/pages', {
        workspaceId: LONE_STAR,
        templateId: TEMPLATE,
        from: 0,
        count: 4,
      }),
    );
    expect(await screen.findByTestId('document-page-picture-0')).toBeTruthy();
    expect(screen.getAllByTestId('field-box')).toHaveLength(3);

    await fireEvent.press(screen.getByTestId('editor-add'));
    await fireEvent.press(within(screen.getByTestId('palette-sheet')).getByTestId('role-us'));
    // The business before it sends can't sign, so the kinds follow who's chosen.
    await fireEvent.press(within(screen.getByTestId('palette-sheet')).getByTestId('role-sender'));
    expect(screen.queryByTestId('tool-signature')).toBeNull();
    await fireEvent.press(screen.getByTestId('role-us'));
    await fireEvent.press(screen.getByTestId('tool-text'));
    expect(screen.getByTestId('tool-hint')).toHaveTextContent(E.phone.hintField('Text'));
    await tapPage(0, 0.5, 0.5);
    expect(screen.queryByTestId('tool-hint')).toBeNull();
    expect(screen.getAllByTestId('field-box')).toHaveLength(4);

    // A moment later it's saved, with the revision it started from.
    await waitFor(() => expect(sent('/v1/commands/document_template.save')).toHaveLength(1), {
      timeout: 3000,
    });
    expect(sent('/v1/commands/document_template.save')[0]).toMatchObject({
      workspaceId: LONE_STAR,
      templateId: TEMPLATE,
      baseRevision: 3,
    });
    const added = savedDefinition().fields.at(-1)!;
    expect(added).toMatchObject({ type: 'text', role: 'us', page: 0 });
    expect(added.x + added.w / 2).toBeCloseTo(0.5, 3);
    expect(await screen.findByTestId('save-state')).toHaveTextContent(E.saved);
    expect(screen.getByTestId('template-issues')).toHaveTextContent(
      'Customer has nothing to sign.',
      { exact: false },
    );
    expect(screen.queryByTestId('template-send')).toBeNull();

    // Undo takes it off, and that's saved on the next revision.
    await fireEvent.press(screen.getByTestId('editor-undo'));
    expect(screen.getAllByTestId('field-box')).toHaveLength(3);
    await waitFor(() => expect(sent('/v1/commands/document_template.save')).toHaveLength(2), {
      timeout: 3000,
    });
    expect(sent('/v1/commands/document_template.save')[1]).toMatchObject({ baseRevision: 4 });
  });

  it('changes a picked field’s settings, nudges it and takes it off', async () => {
    answers['/v1/commands/document_template.save'] = saves();
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    const name = screen
      .getAllByTestId('field-box')
      .find((b) => b.props.accessibilityLabel === 'Name, Customer')!;
    await fireEvent.press(name);
    await fireEvent.press(screen.getByTestId('picked-settings'));
    const sheet = within(screen.getByTestId('picked-sheet'));
    await fireEvent.changeText(sheet.getByTestId('field-label'), 'Full legal name');
    await fireEvent.press(sheet.getByTestId('field-fill-customer.name'));
    await fireEvent.press(sheet.getByTestId('field-role-us'));
    await fireEvent.press(sheet.getByTestId(`nudge-${E.phone.right.toLowerCase()}`));
    await waitFor(
      () => expect(sent('/v1/commands/document_template.save').length).toBeGreaterThan(0),
      {
        timeout: 3000,
      },
    );
    await waitFor(
      () =>
        expect(savedDefinition().fields.find((f) => f.id === 'f_name')).toMatchObject({
          label: 'Full legal name',
          fillFrom: 'customer.name',
          role: 'us',
          x: 0.105,
        }),
      { timeout: 3000 },
    );

    await fireEvent.press(sheet.getByTestId('field-remove'));
    await waitFor(
      () => expect(savedDefinition().fields.map((f) => f.id)).toEqual(['f_sign', 'f_ours']),
      { timeout: 3000 },
    );
  });

  it('types over the PDF’s own words in their font and colours', async () => {
    answers['/v1/commands/document_template.save'] = saves();
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    await screen.findByTestId('document-page-picture-0');
    await fireEvent.press(screen.getByTestId('editor-add'));
    await fireEvent.press(screen.getByTestId('tool-words'));
    expect(screen.getByTestId('tool-hint')).toHaveTextContent(E.phone.hintWords);
    const line = screen.getByTestId('word-line');
    expect(line.props.accessibilityLabel).toBe('Type over “Payment is due in 30 days.”');
    await fireEvent.press(line);

    const sheet = within(screen.getByTestId('picked-sheet'));
    expect(sheet.getByTestId('edit-settings')).toHaveTextContent(LINE.text, { exact: false });
    await fireEvent.changeText(sheet.getByTestId('edit-text'), 'Payment is due in 15 days.');
    await fireEvent.changeText(sheet.getByTestId('edit-colour'), '#222222');
    await waitFor(
      () =>
        expect(savedDefinition().edits).toEqual([
          expect.objectContaining({
            page: 0,
            original: LINE.text,
            text: 'Payment is due in 15 days.',
            font: 'serif',
            size: 11,
            background: '#fffdf5',
            color: '#222222',
          }),
        ]),
      { timeout: 3000 },
    );
    // A line already typed over can't be picked again.
    await fireEvent.press(sheet.getByTestId('edit-remove'));
    await fireEvent.press(screen.getByTestId('editor-add'));
    await fireEvent.press(screen.getByTestId('tool-words'));
    expect(screen.getAllByTestId('word-line')).toHaveLength(1);
  });

  it('adds someone who signs, and asks before taking one off with their fields', async () => {
    answers['/v1/commands/document_template.save'] = saves();
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    await fireEvent.press(screen.getByTestId('editor-roles'));
    const sheet = within(screen.getByTestId('roles-sheet'));
    await fireEvent.press(sheet.getByTestId('role-add-customer'));
    expect(sheet.getByTestId('role-label-customer_1').props.value).toBe('Customer 2');
    await fireEvent.changeText(sheet.getByTestId('role-label-customer_1'), 'Co-owner');

    await fireEvent.press(sheet.getByTestId('role-remove-us'));
    expect(sheet.getByText(E.takeRoleOffAsk('Us', 1))).toBeTruthy();
    await fireEvent.press(sheet.getByTestId('role-remove-yes'));
    await waitFor(
      () => {
        const d = savedDefinition();
        expect(d.roles.map((r) => r.label)).toEqual(['Customer', 'Co-owner']);
        expect(d.fields.map((f) => f.id)).toEqual(['f_sign', 'f_name']);
      },
      { timeout: 3000 },
    );
  });

  it('places fields for them, as one change Undo takes back', async () => {
    answers['/v1/commands/document_template.save'] = saves();
    worker.mockImplementation(async (path: string) =>
      path === '/v1/documents/place-fields'
        ? {
            fields: [
              {
                id: 'f_found',
                type: 'date',
                role: 'customer',
                page: 0,
                x: 0.6,
                y: 0.9,
                w: 0.2,
                h: 0.03,
                required: true,
                label: 'Start date',
                fillFrom: null,
                options: [],
                fontSize: 11,
              },
            ],
          }
        : { pageCount: 2, pages: [] },
    );
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    await fireEvent.press(screen.getByTestId('template-place-fields'));
    await waitFor(() => expect(screen.getAllByTestId('field-box')).toHaveLength(4));
    // The worker finds the spots on the stored PDF itself: the phone sends who signs.
    expect(worker).toHaveBeenCalledWith('/v1/documents/place-fields', {
      workspaceId: LONE_STAR,
      templateId: TEMPLATE,
      roles: DEFINITION.roles,
    });
    expect(toast.show).toHaveBeenCalledWith(E.placed(1), {
      action: expect.objectContaining({ label: E.undo }),
    });
    const undo = jest.mocked(toast.show).mock.calls.at(-1)![1]!.action!;
    await act(async () => undo.onPress());
    expect(screen.getAllByTestId('field-box')).toHaveLength(3);
  });

  it('stops saving when someone saved in between, and loads their changes', async () => {
    answers['/v1/commands/document_template.save'] = new Response(
      JSON.stringify({
        error: {
          code: 'conflict',
          message: 'Someone else saved it.',
          rule: 'revision_conflict',
          disposition: 'final',
        },
      }),
      { status: 409 },
    );
    answers['/v1/queries/document_template.get'] = {
      ...GOT,
      revision: 7,
      definition: { ...DEFINITION, fields: [] },
    };
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await layOut('editor-pages');
    await fireEvent.press(screen.getByTestId('editor-add'));
    await fireEvent.press(screen.getByTestId('tool-checkbox'));
    await tapPage(0, 0.2, 0.2);
    expect(await screen.findByTestId('template-conflict', {}, { timeout: 3000 })).toHaveTextContent(
      E.conflict,
      { exact: false },
    );
    // Nothing more is changed or saved over theirs until they're loaded.
    expect(screen.queryByTestId('editor-bar')).toBeNull();
    await fireEvent.press(screen.getByTestId('template-load-theirs'));
    await waitFor(() => expect(screen.queryByTestId('template-conflict')).toBeNull());
    expect(screen.queryAllByTestId('field-box')).toHaveLength(0);
    expect(screen.getByTestId('editor-bar')).toBeTruthy();
  });

  it('starts one without a PDF from the phone’s files', async () => {
    answers = {
      '/v1/commands/document_template.begin_upload': {
        fileId: FILE,
        bucket: 'attachments',
        objectPath: `${LONE_STAR}/document/${TEMPLATE}/${FILE}/Lease.pdf`,
      },
      '/v1/commands/document_template.set_source': {
        revision: 2,
        removedFields: 0,
        removedEdits: 0,
      },
      '/v1/queries/document_template.get': GOT,
    };
    worker.mockImplementation(async (_path: string, body: { fileId?: string }) =>
      body.fileId
        ? { pageCount: 2, sizes: DEFINITION.pages, pages: [] }
        : { pageCount: 2, pages: [] },
    );
    fs.File.pickFileAsync!.mockResolvedValue({
      canceled: false,
      result: {
        uri: 'file:///picked/Lease.pdf',
        name: 'Lease.pdf',
        size: 52_000,
        type: 'application/pdf',
      },
    });
    await wrap(
      <TemplateBody
        workspaceId={LONE_STAR}
        initial={{
          ...GOT,
          revision: 1,
          source: null,
          definition: { ...DEFINITION, pages: [], fields: [] },
        }}
      />,
    );
    expect(screen.getByTestId('template-pdf-add')).toHaveTextContent(E.addPdfTitle, {
      exact: false,
    });
    await fireEvent.press(screen.getByTestId('template-pdf-pick'));
    expect(await screen.findByTestId('template-pages')).toBeTruthy();
    expect(sent('/v1/commands/document_template.set_source')[0]).toMatchObject({ baseRevision: 1 });
    expect(toast.show).toHaveBeenCalledWith(E.pdfAdded(0, false));
  });

  it('is only looked at by someone who can’t change templates', async () => {
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />, SENDS);
    await layOut('editor-pages');
    expect(screen.queryByTestId('editor-bar')).toBeNull();
    expect(screen.queryByTestId('template-more')).toBeNull();
    expect(screen.queryByTestId('template-place-fields')).toBeNull();
    expect(screen.getByTestId('template-head')).toHaveTextContent(E.ownersChange, {
      exact: false,
    });
    // Ready, so it can still be sent.
    await fireEvent.press(screen.getByTestId('template-send'));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/documents/send?template=${TEMPLATE}`,
    );
  });

  it('renames it, makes a copy and archives it', async () => {
    answers = {
      '/v1/commands/document_template.rename': {},
      '/v1/commands/document_template.duplicate': { templateId: COPY },
      '/v1/commands/document_template.archive': {},
    };
    await wrap(<TemplateBody workspaceId={LONE_STAR} initial={GOT} />);
    await fireEvent.press(screen.getByTestId('template-more'));
    await fireEvent.press(screen.getByTestId('template-archive'));
    await waitFor(() => expect(screen.getByTestId('template-badge')).toHaveTextContent(W.archived));
    expect(toast.show).toHaveBeenCalledWith(E.archivedDone);
    // Archived, it's only looked at.
    expect(screen.queryByTestId('editor-bar')).toBeNull();

    await fireEvent.press(screen.getByTestId('template-more'));
    await fireEvent.press(screen.getByTestId('template-copy'));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        `/app/w/${LONE_STAR}/documents/templates/${COPY}`,
      ),
    );
    expect(sent('/v1/commands/document_template.duplicate')).toEqual([
      { workspaceId: LONE_STAR, templateId: TEMPLATE },
    ]);
  });
});

describe('one customer’s own words', () => {
  const PREFILL: DocumentPrefillOut = {
    templateId: TEMPLATE,
    name: 'Service agreement',
    definition: DEFINITION,
    presets: {},
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

  it('changes the words on their copy only, and sends them with it', async () => {
    answers = {
      '/v1/queries/document.prefill': PREFILL,
      '/v1/commands/document.send': {
        documentId: DOC,
        signers: [{ id: FILE, kind: 'signer' }],
      },
    };
    await wrap(
      <SendBody
        workspaceId={LONE_STAR}
        templates={[ROW]}
        members={[{ id: DALE, fullName: 'Dale Ramsey' }]}
        initialTemplate={TEMPLATE}
        initialAbout={{ kind: 'person', id: DANA, name: 'Dana Smith' }}
        fromDocumentId={null}
      />,
      SENDS,
    );
    const card = await screen.findByTestId('send-words-card');
    expect(card).toHaveTextContent(E.forOnly('Dana Smith'), { exact: false });
    await fireEvent.press(screen.getByTestId('send-words-open'));
    await layOut('editor-pages');
    // The fields stay where the template has them: only the words change.
    expect(screen.queryByTestId('editor-roles')).toBeNull();
    await fireEvent.press(screen.getByTestId('editor-add'));
    expect(screen.queryByTestId('tool-text')).toBeNull();
    await fireEvent.press(screen.getByTestId('tool-words'));
    await fireEvent.press(await screen.findByTestId('word-line'));
    await fireEvent.changeText(screen.getByTestId('edit-text'), 'Payment is due on arrival.');
    await fireEvent.press(screen.getByTestId('send-words-done'));
    expect(screen.getByTestId('send-words-card')).toHaveTextContent(E.changesSoFar(1), {
      exact: false,
    });

    await fireEvent.press(screen.getByTestId('send-submit'));
    await waitFor(() => expect(sent('/v1/commands/document.send')).toHaveLength(1));
    expect(sent('/v1/commands/document.send')[0]).toMatchObject({
      templateId: TEMPLATE,
      edits: [expect.objectContaining({ original: LINE.text, text: 'Payment is due on arrival.' })],
    });
    // The template itself isn't saved.
    expect(sent('/v1/commands/document_template.save')).toEqual([]);
  });
});

describe('a sent document’s pages', () => {
  it('shows what’s filled in on the worker’s pictures of its pages', async () => {
    answers['/v1/queries/document.get'] = {
      id: DOC,
      name: 'Service agreement',
      definition: DEFINITION,
      values: { f_name: { kind: 'text', text: 'Dana Smith' } },
      source: SOURCE,
    } as unknown as DocumentGetOut;
    await wrap(<DocumentPagesScreen documentId={DOC} />, SENDS);
    await waitFor(() => expect(screen.getByTestId('document-pages-view')).toBeTruthy());
    await layOut('document-pages-view');
    await waitFor(() =>
      expect(worker).toHaveBeenCalledWith('/v1/documents/pages', {
        workspaceId: LONE_STAR,
        documentId: DOC,
        from: 0,
        count: 4,
      }),
    );
    expect(screen.getByTestId('document-value')).toHaveTextContent('Dana Smith');
    expect(screen.getAllByTestId('document-field-empty')).toHaveLength(2);
  });
});
