import {
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  type MainOfferScore,
  type ScoredPart,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';
import { Text } from 'react-native';

import { router } from 'expo-router';

import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';
import { workerPost } from '@/lib/worker';

import { EditPartScreen } from '../edit';
import { useMainOfferRow } from '../row';
import { MainOfferScreen } from '../screen';

/**
 * Settings → Main offer on the phone (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md, steps 2 and 3): the row in
 * Settings for anyone in a business that uses the offer, and the screen by state: the Review step for whoever can
 * change it, with Score, Make a try, Try N is ready, Go live, Use it anyway and Edit it myself; the live version for
 * everyone else; what isn't built here yet on the web; and needing signal.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn() }));
jest.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    rule: string | null;
    constructor(message: string, status: number, code: string, _how: null, rule: string | null) {
      super(message);
      this.status = status;
      this.code = code;
      this.rule = rule;
    }
  }
  return {
    ApiError: MockApiError,
    api: { POST: jest.fn() },
    errorMessage: (e: unknown) =>
      e instanceof Error ? e.message : 'Something went wrong. Try again.',
    unwrap: (result: { data?: unknown; error?: unknown }) => {
      if (result.error) throw new Error(String(result.error));
      return result.data;
    },
  };
});

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRY_ONE = '22222222-2222-4222-8222-222222222222';
const MANAGE = ['records.read', 'main_offer.manage', 'outreach.use'];
const READ = ['records.read', 'outreach.use'];

const business = (permissions: string[]): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: permissions.includes('main_offer.manage') ? 'owner' : 'member',
  timezone: 'America/Chicago',
  permissions,
});

const me = (permissions: string[]): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(permissions)],
  organizations: [],
  fetchedAt: 0,
});

const PARTS = {
  who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
  outcome: { result: '10 to 20 booked inspections a month' },
  timeframe: { typical: '60 days' },
  method: { steps: ['Find the homes', 'Run the ads', 'Book the calls'] },
  guarantee: { promise: 'If you don’t get 10 in 60 days, you don’t pay' },
  price: { amount: '$2,000 a month' },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month within 60 days.',
  inAFewWords: { outcome: '10 to 20 booked inspections', guarantee: 'you only pay for results' },
};

function scoreOf(each: number, low: Partial<Record<ScoredPart, number>> = {}): MainOfferScore {
  const part = (p: ScoredPart) => ({
    score: low[p] ?? each,
    why: `The ${p} line.`,
    good: [`The ${p} names something real.`],
    holding: [`The ${p} could say more.`],
    fix: `Sharpen the ${p}.`,
  });
  return {
    parts: {
      who: part('who'),
      outcome: part('outcome'),
      timeframe: part('timeframe'),
      method: part('method'),
      guarantee: part('guarantee'),
      price: part('price'),
    },
    weakest: 'who',
    fix: 'Pick one line of work.',
    flags: { vague: false, generic: true, hardToBelieve: false },
    threeSeconds: true,
  };
}

const LIVE = {
  version: 3,
  parts: PARTS,
  line: PARTS.line,
  score: scoreOf(8),
  anyway: null,
  publishedBy: { id: DALE, name: 'Dale Ramsey' },
  publishedAt: '2026-10-12T15:00:00.000Z',
};

const DRAFT = {
  parts: PARTS,
  by: { id: DALE, name: 'Dale Ramsey' },
  at: '2026-10-16T19:14:00.000Z',
  score: scoreOf(8, { who: 4, guarantee: 6 }),
  missing: [],
};

const offerWith = (over: Record<string, unknown> = {}) => ({
  inUse: true,
  comesWith: ['Social Outreach'],
  bar: 7,
  revision: 5,
  direction: 'Lead with the AI teammate.',
  names: ['Lone Star HVAC', 'Cool Breeze Air'],
  businessName: 'Lone Star HVAC',
  live: LIVE,
  draft: DRAFT,
  ...over,
});

const TRY = {
  id: TRY_ONE,
  number: 1,
  fromRevision: 4,
  base: PARTS,
  parts: PARTS,
  why: { who: null, outcome: null, timeframe: null, method: null, guarantee: null, price: null },
  score: scoreOf(8),
  lowest: 8,
  direction: 'Lead with the AI teammate.',
  notes: { who: 'Broad on purpose.' },
  keep: ['method'],
  madeBy: { id: DALE, name: 'Dale Ramsey' },
  madeAt: '2026-10-16T19:00:00.000Z',
};

/** What the API says, per path; `null` fails, as no signal does. */
let answers: Record<string, unknown>;

const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

/** The worker's answers, per route; an Error is thrown instead. */
let worker: Record<string, unknown>;
const askedWorker = (path: string) =>
  (workerPost as jest.Mock).mock.calls.filter((call) => call[0] === path).map((call) => call[1]);

function Provider({ permissions, children }: { permissions: string[]; children: React.ReactNode }) {
  return (
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(permissions),
        business: business(permissions),
        openSwitcher: () => undefined,
      }}
    >
      {children}
    </BusinessProvider>
  );
}

