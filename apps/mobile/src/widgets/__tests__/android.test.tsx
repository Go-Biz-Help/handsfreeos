import { buildWidgetsData } from '@hfos/core';
import {
  buildWidgetTree,
  type WidgetTree,
} from 'react-native-android-widget/src/api/build-widget-tree';

import { ANDROID_WIDGETS, renderAndroidWidget, type AndroidWidgetName } from '../android';
import { BIZ, DATA, INPUT, NOW } from './fixture';

/**
 * The Android widgets (docs/phone-widgets.md): each one builds for every size, light and dark, says what the copy
 * says, opens the app's own links, and hides names when asked.
 */

const SIZES = [
  { width: 110, height: 110 },
  { width: 250, height: 110 },
  { width: 250, height: 250 },
  { width: 320, height: 400 },
];

function treeOf(name: AndroidWidgetName, data = DATA, size = SIZES[2]!) {
  const drawn = renderAndroidWidget(name, data, size, NOW);
  if (!('light' in drawn)) throw new Error('expected light and dark');
  return { light: buildWidgetTree(drawn.light), dark: buildWidgetTree(drawn.dark!) };
}

function texts(tree: WidgetTree): string[] {
  const props = tree.props as { text?: string };
  return [...(props.text ? [props.text] : []), ...(tree.children ?? []).flatMap(texts)];
}

function uris(tree: WidgetTree): string[] {
  const props = tree.props as { clickAction?: string; clickActionData?: { uri?: string } };
  const own =
    props.clickAction === 'OPEN_URI' && props.clickActionData?.uri
      ? [props.clickActionData.uri]
      : [];
  return [...own, ...(tree.children ?? []).flatMap(uris)];
}

describe('the Android widgets', () => {
  it('builds every widget at every size, light and dark', () => {
    for (const name of Object.keys(ANDROID_WIDGETS) as AndroidWidgetName[])
      for (const size of SIZES) expect(() => treeOf(name, DATA, size)).not.toThrow();
  });

  it('lists today’s appointments with their times, names and the tasks due', () => {
    const { light } = treeOf('Today');
    const words = texts(light);
    expect(words).toEqual(
      expect.arrayContaining(['Today', 'Now', 'Duct cleaning for Mike Johnson', '11:00 AM']),
    );
    expect(words).toContain('1 task due today');
    expect(uris(light)).toContain(`handsfreeos://app/w/${BIZ}/calendar?appt=a2`);
  });

  it('shows what each thing is instead of a name with Hide names on', () => {
    const hidden = buildWidgetsData({ ...INPUT, hideNames: true });
    const words = [
      ...texts(treeOf('Today', hidden).light),
      ...texts(treeOf('NeedsYou', hidden).light),
    ];
    expect(words).not.toContain('Duct cleaning for Mike Johnson');
    expect(words).not.toContain('Dana Fox');
    expect(words).toEqual(expect.arrayContaining(['Duct cleaning', 'Hot lead']));
  });

  it('puts four buttons on Quick actions, each opening its screen', () => {
    const { light } = treeOf('QuickActions', DATA, SIZES[1]);
    expect(uris(light)).toEqual([
      `handsfreeos://app/w/${BIZ}/customers/new`,
      `handsfreeos://app/w/${BIZ}/money/expenses?add=1`,
      `handsfreeos://app/w/${BIZ}/money/invoices/new`,
      `handsfreeos://app/w/${BIZ}/assistant?talk=1`,
    ]);
  });

  it('shows the money figures, or who sees them', () => {
    expect(texts(treeOf('Money').light)).toEqual(
      expect.arrayContaining(['Owed', '$4,200', 'Late', '$900.50']),
    );
    const notMine = buildWidgetsData({ ...INPUT, money: null });
    expect(texts(treeOf('Money', notMine).light).join(' ')).toContain(
      'Only people who manage money',
    );
  });

  it('shows Social Outreach’s figures, or that it isn’t on', () => {
    expect(texts(treeOf('Outreach').light)).toEqual(
      expect.arrayContaining(['6 of 20', 'First messages']),
    );
    const off = buildWidgetsData({
      ...INPUT,
      addons: [{ addonId: 'outreach', name: 'Social Outreach', facts: null }],
    });
    expect(texts(treeOf('Outreach', off).light).join(' ')).toContain(
      'isn’t on for you in Lone Star HVAC',
    );
  });

  it('asks to open the app before anyone has signed in', () => {
    const drawn = renderAndroidWidget('Today', null, SIZES[0]!, NOW);
    if (!('light' in drawn)) throw new Error('expected light and dark');
    expect(texts(buildWidgetTree(drawn.light))).toContain('Open HandsFreeOS to see your day here.');
  });
});
