import { formAnswersCsv } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as Sharing from 'expo-sharing';
import QRCode from 'qrcode';
import { crc32, inflateSync } from 'zlib';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Share } from 'react-native';

import FormAnswer from '@/app/app/w/[workspaceId]/forms/[formId]/answers/[responseId]';
import FormPage from '@/app/app/w/[workspaceId]/forms/[formId]';
import { change, ChangeError, NEEDS_SIGNAL } from '@/changes';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { QUIET, qrPath, qrPng } from '@/forms/qr';
import { deleteFormAnswer, forgetDeletedAnswers } from '@/forms/use-answers';
import type { PhoneForm } from '@/forms/use-forms';
import { answerWords, FORM_WORDS, formLink, responseLine } from '@/forms/words';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { setTestOffline } from '@/lib/network';

/**
 * A form on the phone (M17): who answered it and what they said, live from HandsFreeOS or saying it needs a signal;
 * the ones filled in on this phone counted until they arrive; and its public link, on the business's own domain once
 * that is serving, shown as a QR code to scan off the phone and handed to the phone's share sheet, and the QR code
 * saved as a picture.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(async () => ({ id: 'change-1', queued: false })),
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
/** What the stand-in file system holds, by address (jest.setup.ts). */
const savedFiles = (jest.requireMock('expo-file-system') as { __files: Map<string, unknown> })
  .__files;
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));
let mockForm: PhoneForm | null = null;
jest.mock('@/forms/use-forms', () => ({
  ...jest.requireActual<object>('@/forms/use-forms'),
  usePhoneForm: () => mockForm,
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARIA_SHEET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ANON_SHEET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MARIA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TZ = 'America/Chicago';

const business: Business = {
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: TZ,
};

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const QUOTE_FORM: PhoneForm = {
  id: QUOTE,
  name: 'Get a quote',
  mode: 'form',
  slug: 'quote',
  // The form's page doesn't read its questions: filling in is the fill screen's.
  definition: {} as PhoneForm['definition'],
};

const row = (over: Record<string, unknown> = {}) => ({
  responseId: MARIA_SHEET,
  formId: QUOTE,
  versionId: '99999999-9999-4999-8999-999999999999',
  status: 'completed',
  source: 'link',
  personId: MARIA,
  personName: 'Maria Lopez',
  leadId: null,
  scorePercent: null,
  passed: null,
  resultId: null,
  startedAt: '2026-09-17T15:00:00.000Z',
  completedAt: '2026-09-17T15:02:00.000Z',
  ...over,
});

const LIST = {
  items: [
    row(),
    row({
      responseId: ANON_SHEET,
      personId: null,
      personName: null,
      source: 'qr',
      completedAt: '2026-09-16T20:30:00.000Z',
    }),
  ],
  nextCursor: null,
};

const FULL = {
  response: row(),
  answers: [
    {
      questionId: 'q_aaaaaaaa',
      questionTitle: 'What needs doing?',
      questionType: 'choice',
      value: 'c_aaaaaaaa',
      text: 'AC repair',
      labels: ['AC repair'],
    },
    {
      questionId: 'q_bbbbbbbb',
      questionTitle: 'Anything else?',
      questionType: 'long_text',
      value: 'The upstairs unit rattles.',
      text: 'The upstairs unit rattles.',
      labels: [],
    },
  ],
  calculations: {},
};

/** What the API says, per path. A path given `null` fails instead, as no signal does. */
let answers: Record<string, unknown>;

const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

function mockApi() {
  post.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === undefined) return { data: {} };
    if (answer === null) throw new Error('No signal. Try again when you’re back online.');
    return { data: typeof answer === 'function' ? (answer as () => unknown)() : answer };
  });
}

async function show(element: React.ReactElement) {
  mockApi();
  await render(
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      {element}
    </BusinessProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  forgetDeletedAnswers();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  setTestOffline(false);
  mockParams = { workspaceId: LONE_STAR, formId: QUOTE };
  mockForm = QUOTE_FORM;
  answers = {
    '/v1/queries/form.response_list': LIST,
    '/v1/queries/form.response_get': FULL,
    '/v1/queries/booking_site.get': { site: { slug: 'lone-star-hvac' } },
    '/v1/queries/branded_domain.get': { domain: null },
  };
});