async function show(permissions = MANAGE) {
  await render(
    <Provider permissions={permissions}>
      <MainOfferScreen />
    </Provider>,
  );
  await waitFor(() => expect(sent('/v1/queries/main_offer.get').length).toBeGreaterThan(0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  worker = {};
  (workerPost as jest.Mock).mockImplementation(async (path: string) => {
    const answer = worker[path];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  answers = {
    '/v1/queries/main_offer.get': offerWith(),
    '/v1/queries/main_offer.tries': { round: 3, tries: [] },
  };
  post.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === null) throw new Error(PW.needsSignal);
    return { data: answer ?? {} };
  });
});

describe('Review your draft', () => {
  it('shows the score at a glance, and opens the parts under the bar', async () => {
    await show();
    expect(await screen.findByTestId('offer-score-title')).toHaveTextContent(
      'Under 7: who and guarantee',
    );
    expect(screen.getByTestId('main-offer-draft')).toHaveTextContent(W.draftBy('Dale Ramsey'), {
      exact: false,
    });
    expect(screen.getByTestId('offer-line')).toHaveTextContent(PARTS.line);
    // Under the bar, open: what's working, what's holding it back, and the AI's fix.
    const who = screen.getByTestId('offer-part-who');
    expect(within(who).getByText('The who names something real.')).toBeTruthy();
    expect(within(who).getByText('The who could say more.')).toBeTruthy();
    expect(within(who).getByText(/Sharpen the who\./)).toBeTruthy();
    // Over it, closed until tapped.
    const price = screen.getByTestId('offer-part-price');
    expect(within(price).queryByText(/Sharpen the price\./)).toBeNull();
    await fireEvent.press(screen.getByTestId('offer-part-price-toggle'));
    expect(
      within(screen.getByTestId('offer-part-price')).getByText(/Sharpen the price\./),
    ).toBeTruthy();
    // Under the bar and complete: Use it anyway, or make a try.
    expect(screen.getByTestId('offer-use-anyway')).toBeTruthy();
    expect(within(screen.getByTestId('offer-footer')).getByText(TW.makeTry('Try 1'))).toBeTruthy();
  });

  it('takes a note, a quick pick and Keep, and lists what goes into the next try', async () => {
    await show();
    await screen.findByTestId('offer-parts');
    await fireEvent.changeText(screen.getByTestId('offer-part-who-note'), 'Broad on purpose.');
    await fireEvent.press(screen.getByTestId('offer-part-who-pick-1'));
    expect(screen.getByTestId('offer-part-who-note')).toHaveProp(
      'value',
      'Broad on purpose. This undersells what it really does.',
    );
    await fireEvent.press(screen.getByTestId('offer-part-guarantee-keep'));
    const going = screen.getByTestId('offer-going-into');
    expect(within(going).getByText('Your direction')).toBeTruthy();
    expect(within(going).getByText('Your note on who')).toBeTruthy();
    expect(within(going).getByText('Guarantee kept as is')).toBeTruthy();
    expect(within(screen.getByTestId('offer-part-guarantee')).getByText(TW.keptAsIs)).toBeTruthy();
    // The direction's quick picks add their line to it.
    await fireEvent.press(screen.getByTestId('offer-direction-pick-0'));
    expect(screen.getByTestId('offer-direction')).toHaveProp(
      'value',
      'Lead with the AI teammate. It’s more than it sounds like at first. Say what makes it different.',
    );
  });

  it('starts the notes and kept parts from the latest try’s, and names the next one', async () => {
    answers['/v1/queries/main_offer.tries'] = { round: 3, tries: [TRY] };
    await show();
    await screen.findByTestId('offer-parts');
    expect(screen.getByTestId('offer-part-who-note')).toHaveProp('value', 'Broad on purpose.');
    expect(
      within(screen.getByTestId('offer-going-into')).getByText('Method kept as is'),
    ).toBeTruthy();
    expect(screen.getByTestId('offer-make-try')).toHaveTextContent(TW.makeTry('Try 2'));
  });

  it('reviews the live version when there’s no draft, and can only try it again', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ draft: null });
    await show();
    expect(await screen.findByTestId('main-offer-live-only')).toHaveTextContent(PW.liveOnly(3));
    expect(screen.getByTestId('offer-score-title')).toHaveTextContent(
      'Every part scores 7 or more',
    );
    const footer = screen.getByTestId('offer-footer');
    expect(within(footer).getByText(TW.makeTry('Try 1'))).toBeTruthy();
    expect(within(footer).queryByText(W.goLive)).toBeNull();
  });

  it('says what a draft still needs, and opens the builder’s step for it on the web', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({
      draft: {
        ...DRAFT,
        score: null,
        missing: [
          { path: 'inAFewWords.outcome', label: 'The outcome in a few words, for messages' },
        ],
      },
    });
    await show();
    expect(await screen.findByTestId('offer-not-scored')).toHaveTextContent(TW.notScored, {
      exact: false,
    });
    await fireEvent.press(screen.getByText('The outcome in a few words, for messages'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/main-offer/build?step=line`);
  });
});

describe('everyone else, and what isn’t here', () => {
  it('lets a member read the live version, and change nothing', async () => {
    await show(READ);
    const partly = { exact: false } as const;
    expect(await screen.findByTestId('main-offer-live')).toHaveTextContent(PARTS.line, partly);
    expect(screen.getByTestId('main-offer-direction')).toHaveTextContent(
      'Lead with the AI teammate.',
      partly,
    );
    expect(screen.getByTestId('main-offer-draft')).toHaveTextContent(
      W.draftBy('Dale Ramsey'),
      partly,
    );
    // The names the business goes by, which the web changes (decision 84 in docs/outreach.md).
    expect(screen.getByTestId('main-offer-names')).toHaveTextContent(
      'Lone Star HVAC · Cool Breeze Air',
      partly,
    );
    expect(screen.queryByTestId('offer-footer')).toBeNull();
    expect(screen.queryByTestId('offer-part-who-note')).toBeNull();
    // A member never asks for the tries.
    expect(sent('/v1/queries/main_offer.tries')).toHaveLength(0);
  });

  it('sends an owner to the web to build a first offer', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ live: null, draft: null, direction: null });
    await show();
    await fireEvent.press(await screen.findByTestId('main-offer-open-web'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/main-offer/build`);
  });

  it('asks a member to ask an owner when nothing is built', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ live: null, draft: null });
    await show(READ);
    expect(await screen.findByTestId('main-offer-ask-owner')).toHaveTextContent(W.askOwner);
  });

  it('says which add-on brings it when none that uses it is on', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ inUse: false });
    await show();
    expect(await screen.findByTestId('main-offer-not-in-use')).toHaveTextContent(
      PW.notInUse('Social Outreach'),
    );
  });

  it('says it needs signal, and asks again on Try again', async () => {
    answers['/v1/queries/main_offer.get'] = null;
    await show();
    expect(await screen.findByTestId('main-offer-trouble')).toHaveTextContent(PW.needsSignal, {
      exact: false,
    });
    answers['/v1/queries/main_offer.get'] = offerWith();
    await fireEvent.press(screen.getByText(PW.tryAgain));
    expect(await screen.findByTestId('offer-score-title')).toBeTruthy();
  });
});

