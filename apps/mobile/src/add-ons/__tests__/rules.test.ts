import { addonCheckWords, type InstallationState, type LifecycleAction } from '@hfos/core';

import {
  agreedWith,
  anyBusy,
  asksFirst,
  findAddonView,
  groupAddons,
  isEmptyGroups,
  movesFor,
  questionOf,
  troubleOf,
  typedNameMatches,
  type AddonGrants,
} from '../rules';
import { ADDON_PHONE_WORDS } from '../words';
import { ADMIN, FIXTURE_CATALOG, listFor, MEMBER } from './fixtures';

/**
 * What the Add-ons screens show and offer, pinned without drawing anything: the three sections, what each state
 * offers whom (the owner's decisions of 2026-09-28), paid, beta and planned add-ons, trouble in core's words, and the
 * question a refused move asks. The sentences themselves are core's, tested there (test/addons/words.test.ts).
 */

const OWNER_GRANTS: AddonGrants = { manage: true, purge: true };
const ADMIN_GRANTS: AddonGrants = { manage: true, purge: false };
const MEMBER_GRANTS: AddonGrants = { manage: false, purge: false };

const ids = (views: readonly { addonId: string }[]) => views.map((v) => v.addonId);

describe('the sections', () => {
  it('has nothing to show with nothing in the catalogue, as until the first add-on ships', () => {
    const groups = groupAddons(listFor({}, { catalog: [] }), [], OWNER_GRANTS);
    expect(groups).toEqual({ installed: [], addable: [], comingSoon: [] });
    expect(isEmptyGroups(groups)).toBe(true);
  });

  it('puts what the business has first, what could be added next, and what is planned last', () => {
    const list = listFor({ fxprop: 'enabled', fxacct: 'disabled' });
    const groups = groupAddons(list, FIXTURE_CATALOG, OWNER_GRANTS);
    expect(ids(groups.installed)).toEqual(['fxprop', 'fxacct']);
    // Rent Collection can come now its property management is on; Premium Payroll is paid, so support turns it on.
    expect(ids(groups.addable)).toEqual(['fxrent', 'fxsocial', 'fxcontent', 'fxpaid']);
    expect(groups.addable.map((v) => v.offer)).toEqual(['install', 'install', 'install', 'paid']);
    expect(ids(groups.comingSoon)).toEqual(['fxinflu']);
    expect(groups.comingSoon[0]).toMatchObject({ offer: 'coming_soon', moves: [], state: null });
    expect(isEmptyGroups(groups)).toBe(false);
  });

  it('never offers a beta or a deprecated add-on, and offers nothing already here', () => {
    const groups = groupAddons(listFor({ fxprop: 'enabled' }), FIXTURE_CATALOG, OWNER_GRANTS);
    const all = [...groups.installed, ...groups.addable, ...groups.comingSoon].map(
      (v) => v.addonId,
    );
    expect(all).not.toContain('fxbeta');
    expect(all).not.toContain('fxold');
    expect(all.filter((id) => id === 'fxprop')).toHaveLength(1);
  });

  it('keeps one uninstalled, or with its data deleted, among what the business has', () => {
    const list = listFor({ fxprop: 'uninstalled', fxsocial: 'purged' });
    const groups = groupAddons(list, FIXTURE_CATALOG, OWNER_GRANTS);
    expect(ids(groups.installed)).toEqual(['fxprop', 'fxsocial']);
    expect(ids(groups.addable)).not.toContain('fxprop');
    expect(ids(groups.addable)).not.toContain('fxsocial');
    // Installing it again is how it comes back: its data is waiting for it.
    expect(groups.installed[0]).toMatchObject({ offer: 'install', moves: ['install', 'purge'] });
    expect(groups.installed[1]).toMatchObject({ offer: 'install', moves: ['install'] });
  });

  it('shows nothing to add to someone who does not manage add-ons', () => {
    const groups = groupAddons(
      listFor({ fxprop: 'enabled' }, { permissions: MEMBER }),
      FIXTURE_CATALOG,
      MEMBER_GRANTS,
    );
    expect(groups.addable).toEqual([]);
    expect(groups.comingSoon).toEqual([]);
    expect(groups.installed[0]!.moves).toEqual([]);
  });

  it('keeps the catalogue’s order, with add-ons this build doesn’t know at the end', () => {
    const list = listFor({ fxgone: 'uninstalled', fxacct: 'enabled', fxprop: 'enabled' });
    expect(ids(groupAddons(list, FIXTURE_CATALOG, OWNER_GRANTS).installed)).toEqual([
      'fxprop',
      'fxacct',
      'fxgone',
    ]);
  });
});

