import {
  AUTOMATION_DEFAULTS,
  type AutomationOutput,
  type AutomationSettings,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import type { CountriesSkippedOutput, CountryRule } from '@hfos/core/addons/outreach/countries';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { change } from '@/changes';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';

import { useAutosave } from '../autosave';
import {
  CountriesBody,
  CountriesScreen,
  countryCallDone,
  countryListOf,
  CountryListRows,
  countryListsShown,
  type CountryRow,
} from '../countries';
import { countriesFound, countriesProblem, CountrySetting } from '../country-setting';
import { SettingsPartBody } from '../settings';
import { id, ME, TZ, WS } from './mocks';

/**
 * Which countries the business reaches on the phone (decisions 61 and 86), as the web's: Anywhere, Only these
 * countries or Not these countries, under For your team on General, saved as it's changed but held while Only these
 * countries has none picked; the countries found by name or code as they're typed, each picked one an × to take off;
 * When we can't tell; and the two lists the setting makes, Not sure where they live and Skipped for country, each on
 * its own screen with its calls: Let through, Skip, Undo and Unskip.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('../kit', () => ({
  ...jest.requireActual<object>('../kit'),
  useOutreachContext: () => ({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    timeZone: 'America/Chicago',
    manages: true,
    makesPartners: false,
    writesContacts: true,
    online: true,
  }),
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = Date.parse('2026-10-20T15:00:00.000Z');

describe('Which countries the business reaches', () => {
  it('finds countries by name or code, leaving out those picked', () => {
    expect(countriesFound('canad', []).map((c) => c.code)).toEqual(['CA']);
    expect(countriesFound('gb', []).map((c) => c.code)).toEqual(['GB']);
    expect(countriesFound('canada', ['CA'])).toEqual([]);
    expect(countriesFound('  ', [])).toEqual([]);
    expect(countriesFound('a', []).length).toBeLessThanOrEqual(8);
  });

  it('says why Only these countries with none picked can’t be saved', () => {
    expect(countriesProblem({ mode: 'only', codes: [], unsure: 'ask' })).toBe(
      'Pick at least one country for Only these countries, or choose Anywhere. As it is, nobody would be reached.',
    );
    expect(countriesProblem({ mode: 'only', codes: ['US'], unsure: 'ask' })).toBeNull();
    expect(countriesProblem({ mode: 'not', codes: [], unsure: 'ask' })).toBeNull();
    expect(countriesProblem({ mode: 'anywhere', codes: [], unsure: 'ask' })).toBeNull();
  });

  it('picks a mode, finds and picks countries, takes one off, and sets When we can’t tell', async () => {
    const onChange = jest.fn();
    const Setting = () => {
      const [rule, setRule] = React.useState<CountryRule>({
        mode: 'anywhere',
        codes: [],
        unsure: 'ask',
      });
      return (
        <CountrySetting
          value={rule}
          onChange={(next) => {
            onChange(next);
            setRule(next);
          }}
          disabled={false}
        />
      );
    };
    await render(<Setting />);
    // Anywhere has nothing more to pick.
    expect(screen.queryByTestId('settings-country-find')).toBeNull();
    expect(screen.queryByTestId('settings-countries-unsure')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-countries-only'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'only', codes: [], unsure: 'ask' });
    expect(screen.getByTestId('settings-countries-problem')).toHaveTextContent(
      /Pick at least one country/,
    );
    await fireEvent.changeText(screen.getByTestId('settings-country-find'), 'Canad');
    await fireEvent.press(screen.getByTestId('settings-country-CA'));
    // Typed and Done: the first match goes in.
    await fireEvent.changeText(screen.getByTestId('settings-country-find'), 'Mexi');
    await fireEvent(screen.getByTestId('settings-country-find'), 'submitEditing');
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'only', codes: ['CA', 'MX'], unsure: 'ask' });
    expect(screen.queryByTestId('settings-countries-problem')).toBeNull();
    expect(screen.getByTestId('settings-country-find').props.value).toBe('');
    // Nothing called that.
    await fireEvent.changeText(screen.getByTestId('settings-country-find'), 'Atlantis');
    expect(screen.getByTestId('settings-country-none')).toHaveTextContent(
      'No country called “Atlantis”. Check the spelling.',
    );
    await fireEvent.press(screen.getByLabelText('Take Canada off'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'only', codes: ['MX'], unsure: 'ask' });
    await fireEvent.press(screen.getByTestId('settings-countries-unsure-skip'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'only', codes: ['MX'], unsure: 'skip' });
  });
});

describe('A save held until it can be made', () => {
  it('waits while held, then saves the latest once it isn’t', async () => {
    const save = jest.fn(async (_n: number): Promise<string | null> => null);
    let form: { change: (edit: (n: number) => number) => void; value: number } | null = null;
    const Form = () => {
      const f = useAutosave<number>(1, save, undefined, (n) => n < 0);
      form = { change: (edit) => f.change(edit), value: f.value };
      return null;
    };
    await render(<Form />);
    await act(async () => form!.change(() => -1));
    expect(save).not.toHaveBeenCalled();
    expect(form!.value).toBe(-1);
    await act(async () => form!.change(() => 3));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(3);
  });
});

const AUTOMATION: AutomationOutput = {
  settings: AUTOMATION_DEFAULTS,
  timezone: TZ,
  startedAt: null,
  saved: true,
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  networkWheels: {
    linkedin: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    instagram: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    alignable: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  },
  fresh: {
    facebook: { on: false, from: null, until: null, days: 14 },
    linkedin: { on: false, from: null, until: null, days: 14 },
    instagram: { on: false, from: null, until: null, days: 14 },
    alignable: { on: false, from: null, until: null, days: 14 },
  },
  userId: ME,
  name: 'Dana Reyes',
  changedBy: null,
  rules: {
    sendingAllowed: ['off', 'steps', 'approve_all', 'everything'],
    repliesAllowed: ['draft', 'simple', 'everything'],
    postingAllowed: ['copy', 'after_ok', 'own'],
    dailyLimits: {},
    networksAllowed: ['facebook', 'linkedin'],
    networkLimits: {},
  },
};

const partProps = () => ({
  error: null,
  mine: true,
  business: null,
  manages: false,
  online: true,
  onRetry: jest.fn(),
  onSaveMine: jest.fn(async (_settings: AutomationSettings): Promise<string | null> => null),
  onSaveBusiness: jest.fn(
    async (_edit: (now: OutreachSettings) => Partial<OutreachSettings>): Promise<string | null> =>
      null,
  ),
});

const BUSINESS = { contactsFromChats: 'tagged', weeklyReport: true };

const savedOn = (p: ReturnType<typeof partProps>): Partial<OutreachSettings> =>
  p.onSaveBusiness.mock.lastCall![0](outreachSettings(BUSINESS));

const COUNTS = (over: Partial<CountriesSkippedOutput> = {}): CountriesSkippedOutput => ({
  rule: { mode: 'only', codes: ['US'], unsure: 'ask' },
  people: [],
  unskipped: 0,
  waiting: 0,
  unsure: 2,
  page: 1,
  pages: 1,
  total: 14,
  ...over,
});

describe('The countries on Team, and their lists on You', () => {
  it('saves them with For your team, holding Only these countries until one’s picked', async () => {
    const p = partProps();
    await render(
      <SettingsPartBody part="team" automation={AUTOMATION} {...p} manages business={BUSINESS} />,
    );
    const part = screen.getByTestId('settings-countries');
    expect(within(part).getByText('Which countries to reach')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-countries-only'));
    // None picked: nothing goes, and it says why.
    expect(p.onSaveBusiness).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-countries-problem')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('settings-country-find'), 'Canada');
    await fireEvent.press(screen.getByTestId('settings-country-CA'));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(1);
    expect(savedOn(p).countries).toEqual({ mode: 'only', codes: ['CA'], unsure: 'ask' });
  });

  it('leads to the lists it makes, with how many are on each, for owners and for everyone else', async () => {
    const onCountries = jest.fn();
    const p = partProps();
    await render(
      <SettingsPartBody
        part="team"
        automation={AUTOMATION}
        {...p}
        manages
        business={{ ...BUSINESS, countries: { mode: 'only', codes: ['US'], unsure: 'ask' } }}
        countries={COUNTS()}
        onCountries={onCountries}
      />,
    );
    expect(screen.getByTestId('settings-country-list-unsure')).toHaveTextContent(/2/);
    await fireEvent.press(screen.getByTestId('settings-country-list-skipped'));
    expect(onCountries).toHaveBeenCalledWith('skipped');
    // Someone who doesn't set them sees what the business reaches, and the lists.
    await render(
      <SettingsPartBody
        part="general"
        automation={AUTOMATION}
        {...partProps()}
        countries={COUNTS()}
        onCountries={onCountries}
      />,
    );
    const lists = screen.getByTestId('settings-country-lists-part');
    expect(within(lists).getByText('Your business reaches: Only United States.')).toBeTruthy();
    await fireEvent.press(within(lists).getByTestId('settings-country-list-unsure'));
    expect(onCountries).toHaveBeenLastCalledWith('unsure');
  });

  it('shows no lists while the setting reaches anywhere and nobody is skipped', async () => {
    const anywhere = COUNTS({
      rule: { mode: 'anywhere', codes: [], unsure: 'ask' },
      unsure: 0,
      total: 0,
    });
    expect(countryListsShown(anywhere)).toBe(false);
    expect(countryListsShown({ ...anywhere, total: 3 })).toBe(true);
    expect(countryListsShown(null)).toBe(false);
    await render(<CountryListRows got={anywhere} onOpen={jest.fn()} />);
    expect(screen.queryByTestId('settings-country-lists')).toBeNull();
  });
});

const person = (n: number, over: Partial<CountryRow> = {}): CountryRow => ({
  profileId: id(n),
  name: `Sam Example ${n}`,
  url: `https://www.facebook.com/sam.example.${n}`,
  country: 'CA',
  countryName: 'Canada',
  how: 'seen',
  reason: ['Lives in Toronto, Ontario'],
  why: null,
  skippedByYou: false,
  at: '2026-10-19T15:00:00.000Z',
  ...over,
});

const body = (list: 'unsure' | 'skipped', got: CountriesSkippedOutput, over = {}) => {
  const props = {
    list,
    got,
    error: null,
    online: true,
    timeZone: TZ,
    now: NOW,
    onRetry: jest.fn(),
    onMore: jest.fn(),
    onOpen: jest.fn(),
    onCall: jest.fn(async () => {}),
    ...over,
  };
  return { props, el: <CountriesBody {...props} /> };
};

describe('The lists the country setting makes', () => {
  it('reads the list from the address, Skipped for country unless it says Not sure', () => {
    expect(countryListOf('unsure')).toBe('unsure');
    expect(countryListOf('skipped')).toBe('skipped');
    expect(countryListOf(undefined)).toBe('skipped');
    expect(countryListOf('something')).toBe('skipped');
    expect(countryCallDone('through', 'Sam Example')).toBe(
      'Sam Example is let through from now on.',
    );
    expect(countryCallDone('unskip', 'Sam Example')).toBe(
      'Sam Example is let through from now on, whatever the country setting says.',
    );
  });

  it('lists who a look couldn’t place, each to let through or skip', async () => {
    const { props, el } = body(
      'unsure',
      COUNTS({
        people: [
          person(1, { how: 'unknown', country: null, countryName: null, why: 'Too little.' }),
        ],
      }),
    );
    await render(el);
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Not sure where they live');
    expect(screen.getByTestId('countries-note')).toHaveTextContent(
      'Their profile and their friends don’t agree, or there’s too little to go on. Nobody here is reached until you pick.',
    );
    const row = screen.getByTestId('country-row');
    expect(within(row).getByText('Couldn’t tell')).toBeTruthy();
    expect(within(row).getByText('Too little.')).toBeTruthy();
    await fireEvent.press(within(row).getByLabelText('Sam Example 1'));
    expect(props.onOpen).toHaveBeenCalledWith('https://www.facebook.com/sam.example.1');
    await fireEvent.press(within(row).getByTestId('country-let-through'));
    expect(props.onCall).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: id(1) }),
      'through',
    );
    await fireEvent.press(within(row).getByTestId('country-skip'));
    expect(props.onCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: id(1) }),
      'skip',
    );
  });

  it('lists who the setting skips, to unskip, and one a person skipped to put back, with Show more', async () => {
    const { props, el } = body(
      'skipped',
      COUNTS({
        people: [person(1), person(2, { skippedByYou: true })],
        unskipped: 1,
        waiting: 3,
        pages: 2,
      }),
    );
    await render(el);
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Skipped for country');
    expect(screen.getByTestId('countries-note')).toHaveTextContent(
      'Your business reaches: Only United States. Nobody here is sent a friend request or a message, suggested on Today or listed as a good fit. Unskip lets someone through for good. 1 person is let through. 3 people wait for a look at their profile before they’re reached or skipped.',
    );
    const [first, second] = screen.getAllByTestId('country-row');
    expect(within(first!).getByText('Lives there, on their profile')).toBeTruthy();
    expect(within(second!).getByText('You skipped them')).toBeTruthy();
    await fireEvent.press(within(first!).getByTestId('country-unskip'));
    expect(props.onCall).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: id(1) }),
      'unskip',
    );
    await fireEvent.press(within(second!).getByTestId('country-undo-skip'));
    expect(props.onCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: id(2) }),
      'setting',
    );
    await fireEvent.press(screen.getByTestId('countries-more'));
    expect(props.onMore).toHaveBeenCalled();
  });

  it('says when nobody is skipped, and waits for signal to make a call', async () => {
    await render(body('skipped', COUNTS({ total: 0 })).el);
    expect(screen.getByTestId('countries-empty')).toBeTruthy();
    const { el } = body('unsure', COUNTS({ people: [person(1)] }), { online: false });
    await render(el);
    expect(screen.getByTestId('countries-offline')).toBeTruthy();
    expect(screen.getByTestId('country-let-through')).toBeDisabled();
  });
});

describe('A list’s own screen', () => {
  it('asks for its list a page at a time, and sends each call as the web does', async () => {
    const got = COUNTS({ people: [person(1), person(2, { skippedByYou: true })], pages: 2 });
    const post = api.POST as unknown as jest.Mock;
    post.mockImplementation(async (_path: string, { body }: { body: { page: number } }) => ({
      data: { ...got, page: body.page, people: body.page === 1 ? got.people : [person(3)] },
      response: { ok: true, status: 200 },
    }));
    await render(<CountriesScreen show="skipped" />);
    await waitFor(() => expect(screen.getAllByTestId('country-row')).toHaveLength(2));
    expect(post).toHaveBeenCalledWith('/v1/queries/outreach.countries.skipped', {
      body: { workspaceId: WS, list: 'skipped', page: 1 },
    });
    await fireEvent.press(screen.getByTestId('countries-more'));
    await waitFor(() => expect(screen.getAllByTestId('country-row')).toHaveLength(3));
    await fireEvent.press(screen.getAllByTestId('country-unskip')[0]!);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.country.unskip', {
        workspaceId: WS,
        profileId: id(1),
        through: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Sam Example 1 is let through from now on, whatever the country setting says.',
    );
    await fireEvent.press(screen.getByTestId('country-undo-skip'));
    await waitFor(() =>
      expect(change).toHaveBeenLastCalledWith('outreach.country.decide', {
        workspaceId: WS,
        profileId: id(2),
        choice: 'setting',
      }),
    );
    expect(toast.show).toHaveBeenLastCalledWith('Sam Example 2 is back under the country setting.');
  });
});