describe('Settings’ Main offer row', () => {
  function Row() {
    const row = useMainOfferRow(LONE_STAR);
    return row.here ? <Text testID="row">{row.line}</Text> : null;
  }

  it('shows for anyone using an add-on that uses the offer, with how it’s doing', async () => {
    await render(
      <Provider permissions={READ}>
        <Row />
      </Provider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('row')).toHaveTextContent(
        'Version 3 is live · your draft is under 7 on the who and the guarantee',
      ),
    );
  });

  it('hides for someone with no add-on that uses it, and asks nothing', async () => {
    await render(
      <Provider permissions={['records.read', 'main_offer.manage']}>
        <Row />
      </Provider>,
    );
    expect(screen.queryByTestId('row')).toBeNull();
    expect(sent('/v1/queries/main_offer.get')).toHaveLength(0);
  });
});

describe('the Review’s actions', () => {
  it('scores the draft, saving the direction first when it changed', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ draft: { ...DRAFT, score: null } });
    answers['/v1/commands/main_offer.save_direction'] = { revision: 6 };
    worker['/v1/main-offer/score'] = { saved: true, score: scoreOf(8) };
    await show();
    await fireEvent.changeText(await screen.findByTestId('offer-direction'), 'Lead with the AI.');
    await fireEvent.press(screen.getByTestId('offer-score-it'));
    await waitFor(() =>
      expect(askedWorker('/v1/main-offer/score')).toEqual([
        { workspaceId: LONE_STAR, revision: 6 },
      ]),
    );
    expect(sent('/v1/commands/main_offer.save_direction')[0]![1].body).toEqual({
      workspaceId: LONE_STAR,
      revision: 5,
      direction: 'Lead with the AI.',
    });
    // The offer is asked again, to show the new score.
    await waitFor(() => expect(sent('/v1/queries/main_offer.get')).toHaveLength(2));
  });

  it('makes a try from the notes and kept parts, then shows how it scored and opens it on the web', async () => {
    worker['/v1/main-offer/try'] = {
      saved: true,
      try: { ...TRY, notes: { who: 'Broad on purpose.' }, keep: ['guarantee'] },
    };
    await show();
    await fireEvent.changeText(
      await screen.findByTestId('offer-part-who-note'),
      'Broad on purpose.',
    );
    await fireEvent.press(screen.getByTestId('offer-part-guarantee-keep'));
    await fireEvent.press(screen.getByTestId('offer-make-try-foot'));
    expect(await screen.findByTestId('try-ready')).toBeTruthy();
    expect(askedWorker('/v1/main-offer/try')).toEqual([
      {
        workspaceId: LONE_STAR,
        revision: 5,
        notes: { who: 'Broad on purpose.' },
        keep: ['guarantee'],
      },
    ]);
    // The who went from the draft's 4 to the try's 8; the guarantee was kept as is.
    expect(screen.getByLabelText(PW.scoreFromTo('Who', 4, 8))).toBeTruthy();
    expect(within(screen.getByTestId('try-ready-guarantee')).getByText(TW.keptAsIs)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('try-ready-compare'));
    expect(openWeb).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/main-offer/build?step=score&try=${TRY_ONE}`,
    );
    await fireEvent.press(screen.getByTestId('try-ready-back'));
    expect(await screen.findByTestId('offer-parts')).toBeTruthy();
  });

  it('keeps the live version as the draft first, when there’s none to try from', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ draft: null });
    answers['/v1/commands/main_offer.save_draft'] = { revision: 6 };
    worker['/v1/main-offer/try'] = { saved: true, try: TRY };
    await show();
    await fireEvent.press(await screen.findByTestId('offer-make-try-foot'));
    await screen.findByTestId('try-ready');
    expect(sent('/v1/commands/main_offer.save_draft')[0]![1].body).toMatchObject({
      workspaceId: LONE_STAR,
      revision: 5,
      parts: expect.objectContaining({ line: PARTS.line }),
    });
    expect(askedWorker('/v1/main-offer/try')[0]).toMatchObject({ revision: 6 });
  });

  it('asks for the offer again when someone else changed the draft meanwhile', async () => {
    worker['/v1/main-offer/try'] = new (ApiError as unknown as new (...a: unknown[]) => Error)(
      'Someone changed your offer’s draft in the meantime.',
      409,
      'conflict',
      null,
      'main_offer_draft_moved',
    );
    await show();
    await fireEvent.press(await screen.findByTestId('offer-make-try-foot'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Someone changed your offer’s draft in the meantime.',
      ),
    );
    await waitFor(() => expect(sent('/v1/queries/main_offer.get')).toHaveLength(2));
  });

  it('puts a draft that clears the bar live', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({ draft: { ...DRAFT, score: scoreOf(8) } });
    answers['/v1/commands/main_offer.publish'] = { version: 4 };
    await show();
    await fireEvent.press(await screen.findByTestId('offer-go-live'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(sent('/v1/commands/main_offer.publish')[0]![1].body).toEqual({
      workspaceId: LONE_STAR,
      revision: 5,
    });
    expect(toast.show).toHaveBeenCalledWith(W.live(4));
  });

  it('puts one under the bar live only with a reason', async () => {
    answers['/v1/commands/main_offer.publish'] = { version: 4 };
    await show();
    await fireEvent.press(await screen.findByTestId('offer-use-anyway'));
    expect(screen.getByText(W.anywayScored('Who', 4))).toBeTruthy();
    expect(screen.getByTestId('offer-anyway-go')).toBeDisabled();
    await fireEvent.changeText(
      screen.getByTestId('offer-anyway-why'),
      'Testing it with past customers',
    );
    await fireEvent.press(screen.getByTestId('offer-anyway-go'));
    await waitFor(() =>
      expect(sent('/v1/commands/main_offer.publish')[0]![1].body).toEqual({
        workspaceId: LONE_STAR,
        revision: 5,
        anyway: 'Testing it with past customers',
      }),
    );
  });

  it('opens Edit it myself for a part, and for what a draft is missing in one', async () => {
    answers['/v1/queries/main_offer.get'] = offerWith({
      draft: {
        ...DRAFT,
        missing: [{ path: 'guarantee.promise', label: 'Guarantee: what you promise' }],
      },
    });
    await show();
    await fireEvent.press(await screen.findByText('Guarantee: what you promise'));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${LONE_STAR}/settings/main-offer-part?part=guarantee`,
    );
    await fireEvent.press(screen.getByTestId('offer-part-who-edit'));
    expect(router.push).toHaveBeenLastCalledWith(
      `/app/w/${LONE_STAR}/settings/main-offer-part?part=who`,
    );
  });
});