describe('what each state offers', () => {
  const cases: [InstallationState | null, AddonGrants, string[]][] = [
    ['enabled', OWNER_GRANTS, ['disable', 'uninstall']],
    ['disabled', OWNER_GRANTS, ['enable', 'uninstall']],
    ['uninstalled', OWNER_GRANTS, ['install', 'purge']],
    // Only owners delete an add-on's data.
    ['uninstalled', ADMIN_GRANTS, ['install']],
    ['purged', OWNER_GRANTS, ['install']],
    [null, ADMIN_GRANTS, ['install']],
    // On its way somewhere: progress, and no move.
    ['installing', OWNER_GRANTS, []],
    ['uninstalling', OWNER_GRANTS, []],
    ['purging', OWNER_GRANTS, []],
    // Nobody else moves an add-on.
    ['enabled', MEMBER_GRANTS, []],
    [null, MEMBER_GRANTS, []],
  ];
  it.each(cases)('%s for %j offers %j', (state, grants, moves) => {
    expect(movesFor(state, 'install', grants)).toEqual(moves);
  });

  it('offers Install only where it could be installed', () => {
    expect(movesFor(null, 'support', OWNER_GRANTS)).toEqual([]);
    expect(movesFor(null, 'coming_soon', OWNER_GRANTS)).toEqual([]);
    expect(movesFor('uninstalled', 'support', OWNER_GRANTS)).toEqual(['purge']);
    expect(movesFor('uninstalled', null, ADMIN_GRANTS)).toEqual([]);
  });

  it('lets a retired add-on, whose code is gone, only leave: uninstalled, then its data deleted', () => {
    expect(movesFor('enabled', null, ADMIN_GRANTS, true)).toEqual(['uninstall']);
    expect(movesFor('disabled', null, ADMIN_GRANTS, true)).toEqual(['uninstall']);
    expect(movesFor('uninstalled', null, OWNER_GRANTS, true)).toEqual(['purge']);
    expect(movesFor('uninstalled', null, ADMIN_GRANTS, true)).toEqual([]);
    expect(movesFor('purged', null, OWNER_GRANTS, true)).toEqual([]);
    const view = findAddonView(
      listFor({ fxgone: 'uninstalled' }),
      FIXTURE_CATALOG,
      OWNER_GRANTS,
      'fxgone',
    );
    expect(view).toMatchObject({ retired: true, name: 'fxgone', moves: ['purge'], offer: null });
  });

  it('asks first before every move that takes something away', () => {
    const all: LifecycleAction[] = ['install', 'enable', 'disable', 'uninstall', 'purge'];
    expect(all.filter(asksFirst)).toEqual(['disable', 'uninstall', 'purge']);
  });
});

describe('how one could come to the business', () => {
  it('says support turns on a paid one, and one only support hands out once it was uninstalled', () => {
    const list = listFor({ fxbeta: 'uninstalled', fxpaid: 'purged' });
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxbeta')).toMatchObject({
      offer: 'support',
      moves: ['purge'],
    });
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxpaid')).toMatchObject({
      offer: 'paid',
      moves: [],
    });
  });

  it('asks to add both when one needs another that isn’t here, and offers nothing it can’t install', () => {
    // Rent Collection needs Property Management, which could be installed with it: HandsFreeOS asks about both.
    const list = listFor({});
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxrent')).toMatchObject({
      offer: 'install',
      needs: [
        { addonId: 'fxprop', name: 'Property Management', why: 'Rent is collected on its leases.' },
      ],
    });
    // A deprecated add-on isn't in what HandsFreeOS lists, so it has no screen of its own to open.
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxold')).toBeNull();
  });

  it('knows what it lets you do, what it works with and its switches', () => {
    const list = listFor({ fxacct: 'enabled' });
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxacct')).toMatchObject({
      state: 'enabled',
      does: [
        { label: 'Books and reports', description: 'A ledger, expenses and a profit report.' },
      ],
      flags: [
        { key: 'beta_reports', label: 'Try the new reports', default: false },
        { key: 'daily_digest', label: 'Email a daily summary', default: true },
      ],
      category: 'finance',
      description: 'Keep the books beside the invoices and payments HandsFreeOS already has.',
    });
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxcontent')).toMatchObject({
      worksWith: [
        {
          addonId: 'fxsocial',
          name: 'Social Media Scheduler',
          why: 'It can hand posts to the scheduler.',
        },
      ],
    });
  });

  it('takes what it does from its manifest when HandsFreeOS lists none for it', () => {
    const list = listFor({ fxold: 'uninstalled' });
    expect(findAddonView(list, FIXTURE_CATALOG, OWNER_GRANTS, 'fxold')!.does).toEqual([
      { label: 'Newsletters', description: 'Monthly.' },
    ]);
  });
});

