/**
 * What a business can do, could do and is only promised, for businesses with no add-ons, a few, twelve, and twelve
 * with a person who holds fewer permissions — and the rules for what may ever be recommended. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_CAPABILITIES,
  MIN_SCORE,
  canUse,
  capabilitySets,
  currentCapabilityIds,
  planTransition,
  recommendAddons,
  type CapabilityContext,
  type InstallationState,
} from '../../src/index';
import { FIXTURE_CATALOG, TWELVE, syntheticCatalog } from './fixtures';

const everyone = (ids: readonly string[]): string[] =>
  FIXTURE_CATALOG.filter((m) => ids.includes(m.id)).flatMap((m) => m.permissions.map((p) => p.key));
const OWNER_CORE = [
  'records.read',
  'records.write',
  'records.import',
  'inbox.use',
  'appointments.write',
  'calendars.manage',
  'money.read',
  'workflows.manage',
  'reviews.manage',
  'forms.manage',
  'assistant.use',
  'ai_team.manage',
  'knowledge.manage',
];
const on = (ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, 'enabled' as InstallationState]));

/** Workspaces A–D from the brief. */
const A: CapabilityContext = {
  catalog: FIXTURE_CATALOG,
  installations: {},
  permissions: OWNER_CORE,
};
const B: CapabilityContext = {
  catalog: FIXTURE_CATALOG,
  installations: on(['fxprop', 'fxrent', 'fxsocial']),
  permissions: [...OWNER_CORE, ...everyone(['fxprop', 'fxrent', 'fxsocial'])],
};
const C: CapabilityContext = {
  catalog: FIXTURE_CATALOG,
  installations: on(TWELVE),
  permissions: [...OWNER_CORE, ...everyone(TWELVE)],
};
const D: CapabilityContext = {
  ...C,
  // Same add-ons as C, but this person was given none of their permissions and only reads customers.
  permissions: ['records.read', 'inbox.use'],
};

