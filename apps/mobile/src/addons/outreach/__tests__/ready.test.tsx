import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import { PROFILE_ITEMS_ON } from '@hfos/core/addons/outreach/profile-check';
import {
  PROFILE_ITEMS,
  READY_WORDS,
  type ReadinessOutput,
} from '@hfos/core/addons/outreach/readiness';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { GetReadyCard } from '../ready';

/**
 * Get ready on the phone (decision 63): what's left, each item's state, the person's own three done right here, the
 * profile ticked an item at a time, the messages written on their computer to OK, and the goal with its math, and
 * nothing once they're ready.
 */

jest.mock('@/changes', () => ({
  change: jest.fn(),
  ChangeError: class extends Error {},
}));

const notReady: ReadinessOutput = {
  ready: false,
  next: 'profile',
  changed: [],
  items: [
    { item: 'offer', state: 'done', whose: 'business', left: null },
    { item: 'playbook', state: 'done', whose: 'business', left: null },
    {
      item: 'profile',
      state: 'todo',
      whose: 'person',
      left: '6 things left to check on your Facebook profile.',
    },
    {
      item: 'numbers',
      state: 'todo',
      whose: 'person',
      left: 'Set a goal for calls booked a month, and see what it takes each day.',
    },
  ],
  offer: { version: 1, line: 'We help roofers get booked inspections.' },
  profile: {},
  profileCheck: null,
  messages: { at: null, version: null, samples: null },
  numbers: { goal: null, at: null, days: [1, 2, 3, 4, 5], canSend: 15 },
};

