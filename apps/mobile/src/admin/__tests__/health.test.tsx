import {
  DESK_AI_WORDS,
  DESK_HEALTH_WORDS,
  DESK_ONBOARDING_WORDS,
  deskMatomoPagesUrl,
  ROLE_PERMISSIONS,
  stepTitle,
} from '@hfos/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { DESK_BUSINESS_PHONE_WORDS, whenWords } from '@/admin/business-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import GettingStarted from '@/app/app/admin/getting-started';
import Health from '@/app/app/admin/health';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import { admin, agent, lastBody, sent, showDesk, type Answers } from './kit';

/**
 * Health and Getting started on the phone's Support desk (the web's /admin/health and /admin/getting-started): what
 * has failed lately, which AI is answering and the switch that keeps it on one, and how businesses get through Getting
 * started over 7, 30 or 90 days. Only the roles the web's menu shows them to see them.
 */

let mockParams: Record<string, string> = {};
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
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const SINCE = minutesAgo(24 * 60);
const count = (label: string, n: number) => ({ label, count: n, worstBusiness: null });

const HEALTH = {
  since: SINCE,
  failedJobs: count('Background job', 2),
  failedDeliveries: count('Webhook', 0),
  emailBounces: count('Email bounced', 0),
  failedTexts: count('Text message', 5),
  paymentFailures: count('Payment', 0),
  lostTranscripts: count('Transcript', 1),
  wallets: { suspended: 1, declines: 0, drifting: 0, negative: 2, unreconciledDays: 0 },
  outboxBacklog: 3,
  oldestPendingMinutes: 12,
  recent: [
    {
      kind: 'Text message failed',
      at: minutesAgo(30),
      business: 'Lone Star HVAC',
      detail: '30007 carrier filtered',
    },
    { kind: 'Background job failed', at: minutesAgo(90), business: null, detail: 'timed out' },
  ],
};

const AI = {
  mode: 'auto',
  active: 'openai',
  answering: 'openai',
  reason: 'status',
  claudeStatus: 'partial_outage',
  goodChecks: 1,
  checkedAt: minutesAgo(2),
  switchedAt: minutesAgo(40),
  modeSetAt: null,
  modeSetBy: null,
};

const COUNTS = {
  since: minutesAgo(30 * 24 * 60),
  started: 48,
  asYouGo: 11,
  finished: { businesses: 20, nothingSkipped: 7, teammates: 15 },
  hidden: 4,
  turnedOff: 2,
  steps: [
    { key: 'payments', for: 'business', skipped: 14, broughtBack: 3 },
    { key: 'notifications', for: 'person', skipped: 6, broughtBack: 0 },
  ],
};