describe('capabilitySets', () => {
  it('A: core only, everything available is installable, planned stays planned', () => {
    const sets = capabilitySets(A);
    expect(sets.current.every((c) => c.provider === 'core')).toBe(true);
    expect(sets.turnedOff).toEqual([]);
    const installable = new Set(sets.installable.map((c) => c.provider));
    expect([...installable].sort()).toEqual(
      [
        'fxacct',
        'fxcare',
        'fxcoach',
        'fxcontent',
        'fxdocs',
        'fxinv',
        'fxjobs',
        'fxproj',
        'fxprop',
        'fxrent',
        'fxseo',
        'fxsocial',
        'fxwarranty',
      ].sort(),
    );
    // Never on offer: planned, beta, paid, deprecated.
    for (const hidden of ['fxinflu', 'fxbeta', 'fxpaid', 'fxgone'])
      expect(installable.has(hidden)).toBe(false);
    expect(sets.planned.map((c) => c.id)).toEqual(['fxinflu.marketplace']);
  });

  it('B: its three add-ons are current; the rest are still installable', () => {
    const sets = capabilitySets(B);
    const current = new Set(sets.current.map((c) => c.provider));
    for (const id of ['fxprop', 'fxrent', 'fxsocial']) expect(current.has(id)).toBe(true);
    expect(sets.installable.some((c) => c.provider === 'fxprop')).toBe(false);
    expect(sets.installable.some((c) => c.provider === 'fxacct')).toBe(true);
  });

  it('C: twelve add-ons on at once', () => {
    const current = new Set(currentCapabilityIds(C));
    for (const id of TWELVE)
      for (const c of FIXTURE_CATALOG.find((m) => m.id === id)!.capabilities)
        expect(current.has(c.id)).toBe(true);
    // None of the fixtures uses a part of core only some add-ons need (the main offer), so those aren't here.
    expect(current.size).toBe(
      CORE_CAPABILITIES.filter((c) => !c.feature).length +
        TWELVE.reduce(
          (n, id) => n + FIXTURE_CATALOG.find((m) => m.id === id)!.capabilities.length,
          0,
        ),
    );
  });

  it('D: the same add-ons, but restricted for a person without their permissions', () => {
    const sets = capabilitySets(D);
    expect(sets.current.some((c) => c.provider !== 'core')).toBe(false);
    for (const id of TWELVE) expect(sets.restricted.some((c) => c.provider === id)).toBe(true);
    // Core capabilities they lack are restricted too, never dropped.
    expect(sets.restricted.some((c) => c.id === 'money.invoices')).toBe(true);
  });

  it('a turned-off add-on is neither current nor installable', () => {
    const ctx: CapabilityContext = {
      ...B,
      installations: { ...B.installations, fxsocial: 'disabled' },
    };
    const sets = capabilitySets(ctx);
    expect(sets.turnedOff.map((c) => c.provider)).toEqual(['fxsocial']);
    expect(sets.current.some((c) => c.provider === 'fxsocial')).toBe(false);
    expect(sets.installable.some((c) => c.provider === 'fxsocial')).toBe(false);
  });

  it('an uninstalled add-on can be installed again; one being removed cannot', () => {
    const gone = capabilitySets({ ...A, installations: { fxacct: 'uninstalled' } });
    expect(gone.installable.some((c) => c.provider === 'fxacct')).toBe(true);
    const going = capabilitySets({ ...A, installations: { fxacct: 'uninstalling' } });
    expect(going.turnedOff.some((c) => c.provider === 'fxacct')).toBe(true);
    expect(going.installable.some((c) => c.provider === 'fxacct')).toBe(false);
  });

  it('HandsFreeOS switching an add-on off (unavailable) stops it where it is installed', () => {
    const ctx: CapabilityContext = { ...B, overrides: { fxprop: 'unavailable' } };
    expect(canUse(ctx, 'fxprop.properties')).toEqual({
      ok: false,
      reason: 'turned_off',
      provider: 'fxprop',
    });
    // And stops it being offered anywhere else.
    expect(
      capabilitySets({ ...A, overrides: { fxprop: 'unavailable' } }).installable.some(
        (c) => c.provider === 'fxprop',
      ),
    ).toBe(false);
  });

  it('an add-on that needs one that cannot be installed is not installable either', () => {
    const ctx: CapabilityContext = { ...A, overrides: { fxjobs: 'unavailable' } };
    expect(capabilitySets(ctx).installable.some((c) => c.provider === 'fxwarranty')).toBe(false);
  });
});

describe('an add-on staff handed a business to try (Real Estate, step 2)', () => {
  it('is installable there, and only there, while it is still being built', () => {
    const granted: CapabilityContext = { ...A, grants: ['fxbeta'] };
    expect(capabilitySets(granted).installable.some((c) => c.provider === 'fxbeta')).toBe(true);
    expect(capabilitySets(A).installable.some((c) => c.provider === 'fxbeta')).toBe(false);
    expect(planTransition(granted, 'fxbeta', 'install').kind).toBe('plan');
    expect(planTransition(A, 'fxbeta', 'install')).toMatchObject({
      kind: 'refused',
      rule: 'addon_not_available',
    });
  });

  it('lets staff hand out a paid one before billing exists', () => {
    const granted: CapabilityContext = { ...A, grants: ['fxpaid'] };
    expect(planTransition(granted, 'fxpaid', 'install').kind).toBe('plan');
  });

  it('never hands out one that is planned, deprecated or switched off everywhere', () => {
    const granted: CapabilityContext = {
      ...A,
      grants: ['fxinflu', 'fxold', 'fxbeta'],
      overrides: { fxbeta: 'unavailable' },
    };
    const installable = new Set(capabilitySets(granted).installable.map((c) => c.provider));
    for (const id of ['fxinflu', 'fxold', 'fxbeta']) expect(installable.has(id)).toBe(false);
  });

  it('is never suggested, even where it is installable', () => {
    const granted: CapabilityContext = { ...A, grants: ['fxbeta'] };
    expect(recommendAddons(granted, 'loyalty points rewards for regulars')).toEqual([]);
  });
});

