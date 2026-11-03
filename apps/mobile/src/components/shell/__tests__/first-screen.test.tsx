import { router, useLocalSearchParams } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import * as React from 'react';
import { Text } from 'react-native';

import * as MoreLayout from '@/app/app/w/[workspaceId]/(tabs)/(more)/_layout';
import * as OutreachLayout from '@/app/app/w/[workspaceId]/(tabs)/(more)/a/outreach/_layout';

import { TabBar } from '../tab-bar';

/**
 * Back from a More screen opened from another tab comes to More's list, and from a Social Outreach page opened from a
 * link to its list of pages (2026-11-03): Needs you, opened from Home's bell, went Back to Home with Needs you still on
 * top of More, so tapping More opened it again, and there was no way to More's other screens or Social Outreach's
 * other pages. The real tab bar and the real More and Social Outreach layouts, with simple screens in them.
 */

jest.mock('@/addons/gate', () => ({
  AddonGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/addons/outreach/ticker', () => ({ OutreachTicker: () => null }));

const page = (name: string) =>
  function Page() {
    return <Text>{name}</Text>;
  };

function OutreachPage() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return <Text>{view ? `Outreach ${view}` : 'Outreach pages'}</Text>;
}

/** The router's answers: what renderRouter gives back, kept apart from the render it waits for. */
type Router = Pick<ReturnType<typeof renderRouter>, 'getPathname' | 'getPathnameWithParams'>;

async function mount(): Promise<{ at: Router }> {
  const rendered = renderRouter({
    _layout: () => (
      <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="(more)" />
      </Tabs>
    ),
    index: page('Home page'),
    '(more)/_layout': MoreLayout,
    '(more)/more': page('More list'),
    '(more)/tasks': page('Tasks list'),
    '(more)/a/outreach/_layout': OutreachLayout,
    '(more)/a/outreach/index': OutreachPage,
    '(more)/a/outreach/playbooks/[playbookId]': page('A playbook'),
  });
  await rendered;
  // renderRouter's answers sit on what it returns, which is also waited on: handed back as is, they'd be lost.
  return { at: rendered };
}

/** As the screens' Back does (`app-bar.tsx`), with somewhere to go back to. */
async function back() {
  expect(router.canGoBack()).toBe(true);
  await act(async () => router.back());
  await settle();
}

async function open(href: string) {
  await act(async () => router.push(href as never));
  await settle();
}

async function tap(tab: 'home' | 'more') {
  await fireEvent.press(screen.getByTestId(`tab-${tab}`));
  await settle();
}

/**
 * Social Outreach's list of pages is on screen. By its words rather than its address: the router puts the address a
 * page was opened with on the add-on's place in More, and adds it to the list's address too (its screen still reads
 * its own, none).
 */
function onPages(at: Router) {
  expect(at.getPathname()).toBe('/a/outreach');
  expect(screen.getByText('Outreach pages')).toBeOnTheScreen();
}

async function settle() {
  await act(async () => {
    jest.runAllTimers();
  });
}

describe('Back from a screen opened from another tab', () => {
  afterEach(() => jest.useRealTimers());

  it('comes to Social Outreach’s pages, then More’s list, from Needs you opened on Home', async () => {
    const { at } = await mount();
    await open('/a/outreach?view=waiting');
    expect(at.getPathnameWithParams()).toBe('/a/outreach?view=waiting');

    await back();
    onPages(at);
    expect(screen.queryByText('Outreach waiting')).toBeNull();
    await back();
    expect(at.getPathname()).toBe('/more');

    // More opens on its list from then on, rather than Needs you again.
    await tap('home');
    expect(at.getPathname()).toBe('/');
    await tap('more');
    expect(at.getPathname()).toBe('/more');
  });

  it('keeps the screen when the tabs are switched, and a second tap on More comes to its list', async () => {
    const { at } = await mount();
    await open('/a/outreach?view=waiting');
    await tap('home');
    await tap('more');
    expect(at.getPathnameWithParams()).toBe('/a/outreach?view=waiting');
    await tap('more');
    expect(at.getPathname()).toBe('/more');
  });

  it('comes to More’s list from any More screen opened on Home', async () => {
    const { at } = await mount();
    await open('/tasks');
    await back();
    expect(at.getPathname()).toBe('/more');
  });

  it('comes to Social Outreach’s pages from a playbook opened from a link', async () => {
    const { at } = await mount();
    await open('/a/outreach/playbooks/p1');
    expect(screen.getByText('A playbook')).toBeOnTheScreen();
    await back();
    onPages(at);
    await back();
    expect(at.getPathname()).toBe('/more');
  });

  it('changes nothing for screens opened the usual way, from More', async () => {
    const { at } = await mount();
    await tap('more');
    await open('/a/outreach');
    await open('/a/outreach?view=waiting');
    await back();
    expect(at.getPathnameWithParams()).toBe('/a/outreach');
    expect(screen.getByText('Outreach pages')).toBeOnTheScreen();
    await back();
    expect(at.getPathname()).toBe('/more');
    // Nothing more under the list: Back from it leaves More, as it always has.
    await back();
    expect(at.getPathname()).toBe('/');
  });
});