describe('trouble', () => {
  it('says each unfinished check in core’s words, never the worker’s own message', () => {
    expect(
      troubleOf({
        failedChecks: ['no_jobs_pending', 'no_resources_held', 'no_jobs_pending'],
        lastError: 'Not finished: no_jobs_pending (3), no_resources_held (1)',
      }),
    ).toEqual([
      ADDON_PHONE_WORDS.troubleChecks,
      addonCheckWords('no_jobs_pending'),
      addonCheckWords('no_resources_held'),
    ]);
    expect(troubleOf({ failedChecks: ['something_new'], lastError: 'Not finished' })).toEqual([
      ADDON_PHONE_WORDS.troubleChecks,
      'Something it left behind is still being cleared up.',
    ]);
    expect(
      troubleOf({ failedChecks: [], lastError: 'relation "addon_fx.x" does not exist' }),
    ).toEqual([ADDON_PHONE_WORDS.trouble]);
    expect(troubleOf({ failedChecks: [], lastError: null })).toEqual([]);
  });

  it('says nothing of checks left from the move before, once a person has made another', () => {
    // A move clears the trouble at once; the checks the worker stored stay until it looks again.
    expect(troubleOf({ failedChecks: ['no_jobs_pending'], lastError: null })).toEqual([]);
  });

  it('asks again while anything is on its way somewhere', () => {
    expect(anyBusy(listFor({ fxprop: 'enabled', fxacct: 'disabled' }))).toBe(false);
    expect(anyBusy(listFor({ fxprop: 'enabled', fxacct: 'installing' }))).toBe(true);
    expect(anyBusy(listFor({ fxprop: 'purging' }))).toBe(true);
  });
});

describe('the question a refused move asks', () => {
  const refusal = (rule: string, details: unknown) =>
    Object.assign(new Error('Rent Collection needs Property Management. Turn it on too?'), {
      rule,
      details,
      status: 409,
    });

  it('reads the question and the add-ons it is about', () => {
    expect(questionOf(refusal('addon_needs', { addons: ['fxprop'] }))).toEqual({
      rule: 'addon_needs',
      question: 'Rent Collection needs Property Management. Turn it on too?',
      addons: ['fxprop'],
    });
    expect(
      questionOf(refusal('addon_required_by', { addons: ['fxrent', 'fxlate'] }))?.addons,
    ).toEqual(['fxrent', 'fxlate']);
  });

  it('finds none in any other refusal', () => {
    expect(questionOf(refusal('addon_busy', undefined))).toBeNull();
    expect(questionOf(refusal('addon_needs', { addons: [] }))).toBeNull();
    expect(questionOf(refusal('addon_needs', null))).toBeNull();
    expect(questionOf(new TypeError('Network request failed'))).toBeNull();
    expect(questionOf(null)).toBeNull();
  });

  it('keeps everything agreed to so far when it asks again', () => {
    expect(agreedWith(['fxprop'], ['fxsocial', 'fxprop'])).toEqual(['fxprop', 'fxsocial']);
  });
});

describe('the name typed to delete its data', () => {
  it('takes the typed name in any case, with spaces around it', () => {
    expect(typedNameMatches('  property management ', 'Property Management')).toBe(true);
    expect(typedNameMatches('Property', 'Property Management')).toBe(false);
    expect(typedNameMatches('', 'Property Management')).toBe(false);
  });
});

describe('an admin', () => {
  it('manages add-ons and never deletes their data', () => {
    const list = listFor({ fxprop: 'uninstalled' }, { permissions: ADMIN });
    expect(findAddonView(list, FIXTURE_CATALOG, ADMIN_GRANTS, 'fxprop')!.moves).toEqual([
      'install',
    ]);
  });
});
