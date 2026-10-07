import {
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_WORDS,
  AiSetupGetOutput,
  aiSetupStateOf,
  aiSetupTemplateAbout,
  emptyKnowledgeProfile,
  setupKindOf,
  startingAiSetupAnswers,
  teammateConfigFromPreset,
  withAiName,
  type AiSetupAnswers,
  type AiSetupStateOut,
  type AiSetupStep,
  type AiSetupTemplate,
  type TestConsoleBody,
  type TestEvent,
} from '@hfos/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import type * as TestStream from '@/ai-team/test-stream';
import AiSetup from '@/app/app/w/[workspaceId]/ai-setup';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';
import { pushRegistration } from '@/push/device';

/**
 * Quick setup for the AI teammate on the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), with HandsFreeOS
 * and the worker's test chat played by stand-ins: the first screen keeps the business at once; the kind of business
 * comes from a searchable sheet; the hours editor; qualifying questions; carrying on what was started on the
 * computer, Save and the test chat with "Add the answer", then turning it on; what will change for a business that
 * has a teammate; starting from answers the agency saved; and no signal, and someone who can't run it.
 */

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
}));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
let mockPermission: 'granted' | 'denied' | 'undetermined' | null = 'undetermined';
jest.mock('@/push/hooks', () => ({
  usePushRegistration: () => ({ permission: mockPermission, canAskAgain: true }),
}));
jest.mock('@/push/device', () => ({
  pushRegistration: { ask: jest.fn(async () => 'granted') },
}));
const mockAnswer = jest.fn<readonly TestEvent[], [TestConsoleBody]>();
const mockAsked: string[] = [];
jest.mock('@/ai-team/test-stream', () => {
  const actual = jest.requireActual<object>('@/ai-team/test-stream');
  return {
    ...actual,
    streamTest: async (body: TestConsoleBody, onEvent: (e: TestEvent) => void) => {
      mockAsked.push(body.messages?.[0]?.text ?? '');
      for (const e of mockAnswer(body)) onEvent(e);
    },
  };
});
let mockParams: Record<string, string> = {};

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAMMATE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Lone Star as quick setup finds it: an HVAC business with no website and no teammate yet. */
const STATE: AiSetupStateOut = {
  businessName: 'Lone Star HVAC & Roofing',
  industry: 'hvac',
  kind: setupKindOf('hvac'),
  goal: null,
  website: null,
  page: null,
  timeZone: 'America/Chicago',
  openHours: null,
  teammate: null,
  profile: emptyKnowledgeProfile(),
  facts: [],
  services: [],
  calendars: [],
  territories: 0,
  emailAddress: null,
  chat: null,
  number: true,
  textingReady: true,
  scan: { state: 'none', pending: 0 },
  found: null,
  reading: false,
};

/** The same business once Save has set up Ava, off. */
const WITH_AVA: AiSetupStateOut = {
  ...STATE,
  teammate: {
    id: TEAMMATE,
    name: 'Ava',
    status: 'off',
    revision: 1,
    config: teammateConfigFromPreset('blank', { industry: 'hvac' }) as unknown as Record<
      string,
      unknown
    >,
  },
};

/** What `ai_setup.get` says: where it stands, the answers, and how far it got. */
function gotOf(
  state: AiSetupStateOut,
  extra: { reached?: AiSetupStep | null; answers?: Partial<AiSetupAnswers> } = {},
) {
  const starting = startingAiSetupAnswers(aiSetupStateOf(state));
  return AiSetupGetOutput.parse({
    state,
    answers: { ...starting, ...extra.answers },
    starting,
    reached: extra.reached ?? null,
    started: null,
    finished: null,
    runs: 0,
  });
}

const PLUMBERS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
/** Answers Lone Star's agency saved from another of its businesses: Max, professional, asks qualifying questions. */
const PLUMBERS_ANSWERS: Partial<AiSetupTemplate> = {
  name: 'Max',
  jobs: ['reply', 'answer', 'qualify', 'follow_up'],
  tone: 'professional',
};

/**
 * What `ai_setup.get` says for a business whose agency saved answers: the screens start from them, or from our picks
 * (null); `picked`, whether someone picked on the first screen.
 */