const lead = { ...admin, role: 'lead' as const, permissions: ROLE_PERMISSIONS.staff_lead };

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = {};
  answers = {
    '/v1/queries/platform.health.summary': HEALTH,
    '/v1/queries/platform.ai_provider.get': AI,
    '/v1/commands/ai_provider.set_mode': { was: 'auto', mode: 'claude', changed: true },
    '/v1/queries/platform.onboarding.counts': COUNTS,
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('health', () => {
  it('counts what failed in the last day, with the oldest queued job when it’s news', async () => {
    await showDesk(<Health />, () => answers);
    await screen.findByTestId('health-counts');
    expect(lastBody('/v1/queries/platform.health.summary')).toEqual({ hours: 24 });
    expect(screen.getByTestId('app-bar-subtitle')).toHaveTextContent(
      `Since ${whenWords(SINCE)} · oldest queued job 12 minutes old`,
    );
    expect(screen.getByTestId('health-counts')).toHaveTextContent(
      'Background jobs that failed2Webhooks that failed0Emails that bounced0Texts that failed5' +
        'Payments that failed0Calls with no words1Cards declined0Balances suspended1' +
        'Balances that disagree0Balances below zero2Days not reconciled0Work still queued3',
    );
  });

  it('looks back as far as a link to the web’s page asked, up to a week', async () => {
    mockParams = { hours: '72' };
    await showDesk(<Health />, () => answers);
    await screen.findByTestId('health-counts');
    expect(lastBody('/v1/queries/platform.health.summary')).toEqual({ hours: 72 });
  });

  it('keeps a linked window to a week', async () => {
    mockParams = { hours: '999' };
    await showDesk(<Health />, () => answers);
    await screen.findByTestId('health-counts');
    expect(lastBody('/v1/queries/platform.health.summary')).toEqual({ hours: 168 });
  });

  it('lists the last few failures, and whose they were', async () => {
    await showDesk(<Health />, () => answers);
    const recent = await screen.findByTestId('health-recent');
    expect(recent).toHaveTextContent('Text message failed Lone Star HVAC ·', { exact: false });
    expect(recent).toHaveTextContent('Background job failed no business ·', { exact: false });
    expect(screen.getByText('30007 carrier filtered')).toBeTruthy();
  });

  it('says nothing has failed', async () => {
    answers['/v1/queries/platform.health.summary'] = {
      ...HEALTH,
      oldestPendingMinutes: 3,
      recent: [],
    };
    await showDesk(<Health />, () => answers);
    expect(await screen.findByText(DESK_HEALTH_WORDS.nothingFailed)).toBeTruthy();
    expect(screen.getByTestId('app-bar-subtitle')).toHaveTextContent(`Since ${whenWords(SINCE)}`);
  });

  it('says which AI is answering and why', async () => {
    await showDesk(<Health />, () => answers);
    const block = await screen.findByTestId('health-ai');
    expect(block).toHaveTextContent('Answering nowOpenAI', { exact: false });
    expect(block).toHaveTextContent('Claude’s status pagePartly down', { exact: false });
    expect(screen.getByTestId('health-ai-why')).toHaveTextContent(
      'Claude’s status page reports trouble. Back on Claude after two good checks in a row (1 so far).',
    );
    expect(screen.getByText(DESK_AI_WORDS.autoExplain)).toBeTruthy();
  });

  it('says who kept it on Claude, and what Auto would do', async () => {
    const at = minutesAgo(15);
    answers['/v1/queries/platform.ai_provider.get'] = {
      ...AI,
      mode: 'claude',
      answering: 'claude',
      reason: 'errors',
      modeSetBy: 'Riley',
      modeSetAt: at,
    };
    await showDesk(<Health />, () => answers);
    expect(await screen.findByTestId('health-ai-why')).toHaveTextContent(
      `Kept on Claude by Riley, ${whenWords(at)}.`,
    );
    expect(screen.getByTestId('health-ai-overruled')).toHaveTextContent(
      'On Auto it would be on OpenAI now: Claude’s answers kept failing.',
    );
  });

  it('lets a support admin keep it on one, and asks again', async () => {
    await showDesk(<Health />, () => answers);
    await fireEvent.press(await screen.findByTestId('ai-provider-claude'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/ai_provider.set_mode')).toEqual({ mode: 'claude' }),
    );
    expect(toast.show).toHaveBeenCalledWith(DESK_PHONE_WORDS.saved);
    await waitFor(() => expect(sent('/v1/queries/platform.ai_provider.get')).toHaveLength(2));
  });

  it('says why the switch was refused', async () => {
    answers['/v1/commands/ai_provider.set_mode'] = null;
    await showDesk(<Health />, () => answers);
    await fireEvent.press(await screen.findByTestId('ai-provider-openai'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('No signal. Try again when you’re back online.'),
    );
  });

  it('shows a lead where it is, with no switch', async () => {
    await showDesk(<Health />, () => answers, lead);
    expect(await screen.findByTestId('health-ai-mode')).toHaveTextContent('Auto');
    expect(screen.queryByTestId('ai-provider-claude')).toBeNull();
  });

  it('keeps the rest of the page when which AI answers can’t be read', async () => {
    answers['/v1/queries/platform.ai_provider.get'] = null;
    await showDesk(<Health />, () => answers);
    expect(await screen.findByTestId('health-ai-unread')).toHaveTextContent(
      DESK_BUSINESS_PHONE_WORDS.aiUnreadable,
    );
    expect(screen.getByTestId('health-counts')).toBeTruthy();
  });

  it('is left closed to an agent, and asks nothing', async () => {
    await showDesk(<Health />, () => answers, agent);
    expect(screen.getByTestId('health-not-yours')).toHaveTextContent(
      DESK_BUSINESS_PHONE_WORDS.notYourRole('health'),
    );
    expect(sent('/v1/queries/platform.health.summary')).toHaveLength(0);
    expect(sent('/v1/queries/platform.ai_provider.get')).toHaveLength(0);
  });

  it('says it needs a signal, and asks again once the phone is back in signal', async () => {
    answers['/v1/queries/platform.health.summary'] = null;
    setTestOffline(true);
    await showDesk(<Health />, () => answers);
    await screen.findByTestId('health-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/platform.health.summary'] = HEALTH;
    await act(() => setTestOffline(false));
    expect(await screen.findByTestId('health-counts')).toBeTruthy();
  });
});

describe('getting started', () => {
  it('counts the last 30 days, the finished card with its note', async () => {
    await showDesk(<GettingStarted />, () => answers);
    expect(await screen.findByTestId('onboarding-count-started')).toHaveTextContent(
      'Answered the quick questions48',
    );
    expect(lastBody('/v1/queries/platform.onboarding.counts')).toEqual({ days: 30 });
    expect(screen.getByTestId('onboarding-count-finished')).toHaveTextContent(
      'Finished setting up207 with nothing skipped',
    );
    expect(screen.getByTestId('onboarding-count-as-you-go')).toHaveTextContent(
      'Adding customers as they go11',
    );
    expect(screen.getByTestId('onboarding-count-turned-off')).toHaveTextContent(
      'Businesses that turned it off2',
    );
    expect(screen.getByTestId('app-bar-subtitle')).toHaveTextContent(
      DESK_ONBOARDING_WORDS.since(whenWords(COUNTS.since)),
    );
  });

  it('lists the skipped steps, whose list each is on, and how many came back', async () => {
    await showDesk(<GettingStarted />, () => answers);
    expect(await screen.findByTestId('onboarding-step-payments')).toHaveTextContent(
      `${stepTitle('payments')}Business143`,
    );
    expect(screen.getByTestId('onboarding-step-notifications')).toHaveTextContent(
      `${stepTitle('notifications')}Own list60`,
    );
  });

  it('counts over another window, and opens Matomo’s report over the same days', async () => {
    const { openWeb } = jest.requireMock('@/lib/open-web') as { openWeb: jest.Mock };
    await showDesk(<GettingStarted />, () => answers);
    await screen.findByTestId('onboarding-count-started');
    await fireEvent.press(screen.getByTestId('onboarding-window-7'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/platform.onboarding.counts')).toEqual({ days: 7 }),
    );
    await fireEvent.press(await screen.findByTestId('onboarding-matomo'));
    expect(openWeb).toHaveBeenCalledWith(deskMatomoPagesUrl(7));
    expect(screen.getByTestId('onboarding-how-far')).toHaveTextContent(
      'from onboarding to the questions, then each onboarding/:id/setup/… step.',
      { exact: false },
    );
  });

  it('opens on the window a link to the web’s page asked for, and on 30 days for any other', async () => {
    mockParams = { days: '90' };
    await showDesk(<GettingStarted />, () => answers);
    await screen.findByTestId('onboarding-count-started');
    expect(lastBody('/v1/queries/platform.onboarding.counts')).toEqual({ days: 90 });
    expect(screen.getByTestId('onboarding-window-90').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  it('is left closed to a role without the directory', async () => {
    await showDesk(<GettingStarted />, () => answers, { ...agent, permissions: ['support.read'] });
    expect(screen.getByTestId('getting-started-not-yours')).toBeTruthy();
    expect(sent('/v1/queries/platform.onboarding.counts')).toHaveLength(0);
  });

  it('says it needs a signal', async () => {
    answers['/v1/queries/platform.onboarding.counts'] = null;
    setTestOffline(true);
    await showDesk(<GettingStarted />, () => answers);
    await screen.findByTestId('getting-started-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
  });
});
