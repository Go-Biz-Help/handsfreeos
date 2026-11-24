/**
 * What the catalogue brings to a browser. Every signed-in page loads `ADDON_CATALOG` (the side menu, the gate, the
 * Add-ons page), so whatever a manifest imports is in every page's first script, read or not. The speed audit (Nov
 * 2026) found each manifest importing the Assistant's places and its settings' shape, and through them 144 files and
 * 2.6 MB of the add-ons' own words and rules: 168 KB of the 1,089 KB (zipped) a signed-in page loaded first.
 *
 * Those two are in each add-on's server half now (`AddonServerModule.settings` and `.ai`), where the save and the
 * Assistant read them. This keeps them there, and holds the server half to what the manifest used to be held to.
 * Pure: no database.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ADDON_CATALOG } from '../../src/addons/catalog';
import { ADDON_SERVER_MODULES } from '../../src/addons/modules';
import { addonModuleIssues, addonSettingsShapes } from '../../src/addons/server';
import { fxacct, fxprop } from './fixtures';

const SRC = resolve(import.meta.dirname, '../../src');
const IMPORT = /^(?:import|export)\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gms;

/** Every file a file brings with it at run time (never `import type`), and the packages they name. */
function reach(start: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, typeOnly, names = '', from = ''] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const named = names
        .replace(/[{}]/g, '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      if (typeOnly || (named.length > 0 && named.every((n) => n.startsWith('type ')))) continue;
      if (!from.startsWith('.')) {
        packages.add(from);
        continue;
      }
      const base = resolve(dirname(file), from);
      const found = [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find((f) =>
        existsSync(f),
      );
      if (!found) throw new Error(`${relative(SRC, file)} imports ${from}, which isn't a file`);
      walk(found);
    }
  };
  walk(start);
  return { files: [...files].map((f) => relative(SRC, f)), packages: [...packages] };
}

describe('what the catalogue brings to every signed-in page', () => {
  const { files, packages } = reach(resolve(SRC, 'addons/catalog.ts'));

  it('reads nothing of an add-on but its manifest and its page names', () => {
    const own = files.filter((f) => /^addons\/[a-z]+\//.test(f));
    expect(own.length).toBeGreaterThan(0);
    for (const f of own)
      expect(
        /^addons\/[a-z]+\/(manifest|pages)\.ts$/.test(f),
        `${f} is in every signed-in page, because a manifest imports it (or something that does). What only the server reads goes in the add-on's server half (AddonServerModule), and a name the manifest needs in its pages.ts.`,
      ).toBe(true);
  });

  it('brings no schema library, and stays small', () => {
    expect(packages).toEqual([]);
    const bytes = files.reduce((sum, f) => sum + statSync(resolve(SRC, f)).size, 0);
    // 294 KB of source when this was written, most of it the manifests themselves.
    expect(bytes, files.join('\n')).toBeLessThan(400_000);
  });

  it('keeps each add-on’s settings’ shape and the Assistant’s places in its server half', () => {
    for (const m of ADDON_CATALOG) {
      expect(m.settings ?? {}, m.id).not.toHaveProperty('workspace');
      expect(m.settings ?? {}, m.id).not.toHaveProperty('user');
      expect(m.ai ?? {}, m.id).not.toHaveProperty('places');
    }
    // The three with business settings still have them checked, and all five still say where their pages are.
    for (const id of ['realestate', 'outreach', 'contractor'])
      expect(addonSettingsShapes(ADDON_SERVER_MODULES, id).workspace, id).toBeInstanceOf(z.ZodType);
    for (const { manifest, ai } of ADDON_SERVER_MODULES)
      expect(ai?.places?.length, manifest.id).toBeGreaterThan(0);
    expect(addonSettingsShapes(ADDON_SERVER_MODULES, 'nosuchaddon')).toEqual({});
  });
});

describe('addonModuleIssues, for what moved to the server half', () => {
  const core = { commands: [], queries: [] };
  const shape = { workspace: z.object({ closeDay: z.number().default(1) }) };

  it('holds a setting the phone keeps to the settings’ shape', () => {
    const manifest = {
      ...fxacct,
      offline: { permission: 'fxacct.use', tables: [], settings: ['closeDay', 'openDay'] },
    };
    expect(addonModuleIssues(core, [{ manifest, settings: shape }])).toEqual([
      'fxacct: offline setting "openDay" isn\'t one of its settings',
    ]);
    // With no shape at all, none of them is.
    expect(addonModuleIssues(core, [{ manifest }])).toHaveLength(2);
  });

  it('refuses shapes or places the manifest says nothing of', () => {
    expect(addonModuleIssues(core, [{ manifest: fxacct, settings: shape }])).toEqual([]);
    expect(addonModuleIssues(core, [{ manifest: fxprop, settings: shape }])).toEqual([
      "fxprop has settings' shapes, and its manifest declares no settings",
    ]);
    const homes = {
      label: 'Homes',
      what: 'Every home.',
      where: ['Homes'],
      onScreen: ['The list'],
      howTo: ['Add a home: press New home.'],
      path: '',
    };
    // Property Management has a line for the AI; Accounting has none.
    expect(addonModuleIssues(core, [{ manifest: fxprop, ai: { places: [homes] } }])).toEqual([]);
    expect(addonModuleIssues(core, [{ manifest: fxacct, ai: { places: [homes] } }])).toEqual([
      'fxacct tells the AI its pages, and its manifest has no line for the AI',
    ]);
  });
});
