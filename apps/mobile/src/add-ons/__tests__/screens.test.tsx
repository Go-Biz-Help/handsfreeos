import { ADDON_MOVE_WORDS, addonCheckWords } from '@hfos/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';

import AddonScreen from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/add-ons/[addonId]';
import Addons from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/add-ons';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';

import { BUSY_POLL_MS } from '../use-add-ons';
import { ADDON_PHONE_WORDS } from '../words';
import { impactOf, listFor, MEMBER } from './fixtures';

/**
 * Settings → Add-ons and one add-on's own screen, with React Native Testing Library over a made-up catalogue: the
 * sections (and the card when there's nothing at all, as today), progress while the worker moves one, a move that
 * takes something away asked first with what goes with it, the question HandsFreeOS asks about the add-ons one needs
 * and the yes that sends it again, deleting data with the name typed (owners only), switches, and what a paid or a
 * planned add-on says instead of Install. Everything is live, so the API stands in for HandsFreeOS.
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
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
// The screens read the catalogue's manifests; the real catalogue is empty until the first add-on ships.
jest.mock('@hfos/core', () => ({
  ...jest.requireActual<object>('@hfos/core'),
  get ADDON_CATALOG() {
    return jest.requireActual<{ FIXTURE_CATALOG: unknown }>('@/add-ons/__tests__/fixtures')
      .FIXTURE_CATALOG;
  },
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const business = (role: Business['role']): Business => ({
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role,
  timezone: 'America/Chicago',
});

const me = (role: Business['role']): Me => ({
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business(role)],
  organizations: [],
  fetchedAt: 0,
});

/** A refusal as the API sends one. */
const refused = (status: number, error: Record<string, unknown>) => ({
  refused: { status, error },
});

/** What the API answers, per path: a value, a refusal, `null` for no signal, or a function of the body. */
let answers: Record<string, unknown>;

const post = api.POST as unknown as jest.Mock<
  Promise<{ data?: unknown; error?: unknown; response: Response }>,
  [string, { body: Record<string, unknown> }]
>;

function mockApi() {
  post.mockImplementation(async (path, init) => {
    const found = answers[path];
    const answer =
      typeof found === 'function' ? (found as (b: unknown) => unknown)(init.body) : found;
    if (answer === null) throw new TypeError('Network request failed');
    const refusal = (answer as { refused?: { status: number; error: object } } | undefined)
      ?.refused;
    if (refusal)
      return {
        error: { error: { disposition: 'final', ...refusal.error } },
        response: new Response(null, { status: refusal.status }),
      };
    return { data: answer ?? {}, response: new Response(null, { status: 200 }) };
  });
}

const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