function gotWithSaved(
  templateId: string | null,
  picked: boolean,
  reached: AiSetupStep | null = null,
) {
  const starting = startingAiSetupAnswers(
    aiSetupStateOf(STATE),
    templateId ? PLUMBERS_ANSWERS : null,
  );
  return AiSetupGetOutput.parse({
    state: STATE,
    answers: starting,
    starting,
    reached,
    started: null,
    finished: null,
    runs: 0,
    templates: [
      {
        id: PLUMBERS,
        name: 'Plumbers',
        kind: STATE.kind,
        about: aiSetupTemplateAbout(PLUMBERS_ANSWERS),
        updatedAt: '2026-10-01T12:00:00.000Z',
      },
    ],
    templateId,
    templatePicked: picked,
  });
}

/** Answers already given on the computer: enough for every screen before "Stay in the loop". */
const GIVEN: Partial<AiSetupAnswers> = {
  description: 'We fix and replace heating and air conditioning in Austin.',
  services: [{ name: 'AC repair', description: '' }],
  area: 'Austin',
};

class Refusal {
  constructor(
    readonly status: number,
    readonly error: { code: string; message: string; rule?: string; details?: unknown },
  ) {}
}

let answers: Record<string, unknown>;
const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;
const sent = (path: string) => post.mock.calls.filter((c) => c[0] === path).map((c) => c[1].body);

function serve() {
  post.mockImplementation(async (path, { body }) => {
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer;
    if (value instanceof Refusal)
      return {
        error: { error: value.error },
        response: new Response(null, { status: value.status }),
      };
    return { data: value ?? {}, response: new Response(null, { status: 200 }) };
  });
}

/** `ai_setup.save` as HandsFreeOS answers it: the screen just finished is the furthest. */
const saved = (body: unknown) => ({
  workspaceId: LONE_STAR,
  reached: (body as { step: AiSetupStep }).step,
  kind: STATE.kind,
  kindChanged: false,
  scanStarted: false,
});

async function open(role: Business['role'] = 'owner', permissions?: string[]) {
  const business: Business = {
    id: LONE_STAR,
    name: 'Lone Star HVAC & Roofing',
    organizationId: 'org',
    organizationName: 'Lone Star HVAC & Roofing',
    role,
    timezone: 'America/Chicago',
    ...(permissions ? { permissions } : {}),
  };
  const me: Me = {
    user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
    businesses: [business],
    organizations: [],
    fetchedAt: 0,
  };
  const wrap = (node: React.ReactNode) => (
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      {node}
    </BusinessProvider>
  );
  const view = await render(wrap(<AiSetup />));
  return { rerender: () => view.rerender(wrap(<AiSetup />)) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOnline = true;
  mockPermission = 'undetermined';
  mockParams = {};
  mockAsked.length = 0;
  answers = {
    '/v1/queries/ai_setup.get': gotOf(STATE),
    '/v1/queries/knowledge_scan.get': { scan: null },
    '/v1/commands/ai_setup.save': saved,
  };
  serve();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
});