describe('the words', () => {
  it('says when an answer sheet came in, in the business’s time zone, and where from', () => {
    expect(responseLine(row(), TZ)).toBe('Thu, Sep 17 at 10:02 AM · from the link');
    expect(responseLine(row({ scorePercent: 80, passed: true, source: 'app' }), TZ)).toBe(
      'Thu, Sep 17 at 10:02 AM · 80% · passed · on the phone',
    );
    expect(responseLine(row({ completedAt: null, source: 'mystery' }), TZ)).toBe(
      'Not finished · started Thu, Sep 17 at 10:00 AM',
    );
  });

  it('puts an answer in words, and sends a file or a signature to the web', () => {
    const base = { questionType: 'short_text', value: null, text: null, labels: [] };
    expect(answerWords({ ...base, labels: ['Repair', 'Tune-up'] })).toBe('Repair, Tune-up');
    expect(answerWords({ ...base, text: 'Upstairs' })).toBe('Upstairs');
    expect(answerWords({ ...base, questionType: 'yes_no', value: false })).toBe('No');
    expect(answerWords({ ...base, questionType: 'number', value: 3 })).toBe('3');
    expect(answerWords({ ...base, questionType: 'signature', value: { id: 'x' } })).toBe(
      'Open it on the web to see this one.',
    );
    expect(answerWords(base)).toBe('No answer');
  });

  it('builds the link on the business’s own domain only once it is serving', () => {
    const web = 'https://app.handsfreeos.com';
    expect(formLink('lone-star-hvac', 'quote', null, web)).toBe(
      'https://app.handsfreeos.com/f/lone-star-hvac/quote',
    );
    const domain = { domain: 'book.lonestarhvac.com', status: 'verified', certificateReady: true };
    expect(formLink('lone-star-hvac', 'quote', domain, web)).toBe(
      'https://book.lonestarhvac.com/f/lone-star-hvac/quote',
    );
    expect(formLink('lone-star-hvac', 'quote', { ...domain, certificateReady: false }, web)).toBe(
      'https://app.handsfreeos.com/f/lone-star-hvac/quote',
    );
    expect(formLink(null, 'quote', null, web)).toBeNull();
  });
});

