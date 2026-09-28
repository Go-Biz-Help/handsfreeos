/**
 * Add-ons in words: every state and move has its words, and every check the database runs after a move
 * (private.addon_verify) has a line a person can read. Pure: it reads the migration, as other file checks do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADDON_CATEGORIES,
  ADDON_CATEGORY_WORDS,
  ADDON_CHECK_WORDS,
  ADDON_MOVE_WORDS,
  ADDON_PAGE_WORDS,
  ADDON_STATE_WORDS,
  INSTALLATION_STATES,
  LIFECYCLE_ACTIONS,
  addonAgreeWords,
  addonBlockedWords,
  addonCategoryLine,
  addonCheckWords,
  addonHoldsLines,
  addonMovedLine,
  addonMovesFor,
  addonOptionalLine,
  isBusyState,
  possessiveOf,
  type AddonHoldings,
  type InstallationState,
} from '../../src/index';
import { FIXTURE_CATALOG, fxrent } from './fixtures';

const MIGRATIONS = resolve(__dirname, '../../../../supabase/migrations');

/** Every check name private.addon_verify can return, as its latest definition writes them. */
function verifyCheckNames(): string[] {
  const files = readdirSync(MIGRATIONS).sort();
  const source = files
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .filter((s) => s.includes('function private.addon_verify('))
    .at(-1)!;
  const body = source.slice(source.indexOf('function private.addon_verify('));
  const end = body.indexOf('$$;', body.indexOf('as $$') + 5);
  return [...new Set([...body.slice(0, end).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!))];
}

describe('add-on words', () => {
  it('name every state and every move', () => {
    for (const s of INSTALLATION_STATES)
      expect(ADDON_STATE_WORDS[s].label.length).toBeGreaterThan(0);
    for (const a of LIFECYCLE_ACTIONS) expect(ADDON_MOVE_WORDS[a].button.length).toBeGreaterThan(0);
    // Every move that takes something away asks first, and says what it takes.
    for (const a of ['disable', 'uninstall', 'purge'] as const) {
      expect(ADDON_MOVE_WORDS[a].confirm?.('Pool Service')).toContain('Pool Service');
      expect(ADDON_MOVE_WORDS[a].consequence).toBeTruthy();
    }
  });

  it('have a line for every check the database runs after a move', () => {
    const names = verifyCheckNames();
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(ADDON_CHECK_WORDS[name], name).toBeTruthy();
    expect(addonCheckWords('something_new')).toBe(
      'Something it left behind is still being cleared up.',
    );
  });
});

const nothing: AddonHoldings = {
  records: 0,
  relationships: 0,
  pendingJobs: 0,
  heldResources: 0,
  ownRows: 0,
};