describe('the first screen', () => {
  it('keeps the business at once, from the kind of business picked on a sheet', async () => {
    await open();
    await screen.findByTestId('ai-setup-step-business');
    // Ten screens: with no website there's no website chat, and an HVAC business isn't asked qualifying questions
    // until it ticks them.
    expect(screen.getByText(AI_SETUP_WORDS.position(1, 10))).toBeTruthy();
    expect(screen.getByTestId('ai-setup-business-name')).toHaveDisplayValue(
      'Lone Star HVAC & Roofing',
    );
    expect(screen.getByTestId('ai-setup-kind')).toHaveTextContent('HVAC');
    // No name: the screen says so, and nothing is kept.
    await fireEvent.changeText(screen.getByTestId('ai-setup-business-name'), ' ');
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    expect(screen.getByText(W.businessNameMissing)).toBeTruthy();
    expect(sent('/v1/commands/ai_setup.save')).toEqual([]);
    await fireEvent.changeText(screen.getByTestId('ai-setup-business-name'), 'Lone Star Plumbing');
    expect(screen.queryByText(W.businessNameMissing)).toBeNull();

    // The kind of business, found by what someone calls it.
    await fireEvent.press(screen.getByTestId('ai-setup-kind'));
    await fireEvent.changeText(await screen.findByTestId('ai-setup-kind-search'), 'plumber');
    const list = screen.getByTestId('ai-setup-kind-list');
    expect(within(list).getByTestId('ai-setup-kind-plumbing')).toBeTruthy();
    // Other is always there, last.
    expect(within(list).getByTestId('ai-setup-kind-other')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('ai-setup-kind-search'), 'zzzz');
    expect(screen.getByText(P.noKindFits)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('ai-setup-kind-search'), 'plumber');
    await fireEvent.press(screen.getByTestId('ai-setup-kind-plumbing'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-kind')).toHaveTextContent('Plumbing'));

    // No website: the screens ask instead.
    expect(screen.getByText(withAiName(W.websiteHint, 'Ava'))).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-setup-no-website'));
    expect(screen.getByText(withAiName(W.noWebsiteHint, 'Ava'))).toBeTruthy();
    expect(screen.getByTestId('ai-setup-website-input')).toHaveProp('editable', false);

    answers['/v1/queries/ai_setup.get'] = gotOf(
      { ...STATE, businessName: 'Lone Star Plumbing', industry: 'plumbing' },
      { reached: 'business' },
    );
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-jobs');
    expect(sent('/v1/commands/ai_setup.save')).toEqual([
      expect.objectContaining({
        workspaceId: LONE_STAR,
        step: 'business',
        business: { name: 'Lone Star Plumbing', industry: 'plumbing', website: null },
      }),
    ]);
    expect(screen.getByTestId('ai-setup-summary')).toHaveTextContent(
      withAiName(AI_SETUP_WORDS.summary, 'Ava'),
      { exact: false },
    );
    // Back to the first screen, and "Set it up myself" opens the presets on the web.
    await fireEvent.press(screen.getByTestId('ai-setup-back'));
    await screen.findByTestId('ai-setup-step-business');
    await fireEvent.press(screen.getByTestId('ai-setup-myself'));
    expect(openWeb).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ai-team?myself=1`);
    // Its agency saved no answers, so there's nothing to start from.
    expect(screen.queryByTestId('ai-setup-start-picks')).toBeNull();
  });

  it('starts from answers the agency saved, or from our picks', async () => {
    answers['/v1/queries/ai_setup.get'] = gotWithSaved(PLUMBERS, false);
    await open();
    await screen.findByTestId('ai-setup-step-business');
    // While nobody picks: the newest saved for its kind of business.
    const saved = screen.getByTestId(`ai-setup-start-${PLUMBERS}`);
    const picks = screen.getByTestId('ai-setup-start-picks');
    expect(saved).toBeChecked();
    expect(saved).toHaveTextContent(
      'Max · Professional · Replies to new leads, answers questions, asks qualifying questions, follows up',
      { exact: false },
    );
    expect(picks).not.toBeChecked();
    expect(screen.getByTestId('ai-setup-summary')).toHaveTextContent(
      'Max replies to new leads within a minute.',
      { exact: false },
    );
    // It follows the kind of business: the agency saved nothing for dentists.
    await fireEvent.press(screen.getByTestId('ai-setup-kind'));
    await fireEvent.changeText(await screen.findByTestId('ai-setup-kind-search'), 'dentist');
    await fireEvent.press(screen.getByTestId('ai-setup-kind-dental'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-start-picks')).toBeChecked());
    await fireEvent.press(screen.getByTestId('ai-setup-kind'));
    await fireEvent.changeText(await screen.findByTestId('ai-setup-kind-search'), 'hvac');
    await fireEvent.press(screen.getByTestId('ai-setup-kind-hvac'));
    await waitFor(() => expect(screen.getByTestId(`ai-setup-start-${PLUMBERS}`)).toBeChecked());

    // Our picks instead: kept from the first screen, which picks those answers again.
    await fireEvent.press(screen.getByTestId('ai-setup-start-picks'));
    expect(screen.getByTestId('ai-setup-start-picks')).toBeChecked();
    expect(screen.getByTestId(`ai-setup-start-${PLUMBERS}`)).not.toBeChecked();
    answers['/v1/queries/ai_setup.get'] = gotWithSaved(null, true, 'business');
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-jobs');
    expect(sent('/v1/commands/ai_setup.save')).toEqual([
      expect.objectContaining({ step: 'business', templateId: null }),
    ]);
    expect(screen.getByTestId('ai-setup-job-qualify')).not.toBeChecked();
    expect(screen.getByTestId('ai-setup-summary')).toHaveTextContent(
      'Ava replies to new leads within a minute.',
      { exact: false },
    );

    // Back on the first screen it stays picked, and Next keeps it as it is.
    await fireEvent.press(screen.getByTestId('ai-setup-back'));
    await screen.findByTestId('ai-setup-step-business');
    expect(screen.getByTestId('ai-setup-start-picks')).toBeChecked();
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-jobs');
    expect(sent('/v1/commands/ai_setup.save')[1]).not.toHaveProperty('templateId');
  });
});

describe('the screens in between', () => {
  it('edits the open hours a day at a time, and says when they overlap', async () => {
    answers['/v1/queries/ai_setup.get'] = gotOf(STATE, { reached: 'about', answers: GIVEN });
    await open();
    await screen.findByTestId('ai-setup-step-hours');
    // Started on the computer: carry on, or start over.
    expect(screen.getByTestId('ai-setup-carry-on')).toHaveTextContent(AI_SETUP_WORDS.carryOn, {
      exact: false,
    });
    const saturday = screen.getByTestId('ai-setup-open-day-sat');
    expect(saturday).toHaveTextContent(P.closed, { exact: false });

    // Saturday on, open till midnight.
    await fireEvent(screen.getByTestId('ai-setup-open-day-sat-switch'), 'press');
    expect(screen.getByTestId('ai-setup-open-sat-0-start')).toHaveTextContent('9:00 AM');
    await fireEvent.press(screen.getByTestId('ai-setup-open-sat-0-end'));
    await fireEvent.press(await screen.findByTestId('ai-setup-open-time-sheet-1440'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-setup-open-sat-0-end')).toHaveTextContent(P.midnight),
    );

    // A second stretch on Monday, moved so it overlaps the first.
    await fireEvent.press(screen.getByTestId('ai-setup-open-mon-add'));
    expect(screen.getByTestId('ai-setup-open-mon-1-start')).toHaveTextContent('6:00 PM');
    await fireEvent.press(screen.getByTestId('ai-setup-open-mon-1-start'));
    await fireEvent.press(await screen.findByTestId('ai-setup-open-time-sheet-960'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-setup-open-day-mon')).toHaveTextContent(
        'These hours overlap.',
        { exact: false },
      ),
    );
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    expect(sent('/v1/commands/ai_setup.save')).toEqual([]);
    await fireEvent.press(screen.getByTestId('ai-setup-open-mon-1-remove'));
    expect(screen.queryByText('These hours overlap.')).toBeNull();

    // Only at set times: the hours Ava answers.
    await fireEvent.press(screen.getByTestId('ai-setup-answer-custom'));
    expect(screen.getByTestId('ai-setup-custom-editor')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-facts');
    const [kept] = sent('/v1/commands/ai_setup.save') as { answers: AiSetupAnswers }[];
    expect(kept!.answers.openHours).toEqual(
      expect.arrayContaining([{ day: 6, start: '09:00', end: '24:00' }]),
    );
    expect(kept!.answers.openHours.filter((h) => h.day === 1)).toHaveLength(1);
    expect(kept!.answers.answerWhen).toBe('custom');
  });

  it('asks leads the qualifying questions, choices as typed', async () => {
    answers['/v1/queries/ai_setup.get'] = gotOf(STATE, {
      reached: 'learned',
      answers: { ...GIVEN, jobs: ['reply', 'qualify'], questions: [] },
    });
    await open();
    await screen.findByTestId('ai-setup-step-qualify');
    // None yet: the screen says what it needs.
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    expect(
      screen.getByText('Add at least one question, or untick “Ask qualifying questions”.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ai-setup-add-qualify'));
    await fireEvent.changeText(
      screen.getByTestId('ai-setup-qualify-0-question'),
      'What needs fixing?',
    );
    await fireEvent.press(screen.getByTestId('ai-setup-qualify-0-kind-choice'));
    await fireEvent.changeText(
      screen.getByTestId('ai-setup-qualify-0-choices'),
      'Cooling, Heating, ',
    );
    // A question about who someone is, not what they need.
    await fireEvent.press(screen.getByTestId('ai-setup-add-qualify'));
    await fireEvent.changeText(
      screen.getByTestId('ai-setup-qualify-1-question'),
      'How old are you?',
    );
    expect(screen.getByTestId('ai-setup-qualify-1-protected')).toHaveTextContent(
      W.qualifyProtected,
    );
    await fireEvent.press(screen.getByTestId('ai-setup-qualify-1-remove'));
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-loop');
    const [kept] = sent('/v1/commands/ai_setup.save') as { answers: AiSetupAnswers }[];
    expect(kept!.answers.questions).toEqual([
      expect.objectContaining({
        question: 'What needs fixing?',
        kind: 'choice',
        options: ['Cooling', 'Heating'],
      }),
    ]);
  });
});

describe('Save, the test chat and turning it on', () => {
  it('carries on from the computer, saves, tries Ava and turns it on', async () => {
    answers['/v1/queries/ai_setup.get'] = gotOf(STATE, { reached: 'loop', answers: GIVEN });
    answers['/v1/commands/ai_setup.finish'] = {
      teammateId: TEAMMATE,
      revision: 1,
      changes: ['Sets up Ava, your AI teammate'],
      chat: null,
      calendarId: null,
      notes: ['Service calls can’t be turned on yet. Add who does them in Settings → Calendars.'],
    };
    mockAnswer.mockImplementation((body) => {
      const text = body.messages?.[0]?.text ?? '';
      return text === 'Are you a real person?'
        ? [
            { type: 'delta', text: 'I’m Ava, ' },
            {
              type: 'done',
              outcome: 'replied',
              reply: 'I’m Ava, the AI assistant at Lone Star.',
              draft: false,
              ended: false,
              toolSteps: 0,
              ms: 800,
              firstWordsMs: null,
              steps: null,
            },
          ]
        : [
            {
              type: 'done',
              outcome: 'handed_off',
              reply: 'Let me get someone from the team.',
              draft: false,
              ended: false,
              toolSteps: 0,
              ms: 800,
              firstWordsMs: null,
              steps: null,
            },
          ];
    });
    await open();
    // Where the computer left off: "Stay in the loop", the last question.
    await screen.findByTestId('ai-setup-step-loop');
    expect(screen.getByTestId('ai-setup-carry-on')).toBeTruthy();
    expect(screen.getByTestId('ai-setup-alerts-off')).toHaveTextContent(
      withAiName(P.alertsOff, 'Ava'),
    );
    await fireEvent.press(screen.getByTestId('ai-setup-alerts-turn-on'));
    expect(pushRegistration.ask).toHaveBeenCalled();
    // No business number yet: where to add the cell later.
    expect(screen.getByTestId('ai-setup-cell')).toHaveTextContent(P.cellNoNumber, {
      exact: false,
    });
    expect(screen.getByTestId('ai-setup-next')).toHaveTextContent(AI_SETUP_WORDS.save);

    answers['/v1/queries/ai_setup.get'] = gotOf(WITH_AVA, { answers: GIVEN });
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-try');
    expect(sent('/v1/commands/ai_setup.finish')).toEqual([
      expect.objectContaining({ workspaceId: LONE_STAR, baseRevision: null }),
    ]);
    expect(router.setParams).toHaveBeenCalledWith({ at: 'try' });
    expect(screen.getByTestId('ai-setup-try')).toHaveTextContent(
      'Service calls can’t be turned on yet.',
      { exact: false },
    );

    // The questions made from the business, asked as a new customer.
    await fireEvent.press(screen.getByTestId('ai-setup-ask-all'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-report')).toBeTruthy());
    expect(mockAsked).toContain('How much does AC repair cost?');
    expect(mockAsked[mockAsked.length - 1]).toBe('Are you a real person?');
    const last = mockAsked.length - 1;
    expect(screen.getByTestId(`ai-setup-test-${last}-reply`)).toHaveTextContent(
      'I’m Ava, the AI assistant at Lone Star.',
    );
    expect(screen.getByTestId(`ai-setup-test-${last}-outcome`)).toHaveTextContent(W.knew);
    expect(screen.getByTestId('ai-setup-report')).toHaveTextContent(W.reportGaps(last));

    // An answer it didn't know goes into Knowledge, and it's asked again.
    answers['/v1/commands/knowledge_item.create'] = { id: 'k1' };
    const question = mockAsked[0]!;
    await fireEvent.press(screen.getByTestId('ai-setup-test-0-add'));
    await fireEvent.changeText(
      screen.getByTestId('ai-setup-test-0-answer'),
      'We work all over Austin.',
    );
    await fireEvent.press(screen.getByTestId('ai-setup-test-0-save'));
    await waitFor(() =>
      expect(sent('/v1/commands/knowledge_item.create')).toEqual([
        {
          workspaceId: LONE_STAR,
          content: { kind: 'faq', question, answer: 'We work all over Austin.' },
          status: 'published',
        },
      ]),
    );
    await waitFor(() => expect(mockAsked.filter((q) => q === question)).toHaveLength(2));

    // Turned on with training wheels: the note, and the screen closes.
    answers['/v1/commands/ai_teammate.set_status'] = { teammateId: TEAMMATE, status: 'training' };
    await fireEvent.press(screen.getByTestId('ai-setup-turn-on'));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(sent('/v1/commands/ai_teammate.set_status')).toEqual([
      { workspaceId: LONE_STAR, teammateId: TEAMMATE, status: 'training' },
    ]);
    expect(toast.show).toHaveBeenCalledWith(withAiName(AI_SETUP_WORDS.turnedOnNote, 'Ava'));
  });

  it('shows a business that has a teammate what will change first', async () => {
    const working: AiSetupStateOut = {
      ...WITH_AVA,
      teammate: { ...WITH_AVA.teammate!, status: 'training', revision: 3 },
    };
    answers['/v1/queries/ai_setup.get'] = gotOf(working, { reached: 'loop', answers: GIVEN });
    answers['/v1/commands/ai_setup.finish'] = {
      teammateId: TEAMMATE,
      revision: 4,
      changes: [],
      chat: null,
      calendarId: null,
      notes: [],
    };
    await open();
    await screen.findByTestId('ai-setup-step-loop');
    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-confirm');
    expect(screen.getByText(AI_SETUP_WORDS.willChange)).toBeTruthy();
    expect(screen.getByTestId('ai-setup-changes')).toBeTruthy();
    expect(sent('/v1/commands/ai_setup.finish')).toEqual([]);
    expect(screen.getByTestId('ai-setup-next')).toHaveTextContent(AI_SETUP_WORDS.saveChanges);
    // "More settings", not the presets, once there's a teammate.
    expect(screen.getByTestId('ai-setup-myself')).toHaveTextContent(AI_SETUP_WORDS.moreSettings, {
      exact: false,
    });

    await fireEvent.press(screen.getByTestId('ai-setup-next'));
    await screen.findByTestId('ai-setup-step-try');
    expect(sent('/v1/commands/ai_setup.finish')).toEqual([
      expect.objectContaining({ baseRevision: 3 }),
    ]);
    // Already on: Done closes the screen.
    expect(screen.getByTestId('ai-setup-on')).toHaveTextContent(withAiName(W.isOn, 'Ava'));
    await fireEvent.press(screen.getByTestId('ai-setup-done'));
    expect(router.back).toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('opens on the test chat after Save, and says when the test chat isn’t here yet', async () => {
    mockParams = { at: 'try' };
    answers['/v1/queries/ai_setup.get'] = gotOf(WITH_AVA, { answers: GIVEN });
    const actual = jest.requireActual<typeof TestStream>('@/ai-team/test-stream');
    mockAnswer.mockImplementation(() => {
      throw new actual.TestConsoleError('Not found', 'gone', 404);
    });
    await open();
    await screen.findByTestId('ai-setup-step-try');
    await fireEvent.press(screen.getByTestId('ai-setup-ask-all'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-test-0-error')).toBeTruthy());
    expect(screen.getByTestId('ai-setup-test-0-error')).toHaveTextContent(P.testNotHere);
    // It stops at the first that fails, rather than failing them all.
    expect(mockAsked).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('ai-setup-not-yet'));
    expect(router.back).toHaveBeenCalled();
    expect(sent('/v1/commands/ai_teammate.set_status')).toEqual([]);
  });
});

describe('before it opens', () => {
  it('says it needs signal, and opens once the phone is back online', async () => {
    mockOnline = false;
    const view = await open();
    expect(await screen.findByTestId('ai-setup-offline')).toHaveTextContent(P.needsSignal);
    expect(post).not.toHaveBeenCalled();
    mockOnline = true;
    await view.rerender();
    await screen.findByTestId('ai-setup-step-business');
  });

  it('says plainly what HandsFreeOS refused, with Try again', async () => {
    answers['/v1/queries/ai_setup.get'] = new Refusal(500, {
      code: 'internal',
      message: 'Something went wrong on our side. Try again in a minute.',
    });
    await open();
    expect(await screen.findByTestId('ai-setup-failed')).toHaveTextContent(
      'Something went wrong on our side. Try again in a minute.',
      { exact: false },
    );
    answers['/v1/queries/ai_setup.get'] = gotOf(STATE);
    await fireEvent.press(screen.getByText(P.tryAgain));
    await screen.findByTestId('ai-setup-step-business');
  });

  it('is only for people who manage the AI teammate', async () => {
    await open('member', ['inbox.view']);
    expect(await screen.findByTestId('ai-setup-not-allowed')).toHaveTextContent(P.notAllowed, {
      exact: false,
    });
    expect(post).not.toHaveBeenCalled();
  });
});
