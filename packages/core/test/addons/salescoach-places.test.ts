/**
 * Where AI Sales Coach's tabs are, as the Assistant says them (its manifest's `ai.places`): every way it gives is the
 * side menu's AI Sales Coach row, then one of the page's tabs, in the screens' own words, and the tab a question is
 * asked from is named by the address's `?view=`, with a call's or a rep's id kept. It once had none of them, and
 * couldn't say where call scores, Make it the usual one or Delete were.
 */
import { describe, expect, it } from 'vitest';
import { addonPlaces, addonPlacesText } from '../../src/addons/ai';
import { ADDON_CATALOG } from '../../src/addons/catalog';
import { SALESCOACH_LOOK_ALIKES, SALESCOACH_PLACES } from '../../src/addons/salescoach/ai-places';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import {
  SALESCOACH_PAGE_VIEWS,
  SALESCOACH_VIEWS,
  SALESCOACH_WORDS as W,
} from '../../src/addons/salescoach/words';
import { placeLine } from '../../src/assistant/places-map';
import { screenPlace } from '../../src/assistant/screen-place';

const NAME = W.title;
const nav = salescoachAddon.ui?.nav ?? [];
const TABS = SALESCOACH_VIEWS.map((v) => W.tabs[v]);

/** Every "AI Sales Coach → X" the words spell out, as the step after the arrow. */
function waysIn(text: string): string[] {
  const ways: string[] = [];
  let from = text.indexOf(`${NAME} → `);
  while (from >= 0) {
    const rest = text.slice(from + NAME.length + 3);
    ways.push(TABS.find((t) => rest.startsWith(t)) ?? rest.split(/[,.;:)]| then /)[0]!.trim());
    from = text.indexOf(`${NAME} → `, from + 1);
  }
  return ways;
}

describe('AI Sales Coach’s places', () => {
  it('gives each tab a way there that is really on the page, in the page’s order', () => {
    expect(salescoachAddon.ai?.places).toBe(SALESCOACH_PLACES);
    expect(salescoachAddon.ai?.lookAlikes).toBe(SALESCOACH_LOOK_ALIKES);
    expect(nav.map((n) => n.label)).toEqual([NAME]);
    expect(SALESCOACH_PLACES.map((p) => p.label)).toEqual(TABS);
    for (const [i, p] of SALESCOACH_PLACES.entries()) {
      expect(p.where, p.label).toEqual([NAME, TABS[i]]);
      expect(p.path, p.label).toBe(nav[0]!.path);
      expect(p.onScreen.length, p.label).toBeGreaterThan(0);
      // Live call is the bare page; every other tab is its view.
      const view = SALESCOACH_VIEWS[i]!;
      expect(p.view, p.label).toBe(view === 'live' ? undefined : view);
      if (p.view) expect(SALESCOACH_PAGE_VIEWS).toContain(p.view);
    }
  });

  it('only ever spells out ways that are really there', () => {
    const words = [
      ...SALESCOACH_PLACES.flatMap((p) => [
        p.what,
        ...p.onScreen,
        ...p.howTo,
        ...(p.canChange ?? []),
        ...(p.notHere ?? []),
      ]),
      ...SALESCOACH_LOOK_ALIKES,
    ];
    let seen = 0;
    for (const text of words)
      for (const way of waysIn(text)) {
        expect(TABS, `“${text}” names ${way}, which isn’t a tab`).toContain(way);
        seen++;
      }
    expect(seen).toBeGreaterThan(3);
  });

  it('says what only the person does, and how calls pick a playbook', () => {
    const text = addonPlacesText(ADDON_CATALOG, ['salescoach'], ['salescoach.use']).join('\n');
    // Deleting a coached call is for good: the person does it, and who may.
    expect(text).toContain(`${W.calls.delete}, then ${W.calls.deleteConfirm}`);
    expect(text).toMatch(/the Assistant never deletes one/);
    expect(text).toContain('Settings → Permissions');
    // Zoom: linking it and starting its stream are the person's, inside Zoom.
    expect(text).toContain(W.zoom.connect);
    expect(text).toContain(W.zoom.notice);
    // Calls pick by how they started first, then the usual one.
    expect(text).toContain(
      'the one for how the call started (a booked call, a new lead, an older lead or a cold call), else the usual one',
    );
    // The screens' hints the tools' answers don't carry.
    expect(text).toContain('35 to 60%');
    expect(text).toContain('within a week');
    expect(text).toContain('at least 3 calls');
    expect(text).toContain('at least 3 wins');
    // The cards above the call bar and the suggested replies above the reply box.
    expect(text).toContain('above the call bar');
    expect(text).toContain(W.suggest.title);
    expect(text).toContain(W.suggest.hide);
    for (const p of SALESCOACH_PLACES) expect(text).toContain(placeLine(p));
  });

  it('is said only where AI Sales Coach runs, to people who may open it, under its own address', () => {
    const may = ['salescoach.use'];
    const places = addonPlaces(ADDON_CATALOG, ['salescoach'], may);
    expect(places).toHaveLength(SALESCOACH_PLACES.length);
    expect(places.every((p) => p.path === '/a/salescoach')).toBe(true);
    expect(addonPlaces(ADDON_CATALOG, [], may)).toEqual([]);
    expect(addonPlaces(ADDON_CATALOG, ['salescoach'], ['inbox.use'])).toEqual([]);
    const text = addonPlacesText(ADDON_CATALOG, ['salescoach'], may).join('\n');
    expect(text).toContain('AI Sales Coach’s pages');
    for (const l of SALESCOACH_LOOK_ALIKES) expect(text).toContain(l);
  });

  it('names the tab a question is asked from, with the call’s or the rep’s id', () => {
    const places = addonPlaces(ADDON_CATALOG, ['salescoach'], ['salescoach.use']);
    const call = '7c1f6a52-3b0e-4f8e-9d4b-1a2b3c4d5e6f';
    const rep = '0d6b2f1e-8a4c-4e2b-9f3a-5c6d7e8f9a0b';
    expect(screenPlace('/a/salescoach', places)).toMatchObject({
      label: W.tabs.live,
      way: `${NAME} → ${W.tabs.live}`,
      ids: [],
    });
    expect(screenPlace(`/a/salescoach?view=calls&call=${call}`, places)).toMatchObject({
      label: W.tabs.calls,
      ids: [{ name: 'coached call', id: call }],
    });
    expect(screenPlace(`/a/salescoach?view=trends&weeks=26&rep=${rep}`, places)).toMatchObject({
      label: W.tabs.trends,
      ids: [{ name: 'user', id: rep }],
    });
    expect(screenPlace('/a/salescoach?view=playbooks', places)?.label).toBe(W.tabs.playbooks);
    // A view the tabs don't have (the Zoom panel's), or none, is the page itself: Live call.
    expect(screenPlace('/a/salescoach?view=zoom', places)?.label).toBe(W.tabs.live);
    expect(screenPlace('/a/salescoach?view=nothing', places)?.label).toBe(W.tabs.live);
    // Core's pages are named as before.
    expect(screenPlace('/inbox', places)?.label).toBe('Inbox');
  });
});