describe('a form’s answers', () => {
  it('lists who answered, newest first, and opens one', async () => {
    await show(<FormPage />);
    expect(await screen.findByText('Maria Lopez')).toBeTruthy();
    expect(screen.getByText(FORM_WORDS.anonymous)).toBeTruthy();
    expect(screen.getByText('Wed, Sep 16 at 3:30 PM · from the QR code')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/v1/queries/form.response_list', {
      body: { workspaceId: LONE_STAR, formId: QUOTE, includeUnfinished: false, limit: 25 },
    });
    await fireEvent.press(screen.getByTestId(`form-answer-${MARIA_SHEET}`));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/forms/${QUOTE}/answers/${MARIA_SHEET}`,
    );
  });

  it('opens filling it in from the form’s page', async () => {
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-fill'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/forms/${QUOTE}/fill`);
  });

  it('says so when nobody has answered yet', async () => {
    answers['/v1/queries/form.response_list'] = { items: [], nextCursor: null };
    await show(<FormPage />);
    expect(await screen.findByTestId('form-answers-none')).toBeTruthy();
  });

  it('asks for more when there are more', async () => {
    answers['/v1/queries/form.response_list'] = { items: [row()], nextCursor: 'next' };
    await show(<FormPage />);
    await screen.findByText('Maria Lopez');
    answers['/v1/queries/form.response_list'] = {
      items: [row({ responseId: ANON_SHEET, personName: 'Ray Ortiz' })],
      nextCursor: null,
    };
    await fireEvent.press(screen.getByTestId('form-answers-more'));
    expect(await screen.findByText('Ray Ortiz')).toBeTruthy();
    expect(post).toHaveBeenLastCalledWith('/v1/queries/form.response_list', {
      body: {
        workspaceId: LONE_STAR,
        formId: QUOTE,
        includeUnfinished: false,
        limit: 25,
        cursor: 'next',
      },
    });
    expect(screen.queryByTestId('form-answers-more')).toBeNull();
  });

  it('says it needs a signal, and shows the answers once signal is back', async () => {
    answers['/v1/queries/form.response_list'] = null;
    setTestOffline(true);
    await show(<FormPage />);
    await screen.findByTestId('form-answers-error');
    expect(screen.getByText(FORM_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/form.response_list'] = LIST;
    await act(async () => setTestOffline(false));
    expect(await screen.findByText('Maria Lopez')).toBeTruthy();
  });

  it('counts the ones filled in on this phone that haven’t arrived yet', async () => {
    const outbox = [
      { name: 'form_response.record', state: 'waiting', input: JSON.stringify({ formId: QUOTE }) },
      { name: 'form_response.record', state: 'held', input: JSON.stringify({ formId: QUOTE }) },
      {
        name: 'form_response.record',
        state: 'waiting',
        input: JSON.stringify({ formId: 'other' }),
      },
    ];
    (useQuery as jest.Mock).mockReturnValue({ data: outbox, isLoading: false, isFetching: false });
    await show(<FormPage />);
    expect(await screen.findByTestId('form-answers-waiting')).toHaveTextContent(
      '2 filled in on this phone are on their way. They show here once HandsFreeOS has them.',
    );
    (useQuery as jest.Mock).mockReturnValue({ data: [], isLoading: false, isFetching: false });
  });

  it('shows what one person said, with the question as it read, and opens them', async () => {
    mockParams = { workspaceId: LONE_STAR, formId: QUOTE, responseId: MARIA_SHEET };
    await show(<FormAnswer />);
    expect(await screen.findByText('What needs doing?')).toBeTruthy();
    expect(screen.getByText('AC repair')).toBeTruthy();
    expect(screen.getByText('The upstairs unit rattles.')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/v1/queries/form.response_get', {
      body: { workspaceId: LONE_STAR, responseId: MARIA_SHEET },
    });
    await fireEvent.press(screen.getByTestId('form-answer-person'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/customers/people/${MARIA}`);
  });

  it('says one answer sheet needs a signal too', async () => {
    mockParams = { workspaceId: LONE_STAR, formId: QUOTE, responseId: MARIA_SHEET };
    answers['/v1/queries/form.response_get'] = null;
    setTestOffline(true);
    await show(<FormAnswer />);
    expect(await screen.findByTestId('form-answer-error')).toBeTruthy();
    expect(screen.getByText(FORM_WORDS.needsSignal)).toBeTruthy();
  });
});

describe('deleting an answer sheet', () => {
  const changed = change as jest.Mock;

  beforeEach(() => {
    mockParams = { workspaceId: LONE_STAR, formId: QUOTE, responseId: MARIA_SHEET };
  });

  it('asks a second time, then deletes it straight out and goes back to the form', async () => {
    await show(<FormAnswer />);
    await fireEvent.press(await screen.findByTestId('form-answer-delete'));
    expect(screen.getByText(FORM_WORDS.deleteTitle)).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('form-answer-delete-confirm'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(changed).toHaveBeenCalledWith('form_response.delete', {
      workspaceId: LONE_STAR,
      responseId: MARIA_SHEET,
    });
    expect(toast.show).toHaveBeenCalledWith(FORM_WORDS.deleted);
  });

  it('leaves the deleted sheet out of the form’s list at once, before the list asks again', async () => {
    await deleteFormAnswer(LONE_STAR, ANON_SHEET);
    // The server still sends it on this answer (it hasn't caught up); the list leaves it out anyway.
    await show(<FormPage />);
    expect(await screen.findByText('Maria Lopez')).toBeTruthy();
    expect(screen.queryByTestId(`form-answer-${ANON_SHEET}`)).toBeNull();
  });

  it('keeps it when they say keep them', async () => {
    await show(<FormAnswer />);
    await fireEvent.press(await screen.findByTestId('form-answer-delete'));
    await fireEvent.press(screen.getByText(FORM_WORDS.keep));
    expect(changed).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it('says it needs signal and stays put when there is none', async () => {
    const Refusal = ChangeError as unknown as new (kind: string, message: string) => Error;
    changed.mockRejectedValueOnce(new Refusal('needs-signal', NEEDS_SIGNAL));
    await show(<FormAnswer />);
    await fireEvent.press(await screen.findByTestId('form-answer-delete'));
    await fireEvent.press(screen.getByTestId('form-answer-delete-confirm'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NEEDS_SIGNAL));
    expect(router.back).not.toHaveBeenCalled();
  });

  it('isn’t offered to somebody who can’t look after forms', async () => {
    // Their own access row on the phone (me_v1): a member, who may read answers but not delete them.
    (useQuery as jest.Mock).mockReturnValue({
      data: [{ role: 'member', permissions: null }],
      isLoading: false,
      isFetching: false,
    });
    await show(<FormAnswer />);
    expect(await screen.findByText('What needs doing?')).toBeTruthy();
    expect(screen.queryByTestId('form-answer-delete')).toBeNull();
    (useQuery as jest.Mock).mockReturnValue({ data: [], isLoading: false, isFetching: false });
  });
});

describe('exporting the answers', () => {
  const sheetRow = (id: string, over: Record<string, unknown> = {}) => ({
    responseId: id,
    personName: 'Maria Lopez',
    source: 'link',
    completedAt: '2026-09-17T15:02:00.000Z',
    scorePercent: null,
    passed: null,
    answers: { q_aaaaaaaa: 'AC repair', q_bbbbbbbb: 'The upstairs unit rattles, badly.' },
    ...over,
  });
  const columns = [
    { questionId: 'q_aaaaaaaa', title: 'What needs doing?' },
    { questionId: 'q_bbbbbbbb', title: 'Anything else?' },
  ];

  it('asks for every page, makes one spreadsheet and hands it to the share sheet', async () => {
    const pages = [
      { formName: 'Get a quote', columns, rows: [sheetRow(MARIA_SHEET)], nextCursor: 'p2' },
      {
        formName: 'Get a quote',
        columns,
        rows: [sheetRow(ANON_SHEET, { personName: null, source: 'qr', answers: {} })],
        nextCursor: null,
      },
    ];
    let asked = 0;
    answers['/v1/queries/form.response_export'] = () => pages[asked++];
    const shared = Sharing.shareAsync as jest.Mock;
    shared.mockClear();

    await show(<FormPage />);
    await fireEvent.press(await screen.findByTestId('form-answers-export'));
    await waitFor(() => expect(shared).toHaveBeenCalled());

    const exports = post.mock.calls.filter((c) => c[0] === '/v1/queries/form.response_export');
    expect(exports.map((c) => c[1].body)).toEqual([
      { workspaceId: LONE_STAR, formId: QUOTE, limit: 500 },
      { workspaceId: LONE_STAR, formId: QUOTE, limit: 500, cursor: 'p2' },
    ]);
    const [uri, options] = shared.mock.calls[0] as [string, Record<string, string>];
    expect(uri).toMatch(/^file:\/\/\/cache\/quote-answers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(options).toEqual({
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: FORM_WORDS.exportTitle,
    });
    expect(savedFiles.get(uri)).toBe(
      formAnswersCsv({ columns, rows: [...pages[0]!.rows, ...pages[1]!.rows] }, TZ),
    );
  });

  it('says it needs signal when there is none', async () => {
    answers['/v1/queries/form.response_export'] = null;
    await show(<FormPage />);
    await fireEvent.press(await screen.findByTestId('form-answers-export'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('No signal. Try again when you’re back online.'),
    );
  });

  it('isn’t offered to somebody who can’t look after forms', async () => {
    (useQuery as jest.Mock).mockImplementation((sql: string) =>
      sql.includes('workspace_access')
        ? { data: [{ role: 'member', permissions: null }], isLoading: false, isFetching: false }
        : { data: [], isLoading: false, isFetching: false },
    );
    await show(<FormPage />);
    expect(await screen.findByText('Maria Lopez')).toBeTruthy();
    expect(screen.queryByTestId('form-answers-export')).toBeNull();
    (useQuery as jest.Mock).mockImplementation(() => ({
      data: [],
      isLoading: false,
      isFetching: false,
    }));
  });
});

describe('sharing a form', () => {
  it('shows the link first, then hands it to the share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    answers['/v1/queries/branded_domain.get'] = {
      domain: { domain: 'book.lonestarhvac.com', status: 'verified', certificateReady: true },
    };
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-share'));
    const url = 'https://book.lonestarhvac.com/f/lone-star-hvac/quote';
    expect(await screen.findByTestId('form-link-url')).toHaveTextContent(url);
    expect(screen.getByTestId('form-link-qr')).toBeTruthy();
    expect(screen.getByLabelText('QR code for Get a quote')).toBeTruthy();
    expect(share).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('form-link-share'));
    expect(share).toHaveBeenCalledWith({ message: url, url });
  });

  it('uses HandsFreeOS’s own address when the domain can’t be read', async () => {
    answers['/v1/queries/branded_domain.get'] = null;
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-share'));
    expect(await screen.findByTestId('form-link-url')).toHaveTextContent(
      /\/f\/lone-star-hvac\/quote$/,
    );
  });

  it('says why there is no link when the business has no link name', async () => {
    answers['/v1/queries/booking_site.get'] = { site: null };
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-share'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(FORM_WORDS.noSite));
    expect(screen.queryByTestId('form-link-url')).toBeNull();
  });

  it('saves the QR code as a picture through the share sheet', async () => {
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-share'));
    await fireEvent.press(await screen.findByTestId('form-link-save-qr'));
    await waitFor(() =>
      expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/quote-qr.png', {
        mimeType: 'image/png',
        UTI: 'public.png',
        dialogTitle: 'Save the QR code',
      }),
    );
    const saved = savedFiles.get('file:///cache/quote-qr.png') as Uint8Array;
    expect(Array.from(saved.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(saved).toEqual(qrPng(screen.getByTestId('form-link-url').props.children as string));
  });

  it('says so when the phone can’t save or share a file', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    await show(<FormPage />);
    await fireEvent.press(screen.getByTestId('form-share'));
    await fireEvent.press(await screen.findByTestId('form-link-save-qr'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This phone can’t save or share files.'),
    );
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('says the link needs signal when there is none', async () => {
    setTestOffline(true);
    await show(<FormPage />);
    expect(screen.getByText(FORM_WORDS.shareNeedsSignal)).toBeTruthy();
  });
});

describe('the QR code', () => {
  /** Every dark square the path draws, read back off its `M x y h n v1 h-n z` runs. */
  function drawn(d: string): Set<string> {
    const squares = new Set<string>();
    for (const [, x, y, n] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g))
      for (let i = 0; i < Number(n); i++) squares.add(`${Number(x) + i},${y}`);
    return squares;
  }

  it('draws exactly the dark squares of the link’s code, and nothing else', () => {
    const url = 'https://book.lonestarhvac.com/f/lone-star-hvac/quote';
    const { size, data } = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    const dark = new Set<string>();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (data[y * size + x]) dark.add(`${x},${y}`);

    const code = qrPath(url);
    expect(code.size).toBe(size);
    expect(drawn(code.d)).toEqual(dark);
  });

  /** A PNG read back: its chunks with their checksums checked, and the one-bit pixels inflated. */
  function readPng(png: Uint8Array) {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: { type: string; data: Uint8Array }[] = [];
    for (let o = 8; o < png.length;) {
      const length = view.getUint32(o);
      const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
      const data = png.subarray(o + 8, o + 8 + length);
      const crc = view.getUint32(o + 8 + length);
      // zlib's own crc32 is what every PNG reader checks against.
      expect(crc).toBe(crc32(png.subarray(o + 4, o + 8 + length)));
      chunks.push({ type, data });
      o += 12 + length;
    }
    const header = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset);
    const width = header.getUint32(0);
    const pixels = inflateSync(
      Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)),
    );
    const stride = Math.ceil(width / 8) + 1;
    return {
      types: chunks.map((c) => c.type),
      width,
      height: header.getUint32(4),
      depth: chunks[0]!.data[8],
      colour: chunks[0]!.data[9],
      filters: new Set(Array.from({ length: width }, (_, y) => pixels[y * stride])),
      /** Whether the pixel at (x, y) is black. */
      black: (x: number, y: number) =>
        (pixels[y * stride + 1 + (x >> 3)]! & (0x80 >> (x & 7))) === 0,
    };
  }

  it('saves a picture of exactly the same code, sharp and big enough to print', () => {
    const url = 'https://book.lonestarhvac.com/f/lone-star-hvac/quote';
    const { size, data } = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    const png = readPng(qrPng(url));
    const box = size + QUIET * 2;
    const scale = png.width / box;

    expect(png.types).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(png.width).toBe(png.height);
    expect(Number.isInteger(scale)).toBe(true);
    expect(png.width).toBeGreaterThan(900);
    expect(png.width).toBeLessThanOrEqual(1024);
    expect([png.depth, png.colour]).toEqual([1, 0]);
    expect(png.filters).toEqual(new Set([0]));

    // Every pixel of every square, the quiet border included, is the colour its square should be.
    for (let py = 0; py < png.width; py++)
      for (let px = 0; px < png.width; px++) {
        const x = Math.floor(px / scale) - QUIET;
        const y = Math.floor(py / scale) - QUIET;
        const dark = x >= 0 && y >= 0 && x < size && y < size && Boolean(data[y * size + x]);
        if (png.black(px, py) !== dark) throw new Error(`pixel ${px},${py} is the wrong colour`);
      }
  });

  it('changes when the link does', () => {
    expect(qrPath('https://app.handsfreeos.com/f/a/quote').d).not.toBe(
      qrPath('https://app.handsfreeos.com/f/a/survey').d,
    );
  });
});