async function show(element: React.ReactElement, role: Business['role'] = 'owner') {
  mockApi();
  await render(
    <BusinessProvider
      value={{
        userId: DALE,
        me: me(role),
        business: business(role),
        openSwitcher: () => undefined,
      }}
    >
      {element}
    </BusinessProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  answers = {};
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('Settings → Add-ons', () => {
  it('says there are none yet when there is nothing anywhere, as until the first add-on ships', async () => {
    answers['/v1/queries/addon.list'] = listFor({}, { catalog: [] });
    await show(<Addons />);
    expect(await screen.findByTestId('add-ons-empty')).toHaveTextContent(
      ADDON_PHONE_WORDS.emptyTitle,
      {
        exact: false,
      },
    );
    expect(screen.queryByTestId('add-ons-installed')).toBeNull();
    expect(screen.getByText(ADDON_PHONE_WORDS.intro)).toBeTruthy();
    expect(sent('/v1/queries/addon.list')[0]![1]).toEqual({ body: { workspaceId: LONE_STAR } });
  });

  it('lists what the business has, what could be added and what is coming', async () => {
    answers['/v1/queries/addon.list'] = listFor(
      { fxprop: 'enabled', fxacct: 'disabled' },
      {
        rows: {
          fxprop: {
            failedChecks: ['no_jobs_pending'],
            lastError: 'Not finished: no_jobs_pending (2)',
          },
        },
      },
    );
    await show(<Addons />);
    const installed = await screen.findByTestId('add-ons-installed');
    expect(installed).toHaveTextContent('Property Management', { exact: false });
    expect(screen.getByTestId('add-on-row-fxprop')).toHaveTextContent('On', { exact: false });
    // Its trouble in core's words (its own screen lists each check), never the worker's own message.
    expect(screen.getByTestId('add-on-row-fxprop')).toHaveTextContent(
      ADDON_PHONE_WORDS.troubleChecks,
      { exact: false },
    );
    expect(screen.queryByText(/Not finished/)).toBeNull();
    expect(screen.getByTestId('add-on-row-fxacct')).toHaveTextContent('Off', { exact: false });

    expect(screen.getByTestId('add-ons-addable')).toHaveTextContent('Rent Collection', {
      exact: false,
    });
    // Paid: support turns it on, since billing isn't built.
    expect(screen.getByTestId('add-on-row-fxpaid')).toHaveTextContent(ADDON_PHONE_WORDS.paid, {
      exact: false,
    });
    expect(screen.getByTestId('add-ons-coming-soon')).toHaveTextContent('Influencer Marketplace', {
      exact: false,
    });
    expect(screen.getByTestId('add-on-row-fxinflu')).toHaveTextContent(
      ADDON_PHONE_WORDS.comingSoon,
      {
        exact: false,
      },
    );
    // A beta add-on is only ever handed out by HandsFreeOS support.
    expect(screen.queryByTestId('add-on-row-fxbeta')).toBeNull();

    await fireEvent.press(screen.getByTestId('add-on-row-fxrent'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/add-ons/fxrent`);
  });

  it('opens one add-on’s own screen when a link names it', async () => {
    mockParams = { addon: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'enabled' });
    await show(<Addons />);
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/settings/add-ons/fxprop`),
    );
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('says so when this business has none yet but some could be added', async () => {
    answers['/v1/queries/addon.list'] = listFor({});
    await show(<Addons />);
    expect(await screen.findByTestId('add-ons-none-here')).toHaveTextContent(
      ADDON_PHONE_WORDS.noneHere,
      { exact: false },
    );
    expect(screen.getByTestId('add-ons-addable')).toBeTruthy();
  });

  it('tells someone who doesn’t manage add-ons who does, and asks HandsFreeOS nothing', async () => {
    await show(<Addons />, 'member');
    expect(await screen.findByTestId('add-ons-not-yours')).toHaveTextContent(
      ADDON_PHONE_WORDS.notYours,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('says it needs signal, and tries again', async () => {
    answers['/v1/queries/addon.list'] = null;
    await show(<Addons />);
    expect(await screen.findByTestId('add-ons-error')).toHaveTextContent(
      'No signal. Try again when you’re back online.',
      { exact: false },
    );
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'enabled' });
    await fireEvent.press(screen.getByTestId('add-ons-retry'));
    expect(await screen.findByTestId('add-on-row-fxprop')).toBeTruthy();
  });

  describe('while an add-on is on its way somewhere', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('shows progress, and asks again every few seconds until it is done', async () => {
      answers['/v1/queries/addon.list'] = listFor({ fxacct: 'installing' });
      await show(<Addons />);
      expect(await screen.findByTestId('add-on-row-fxacct')).toHaveTextContent('Setting up', {
        exact: false,
      });
      expect(sent('/v1/queries/addon.list')).toHaveLength(1);

      await act(async () => jest.advanceTimersByTime(BUSY_POLL_MS));
      expect(sent('/v1/queries/addon.list')).toHaveLength(2);

      answers['/v1/queries/addon.list'] = listFor({ fxacct: 'enabled' });
      await act(async () => jest.advanceTimersByTime(BUSY_POLL_MS));
      await waitFor(() =>
        expect(screen.getByTestId('add-on-row-fxacct')).toHaveTextContent('On', { exact: false }),
      );
      const asked = sent('/v1/queries/addon.list').length;
      // Settled: nothing more to wait for.
      await act(async () => jest.advanceTimersByTime(BUSY_POLL_MS * 3));
      expect(sent('/v1/queries/addon.list')).toHaveLength(asked);
    });
  });
});

describe('one add-on', () => {
  it('turns it off only after saying what goes with it, and sends what was agreed to', async () => {
    mockParams = { addonId: 'fxprop' };
    let list = listFor({ fxprop: 'enabled', fxrent: 'enabled' });
    answers['/v1/queries/addon.list'] = () => list;
    answers['/v1/queries/addon.impact'] = impactOf({
      addonId: 'fxprop',
      action: 'disable',
      moves: [
        { addonId: 'fxrent', action: 'disable', name: 'Rent Collection' },
        { addonId: 'fxprop', action: 'disable', name: 'Property Management' },
      ],
      needsAgreement: ['fxrent'],
      question: 'Rent Collection needs Property Management. Turn it off too?',
      capabilitiesLost: [
        { id: 'fxrent.overdue', label: 'Overdue rent' },
        { id: 'fxprop.properties', label: 'Properties and units' },
      ],
      holds: {
        records: 12,
        relationships: 3,
        pendingJobs: 2,
        heldResources: 0,
        ownRows: 0,
        usageEvents: 4,
      },
    });
    answers['/v1/commands/addon.disable'] = {
      moved: [
        { addonId: 'fxrent', action: 'disable', from: 'enabled', to: 'disabled', generation: 1 },
        { addonId: 'fxprop', action: 'disable', from: 'enabled', to: 'disabled', generation: 1 },
      ],
    };
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-state')).toHaveTextContent('On');
    expect(screen.getByTestId('add-on-state-detail')).toHaveTextContent(
      'Working for everyone who may use it.',
    );
    expect(screen.getByTestId('add-on-does')).toHaveTextContent('Properties and units', {
      exact: false,
    });

    await fireEvent.press(screen.getByTestId('add-on-disable'));
    expect(await screen.findByTestId('addon-confirm-title')).toHaveTextContent(
      'Turn off Property Management?',
    );
    expect(screen.getByText(ADDON_MOVE_WORDS.disable.consequence!)).toBeTruthy();
    expect(await screen.findByTestId('addon-impact-question')).toHaveTextContent(
      'Rent Collection needs Property Management. Turn it off too?',
    );
    expect(screen.getByTestId('addon-impact-lines')).toHaveTextContent(
      'What stops: Overdue rent and Properties and units.',
      { exact: false },
    );
    const holds = screen.getByTestId('addon-impact-holds');
    expect(holds).toHaveTextContent('12 records and 3 relationships stay for when it’s back on.', {
      exact: false,
    });
    expect(holds).toHaveTextContent('2 things it had scheduled are cancelled.', { exact: false });
    // The button says it takes Rent Collection with it.
    expect(screen.getByTestId('addon-confirm')).toHaveTextContent('Turn off both');
    expect(sent('/v1/queries/addon.impact')[0]![1]).toEqual({
      body: { workspaceId: LONE_STAR, addonId: 'fxprop', action: 'disable' },
    });
    // Nothing has moved yet.
    expect(sent('/v1/commands/addon.disable')).toHaveLength(0);

    list = listFor({ fxprop: 'disabled', fxrent: 'disabled' });
    await fireEvent.press(screen.getByTestId('addon-confirm'));
    await waitFor(() => expect(sent('/v1/commands/addon.disable')).toHaveLength(1));
    expect(sent('/v1/commands/addon.disable')[0]![1]).toEqual({
      body: { workspaceId: LONE_STAR, addonId: 'fxprop', include: ['fxrent'] },
    });
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'Property Management is off. Rent Collection is off too.',
      ),
    );
    // Read again: it's off now, and Turn on is its move.
    expect(await screen.findByTestId('add-on-enable')).toHaveTextContent(
      ADDON_MOVE_WORDS.enable.button,
    );
    expect(screen.getByTestId('add-on-state')).toHaveTextContent('Off');
  });

  it('keeps the move back when HandsFreeOS can’t say what it would do', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'enabled' });
    answers['/v1/queries/addon.impact'] = null;
    await show(<AddonScreen />);
    await fireEvent.press(await screen.findByTestId('add-on-uninstall'));
    expect(await screen.findByTestId('addon-impact-error')).toHaveTextContent(
      'No signal. Try again when you’re back online.',
      { exact: false },
    );
    expect(screen.getByTestId('addon-confirm')).toBeDisabled();

    answers['/v1/queries/addon.impact'] = impactOf({ addonId: 'fxprop', action: 'uninstall' });
    await fireEvent.press(screen.getByTestId('addon-impact-retry'));
    // It holds nothing and nothing else moves: nothing more to say, and the move can go.
    expect(await screen.findByTestId('addon-impact')).toBeTruthy();
    expect(screen.queryByTestId('addon-impact-holds')).toBeNull();
    expect(screen.getByTestId('addon-confirm')).not.toBeDisabled();
  });

  it('asks to add both when it needs another, and sends it again with a yes', async () => {
    mockParams = { addonId: 'fxrent' };
    answers['/v1/queries/addon.list'] = listFor({});
    answers['/v1/commands/addon.install'] = (body: { include: string[] }) =>
      body.include.includes('fxprop')
        ? {
            moved: [
              { addonId: 'fxprop', action: 'install', from: null, to: 'installing', generation: 1 },
              { addonId: 'fxrent', action: 'install', from: null, to: 'installing', generation: 1 },
            ],
          }
        : refused(409, {
            code: 'rule_violation',
            message: 'Rent Collection needs Property Management. Turn it on too?',
            rule: 'addon_needs',
            details: { addons: ['fxprop'] },
            disposition: 'ask',
          });
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-link-fxprop')).toHaveTextContent(
      'Rent is collected on its leases.',
      { exact: false },
    );
    // Installing needs no question of its own: it goes, and HandsFreeOS asks what it has to.
    await fireEvent.press(screen.getByTestId('add-on-install'));
    expect(await screen.findByTestId('addon-question')).toHaveTextContent(
      'Rent Collection needs Property Management. Turn it on too?',
    );
    expect(sent('/v1/queries/addon.impact')).toHaveLength(0);
    expect(screen.getByTestId('addon-question-yes')).toHaveTextContent('Add both');

    await fireEvent.press(screen.getByTestId('addon-question-yes'));
    await waitFor(() => expect(sent('/v1/commands/addon.install')).toHaveLength(2));
    expect(sent('/v1/commands/addon.install').map((c) => c[1].body.include)).toEqual([
      [],
      ['fxprop'],
    ]);
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'Setting up Rent Collection. It turns on by itself in a moment. Property Management is being set up too.',
      ),
    );
  });

  it('says HandsFreeOS’s own words when a move is refused, and reads it again', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'disabled' });
    answers['/v1/commands/addon.enable'] = refused(409, {
      code: 'rule_violation',
      message: 'That add-on is still being removed. Try again when it has finished.',
      rule: 'addon_busy',
    });
    await show(<AddonScreen />);
    await fireEvent.press(await screen.findByTestId('add-on-enable'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'That add-on is still being removed. Try again when it has finished.',
      ),
    );
    await waitFor(() => expect(sent('/v1/queries/addon.list')).toHaveLength(2));
  });

  it('deletes its data only with its name typed, for an owner', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'uninstalled' });
    answers['/v1/queries/addon.impact'] = impactOf({
      addonId: 'fxprop',
      action: 'purge',
      moves: [{ addonId: 'fxprop', action: 'purge', name: 'Property Management' }],
      holds: {
        records: 40,
        relationships: 0,
        pendingJobs: 0,
        heldResources: 0,
        ownRows: 7,
        usageEvents: 0,
      },
    });
    answers['/v1/commands/addon.purge'] = {
      moved: [
        { addonId: 'fxprop', action: 'purge', from: 'uninstalled', to: 'purging', generation: 1 },
      ],
    };
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-install')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('add-on-purge'));
    expect(await screen.findByTestId('addon-confirm-title')).toHaveTextContent(
      'Delete Property Management’s data for good?',
    );
    const holds = await screen.findByTestId('addon-impact-holds');
    expect(holds).toHaveTextContent('40 records keep their names and nothing else.', {
      exact: false,
    });
    expect(holds).toHaveTextContent('7 other saved items are deleted.', { exact: false });
    expect(screen.getByText(ADDON_PHONE_WORDS.typeName('Property Management'))).toBeTruthy();
    expect(screen.getByTestId('addon-confirm')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('addon-confirm-name'), 'Property');
    expect(screen.getByTestId('addon-confirm')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('addon-confirm-name'), ' property management ');
    expect(screen.getByTestId('addon-confirm')).not.toBeDisabled();

    await fireEvent.press(screen.getByTestId('addon-confirm'));
    await waitFor(() => expect(sent('/v1/commands/addon.purge')).toHaveLength(1));
    expect(sent('/v1/commands/addon.purge')[0]![1]).toEqual({
      body: { workspaceId: LONE_STAR, addonId: 'fxprop', confirmName: 'property management' },
    });
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        'Deleting Property Management’s data. This takes a little while.',
      ),
    );
  });

  it('keeps the name box open with HandsFreeOS’s words when it turns the name down', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'uninstalled' });
    answers['/v1/queries/addon.impact'] = impactOf({ addonId: 'fxprop', action: 'purge' });
    answers['/v1/commands/addon.purge'] = refused(400, {
      code: 'validation',
      message: 'Type Property Management to confirm.',
      details: [{ path: 'confirmName', message: 'Type Property Management to confirm.' }],
    });
    await show(<AddonScreen />);
    await fireEvent.press(await screen.findByTestId('add-on-purge'));
    await screen.findByTestId('addon-impact');
    await fireEvent.changeText(screen.getByTestId('addon-confirm-name'), 'Property Management');
    await fireEvent.press(screen.getByTestId('addon-confirm'));
    expect(await screen.findByTestId('addon-confirm-name-refused')).toHaveTextContent(
      'Type Property Management to confirm.',
    );
    expect(screen.getByTestId('addon-confirm-title')).toBeTruthy();
  });

  it('lets an admin install and uninstall, and never delete data', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor(
      { fxprop: 'uninstalled' },
      { permissions: ['workspace.read', 'addons.manage'] },
    );
    await show(<AddonScreen />, 'admin');
    expect(await screen.findByTestId('add-on-install')).toBeTruthy();
    expect(screen.queryByTestId('add-on-purge')).toBeNull();
    expect(screen.getByTestId('add-on-notes')).toHaveTextContent(ADDON_PHONE_WORDS.ownersDelete);
  });

  it('flips a switch through the add-on’s settings, and puts it back if that fails', async () => {
    mockParams = { addonId: 'fxacct' };
    answers['/v1/queries/addon.list'] = listFor({ fxacct: 'enabled' });
    answers['/v1/queries/addon.settings'] = {
      addonId: 'fxacct',
      settings: {},
      flags: { beta_reports: false, daily_digest: true },
      mySettings: {},
    };
    answers['/v1/commands/addon.save_settings'] = { addonId: 'fxacct', saved: true };
    await show(<AddonScreen />);
    const beta = await screen.findByTestId('add-on-switch-beta_reports');
    expect(beta).not.toBeChecked();
    expect(screen.getByTestId('add-on-switch-daily_digest')).toBeChecked();
    expect(sent('/v1/queries/addon.settings')[0]![1]).toEqual({
      body: { workspaceId: LONE_STAR, addonId: 'fxacct' },
    });

    await fireEvent(beta, 'checkedChange', true);
    await waitFor(() => expect(sent('/v1/commands/addon.save_settings')).toHaveLength(1));
    expect(sent('/v1/commands/addon.save_settings')[0]![1]).toEqual({
      body: { workspaceId: LONE_STAR, addonId: 'fxacct', flags: { beta_reports: true } },
    });
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(
        ADDON_PHONE_WORDS.flipped('Try the new reports', true),
      ),
    );

    answers['/v1/commands/addon.save_settings'] = refused(403, {
      code: 'forbidden',
      message: 'You do not have permission to do that.',
    });
    await fireEvent(screen.getByTestId('add-on-switch-daily_digest'), 'checkedChange', false);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('You do not have permission to do that.'),
    );
    expect(screen.getByTestId('add-on-switch-daily_digest')).toBeChecked();
  });

  it('reads it again when a switch finds it was turned off meanwhile', async () => {
    mockParams = { addonId: 'fxacct' };
    let list = listFor({ fxacct: 'enabled' });
    answers['/v1/queries/addon.list'] = () => list;
    answers['/v1/queries/addon.settings'] = {
      addonId: 'fxacct',
      settings: {},
      flags: { beta_reports: false, daily_digest: true },
      mySettings: {},
    };
    answers['/v1/commands/addon.save_settings'] = refused(403, {
      code: 'rule_violation',
      message: 'Accounting is turned off for this business.',
      rule: 'addon_inactive',
      details: { addonId: 'fxacct' },
    });
    await show(<AddonScreen />);
    const beta = await screen.findByTestId('add-on-switch-beta_reports');
    list = listFor({ fxacct: 'disabled' });
    await fireEvent(beta, 'checkedChange', true);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Accounting is turned off for this business.'),
    );
    expect(await screen.findByTestId('add-on-enable')).toBeTruthy();
    expect(screen.queryByTestId('add-on-switches')).toBeNull();
  });

  it('asks for no switches while it is off', async () => {
    mockParams = { addonId: 'fxacct' };
    answers['/v1/queries/addon.list'] = listFor({ fxacct: 'disabled' });
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-enable')).toBeTruthy();
    expect(screen.queryByTestId('add-on-switches')).toBeNull();
    expect(sent('/v1/queries/addon.settings')).toHaveLength(0);
  });

  it('says why its last change isn’t finished, check by check, in core’s words', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor(
      { fxprop: 'enabled' },
      {
        rows: {
          fxprop: {
            failedChecks: ['no_jobs_pending', 'no_resources_held'],
            lastError: 'Not finished: no_jobs_pending (2), no_resources_held (1)',
          },
        },
      },
    );
    await show(<AddonScreen />);
    const trouble = await screen.findByTestId('add-on-trouble');
    expect(trouble).toHaveTextContent(ADDON_PHONE_WORDS.troubleChecks, { exact: false });
    expect(trouble).toHaveTextContent(addonCheckWords('no_jobs_pending'), { exact: false });
    expect(trouble).toHaveTextContent(addonCheckWords('no_resources_held'), { exact: false });
    expect(screen.queryByText(/Not finished/)).toBeNull();
  });

  it('says when HandsFreeOS has switched it off everywhere for now', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor(
      { fxprop: 'enabled' },
      { rows: { fxprop: { running: false, status: 'unavailable' } } },
    );
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-notes')).toHaveTextContent(
      ADDON_PHONE_WORDS.paused('Property Management'),
    );
  });

  it('says support turns on a paid add-on, in place of Install', async () => {
    mockParams = { addonId: 'fxpaid' };
    answers['/v1/queries/addon.list'] = listFor({});
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-support')).toHaveTextContent(ADDON_PHONE_WORDS.paid, {
      exact: false,
    });
    expect(screen.queryByTestId('add-on-install')).toBeNull();
    await fireEvent.press(screen.getByTestId('add-on-ask-support'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/get-help`);
  });

  it('says when one uninstalled can’t come back, and still lets an owner delete its data', async () => {
    mockParams = { addonId: 'fxold' };
    answers['/v1/queries/addon.list'] = listFor({ fxold: 'uninstalled' });
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-notes')).toHaveTextContent(ADDON_PHONE_WORDS.cantAdd);
    expect(screen.queryByTestId('add-on-install')).toBeNull();
    expect(screen.getByTestId('add-on-purge')).toHaveTextContent(ADDON_MOVE_WORDS.purge.button);
  });

  it('marks a planned add-on Coming soon, with no Install', async () => {
    mockParams = { addonId: 'fxinflu' };
    answers['/v1/queries/addon.list'] = listFor({});
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-state')).toHaveTextContent(
      ADDON_PHONE_WORDS.comingSoon,
    );
    expect(screen.getByTestId('add-on-notes')).toHaveTextContent(ADDON_PHONE_WORDS.notYet);
    expect(screen.queryByTestId('add-on-install')).toBeNull();
  });

  it('shows progress and offers no move while it is on its way', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'uninstalling' });
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-state')).toHaveTextContent('Uninstalling');
    for (const move of ['install', 'enable', 'disable', 'uninstall', 'purge'])
      expect(screen.queryByTestId(`add-on-${move}`)).toBeNull();
  });

  it('says so when HandsFreeOS has no such add-on here', async () => {
    mockParams = { addonId: 'fxold' };
    answers['/v1/queries/addon.list'] = listFor({});
    await show(<AddonScreen />);
    expect(await screen.findByTestId('add-on-not-found')).toHaveTextContent(
      ADDON_PHONE_WORDS.notFound,
    );
  });

  it('asks nothing for someone who doesn’t manage add-ons', async () => {
    mockParams = { addonId: 'fxprop' };
    answers['/v1/queries/addon.list'] = listFor({ fxprop: 'enabled' }, { permissions: MEMBER });
    await show(<AddonScreen />, 'member');
    expect(await screen.findByTestId('add-ons-not-yours')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
