import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { addTime, checkOut } from '@/safety/actions';
import { checkOutChoices, laterChoices, type ActiveCheckIn } from '@/safety/check-in';
import { contactsOf, type MyContact } from '@/safety/use-check-in-context';

import { CheckInStrip } from '../check-in-banner';
import { ToldList } from '../check-in-sheet';
import { reachable, smsLink } from '../help-sheet';

/**
 * Showing safety on the phone (boards 90–91): the planned ends to pick from, who's told, the banner on every screen,
 * and Help's own calling and texting.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/safety/actions', () => ({
  addTime: jest.fn(async () => {}),
  checkOut: jest.fn(async () => {}),
}));
jest.mock('@/changes', () => ({ change: jest.fn(async () => ({})) }));

const TZ = 'America/Chicago';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROWS = [
  {
    id: 'c1',
    contact_user_id: null,
    name: 'Sam Reyes',
    phone_e164: '+15125550142',
    email: 'sam@example.com',
    agreed_at: '2026-09-30T12:00:00Z',
    stopped_at: null,
  },
  {
    id: 'c2',
    contact_user_id: 'u2',
    name: 'Marcus Lee',
    phone_e164: null,
    email: null,
    agreed_at: null,
    stopped_at: null,
  },
  {
    id: 'c3',
    contact_user_id: null,
    name: 'Jo Reyes',
    phone_e164: '+15125550199',
    email: null,
    agreed_at: null,
    stopped_at: null,
  },
];
const CONTACTS: MyContact[] = contactsOf(ROWS, new Set(['u2']));
const ACTIVE: ActiveCheckIn = {
  id: '66666666-6666-4666-8666-666666666666',
  workspaceId: WS,
  place: '2207 Juniper Trail',
  plannedEndAt: '2026-10-01T21:45:00.000Z',
  startedAt: '2026-10-01T21:01:00.000Z',
  state: 'in',
  overdue: false,
  appointmentId: null,
};

describe('checking in', () => {
  it('offers the appointment’s end and the next two quarter hours, or from half an hour on with none', () => {
    const now = Date.parse('2026-10-01T20:58:00.000Z');
    expect(checkOutChoices('2026-10-01T21:30:00.000Z', now)).toEqual([
      '2026-10-01T21:30:00.000Z',
      '2026-10-01T21:45:00.000Z',
      '2026-10-01T22:00:00.000Z',
    ]);
    // No appointment, or one already over: the next quarter hour at least 30 minutes away.
    expect(checkOutChoices(null, now)[0]).toBe('2026-10-01T21:30:00.000Z');
    expect(checkOutChoices('2026-10-01T20:30:00.000Z', now)[0]).toBe('2026-10-01T21:30:00.000Z');
    expect(laterChoices(now)).toEqual([
      '2026-10-01T22:00:00.000Z',
      '2026-10-01T22:30:00.000Z',
      '2026-10-01T23:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);
  });

  it('names who’d be told: teammates on the team and people outside who agreed', async () => {
    expect(CONTACTS.map((c) => [c.name, c.status, c.told])).toEqual([
      ['Sam Reyes', 'agreed', true],
      ['Marcus Lee', 'teammate', true],
      ['Jo Reyes', 'asked', false],
    ]);
    await render(<ToldList contacts={CONTACTS} />);
    expect(screen.getByText('Sam Reyes')).toBeTruthy();
    expect(screen.getByText('Teammate · an alert only they see')).toBeTruthy();
    expect(screen.queryByText('Jo Reyes')).toBeNull();
  });

  it('says the business’s safety person is told when nobody is set', async () => {
    await render(<ToldList contacts={[]} />);
    expect(screen.getByText(/the business’s safety person is told/)).toBeTruthy();
  });
});

describe('the banner while checked in', () => {
  it('says where, until when and who’s told, and checks out or adds time', async () => {
    await render(<CheckInStrip active={ACTIVE} contacts={CONTACTS} timeZone={TZ} />);
    expect(screen.getByTestId('check-in-banner-line')).toHaveTextContent(
      'Until 4:45 PM · Sam and Marcus are told if you don’t check out',
    );
    await fireEvent.press(screen.getByTestId('check-in-add-15'));
    expect(addTime).toHaveBeenCalledWith({ workspaceId: WS, checkInId: ACTIVE.id }, 15);
    await fireEvent.press(screen.getByTestId('check-in-out'));
    expect(checkOut).toHaveBeenCalledWith({ workspaceId: WS, checkInId: ACTIVE.id });
    expect(screen.queryByTestId('check-in-banner-sharing')).toBeNull();
  });

  it('says when the phone is sharing where it is until the check-out', async () => {
    await render(<CheckInStrip active={ACTIVE} contacts={CONTACTS} timeZone={TZ} sharing />);
    expect(screen.getByTestId('check-in-banner-sharing')).toHaveTextContent(
      'Sharing where you are',
    );
  });

  it('asks whether they’re OK once it’s past the planned end', async () => {
    await render(
      <CheckInStrip active={{ ...ACTIVE, overdue: true }} contacts={CONTACTS} timeZone={TZ} />,
    );
    expect(screen.getByTestId('check-in-banner-line')).toHaveTextContent(
      'It’s past 4:45 PM. Are you OK?',
    );
    expect(screen.getByTestId('check-in-out')).toHaveTextContent('I’m OK');
  });
});

describe('Help', () => {
  it('reaches people from the phone itself: outside contacts by text, never anyone who said STOP', () => {
    const stopped = contactsOf(
      [
        {
          ...ROWS[2]!,
          id: 'c4',
          agreed_at: '2026-09-01T00:00:00Z',
          stopped_at: '2026-09-02T00:00:00Z',
        },
      ],
      new Set(),
    );
    expect(reachable([...CONTACTS, ...stopped]).map((r) => [r.contact.name, r.how])).toEqual([
      ['Sam Reyes', 'text'],
      ['Jo Reyes', 'text'],
    ]);
  });

  it('writes the text for them, the way each phone’s texting app reads it', () => {
    expect(smsLink('+15125550142', "I need help. I'm at 2207 Juniper Trail.", 'ios')).toBe(
      "sms:+15125550142&body=I%20need%20help.%20I'm%20at%202207%20Juniper%20Trail.",
    );
    expect(smsLink('+15125550142', 'Hi', 'android')).toBe('sms:+15125550142?body=Hi');
  });
});
