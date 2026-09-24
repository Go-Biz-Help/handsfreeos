import { useQuery } from '@powersync/react-native';
import QRCode from 'qrcode';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Share } from 'react-native';

import FormAnswer from '@/app/app/w/[workspaceId]/forms/[formId]/answers/[responseId]';
import FormPage from '@/app/app/w/[workspaceId]/forms/[formId]';
import { qrPath } from '@/components/forms/qr-code';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import type { PhoneForm } from '@/forms/use-forms';
import { answerWords, FORM_WORDS, formLink, responseLine } from '@/forms/words';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { setTestOffline } from '@/lib/network';

/**
 * A form on the phone (M17): who answered it and what they said, live from HandsFreeOS or saying it needs a signal;
 * the ones filled in on this phone counted until they arrive; and its public link, on the business's own domain once
 * that is serving, shown as a QR code to scan off the phone and handed to the phone's share sheet.
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
    return { data: answer };
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

  it('changes when the link does', () => {
    expect(qrPath('https://app.handsfreeos.com/f/a/quote').d).not.toBe(
      qrPath('https://app.handsfreeos.com/f/a/survey').d,
    );
  });
});