describe('Get ready on the phone', () => {
  it('says what’s left, and ticks a profile item', async () => {
    const onTick = jest.fn(async () => undefined);
    await render(<GetReadyCard readiness={notReady} onTick={onTick} onNumbers={jest.fn()} />);
    expect(
      screen.getByText('2 things to do before the extension reaches anyone for you.'),
    ).toBeTruthy();
    expect(screen.getByText('6 things left to check on your Facebook profile.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    const list = screen.getByTestId('ready-profile-list');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(PROFILE_ITEMS.length);
    await fireEvent.press(screen.getByTestId('ready-profile-bio'));
    await waitFor(() => expect(onTick).toHaveBeenCalledWith('bio', true));
  });

  it('shows the messages written on the computer, and OKs them', async () => {
    const onMessages = jest.fn(async () => true);
    const readiness: ReadinessOutput = {
      ...notReady,
      items: [
        ...notReady.items,
        {
          item: 'messages',
          state: 'todo',
          whose: 'person',
          left: 'See sample messages for your playbook, and OK how they read.',
        },
      ],
      messages: {
        at: null,
        version: null,
        samples: {
          playbookId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          playbookName: 'CRM demos',
          first: ['Hi Sam! Open to 10 booked inspections a month, on a 60-day guarantee?'],
          video: null,
          link: 'Here’s my link to book a quick call: [booking link]',
          followUps: ['Just making sure this didn’t get buried.', 'Should I check back later?'],
          followUpGaps: [1, 2],
          checkIn: 'Thought you might like our storm-season checklist.',
          at: '2026-10-15T09:00:00.000Z',
          version: 1,
        },
      },
    };
    await render(
      <GetReadyCard
        readiness={readiness}
        onTick={jest.fn()}
        onMessages={onMessages}
        onNumbers={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('ready-open-messages'));
    const list = screen.getByTestId('ready-messages-list');
    expect(within(list).getAllByTestId('ready-message-sample')).toHaveLength(5);
    expect(within(list).getByText('If they go quiet: 2 follow-ups')).toBeTruthy();
    expect(within(list).getByText('2 days later')).toBeTruthy();
    expect(within(list).getByText(READY_WORDS.messages.noVideo)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-messages-ok'));
    await waitFor(() => expect(onMessages).toHaveBeenCalled());
  });

  it('works the goal out as it changes, and saves it with the days', async () => {
    const onNumbers = jest.fn(async () => true);
    await render(<GetReadyCard readiness={notReady} onTick={jest.fn()} onNumbers={onNumbers} />);
    await fireEvent.press(screen.getByTestId('ready-open-numbers'));
    expect(screen.getByText('8 calls a month ÷ 22 working days = 0.4 calls a day')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-goal-more'));
    await fireEvent.press(screen.getByTestId('ready-day-6'));
    expect(screen.getByText('9 calls a month ÷ 26 working days = 0.3 calls a day')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-numbers-save'));
    await waitFor(() => expect(onNumbers).toHaveBeenCalledWith(9, [1, 2, 3, 4, 5, 6]));
  });

  it('shows the AI’s check, and asks the computer to put a bio in', async () => {
    const ok = { ok: true, why: 'A clear photo of you.', fix: null };
    const fix = (why: string, change: string) => ({ ok: false, why, fix: change });
    const readiness: ReadinessOutput = {
      ...notReady,
      profileCheck: {
        items: {
          picture: ok,
          cover: fix('It says nothing about roofs.', 'Put your offer on it.'),
          bio: fix('It’s about golf.', 'Say who you help.'),
          work: ok,
          featured: fix('Nothing featured.', 'Feature a result.'),
          posts: ok,
        },
        bios: ['I help roofers book inspections.', 'Booked inspections for roofers.'],
        coverLine: 'Roofers: 10 booked inspections a month.',
        feature: ['A result from a roofer you helped'],
        at: '2026-10-14T15:00:00.000Z',
        version: 1,
      },
    };
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const asks: AsksOutput = {
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer: {
        computerId: '00000000-0000-4000-8000-000000000001',
        name: 'Office laptop',
        online: true,
        signedOut: false,
        lastSeenAt: new Date().toISOString(),
        version: '0.32.0',
      },
      warnedToday: false,
      asks: [],
    };
    await render(
      <GetReadyCard
        readiness={readiness}
        asks={asks}
        actions={actions}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    // Right by the AI: nothing to tick. The rest say what to change, with a tick for when it's done.
    expect(screen.getByTestId('ready-profile-picture-ok')).toBeTruthy();
    expect(screen.queryByTestId('ready-profile-picture')).toBeNull();
    expect(screen.getByText(/Put your offer on it\./)).toBeTruthy();
    expect(screen.getByTestId('ready-profile-cover')).toBeTruthy();
    expect(screen.getByText('“Roofers: 10 booked inspections a month.”')).toBeTruthy();
    expect(screen.getByTestId('ready-profile-read-ask')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-bio-use-1'));
    expect(actions.ask).toHaveBeenCalledWith(
      { kind: 'profile_edit', bio: 'Booked inspections for roofers.' },
      'facebook',
    );
  });

  it('checks LinkedIn’s profile by its own list, in its words, and asks on LinkedIn', async () => {
    const ok = { ok: true, why: 'Looks right.', fix: null };
    const fix = (why: string, change: string) => ({ ok: false, why, fix: change });
    const headline =
      'I help roofers book 10 more inspections a month with plain follow-ups that sound like them, not a robot.';
    const readiness: ReadinessOutput = {
      ...notReady,
      platform: 'linkedin',
      profileCheck: {
        items: {
          picture: ok,
          cover: fix('Nothing read.', 'Put your result on your banner.'),
          bio: fix('Only a job title.', 'Say who you help.'),
          about: fix('Nothing read.', 'Start with who you help.'),
          work: ok,
          featured: ok,
          posts: ok,
        },
        bios: [headline],
        aboutDraft: 'I help roofers book more inspections. Book a call with me below.',
        coverLine: 'Roofers: 10 booked inspections a month.',
        feature: [],
        at: '2026-10-14T15:00:00.000Z',
        version: 1,
      },
    };
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const asks: AsksOutput = {
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer: {
        computerId: '00000000-0000-4000-8000-000000000001',
        name: 'Office laptop',
        online: true,
        signedOut: false,
        lastSeenAt: new Date().toISOString(),
        version: '0.40.0',
      },
      warnedToday: false,
      asks: [],
    };
    const onTick = jest.fn(async () => undefined);
    await render(
      <GetReadyCard
        readiness={readiness}
        asks={asks}
        actions={actions}
        onTick={onTick}
        onNumbers={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    const list = screen.getByTestId('ready-profile-list');
    // LinkedIn's seven, About among them: four right by the AI, three to tick.
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    expect(PROFILE_ITEMS_ON.linkedin).toHaveLength(7);
    expect(within(list).getByText('A headline that says who you help and the result')).toBeTruthy();
    expect(within(list).getByText('Headlines to pick from')).toBeTruthy();
    expect(within(list).getByText('A line for your banner')).toBeTruthy();
    expect(within(list).getByText('Your About')).toBeTruthy();
    expect(
      within(list).getByDisplayValue(
        'I help roofers book more inspections. Book a call with me below.',
      ),
    ).toBeTruthy();
    expect(within(list).queryByText(/Facebook/)).toBeNull();
    await fireEvent.press(screen.getByTestId('ready-profile-about'));
    await waitFor(() => expect(onTick).toHaveBeenCalledWith('about', true));
    await fireEvent.press(screen.getByTestId('ready-bio-use-0'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'profile_edit', bio: headline }, 'linkedin');
  });

  it('puts the picked headline and the About, as changed, in with one press, and nothing in [brackets]', async () => {
    const ok = { ok: true, why: 'Looks right.', fix: null };
    const readiness: ReadinessOutput = {
      ...notReady,
      platform: 'linkedin',
      profileCheck: {
        items: Object.fromEntries(PROFILE_ITEMS_ON.linkedin.map((i) => [i, ok])) as NonNullable<
          ReadinessOutput['profileCheck']
        >['items'],
        bios: [
          'I help roofers book inspections.',
          'Booked inspections for roofers.',
          'Roofers in [your city]: booked inspections.',
        ],
        aboutDraft: 'I help roofers book more inspections.',
        coverLine: null,
        feature: [],
        at: '2026-10-14T15:00:00.000Z',
        version: 1,
      },
    };
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const asks: AsksOutput = {
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer: {
        computerId: '00000000-0000-4000-8000-000000000001',
        name: 'Office laptop',
        online: true,
        signedOut: false,
        lastSeenAt: new Date().toISOString(),
        version: '0.62.0',
      },
      warnedToday: false,
      asks: [],
    };
    await render(
      <GetReadyCard
        readiness={readiness}
        asks={asks}
        actions={actions}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    // A headline still in [brackets] says to fill it in, with nothing to put in.
    expect(screen.queryByTestId('ready-bio-use-2')).toBeNull();
    expect(screen.getByText(READY_WORDS.profile.on.linkedin.items.bio.label)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('ready-bio-pick-1'));
    await fireEvent.changeText(
      screen.getByTestId('ready-about-text'),
      'I help roofers in Austin book more inspections.',
    );
    await fireEvent.press(screen.getByTestId('ready-all-use'));
    expect(actions.ask).toHaveBeenCalledWith(
      {
        kind: 'profile_edit',
        bio: 'Booked inspections for roofers.',
        about: 'I help roofers in Austin book more inspections.',
      },
      'linkedin',
    );
    await fireEvent.press(screen.getByTestId('ready-about-use'));
    expect(actions.ask).toHaveBeenLastCalledWith(
      { kind: 'profile_edit', about: 'I help roofers in Austin book more inspections.' },
      'linkedin',
    );
    // An About with a part left to fill in goes nowhere until it's filled.
    await fireEvent.changeText(
      screen.getByTestId('ready-about-text'),
      'I help roofers in [your city].',
    );
    expect(screen.getByTestId('ready-about-why')).toHaveTextContent(
      'Fill in the parts in [brackets] first.',
    );
    expect(screen.getByTestId('ready-all-use')).toBeDisabled();
    expect(screen.getByTestId('ready-about-use')).toBeDisabled();
  });

  it('checks Instagram’s profile by its own list, with a bio to put in and a name to use', async () => {
    const ok = { ok: true, why: 'Looks right.', fix: null };
    const fix = (why: string, change: string) => ({ ok: false, why, fix: change });
    const readiness: ReadinessOutput = {
      ...notReady,
      platform: 'instagram',
      profileCheck: {
        items: {
          picture: ok,
          name: fix('Only your name.', 'Add what you do.'),
          bio: fix('Nothing about who you help.', 'Say who you help.'),
          link: fix('No link.', 'Add your booking link.'),
          featured: ok,
          posts: ok,
        },
        bios: ['I help roofers book inspections. Book a call ↓'],
        nameDraft: 'Chris | Roofing leads',
        coverLine: null,
        feature: [],
        at: '2026-10-14T15:00:00.000Z',
        version: 1,
      },
    };
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const asks: AsksOutput = {
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer: {
        computerId: '00000000-0000-4000-8000-000000000001',
        name: 'Office laptop',
        online: true,
        signedOut: false,
        lastSeenAt: new Date().toISOString(),
        version: '0.62.0',
      },
      warnedToday: false,
      asks: [],
    };
    await render(
      <GetReadyCard
        readiness={readiness}
        asks={asks}
        actions={actions}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    const list = screen.getByTestId('ready-profile-list');
    // Instagram's six: three right by the AI, three to tick.
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(list).getByText('A name that says what you do and where')).toBeTruthy();
    expect(
      within(screen.getByTestId('ready-name')).getByText('“Chris | Roofing leads”'),
    ).toBeTruthy();
    // No About on Instagram, so nothing to put them all in with.
    expect(screen.queryByTestId('ready-about')).toBeNull();
    expect(screen.queryByTestId('ready-all')).toBeNull();
    await fireEvent.press(screen.getByTestId('ready-bio-use-0'));
    expect(actions.ask).toHaveBeenCalledWith(
      { kind: 'profile_edit', bio: 'I help roofers book inspections. Book a call ↓' },
      'instagram',
    );
  });

  it('checks Alignable’s profile by its own list, and puts About Us in, with its code’s box under it', async () => {
    const ok = { ok: true, why: 'Looks right.', fix: null };
    const fix = (why: string, change: string) => ({ ok: false, why, fix: change });
    const about = 'We help Columbus homeowners keep the rain out. Book a call on our page.';
    const readiness: ReadinessOutput = {
      ...notReady,
      platform: 'alignable',
      profileCheck: {
        items: {
          picture: ok,
          about: fix('Doesn’t say how to book.', 'End with how to book a call.'),
          bio: fix('Not read.', 'Make it with Alignable’s Elevator Pitch button.'),
          work: ok,
          featured: ok,
        },
        bios: [],
        aboutDraft: about,
        coverLine: null,
        feature: [],
        at: '2026-10-20T06:00:00.000Z',
        version: 1,
      },
    };
    const code = jest.fn(async () => true);
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn(), code };
    const computer = {
      computerId: '00000000-0000-4000-8000-000000000001',
      name: 'Office laptop',
      online: true,
      signedOut: false,
      lastSeenAt: new Date().toISOString(),
      version: '0.71.0',
    };
    const asking = {
      askId: '00000000-0000-4000-8000-000000000002',
      platform: 'alignable' as const,
      kind: 'profile_edit' as const,
      target: 'alignable:',
      about: null,
      via: 'mobile' as const,
      state: 'code' as const,
      line: 'Alignable emailed you a code to check it’s you. Look in your email, and type the code here. Your computer puts it in.',
      result: null,
      reply: null,
      askedAt: '2026-10-20T06:05:00.000Z',
      startedAt: '2026-10-20T06:05:10.000Z',
      endedAt: null,
      computerName: 'Office laptop',
    };
    const asksWith = (open: (typeof asking)[]): AsksOutput => ({
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer,
      warnedToday: false,
      asks: open,
    });
    const card = (asks: AsksOutput) => (
      <GetReadyCard
        readiness={readiness}
        asks={asks}
        actions={actions}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />
    );
    const { rerender } = await render(card(asksWith([])));
    await fireEvent.press(screen.getByTestId('ready-open-profile'));
    const list = screen.getByTestId('ready-profile-list');
    // Alignable's five: three right by the AI, the About Us and the pitch to tick.
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    expect(
      within(list).getByText('An About Us that says who you help, where, and how to book'),
    ).toBeTruthy();
    // No bios: its pitch is Alignable's own. About Us goes in on its own.
    expect(screen.queryByTestId('ready-bios')).toBeNull();
    expect(screen.queryByTestId('ready-all')).toBeNull();
    await fireEvent.press(screen.getByTestId('ready-about-use'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'profile_edit', about }, 'alignable');
    // Putting it in waits on the code Alignable emailed: its box is right there.
    await rerender(card(asksWith([asking])));
    const box = within(screen.getByTestId('ready-about')).getByTestId('ask-code');
    await fireEvent.changeText(box, '482913');
    await fireEvent.press(within(screen.getByTestId('ready-about')).getByTestId('ask-code-send'));
    expect(code).toHaveBeenCalledWith(asking, '482913');
  });

  it('says how the last headline put in went once, under them all, and none from before the latest read', async () => {
    const check = {
      items: Object.fromEntries(
        PROFILE_ITEMS_ON.linkedin.map((i) => [
          i,
          { ok: false, why: 'Nothing read.', fix: 'Add it.' },
        ]),
      ) as NonNullable<ReadinessOutput['profileCheck']>['items'],
      bios: ['I help roofers book inspections.', 'Booked inspections for roofers.'],
      aboutDraft: null,
      coverLine: null,
      feature: [],
      at: '2026-10-16T17:12:13.000Z',
      version: 1,
    };
    const edit = (endedAt: string): AsksOutput['asks'][number] => ({
      askId: '00000000-0000-4000-8000-000000000002',
      platform: 'linkedin',
      kind: 'profile_edit',
      target: 'linkedin:',
      about: null,
      via: 'web',
      state: 'failed',
      line: 'Stopped.',
      result: null,
      reply: null,
      askedAt: '2026-10-16T15:36:26.000Z',
      startedAt: '2026-10-16T15:36:30.000Z',
      endedAt,
      computerName: 'Office laptop',
    });
    const asksWith = (ended: string): AsksOutput => ({
      now: new Date().toISOString(),
      timezone: 'America/New_York',
      computer: null,
      warnedToday: false,
      asks: [edit(ended)],
    });
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const shown = async (ended: string) => {
      const view = await render(
        <GetReadyCard
          readiness={{ ...notReady, platform: 'linkedin', profileCheck: check }}
          asks={asksWith(ended)}
          actions={actions}
          onTick={jest.fn()}
          onNumbers={jest.fn()}
        />,
      );
      await fireEvent.press(screen.getByTestId('ready-open-profile'));
      const lines = within(await screen.findByTestId('ready-bios')).queryAllByTestId('ask-line');
      view.unmount();
      return lines.length;
    };
    // Stopped before the latest read: its headlines are gone.
    expect(await shown('2026-10-16T15:40:23.000Z')).toBe(0);
    // Ended after it, as one put in ends after its own read: once, not under each.
    expect(await shown('2026-10-16T17:12:20.000Z')).toBe(1);
  });

  it('shows nothing once they’re ready', async () => {
    await render(
      <GetReadyCard
        readiness={{ ...notReady, ready: true, next: null }}
        onTick={jest.fn()}
        onNumbers={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('get-ready')).toBeNull();
  });
});
