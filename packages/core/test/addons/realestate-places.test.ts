/**
 * Where the Real Estate Agent's pages are, as the Assistant says them (its manifest's `ai.places`): every way it gives
 * is the side menu's Real Estate Agent row, then one of its pages, then a tab on that page, in the screens' own words,
 * and every page's address is one the web opens. It once had none of them, and couldn't say where a deal's More menu,
 * its photos or a lockbox's code were.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonPlaces, addonPlacesText } from '../../src/addons/ai';
import { ADDON_CATALOG } from '../../src/addons/catalog';
import { REALESTATE_LOOK_ALIKES, REALESTATE_PLACES } from '../../src/addons/realestate/ai-places';
import { KEEPING_WORDS } from '../../src/addons/realestate/keeping-words';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { screenPlace } from '../../src/assistant/screen-place';

const NAME = 'Real Estate Agent';
const nav = realestateAddon.ui?.nav ?? [];

/** What may follow each page in its own row: Deals' views, Coordinate's tabs and Deal settings' tabs. */
const ROWS: Readonly<Record<string, readonly string[]>> = {
  Deals: ['My deals', 'All deals', 'Needs attention', 'Closed', 'Archived'],
  Coordinate: ['Today', 'Exceptions', 'Waiting room', 'Workload'],
  'Deal settings': [
    'Duty list',
    'Alerts & dates',
    'Connections',
    KEEPING_WORDS.tab,
    'Versions',
    'Support access',
  ],
};

/** The pages the web opens under /a/realestate/, read from its own folders (`page.tsx` in each). */
const WEB_PATHS: ReadonlySet<string> = (() => {
  const root = resolve(__dirname, '../../../../apps/web/src/app/app/w/[workspaceId]/a/realestate');
  const found: string[] = [];
  const walk = (dir: string, path: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at, path ? `${path}/${name}` : name);
      else if (name === 'page.tsx') found.push(path);
    }
  };
  walk(root, '');
  return new Set(found);
})();

/** Every "Real Estate Agent → A → B" the words spell out, as its steps. */
function waysIn(text: string): string[][] {
  const ways: string[][] = [];
  let from = text.indexOf(`${NAME} → `);
  while (from >= 0) {
    const way = [NAME];
    let rest = text.slice(from + NAME.length);
    while (rest.startsWith(' → ')) {
      rest = rest.slice(3);
      const menu = way.length === 1 ? nav.map((n) => n.label) : (ROWS[way[way.length - 1]!] ?? []);
      const step = [...menu]
        .sort((a, b) => b.length - a.length)
        .find((l) => rest.startsWith(l) && /^($|[\s,.;:)])/.test(rest.slice(l.length)));
      if (!step) {
        way.push(rest.split(/[,.;:)]| then /)[0]!.trim());
        break;
      }
      way.push(step);
      rest = rest.slice(step.length);
    }
    ways.push(way);
    from = text.indexOf(`${NAME} → `, from + 1);
  }
  return ways;
}

function expectRealWay(way: readonly string[], name: string) {
  expect(way[0], name).toBe(NAME);
  expect(
    nav.map((n) => n.label),
    `${name}: "${way[1]}" is not in the Real Estate Agent’s menu`,
  ).toContain(way[1]);
  if (way.length > 2)
    expect(ROWS[way[1]!] ?? [], `${name}: "${way[2]}" is not on ${way[1]}`).toContain(way[2]);
  expect(way.length, name).toBeLessThanOrEqual(3);
}

