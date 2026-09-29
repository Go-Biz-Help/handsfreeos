/**
 * The Assistant tells people where things are from the settings map, so every way there it gives has to be one a
 * person can really click. It once said "Settings → Territories": there is no such tab — territories are a button
 * under Settings → Calendars — and the person could not find it.
 *
 * So this reads the menus themselves (the side menu, the Settings tabs, and each screen's own row of tabs) and
 * checks every step of every way the map gives against them, every "A → B" its words spell out, and that every
 * screen it links to is a page that exists. A tab renamed, moved or added under another one fails here, not in
 * front of a customer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_PLACES,
  CUSTOMER_PAGES,
  EVERY_PAGE,
  IDEAS_WORDS,
  NOT_ANYWHERE,
  LOOK_ALIKES,
  MONEY_TAB_LABELS,
  PHONE_APP,
  placesText,
  settingsAreas,
  settingsMapText,
  settingsWhere,
} from '../src';

const WEB = resolve(__dirname, '../../../apps/web/src');
const PAGES = join(WEB, 'app/app/w/[workspaceId]');

/**
 * The places a menu file names: every `label: '…'` in it, and the words of a counted one (`label: \`People · ${n}\``
 * is People).
 */
const labelsIn = (file: string): ReadonlySet<string> => {
  const src = readFileSync(join(WEB, file), 'utf8');
  return new Set([
    ...[...src.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!),
    ...[...src.matchAll(/label: `([^`$]+?) · /g)].map((m) => m[1]!),
  ]);
};

/** What may come next after each way so far: the side menu first, then each screen's own tabs. */
const MENUS: Readonly<Record<string, ReadonlySet<string>>> = {
  '': labelsIn('components/shell/nav-links.tsx'),
  Settings: labelsIn('components/settings/settings-nav.tsx'),
  'Settings → Calendars': labelsIn('components/calendars/subnav.tsx'),
  Knowledge: labelsIn('components/knowledge/subnav.tsx'),
  Workflows: labelsIn('components/workflows/subnav.tsx'),
  'AI teammate': labelsIn('components/ai-team/header.tsx'),
  Money: new Set(Object.values(MONEY_TAB_LABELS)),
  Contacts: labelsIn('components/crm/customers-list.tsx'),
  Ideas: new Set(Object.values(IDEAS_WORDS.tabs)),
};

/** Every step of the way is in the menu it is reached from. */
function expectRealWay(way: readonly string[], name: string) {
  expect(way.length, name).toBeGreaterThan(0);
  way.forEach((step, i) => {
    const before = way.slice(0, i).join(' → ');
    const menu = MENUS[before];
    expect(menu, `${name}: nothing is known to follow "${before}"`).toBeTruthy();
    expect([...menu!], `${name}: "${step}" is not in ${before || 'the side menu'}`).toContain(step);
  });
}

/** A business's pages are under /app/w/<workspaceId>; the agency area's say their own /app/org/… in full. */
const pageExists = (path: string) =>
  existsSync(join(path.startsWith('/app/') ? join(WEB, 'app') : PAGES, path, 'page.tsx'));

const EVERY_STEP = [...new Set(Object.values(MENUS).flatMap((m) => [...m]))];
const endsWithStep = (text: string) =>
  EVERY_STEP.filter((l) => text === l || text.endsWith(` ${l}`) || text.endsWith(`(${l}`)).sort(
    (a, b) => b.length - a.length,
  )[0];
const startsWithStep = (text: string) =>
  EVERY_STEP.filter(
    (l) => text === l || (text.startsWith(l) && /^[\s,.;:)]/.test(text.slice(l.length))),
  ).sort((a, b) => b.length - a.length)[0];

/**
 * The ways a sentence spells out: "Open Settings → Calendars → Territories, then…" is Settings, Calendars,
 * Territories. The first step is the end of the words before the first arrow and the last is the start of the words
 * after the last; a way goes on only while the words between two arrows are one step and nothing else.
 */
function waysIn(text: string): string[][] {
  const parts = text.split(' → ');
  const ways: string[][] = [];
  let way: string[] | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    way ??= [endsWithStep(parts[i]!) ?? parts[i]!];
    const next = parts[i + 1]!;
    const step = startsWithStep(next) ?? next;
    way.push(step);
    if (step !== next) {
      ways.push(way);
      way = null;
    }
  }
  if (way) ways.push(way);
  return ways;
}

describe('the settings map', () => {
  it('gives every part of the setup a way there that is really in the menus', () => {
    for (const a of settingsAreas()) {
      expectRealWay(a.where, a.area);
      expect(pageExists(a.path), `${a.area}: no page at ${a.path}`).toBe(true);
      expect(a.onScreen.length, a.area).toBeGreaterThan(0);
      for (const h of a.handovers) {
        if (!h.on) continue;
        expectRealWay(h.on.where, `${a.area}: ${h.what}`);
        expect(pageExists(h.on.path), `${a.area}: no page at ${h.on.path}`).toBe(true);
      }
    }
  });

  it('gives every everyday place a way there that is really in the menus', () => {
    for (const p of APP_PLACES) {
      // Only somewhere off the side menu (the agency area) goes without a way through it, and it says what to press.
      if (p.where.length) expectRealWay(p.where, p.label);
      else expect(p.then, p.label).toBeTruthy();
      expect(pageExists(p.path), `${p.label}: no page at ${p.path}`).toBe(true);
      expect(p.onScreen.length, p.label).toBeGreaterThan(0);
      expect(p.then ?? '', `${p.label}: a click after the menus is said in words`).not.toContain(
        '→',
      );
    }
  });

  it('only ever spells out ways that are really there', () => {
    const words = [
      ...settingsAreas().flatMap((a) => [
        a.what,
        ...a.onScreen,
        ...a.handovers.flatMap((h) => [h.why, ...h.steps]),
        ...(a.howTo ?? []),
        ...(a.notHere ?? []),
      ]),
      ...APP_PLACES.flatMap((p) => [
        p.what,
        ...p.onScreen,
        ...p.howTo,
        ...(p.canChange ?? []),
        ...(p.notHere ?? []),
      ]),
      ...EVERY_PAGE,
      ...NOT_ANYWHERE,
      ...PHONE_APP,
      ...CUSTOMER_PAGES,
      ...LOOK_ALIKES,
    ];
    for (const text of words) for (const way of waysIn(text)) expectRealWay(way, text);
  });

  it('says territories are under Calendars, not straight under Settings', () => {
    expect(settingsWhere('territories')).toBe('Settings → Calendars → Territories');
    expect(settingsMapText()).toContain('Settings → Calendars → Territories');
    expect(settingsMapText()).not.toMatch(/Settings → Territories/);
    expect(placesText()).toContain('Service area');
  });

  it('answers the everyday “how do I…” and says what isn’t there', () => {
    const text = placesText();
    expect(text).toContain('Record a payment');
    expect(text).toContain('Money → Invoices, then press the invoice');
    expect(text).toContain('Not in HandsFreeOS');
    for (const p of APP_PLACES) expect(text, p.label).toContain(p.label);
  });

  it('reads the ways in a sentence the way a person would', () => {
    expect(waysIn('Open Settings → Calendars → Territories, then press New.')).toEqual([
      ['Settings', 'Calendars', 'Territories'],
    ]);
    expect(waysIn('a calendar is Settings → My calendar; a mailbox is Settings → Email.')).toEqual([
      ['Settings', 'My calendar'],
      ['Settings', 'Email'],
    ]);
    // The mistake this file exists for.
    expect(() => expectRealWay(waysIn('Open Settings → Territories.')[0]!, 'test')).toThrow();
  });
});