describe('the Add-ons page in words', () => {
  it('say a state is on its way exactly when it offers no move', () => {
    for (const s of INSTALLATION_STATES)
      expect(ADDON_STATE_WORDS[s].tone === 'busy', s).toBe(isBusyState(s));
  });

  it('name every category, and a name’s possessive', () => {
    for (const c of ADDON_CATEGORIES) expect(ADDON_CATEGORY_WORDS[c]).toBeTruthy();
    expect(addonCategoryLine('finance')).toBe('Finance add-on');
    expect(addonCategoryLine('mystery')).toBeNull();
    expect(possessiveOf('Rent Collection')).toBe('Rent Collection’s');
    expect(possessiveOf('Demo Properties')).toBe('Demo Properties’');
    expect(ADDON_MOVE_WORDS.purge.confirm?.('Demo Properties')).toBe(
      'Delete Demo Properties’ data for good?',
    );
    expect(ADDON_PAGE_WORDS.paused('SEO Tools')).toContain('switched SEO Tools off');
    expect(ADDON_PAGE_WORDS.notInterestedDone('SEO Tools')).toBe(
      'We won’t suggest SEO Tools again.',
    );
  });

  it('say what a move does with what an add-on has here', () => {
    const holds: AddonHoldings = { ...nothing, records: 12, relationships: 3, pendingJobs: 2 };
    expect(addonHoldsLines('disable', holds)).toEqual([
      '12 records and 3 relationships stay for when it’s back on.',
      '2 things it had scheduled are cancelled.',
    ]);
    expect(addonHoldsLines('uninstall', { ...nothing, records: 1, heldResources: 1 })).toEqual([
      '1 record stays, hidden, until an owner deletes it.',
      'It lets go of 1 thing it holds outside HandsFreeOS.',
    ]);
    expect(addonHoldsLines('purge', { ...holds, ownRows: 1 })).toEqual([
      '12 records keep their names and nothing else.',
      '3 relationships and 1 other saved item are deleted.',
    ]);
    expect(addonHoldsLines('purge', { ...nothing, records: 1 })).toEqual([
      '1 record keeps its name and nothing else.',
    ]);
    // Nothing there, nothing said: the page leaves the part out.
    for (const a of ['disable', 'uninstall', 'purge'] as const)
      expect(addonHoldsLines(a, nothing)).toEqual([]);
  });

  it('answer the question about other add-ons with what yes does', () => {
    expect(addonAgreeWords('install', ['Property Management'])).toBe('Add both');
    expect(addonAgreeWords('enable', ['A', 'B'])).toBe('Turn on all 3');
    expect(addonAgreeWords('disable', ['Rent Collection'])).toBe('Turn off both');
    expect(addonAgreeWords('uninstall', ['Rent Collection'])).toBe(
      'Uninstall and turn off Rent Collection',
    );
    expect(addonAgreeWords('uninstall', ['A', 'B'])).toBe('Uninstall and turn off 2 others');
    expect(addonOptionalLine(['Content Creator'])).toBe(
      'Content Creator uses it and does less without it.',
    );
    expect(addonOptionalLine([])).toBeNull();
  });

  it('say what a move did, naming everything that moved with it', () => {
    const nameOf = (id: string) =>
      ({ fxprop: 'Property Management', fxrent: 'Rent Collection' })[id] ?? id;
    expect(
      addonMovedLine(
        'fxprop',
        'Property Management',
        'uninstall',
        [
          { addonId: 'fxrent', to: 'disabled' },
          { addonId: 'fxprop', to: 'uninstalling' },
        ],
        nameOf,
      ),
    ).toBe(
      'Uninstalling Property Management. It is letting go of what it holds outside HandsFreeOS. Rent Collection is off too.',
    );
    expect(
      addonMovedLine(
        'fxrent',
        'Rent Collection',
        'install',
        [
          { addonId: 'fxprop', to: 'installing' },
          { addonId: 'fxrent', to: 'installing' },
        ],
        nameOf,
      ),
    ).toBe(
      'Setting up Rent Collection. It turns on by itself in a moment. Property Management is being set up too.',
    );
    expect(
      addonMovedLine(
        'fxprop',
        'Demo Properties',
        'purge',
        [{ addonId: 'fxprop', to: 'purging' }],
        nameOf,
      ),
    ).toBe('Deleting Demo Properties’ data. This takes a little while.');
    expect(addonMovedLine('fxprop', 'Property Management', 'enable', [], nameOf)).toBeNull();
  });

  it('say why an add-on can’t be added, when what it needs explains it', () => {
    const stateOf = (states: Record<string, InstallationState>) => (id: string) =>
      states[id] ?? null;
    expect(
      addonBlockedWords(FIXTURE_CATALOG, fxrent, stateOf({ fxprop: 'uninstalling' }), () => true),
    ).toBe('It needs Property Management, which is still being removed.');
    expect(addonBlockedWords(FIXTURE_CATALOG, fxrent, stateOf({}), () => false)).toBe(
      'It needs Property Management, which can’t be added here.',
    );
    expect(
      addonBlockedWords(FIXTURE_CATALOG, fxrent, stateOf({ fxprop: 'disabled' }), () => false),
    ).toBeNull();
  });
});

describe('addonMovesFor', () => {
  const owner = { manage: true, purge: true, installable: true };
  const admin = { manage: true, purge: false, installable: true };
  const member = { manage: false, purge: false, installable: true };

  it('offers each state its moves, in the order their buttons go', () => {
    expect(addonMovesFor(null, owner)).toEqual(['install']);
    expect(addonMovesFor('enabled', owner)).toEqual(['disable', 'uninstall']);
    expect(addonMovesFor('disabled', owner)).toEqual(['enable', 'uninstall']);
    expect(addonMovesFor('uninstalled', owner)).toEqual(['install', 'purge']);
    expect(addonMovesFor('purged', owner)).toEqual(['install']);
  });

  it('offers nothing while it’s on its way, or to someone who can’t manage add-ons', () => {
    for (const s of ['installing', 'uninstalling', 'purging'] as const)
      expect(addonMovesFor(s, owner), s).toEqual([]);
    for (const s of [null, ...INSTALLATION_STATES])
      expect(addonMovesFor(s, member), String(s)).toEqual([]);
  });

  it('leaves deleting data to owners, and Install to what can be installed here', () => {
    expect(addonMovesFor('uninstalled', admin)).toEqual(['install']);
    expect(addonMovesFor('uninstalled', { ...owner, installable: false })).toEqual(['purge']);
    expect(addonMovesFor(null, { ...owner, installable: false })).toEqual([]);
  });

  it('lets a retired add-on only leave', () => {
    const retired = { ...owner, installable: false, retired: true };
    expect(addonMovesFor('enabled', retired)).toEqual(['uninstall']);
    expect(addonMovesFor('disabled', retired)).toEqual(['uninstall']);
    expect(addonMovesFor('uninstalled', retired)).toEqual(['purge']);
    expect(addonMovesFor('uninstalled', { ...retired, purge: false })).toEqual([]);
    expect(addonMovesFor('purged', retired)).toEqual([]);
  });
});
