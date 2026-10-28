import {
  NO_JOURNEY,
  type GroupPeopleOutput,
  type Journey,
} from '@hfos/core/addons/outreach/journey';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { router } from 'expo-router';

import { openWebPath } from '@/home/open';

import { OutreachWorkspace } from '../frame';
import { GroupPageBody } from '../group-page';
import { OutreachSocialBody } from '../social-card';
import { id, WS } from './mocks';

/**
 * How someone came along, on the phone (decision 103): a customer's Social card, with where they stand, the group
 * they were found in (opening its page), the chat's summary and their steps, and their lead in the pipeline
 * (decision 105); and a group's own page of who was found
 * there and how each turned out, a customer opening their page.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const GROUP = id(7);
const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  jest.mocked(openWebPath).mockClear();
  jest.mocked(router.push).mockClear();
});

describe('a customer’s Social card', () => {
  const journey: Journey = {
    ...NO_JOURNEY,
    stage: 'talking',
    why: ['They wrote back'],
    nextStep: 'Send the price list',
    groups: [
      { groupId: GROUP, name: 'Round Rock Contractors', url: 'https://www.facebook.com/groups/1/' },
    ],
    chat: { summary: 'Asked what it costs.', nextStep: null, lastAt: at(2), lastFromMe: false },
    steps: [
      { kind: 'reply', step: null, at: at(2), auto: false, by: null, group: null, postUrl: null },
      {
        kind: 'message',
        step: 'first_message',
        at: at(3),
        auto: false,
        by: 'Riley Member',
        group: null,
        postUrl: null,
      },
      {
        kind: 'friend_request',
        step: null,
        at: at(5),
        auto: true,
        by: null,
        group: { name: 'Round Rock Contractors', url: 'https://www.facebook.com/groups/1/' },
        postUrl: null,
      },
    ],
  };
  const profile = {
    id: id(1),
    platform: 'facebook' as const,
    url: 'https://www.facebook.com/dana.reyes.12',
    name: 'Dana Reyes',
    journey,
  };

  it('says where they stand, the chat and every step, the latest first', async () => {
    await render(<OutreachSocialBody workspaceId={WS} profiles={[profile]} />);
    expect(screen.getByTestId('outreach-social-stage')).toHaveTextContent('Talking');
    expect(screen.getByTestId('outreach-social-why')).toHaveTextContent('They wrote back');
    expect(screen.getByText('Next step: Send the price list')).toBeTruthy();
    expect(screen.getByTestId('outreach-social-chat')).toHaveTextContent(
      /Your chat: Asked what it costs\. They wrote last/,
    );
    const steps = within(screen.getByTestId('outreach-social-steps'));
    expect(steps.getByText(/They wrote back/)).toBeTruthy();
    expect(steps.getByText(/Started a chat \(Riley Member\)/)).toBeTruthy();
    expect(steps.getByText(/Sent a friend request \(on its own\)/)).toBeTruthy();
    expect(steps.getByText(/from Round Rock Contractors/)).toBeTruthy();
  });

  it('opens the group they were found in', async () => {
    await render(<OutreachSocialBody workspaceId={WS} profiles={[profile]} />);
    await fireEvent.press(screen.getByLabelText('Round Rock Contractors'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach?view=groups&group=${GROUP}`);
  });

  it('says where their lead is in the pipeline, and opens it', async () => {
    const lead = {
      leadId: id(9),
      title: 'Dana Reyes (Facebook)',
      stage: 'New',
      status: 'open' as const,
    };
    await render(
      <OutreachSocialBody
        workspaceId={WS}
        profiles={[{ ...profile, journey: { ...journey, lead } }]}
      />,
    );
    expect(screen.getByTestId('outreach-social-lead')).toHaveTextContent('In your pipeline: New');
    await fireEvent.press(screen.getByLabelText('In your pipeline: New'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${WS}/leads/${id(9)}`);
  });

  it('shows nothing for a customer nobody saved from a network', async () => {
    await render(<OutreachSocialBody workspaceId={WS} profiles={[]} />);
    expect(screen.queryByTestId('outreach-social')).toBeNull();
  });
});

describe('a group’s own page', () => {
  const page: GroupPeopleOutput = {
    group: {
      groupId: GROUP,
      platform: 'facebook',
      name: 'Round Rock Contractors',
      url: 'https://www.facebook.com/groups/1/',
      members: 4_210,
      joined: true,
    },
    counts: {
      all: 2,
      not_reached: 1,
      found: 0,
      warming: 0,
      friends: 0,
      talking: 1,
      ready: 0,
      pitched: 0,
      booked: 0,
      client: 0,
      lost: 0,
    },
    people: [
      {
        profileId: id(1),
        personId: id(9),
        name: 'Dana Reyes',
        url: 'https://www.facebook.com/dana.reyes.12',
        runsGroup: false,
        part: 'Members near you',
        stage: 'talking',
        why: ['They wrote back'],
        nextStep: 'Send the price list',
        lastAt: at(2),
      },
      {
        profileId: id(2),
        personId: null,
        name: 'Lee Park',
        url: 'https://www.facebook.com/lee.park.3',
        runsGroup: true,
        part: null,
        stage: null,
        why: ['Runs the group', 'Not reached yet'],
        nextStep: null,
        lastAt: null,
      },
    ],
    page: 1,
    pages: 1,
    total: 2,
  };
  const draw = (onView = jest.fn()) =>
    render(
      <OutreachWorkspace.Provider value={WS}>
        <GroupPageBody
          workspaceId={WS}
          view="all"
          onView={onView}
          page={page}
          error={null}
          onRetry={jest.fn()}
          onMore={jest.fn()}
        />
      </OutreachWorkspace.Provider>,
    );

  it('lists who was found there and how each turned out, with only the outcomes someone has', async () => {
    await draw();
    expect(screen.getByTestId('group-page-name')).toHaveTextContent('Round Rock Contractors');
    expect(screen.getByTestId('group-page-summary')).toHaveTextContent('2 found here, 1 reached');
    const stages = screen.getAllByTestId('group-page-stage');
    expect(stages[0]).toHaveTextContent('Talking');
    expect(stages[1]).toHaveTextContent('Not reached yet');
    expect(screen.getByText('Runs the group · Not reached yet')).toBeTruthy();
    expect(screen.getByTestId('group-page-view-talking')).toBeTruthy();
    expect(screen.getByTestId('group-page-view-not_reached')).toBeTruthy();
    expect(screen.queryByTestId('group-page-view-client')).toBeNull();
  });

  it('opens a customer’s page, and anyone else’s profile', async () => {
    await draw();
    await fireEvent.press(screen.getByLabelText('Dana Reyes'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${WS}/customers/people/${id(9)}`);
  });

  it('shows one outcome at a time', async () => {
    const onView = jest.fn();
    await draw(onView);
    await fireEvent.press(screen.getByTestId('group-page-view-not_reached'));
    expect(onView).toHaveBeenCalledWith('not_reached');
  });
});