describe('canUse (workspace.can)', () => {
  it('says why not', () => {
    expect(canUse(B, 'fxprop.leases')).toEqual({ ok: true, provider: 'fxprop' });
    expect(canUse(D, 'fxprop.leases')).toEqual({
      ok: false,
      reason: 'no_permission',
      provider: 'fxprop',
    });
    expect(canUse(A, 'fxprop.leases')).toEqual({
      ok: false,
      reason: 'not_installed',
      provider: 'fxprop',
    });
    expect(canUse(A, 'fxinflu.marketplace')).toEqual({
      ok: false,
      reason: 'planned',
      provider: 'fxinflu',
    });
    expect(canUse(A, 'nothing.here')).toEqual({ ok: false, reason: 'unknown' });
    expect(canUse(A, 'crm.contacts')).toEqual({ ok: true, provider: 'core' });
  });

  it('holds for the system, a workflow and the AI teammate, which have no person’s permissions', () => {
    expect(canUse({ ...B, permissions: null }, 'fxrent.overdue').ok).toBe(true);
    expect(canUse({ ...A, permissions: null }, 'fxrent.overdue').ok).toBe(false);
  });
});

describe('planTransition', () => {
  it('asks before installing what an add-on needs, then installs both in order', () => {
    const plan = planTransition(A, 'fxrent', 'install');
    expect(plan).toMatchObject({ kind: 'needs', rule: 'addon_needs', addons: ['fxprop'] });
    const agreed = planTransition(A, 'fxrent', 'install', ['fxprop']);
    expect(agreed.kind === 'plan' && agreed.moves.map((m) => `${m.action} ${m.addonId}`)).toEqual([
      'install fxprop',
      'install fxrent',
    ]);
  });

  it('doesn’t ask about a dependency already on its way', () => {
    const ctx: CapabilityContext = { ...A, installations: { fxprop: 'installing' } };
    const plan = planTransition(ctx, 'fxrent', 'install');
    expect(plan.kind === 'plan' && plan.moves.map((m) => `${m.action} ${m.addonId}`)).toEqual([
      'install fxrent',
    ]);
  });

  it('turns an installed-but-off dependency back on instead of installing it again', () => {
    const ctx: CapabilityContext = { ...A, installations: { fxprop: 'disabled' } };
    const plan = planTransition(ctx, 'fxrent', 'install', ['fxprop']);
    expect(plan.kind === 'plan' && plan.moves.map((m) => `${m.action} ${m.addonId}`)).toEqual([
      'enable fxprop',
      'install fxrent',
    ]);
  });

  it('asks before turning off an add-on another one needs, then turns both off', () => {
    const plan = planTransition(B, 'fxprop', 'disable');
    expect(plan).toMatchObject({ kind: 'needs', rule: 'addon_required_by', addons: ['fxrent'] });
    expect(plan.kind === 'needs' && plan.message).toBe(
      'Rent Collection needs Property Management. Turn it off too?',
    );
    const agreed = planTransition(B, 'fxprop', 'uninstall', ['fxrent']);
    expect(agreed.kind === 'plan' && agreed.moves.map((m) => `${m.action} ${m.addonId}`)).toEqual([
      'disable fxrent',
      'uninstall fxprop',
    ]);
  });

  it('lets an add-on go that others only use optionally, and says who loses what', () => {
    const ctx: CapabilityContext = {
      ...C,
      installations: { ...C.installations, fxcontent: 'enabled' },
    };
    const plan = planTransition(ctx, 'fxsocial', 'disable');
    expect(plan).toMatchObject({ kind: 'plan', optionalFor: ['fxcontent'] });
  });

  it('refuses what can never be installed here, and repeats nothing', () => {
    expect(planTransition(A, 'fxinflu', 'install')).toMatchObject({
      kind: 'refused',
      rule: 'addon_not_available',
    });
    expect(planTransition(A, 'fxbeta', 'install')).toMatchObject({ kind: 'refused' });
    expect(planTransition(A, 'fxpaid', 'install')).toMatchObject({
      kind: 'refused',
      rule: 'addon_needs_billing',
    });
    expect(planTransition(B, 'fxprop', 'install')).toEqual({ kind: 'already' });
    expect(planTransition(A, 'nothing', 'install')).toMatchObject({ rule: 'addon_unknown' });
  });

  it('lets an add-on HandsFreeOS no longer has leave a business that has it, and nothing more', () => {
    // Its code is gone (retired), but a business still has it on, and another has it uninstalled.
    const retired = { ...B, installations: { ...B.installations, fxgone: 'enabled' as const } };
    expect(planTransition(retired, 'fxgone', 'uninstall')).toEqual({
      kind: 'plan',
      moves: [{ addonId: 'fxgone', action: 'uninstall', from: 'enabled', to: 'uninstalling' }],
      optionalFor: [],
    });
    const kept = { ...B, installations: { ...B.installations, fxgone: 'uninstalled' as const } };
    expect(planTransition(kept, 'fxgone', 'purge')).toEqual({
      kind: 'plan',
      moves: [{ addonId: 'fxgone', action: 'purge', from: 'uninstalled', to: 'purging' }],
      optionalFor: [],
    });
    for (const action of ['install', 'enable', 'disable'] as const)
      expect(planTransition(retired, 'fxgone', action), action).toMatchObject({
        rule: 'addon_unknown',
      });
    // Nowhere here, it is no add-on at all.
    expect(planTransition(B, 'fxgone', 'uninstall')).toMatchObject({ rule: 'addon_unknown' });
    expect(planTransition(B, 'fxgone', 'purge')).toMatchObject({ rule: 'addon_unknown' });
  });
});