describe('the Real Estate Agent’s places', () => {
  it('gives each page a way there that is really in its menus, and an address the web opens', () => {
    expect(realestateAddon.ai?.places).toBe(REALESTATE_PLACES);
    for (const p of REALESTATE_PLACES) {
      expectRealWay(p.where, p.label);
      expect(WEB_PATHS, `${p.label}: no page at ${p.path}`).toContain(p.path);
      expect(p.onScreen.length, p.label).toBeGreaterThan(0);
      expect(p.then ?? '', p.label).not.toContain('→');
      // A deal's own pages open from the deal, under Deals.
      if (p.path.startsWith('deals/')) {
        expect(p.where, p.label).toEqual([NAME, 'Deals']);
        expect(p.then, p.label).toMatch(/^press the deal/);
      } else {
        const page = nav.find((n) => n.label === p.where[1])!;
        expect(p.path, p.label).toBe(page.path);
      }
    }
    // Every page in the side menu, and every page of a deal the web opens, is there.
    const paths = REALESTATE_PLACES.map((p) => p.path);
    for (const n of nav) expect(paths).toContain(n.path);
    for (const w of WEB_PATHS)
      if (w.startsWith('deals/') && !w.endsWith('/summary'))
        expect(paths, `no place for ${w}`).toContain(w);
  });

  it('only ever spells out ways that are really there', () => {
    const words = [
      ...REALESTATE_PLACES.flatMap((p) => [
        p.what,
        ...p.onScreen,
        ...p.howTo,
        ...(p.canChange ?? []),
        ...(p.notHere ?? []),
      ]),
      ...REALESTATE_LOOK_ALIKES,
    ];
    let seen = 0;
    for (const text of words)
      for (const way of waysIn(text)) {
        expectRealWay(way, text);
        seen++;
      }
    expect(seen).toBeGreaterThan(3);
  });

  it('says what only the person does, and never offers a lockbox’s code', () => {
    const text = addonPlacesText(ADDON_CATALOG, ['realestate'], ['realestate.use']).join('\n');
    // Uploading photos and signed forms is the person's, from their own device.
    expect(text).toContain('Upload photos');
    expect(text).toContain('Add a document');
    // A lockbox's code is typed by the person on Showings, and never goes through the Assistant.
    const showings = REALESTATE_PLACES.find((p) => p.path === 'deals/[dealId]/showings')!;
    expect(showings.howTo.join(' ')).toMatch(/never goes through the Assistant/);
    expect((showings.canChange ?? []).join(' ')).toMatch(/without its code/);
    // The More menu's ways to end a listing, as the deal's page names them.
    expect(text).toContain('Withdraw the listing…, The listing expired… or Cancel the listing…');
  });

  it('is said only where the Real Estate Agent runs, to people who may open it, under its own address', () => {
    const may = ['realestate.use'];
    const places = addonPlaces(ADDON_CATALOG, ['realestate'], may);
    expect(places).toHaveLength(REALESTATE_PLACES.length);
    expect(places.every((p) => p.path.startsWith('/a/realestate'))).toBe(true);
    expect(addonPlaces(ADDON_CATALOG, [], may)).toEqual([]);
    expect(addonPlaces(ADDON_CATALOG, ['realestate'], ['inbox.use'])).toEqual([]);

    const text = addonPlacesText(ADDON_CATALOG, ['realestate'], may).join('\n');
    expect(text).toContain('Real Estate Agent’s pages');
    for (const l of REALESTATE_LOOK_ALIKES) expect(text).toContain(l);
    expect(addonPlacesText(ADDON_CATALOG, ['realestate'], [])).toEqual([]);
  });

  it('names the deal page a question is asked from, with the deal’s id', () => {
    const places = addonPlaces(ADDON_CATALOG, ['realestate'], ['realestate.use']);
    const deal = '7c1f6a52-3b0e-4f8e-9d4b-1a2b3c4d5e6f';
    const offer = '0d6b2f1e-8a4c-4e2b-9f3a-5c6d7e8f9a0b';
    expect(screenPlace(`/a/realestate/deals/${deal}`, places)).toMatchObject({
      label: 'A deal',
      ids: [{ name: 'deal', id: deal }],
    });
    expect(screenPlace(`/a/realestate/deals/${deal}/photos`, places)).toMatchObject({
      label: 'Photos',
      ids: [{ name: 'deal', id: deal }],
    });
    expect(screenPlace(`/a/realestate/deals/${deal}/offers/${offer}`, places)).toMatchObject({
      label: 'An offer',
      ids: [
        { name: 'deal', id: deal },
        { name: 'offer', id: offer },
      ],
    });
    expect(screenPlace('/a/realestate/settings?tab=alerts', places)?.label).toBe('Deal settings');
  });
});
