import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { change } from '@/changes';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api } from '@/lib/api';

import { PersonMenu, type MenuPerson } from '../person-menu';
import { id, WS } from './mocks';

/**
 * The person menu on the phone's Today (decision 44), as the web's: Add to Contacts, offering the customers with the
 * same name first; In Contacts once they are; Demo booked; and Don't pitch. Each needs signal.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: { addedPerson: true } })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual<object>('@/components/ui/toast'),
  toast: { show: jest.fn(), error: jest.fn() },
}));

const PROFILE = id(50);
const CUSTOMER = id(60);
const DANA: MenuPerson = {
  profileId: PROFILE,
  name: 'Dana Reyes',
  personId: null,
  demoBooked: false,
};

const lookupAnswers = (people: { hasProfile: boolean }[]) =>
  (api.POST as unknown as jest.Mock).mockResolvedValue({
    data: {
      profiles: [],
      marks: [],
      threads: [],
      sameName: [
        {
          name: 'Dana Reyes',
          people: people.map((p, i) => ({
            personId: i ? id(61 + i) : CUSTOMER,
            name: 'Dana Reyes',
            email: 'dana@example.com',
            phone: null,
            source: 'Website',
            createdAt: '2026-03-02T15:00:00.000Z',
            hasProfile: p.hasProfile,
          })),
        },
      ],
    },
    response: { ok: true },
  } as never);

const open = async (who: MenuPerson = DANA, online = true) => {
  const onChanged = jest.fn();
  await render(<PersonMenu workspaceId={WS} who={who} online={online} onChanged={onChanged} />);
  await fireEvent.press(screen.getByTestId('person-menu'));
  return onChanged;
};

beforeEach(() => {
  jest.mocked(change).mockClear();
  (api.POST as unknown as jest.Mock).mockReset();
  jest.mocked(toast.show).mockClear();
  jest.mocked(openWebPath).mockClear();
});

describe('The person menu on the phone', () => {
  it('offers the customer with the same name first, and ties them on It’s them', async () => {
    lookupAnswers([{ hasProfile: false }]);
    const onChanged = await open();
    await fireEvent.press(screen.getByTestId('person-add-contact'));
    expect(api.POST).toHaveBeenCalledWith('/v1/queries/outreach.lookup', {
      body: { workspaceId: WS, names: ['Dana Reyes'] },
    });
    expect(await screen.findByText('Is Dana Reyes one of these?')).toBeTruthy();
    expect(screen.getByText('dana@example.com · Website · added Mar 2, 2026')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('person-same-them'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.profile.contact', {
        workspaceId: WS,
        profileId: PROFILE,
        personId: CUSTOMER,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is tied to them in Contacts now.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('adds them at once when nobody else has the name, or only someone with a profile of their own', async () => {
    lookupAnswers([{ hasProfile: true }]);
    await open();
    await fireEvent.press(screen.getByTestId('person-add-contact'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.profile.contact', {
        workspaceId: WS,
        profileId: PROFILE,
        personId: null,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Dana Reyes is in Contacts now.');
    expect(screen.queryByText('Is Dana Reyes one of these?')).toBeNull();
  });

  it('marks a demo booked, and puts them on Don’t pitch', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('person-demo-mark'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.demo.mark', {
        workspaceId: WS,
        profileId: PROFILE,
        booked: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Marked: Dana Reyes booked a demo.');
    await fireEvent.press(screen.getByTestId('person-menu'));
    await fireEvent.press(screen.getByTestId('person-dont-pitch'));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('outreach.friend.set', {
        workspaceId: WS,
        profileId: PROFILE,
        dontPitch: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(
      'Dana Reyes is on Don’t pitch. Nobody here sends them outreach.',
    );
  });

  it('opens them in Contacts once they’re there, and takes a demo back', async () => {
    await open({ ...DANA, personId: CUSTOMER, demoBooked: true });
    expect(screen.queryByTestId('person-add-contact')).toBeNull();
    expect(screen.getByText('Not a demo after all')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-in-contacts'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/customers/people/${CUSTOMER}`);
  });

  it('says it needs signal, and sends nothing, with none', async () => {
    await open(DANA, false);
    expect(screen.getByText(/need signal\. Try again when you’re back online\.$/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-add-contact'));
    await fireEvent.press(screen.getByTestId('person-dont-pitch'));
    expect(api.POST).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  it('shows nothing for someone not kept as a profile', async () => {
    await render(
      <PersonMenu
        workspaceId={WS}
        who={{ ...DANA, profileId: null }}
        online
        onChanged={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('person-menu')).toBeNull();
  });
});