describe('recommendAddons', () => {
  it('suggests the add-on that does what was asked, when nothing here does', () => {
    const recs = recommendAddons(A, 'Can you schedule my social media posts for the next month?');
    expect(recs.map((r) => r.addonId)).toEqual(['fxsocial']);
    expect(recs[0]!.score).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it('never suggests a planned add-on, even when it matches perfectly', () => {
    expect(recommendAddons(A, 'find an influencer marketplace to promote us')).toEqual([]);
  });

  it('never suggests beta, paid or deprecated add-ons', () => {
    expect(recommendAddons(A, 'loyalty points and rewards for customers')).toEqual([]);
    expect(recommendAddons(A, 'run payroll and pay wages with a paycheck')).toEqual([]);
    expect(recommendAddons(A, 'send a newsletter mailing')).toEqual([]);
  });

  it('suggests nothing for a normal question, or when the business can already do it', () => {
    expect(recommendAddons(A, 'What needs my attention today?')).toEqual([]);
    expect(recommendAddons(A, 'send an invoice and take a payment')).toEqual([]);
    // Installed already: it is current, not a suggestion.
    expect(recommendAddons(B, 'schedule social posts on facebook')).toEqual([]);
  });

  it('never suggests more than two', () => {
    const ctx: CapabilityContext = { ...A, catalog: syntheticCatalog(30) };
    expect(
      recommendAddons(ctx, 'shared shared word1 word2 word3 synthetic').length,
    ).toBeLessThanOrEqual(2);
  });
});

describe('cost', () => {
  it('works out the sets for thirty add-ons, most of them on, well inside a millisecond budget', () => {
    const catalog = syntheticCatalog(30);
    const ctx: CapabilityContext = {
      catalog,
      installations: Object.fromEntries(
        catalog.slice(0, 20).map((m) => [m.id, 'enabled' as const]),
      ),
      permissions: catalog.flatMap((m) => m.permissions.map((p) => p.key)),
    };
    for (let i = 0; i < 20; i++) capabilitySets(ctx);
    const start = performance.now();
    for (let i = 0; i < 200; i++) capabilitySets(ctx);
    const each = (performance.now() - start) / 200;
    // Generous on purpose (CI machines vary): the point is that it's a pure, in-memory walk.
    expect(each).toBeLessThan(5);
  });
});
