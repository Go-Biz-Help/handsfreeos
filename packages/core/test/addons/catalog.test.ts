/**
 * The add-on catalogue and its manifests: every rule a manifest is held to, the dependency graph, and the moves the
 * lifecycle allows. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDON_CATALOG,
  CORE_CAPABILITY_DOMAINS,
  INSTALLATION_STATES,
  LIFECYCLE_ACTIONS,
  catalogIssues,
  defineAddon,
  dependencyOrder,
  dependentClosure,
  findRequiredCycle,
  isActiveState,
  manifestIssues,
  moveFor,
  requirementClosure,
  type AddonManifest,
  type InstallationState,
} from '../../src/index';
import { commands, queries } from '../../src/server';
import { FIXTURE_CATALOG, fxprop, fxrent, syntheticCatalog } from './fixtures';

describe('the real catalogue', () => {
  it('is valid', () => {
    expect(catalogIssues(ADDON_CATALOG)).toEqual([]);
  });

  it('never gives an add-on an id core already uses', () => {
    const coreNamespaces = new Set(
      [...commands, ...queries]
        .map((op) => op.name.split('.')[0] ?? '')
        .filter((ns) => !ADDON_CATALOG.some((m) => m.id === ns)),
    );
    for (const m of ADDON_CATALOG) {
      expect(coreNamespaces.has(m.id), `${m.id} is a core namespace`).toBe(false);
      expect(CORE_CAPABILITY_DOMAINS.has(m.id), `${m.id} is a core capability domain`).toBe(false);
    }
  });
});

describe('the fixture catalogue', () => {
  it('is valid, so the rules below are tested against a catalogue that passes them', () => {
    expect(catalogIssues(FIXTURE_CATALOG)).toEqual([]);
  });

  it('shares no id with core', () => {
    const coreNamespaces = new Set([...commands, ...queries].map((op) => op.name.split('.')[0]));
    for (const m of FIXTURE_CATALOG) expect(coreNamespaces.has(m.id)).toBe(false);
  });
});

describe('manifestIssues', () => {
  const broken = (patch: Partial<AddonManifest>) => manifestIssues({ ...fxprop, ...patch });

  it('refuses a bad or reserved id', () => {
    expect(broken({ id: 'Prop' })).not.toEqual([]);
    expect(broken({ id: 'p' })).not.toEqual([]);
    expect(broken({ id: 'platform' }).map((i) => i.message)).toContain('id "platform" is reserved');
  });

  it('keeps everything an add-on owns under its own id', () => {
    const messages = manifestIssues(
      defineAddon({
        ...fxprop,
        capabilities: [{ id: 'other.thing', label: 'x', description: 'x' }],
        permissions: [{ key: 'records.write', label: 'x', description: 'x', defaultRoles: [] }],
        recordKinds: [{ key: 'property', singular: 'P', plural: 'Ps', writePermission: 'x.y' }],
        relationshipTypes: [],
        events: { emits: ['lease.signed'] },
        jobs: ['rent_check'],
        resources: ['bank'],
      }),
    ).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'capability "other.thing" must start with "fxprop."',
        'permission "records.write" must start with "fxprop."',
        'record kind "property" must start with "fxprop_" and be at most 40 characters',
        'event "lease.signed" must start with "fxprop."',
        'job kind "rent_check" must start with "fxprop."',
        'resource kind "bank" must start with "fxprop."',
      ]),
    );
  });

  it('refuses a capability or record kind whose permission the add-on does not declare', () => {
    const messages = broken({
      capabilities: [
        { id: 'fxprop.units', label: 'Units', description: 'Units.', permission: 'fxprop.nope' },
      ],
    }).map((i) => i.message);
    expect(messages).toContain(
      'capability "fxprop.units" needs permission "fxprop.nope", which the add-on doesn\'t declare',
    );
  });

  it('refuses a relationship type on a record kind it does not keep', () => {
    const messages = broken({
      relationshipTypes: [
        {
          key: 'fxprop_x',
          a: { kind: 'person' },
          aLabel: 'A',
          b: { kind: 'record', recordKind: 'fxprop_nothing' },
          bLabel: 'B',
        },
      ],
    }).map((i) => i.message);
    expect(messages).toContain(
      'relationship type "fxprop_x" names record kind "fxprop_nothing", which isn\'t declared',
    );
  });

  it('refuses duplicates and a dependency on itself', () => {
    const messages = broken({
      permissions: [...fxprop.permissions, fxprop.permissions[0]!],
      requires: [{ addon: 'fxprop', kind: 'required', why: 'x' }],
    }).map((i) => i.message);
    expect(messages).toContain('permission "fxprop.read" is declared twice');
    expect(messages).toContain('an add-on cannot depend on itself');
  });

  it('keeps a planned add-on free of code', () => {
    expect(
      broken({ catalog: { ...fxprop.catalog, status: 'planned' } }).map((i) => i.message),
    ).toContain('a planned add-on has no code yet, so it declares no tables, jobs or record kinds');
  });
});

describe('catalogIssues', () => {
  it('finds a dependency on an add-on that is not in the catalogue', () => {
    expect(catalogIssues([fxrent]).map((i) => i.message)).toContain(
      'depends on "fxprop", which isn\'t in the catalogue',
    );
  });

  it('finds the same id twice and a capability two add-ons both provide', () => {
    const messages = catalogIssues([fxprop, { ...fxprop }]).map((i) => i.message);
    expect(messages).toContain('the id "fxprop" is used 2 times');
  });

  it('finds a circle of required dependencies', () => {
    const a = defineAddon({
      ...fxrent,
      id: 'fxa',
      capabilities: [{ id: 'fxa.x', label: 'x', description: 'x' }],
      permissions: [],
      resources: [],
      requires: [{ addon: 'fxb', kind: 'required', why: 'x' }],
    });
    const b = defineAddon({
      ...a,
      id: 'fxb',
      capabilities: [{ id: 'fxb.x', label: 'x', description: 'x' }],
      requires: [{ addon: 'fxa', kind: 'required', why: 'x' }],
    });
    expect(findRequiredCycle([a, b])).toEqual(['fxa', 'fxb', 'fxa']);
    expect(catalogIssues([a, b]).map((i) => i.message)).toContain(
      'required dependencies go round in a circle: fxa → fxb → fxa',
    );
  });

  it('keeps a built add-on from requiring one that is only planned', () => {
    const needsPlanned = defineAddon({
      ...fxrent,
      id: 'fxneeds',
      capabilities: [{ id: 'fxneeds.x', label: 'x', description: 'x' }],
      permissions: [],
      resources: [],
      requires: [{ addon: 'fxinflu', kind: 'required', why: 'x' }],
    });
    expect(catalogIssues([...FIXTURE_CATALOG, needsPlanned]).map((i) => i.message)).toContain(
      'requires "fxinflu", which is only planned',
    );
  });
});

describe('the dependency graph', () => {
  it('walks required dependencies both ways', () => {
    expect(requirementClosure(FIXTURE_CATALOG, 'fxrent')).toEqual(['fxprop']);
    expect(dependentClosure(FIXTURE_CATALOG, 'fxprop')).toEqual(['fxrent']);
    // Optional dependencies never block anything.
    expect(dependentClosure(FIXTURE_CATALOG, 'fxsocial')).toEqual([]);
  });

  it('orders what is needed before what needs it, deterministically', () => {
    expect(dependencyOrder(FIXTURE_CATALOG, ['fxrent', 'fxprop'])).toEqual(['fxprop', 'fxrent']);
    const big = syntheticCatalog(30);
    const ids = big.map((m) => m.id).reverse();
    const order = dependencyOrder(big, ids);
    for (const m of big)
      for (const d of m.requires ?? [])
        expect(order.indexOf(d.addon)).toBeLessThan(order.indexOf(m.id));
    expect(dependencyOrder(big, ids)).toEqual(order);
  });
});

describe('the lifecycle', () => {
  const table: [InstallationState | null, (typeof LIFECYCLE_ACTIONS)[number], string][] = [
    [null, 'install', 'installing'],
    ['uninstalled', 'install', 'installing'],
    ['purged', 'install', 'installing'],
    ['enabled', 'install', 'already'],
    ['installing', 'install', 'already'],
    ['disabled', 'install', 'addon_installed_off'],
    ['uninstalling', 'install', 'addon_busy'],
    ['purging', 'install', 'addon_busy'],
    ['disabled', 'enable', 'enabled'],
    ['enabled', 'enable', 'already'],
    [null, 'enable', 'addon_not_installed'],
    ['uninstalled', 'enable', 'addon_not_installed'],
    ['enabled', 'disable', 'disabled'],
    ['installing', 'disable', 'disabled'],
    ['disabled', 'disable', 'already'],
    ['purged', 'disable', 'addon_not_installed'],
    ['enabled', 'uninstall', 'uninstalling'],
    ['disabled', 'uninstall', 'uninstalling'],
    ['uninstalled', 'uninstall', 'already'],
    ['purging', 'uninstall', 'addon_busy'],
    ['uninstalled', 'purge', 'purging'],
    ['purged', 'purge', 'already'],
    ['enabled', 'purge', 'addon_uninstall_first'],
    ['disabled', 'purge', 'addon_uninstall_first'],
    ['uninstalling', 'purge', 'addon_busy'],
    [null, 'purge', 'addon_not_installed'],
  ];

  it.each(table)('from %s, %s → %s', (from, action, expected) => {
    const move = moveFor(from, action);
    const got = move.kind === 'move' ? move.to : move.kind === 'already' ? 'already' : move.rule;
    expect(got).toBe(expected);
  });

  it('covers every state and action, and only enabled runs', () => {
    for (const s of [null, ...INSTALLATION_STATES])
      for (const a of LIFECYCLE_ACTIONS) expect(moveFor(s, a)).toBeDefined();
    expect(INSTALLATION_STATES.filter(isActiveState)).toEqual(['enabled']);
  });
});
