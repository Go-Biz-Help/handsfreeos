/**
 * Where Social Outreach's pages are, as the Assistant says them (its manifest's `ai.places`): every way it gives is
 * the side menu's Social Outreach row, then one of its pages, then a part on that page's own row, in the screens' own
 * words, and every page's address is one the web opens. It once couldn't say where Team was, and sent a person
 * looking for Social Outreach's team under Members.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonPlaces, addonPlacesText } from '../../src/addons/ai';
import { ADDON_CATALOG } from '../../src/addons/catalog';
import { OUTREACH_LOOK_ALIKES, OUTREACH_PLACES } from '../../src/addons/outreach/ai-places';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { PLATFORM_KEYS, PLATFORMS } from '../../src/addons/outreach/networks';
import { PEOPLE_VIEWS } from '../../src/addons/outreach/people-views';
import { SETTINGS_PART_KEYS } from '../../src/addons/outreach/settings-parts';
import { OUTREACH_WORDS } from '../../src/addons/outreach/words';
import { screenPlace } from '../../src/assistant/screen-place';

const NAME = 'Social Outreach';
const nav = outreachAddon.ui?.nav ?? [];
const PARTS = OUTREACH_WORDS.settingsParts;

/** What may follow each page in its own row: People's views, Find people's parts, and the Settings menu. */
const ROWS: Readonly<Record<string, readonly string[]>> = {
  People: Object.values(PEOPLE_VIEWS),
  'Find people': Object.values(OUTREACH_WORDS.findParts),
  Settings: [
    ...PLATFORM_KEYS.map((p) => PLATFORMS[p]),
    PARTS.computer,
    PARTS.videos,
    PARTS.team,
    PARTS.fresh,
  ],
};

/** The pages the web opens under /a/outreach/, read from its own addresses. */
const WEB_PATHS: ReadonlySet<string> = (() => {
  const src = readFileSync(
    resolve(__dirname, '../../../../apps/web/src/addons/outreach/address.ts'),
    'utf8',
  );
  const block = /const VIEW_PATH[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '';
  const views = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]!);
  const parts = SETTINGS_PART_KEYS.filter((k) => k !== 'general').map((k) => `settings/${k}`);
  return new Set([...views, ...parts, 'playbooks/[playbookId]']);
})();

/** Every "Social Outreach → A → B" the words spell out, as its steps. */
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
    `${name}: "${way[1]}" is not in Social Outreach’s menu`,
  ).toContain(way[1]);
  if (way.length > 2)
    expect(ROWS[way[1]!] ?? [], `${name}: "${way[2]}" is not on ${way[1]}`).toContain(way[2]);
  expect(way.length, name).toBeLessThanOrEqual(3);
}

describe('Social Outreach’s places', () => {
  it('gives each page a way there that is really in its menus, and an address the web opens', () => {
    expect(outreachAddon.ai?.places).toBe(OUTREACH_PLACES);
    for (const p of OUTREACH_PLACES) {
      expectRealWay(p.where, p.label);
      expect(WEB_PATHS, `${p.label}: no page at ${p.path}`).toContain(p.path);
      const page = nav.find((n) => n.label === p.where[1])!;
      expect(p.path === page.path || p.path.startsWith(`${page.path}/`), p.label).toBe(true);
      expect(p.onScreen.length, p.label).toBeGreaterThan(0);
      expect(p.then ?? '', p.label).not.toContain('→');
    }
    // Every page in the side menu, every network's settings and Team are there.
    for (const n of nav) expect(OUTREACH_PLACES.map((p) => p.path)).toContain(n.path);
    for (const k of PLATFORM_KEYS)
      expect(OUTREACH_PLACES.map((p) => p.path)).toContain(`settings/${k}`);
    // Where the Assistant's card links once it saves the business's settings: Team, where they are.
    expect(WEB_PATHS).toContain(outreachAddon.ui?.settingsPath);
    expect(OUTREACH_PLACES.find((p) => p.path === outreachAddon.ui?.settingsPath)?.label).toBe(
      PARTS.team,
    );
  });

  it('only ever spells out ways that are really there', () => {
    const words = [
      ...OUTREACH_PLACES.flatMap((p) => [
        p.what,
        ...p.onScreen,
        ...p.howTo,
        ...(p.canChange ?? []),
        ...(p.notHere ?? []),
      ]),
      ...OUTREACH_LOOK_ALIKES,
    ];
    let seen = 0;
    for (const text of words)
      for (const way of waysIn(text)) {
        expectRealWay(way, text);
        seen++;
      }
    expect(seen).toBeGreaterThan(5);
  });

  it('is said only where Social Outreach runs, to people who may open it, under its own address', () => {
    const may = ['outreach.use'];
    const places = addonPlaces(ADDON_CATALOG, ['outreach'], may);
    expect(places).toHaveLength(OUTREACH_PLACES.length);
    expect(places.every((p) => p.path.startsWith('/a/outreach/'))).toBe(true);
    expect(addonPlaces(ADDON_CATALOG, [], may)).toEqual([]);
    expect(addonPlaces(ADDON_CATALOG, ['outreach'], ['inbox.use'])).toEqual([]);

    const text = addonPlacesText(ADDON_CATALOG, ['outreach'], may).join('\n');
    expect(text).toContain('Social Outreach’s pages');
    expect(text).toContain('- Team is at Social Outreach → Settings → Team:');
    expect(text).toContain('Social Outreach → People → Partners');
    for (const l of OUTREACH_LOOK_ALIKES) expect(text).toContain(l);
    expect(addonPlacesText(ADDON_CATALOG, ['outreach'], [])).toEqual([]);
  });

  it('names the Social Outreach page a question is asked from, with the ids in its address', () => {
    const places = addonPlaces(ADDON_CATALOG, ['outreach'], ['outreach.use']);
    const someone = '7c1f6a52-3b0e-4f8e-9d4b-1a2b3c4d5e6f';
    const team = screenPlace(`/a/outreach/settings/team?for=${someone}`, places);
    expect(team).toMatchObject({
      label: 'Team',
      way: 'Social Outreach → Settings → Team',
      ids: [{ name: 'user', id: someone }],
    });
    expect(screenPlace('/a/outreach/settings/linkedin', places)?.way).toBe(
      'Social Outreach → Settings → LinkedIn',
    );
    // Their settings, as Team opens them: whose they are is a user.
    expect(screenPlace(`/a/outreach/settings?for=${someone}`, places)).toMatchObject({
      way: 'Social Outreach → Settings',
      ids: [{ name: 'user', id: someone }],
    });
    // `?for=` means that only on Social Outreach's Settings: on Settings → Fields it is a kind of record, never a user.
    expect(screenPlace(`/settings/fields?for=${someone}`, places)?.ids).toEqual([
      { name: 'for', id: someone },
    ]);
    expect(screenPlace('/a/outreach/people/friends?show=sent', places)?.way).toBe(
      'Social Outreach → People → Friends',
    );
    const playbook = screenPlace(`/a/outreach/playbooks/${someone}`, places);
    expect(playbook).toMatchObject({
      label: 'A playbook',
      way: 'Social Outreach → Playbooks, then press the playbook',
      ids: [{ name: 'playbook', id: someone }],
    });
    // Without the add-on's places, its pages are named by their address alone, as before.
    expect(screenPlace('/a/outreach/today')).toMatchObject({
      label: null,
      path: '/a/outreach/today',
    });
  });
});
