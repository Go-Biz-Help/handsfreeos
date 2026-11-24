import { router, useLocalSearchParams } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { act, fireEvent, renderRouter } from 'expo-router/testing-library';
import * as React from 'react';
import { Text } from 'react-native';

import * as MoreLayout from '@/app/app/w/[workspaceId]/(tabs)/(more)/_layout';
import * as OutreachLayout from '@/app/app/w/[workspaceId]/(tabs)/(more)/a/outreach/_layout';
import { TabBar } from '@/components/shell/tab-bar';

import { RouteInView, useInView } from '../in-view';

/**
 * Which screens count as in view, by the router's own word, with the real tab bar and the real More and Social
 * Outreach layouts (the speed audit, Nov 2026). Social Outreach's pages and the ticker under them stay alive under
 * another of More's screens and on a tab that isn't picked, and asked HandsFreeOS again and again from there; what
 * asks again reads `useInView` and waits. Here: what each part is told as the person moves about.
 */

jest.mock('@/addons/gate', () => ({
  AddonGate: ({ children }: { children: React.ReactNode }) => children,
}));

/** What each part was last told: the ticker under Social Outreach's pages, and each page by name. */
const mockTold: Record<string, boolean> = {};
beforeEach(() => {
  for (const name of Object.keys(mockTold)) delete mockTold[name];
});

function Probe({ name }: { name: string }) {
  mockTold[name] = useInView();
  return <Text>{name}</Text>;
}

jest.mock('@/addons/outreach/ticker', () => ({
  OutreachTicker: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inView = require('../in-view') as { useInView: () => boolean };
    mockTold.ticker = inView.useInView();
    return null;
  },
}));

const page = (name: string) =>
  function Page() {
    return (
      <RouteInView>
        <Probe name={name} />
      </RouteInView>
    );
  };

/** Social Outreach's page by its `?view=`, as the real one; with none, its list of pages, which stays under them. */
function OutreachPage() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return (
    <RouteInView>
      <Probe name={view ?? 'pages'} />
    </RouteInView>
  );
}

async function settle() {
  await act(async () => {
    jest.runAllTimers();
  });
}

async function mount() {
  const rendered = renderRouter({
    _layout: () => (
      <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="(more)" />
      </Tabs>
    ),
    index: page('home'),
    '(more)/_layout': MoreLayout,
    '(more)/more': page('more'),
    '(more)/tasks': page('tasks'),
    '(more)/a/outreach/_layout': OutreachLayout,
    '(more)/a/outreach/index': OutreachPage,
    '(more)/a/outreach/playbooks/[playbookId]': page('playbook'),
  });
  await rendered;
  return rendered;
}

async function open(href: string) {
  await act(async () => router.push(href as never));
  await settle();
}

async function back() {
  await act(async () => router.back());
  await settle();
}

describe('the screen in view', () => {
  afterEach(() => jest.useRealTimers());

  it('is Social Outreach’s page and its ticker while the person is on it', async () => {
    await mount();
    await open('/a/outreach?view=today');
    // Its list of pages is alive under it, and isn't.
    expect(mockTold).toMatchObject({ today: true, pages: false, ticker: true, home: false });
  });

  it('is neither once another tab is picked, and both again on the way back', async () => {
    const { getByTestId } = await mount();
    await open('/a/outreach?view=today');
    await fireEvent.press(getByTestId('tab-home'));
    await settle();
    expect(mockTold).toMatchObject({ today: false, ticker: false, home: true });
    await fireEvent.press(getByTestId('tab-more'));
    await settle();
    expect(mockTold).toMatchObject({ today: true, ticker: true, home: false });
  });

  it('is neither under another of More’s screens', async () => {
    await mount();
    await open('/a/outreach?view=today');
    await open('/tasks');
    expect(mockTold).toMatchObject({ today: false, ticker: false, tasks: true });
    await back();
    expect(mockTold).toMatchObject({ today: true, ticker: true });
  });

  it('is the page on top inside Social Outreach, with the ticker still under it', async () => {
    await mount();
    await open('/a/outreach?view=today');
    await open('/a/outreach/playbooks/p1');
    expect(mockTold).toMatchObject({ today: false, playbook: true, ticker: true });
    await back();
    expect(mockTold).toMatchObject({ today: true, ticker: true });
  });
});