describe('Edit it myself', () => {
  async function edit(part: string) {
    mockParams = { part };
    answers['/v1/commands/main_offer.save_draft'] = { revision: 6 };
    await render(
      <Provider permissions={MANAGE}>
        <EditPartScreen />
      </Provider>,
    );
  }

  it('saves a part’s boxes to the draft, with the AI’s fix above them', async () => {
    await edit('guarantee');
    const promise = await screen.findByTestId('main-offer-box-guarantee.promise');
    expect(promise).toHaveProp('value', PARTS.guarantee.promise);
    expect(screen.getByText(/Sharpen the guarantee\./)).toBeTruthy();
    await fireEvent.changeText(promise, 'Ten inspections in 60 days, or that month is free.');
    await fireEvent.press(screen.getByTestId('main-offer-part-save'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    const body = sent('/v1/commands/main_offer.save_draft')[0]![1].body as {
      revision: number;
      parts: typeof PARTS;
    };
    expect(body.revision).toBe(5);
    expect(body.parts.guarantee.promise).toBe('Ten inspections in 60 days, or that month is free.');
    expect(body.parts.who).toEqual(PARTS.who);
  });

  it('changes each method step’s words, and leaves adding steps to the web', async () => {
    await edit('method');
    const second = await screen.findByTestId('main-offer-part-step-1');
    expect(screen.getByText(PW.stepsOnWeb)).toBeTruthy();
    await fireEvent.changeText(second, 'Run the ads that bring calls');
    await fireEvent.press(screen.getByTestId('main-offer-part-save'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    const body = sent('/v1/commands/main_offer.save_draft')[0]![1].body as { parts: typeof PARTS };
    expect(body.parts.method.steps).toEqual([
      'Find the homes',
      'Run the ads that bring calls',
      'Book the calls',
    ]);
  });
});
