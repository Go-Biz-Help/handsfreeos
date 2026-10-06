/**
 * The AI teammate and add-ons (round seven, step 5): what an add-on's manifest lets its teammate look up and ask for,
 * turned into tools, and held to the rules. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDON_SERVER_MODULES,
  addonTeammateIssues,
  allTeammateAddonTools,
  ASK_MESSAGE_KEY,
  ASK_SUMMARY_KEY,
  emptyTeammateConfig,
  diffTeammateConfigs,
  manifestIssues,
  teammateAddonDirectory,
  teammateAddonTools,
  teammateUsesAddon,
  type AddonServerModule,
  type AddonTeammate,
} from '../../src/server';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { realestateAddonServer } from '../../src/addons/realestate/server';

/** Real Estate's module with its teammate declaration swapped. */
const withTeammate = (teammate: AddonTeammate): AddonServerModule => ({
  ...realestateAddonServer,
  manifest: { ...realestateAddon, teammate },
});
const LOOKUP = {
  operation: 'realestate.portal.deals',
  tool: 'realestate_my_deals',
  description: 'Their deals.',
};

describe('Real Estate’s teammate tools', () => {
  it('are declared cleanly', () => {
    expect(manifestIssues(realestateAddon)).toEqual([]);
    expect(addonTeammateIssues(ADDON_SERVER_MODULES)).toEqual([]);
  });

  it('look up as the customer on their own, and ask a person before adding a home', () => {
    const tools = allTeammateAddonTools(ADDON_SERVER_MODULES);
    expect(tools.map((t) => [t.name, t.use, t.autonomy, t.op.name])).toEqual([
      ['realestate_my_deals', 'lookup', 'auto', 'realestate.portal.deals'],
      ['realestate_my_deal', 'lookup', 'auto', 'realestate.portal.deal'],
      ['realestate_my_listing', 'lookup', 'auto', 'realestate.portal.listing'],
      ['realestate_my_showings', 'lookup', 'auto', 'realestate.portal.showings'],
      ['realestate_ask_add_home', 'ask', 'approval', 'realestate.home.add'],
    ]);
    // The same objects every time, so the request the provider caches doesn't change.
    expect(allTeammateAddonTools(ADDON_SERVER_MODULES)[0]).toBe(tools[0]);
  });

  it('never let the model name the business, and asks say what to tell the customer', () => {
    const [deals, deal, , , ask] = allTeammateAddonTools(ADDON_SERVER_MODULES);
    expect(Object.keys(deals!.input.shape)).toEqual([]);
    expect(Object.keys(deal!.input.shape)).toEqual(['dealId']);
    expect(ask!.record).toBe('dealId');
    expect(Object.keys(ask!.input.shape)).not.toContain('workspaceId');
    expect(Object.keys(ask!.input.shape)).toEqual(
      expect.arrayContaining(['dealId', 'address', ASK_SUMMARY_KEY, ASK_MESSAGE_KEY]),
    );
    expect(
      ask!.input.safeParse({ dealId: crypto.randomUUID(), address: '412 Oak St' }).success,
    ).toBe(false);
    expect(ask!.description).toMatch(/a person on their team OKs it first/);
    expect(deal!.description).toMatch(/From the Real Estate Agent add-on\.$/);
  });

  it('are offered only while the add-on runs and an owner turned it on', () => {
    const on = (id: string) => id === 'realestate';
    expect(teammateAddonTools(ADDON_SERVER_MODULES, { active: [], on })).toEqual([]);
    expect(
      teammateAddonTools(ADDON_SERVER_MODULES, { active: ['realestate'], on: () => false }),
    ).toEqual([]);
    const offered = teammateAddonTools(ADDON_SERVER_MODULES, { active: ['realestate'], on });
    expect(offered).toHaveLength(5);
    expect(teammateAddonDirectory(ADDON_SERVER_MODULES, offered)).toEqual([
      expect.stringMatching(/^Real Estate Agent \(realestate_…\): their deal with you/),
    ]);
  });
});

describe('the rules', () => {
  it('keep look-ups to what a customer’s portal runs', () => {
    const issues = addonTeammateIssues([
      withTeammate({
        directory: 'x',
        lookups: [
          { ...LOOKUP, operation: 'realestate.homes', tool: 'realestate_homes' },
          { ...LOOKUP, operation: 'realestate.portal.home.add', tool: 'realestate_add' },
          { ...LOOKUP, operation: 'realestate.portal.nothing', tool: 'realestate_none' },
        ],
      }),
    ]);
    expect(issues).toEqual([
      `realestate: teammate look-up "realestate_homes" runs "realestate.homes", which a customer can't`,
      `realestate: teammate look-up "realestate_add" must run a query`,
      `realestate: teammate look-up "realestate_none" runs "realestate.portal.nothing", which it doesn't have`,
    ]);
  });

  it('keep asks to a person’s commands, risk 2 or less, about a record', () => {
    const ask = (operation: string, tool: string, record = 'dealId') => ({
      operation,
      tool,
      description: 'An ask.',
      record,
    });
    const issues = addonTeammateIssues([
      withTeammate({
        directory: 'x',
        lookups: [LOOKUP],
        asks: [
          ask('realestate.portal.home.add', 'realestate_a'),
          ask('realestate.deal.terminate', 'realestate_b'),
          ask('realestate.status_email.drafted', 'realestate_c'),
          ask('realestate.home.add', 'realestate_d', 'homeId'),
          ask('realestate.portal.deals', 'reply'),
        ],
      }),
    ]);
    expect(issues).toEqual([
      `realestate: teammate tool "reply" is already taken`,
      `realestate: teammate ask "realestate_a" runs "realestate.portal.home.add", which a person can't`,
      `realestate: teammate ask "realestate_a" runs "realestate.portal.home.add", which has no permission`,
      `realestate: teammate ask "realestate_b" runs "realestate.deal.terminate", risk 3: asks are 2 or less`,
      `realestate: teammate ask "realestate_c" runs "realestate.status_email.drafted", which a person can't`,
      `realestate: teammate ask "realestate_c" runs "realestate.status_email.drafted", which has no permission`,
      `realestate: teammate ask "realestate_c" names its record by "dealId", which its input doesn't have`,
      `realestate: teammate ask "realestate_d" names its record by "homeId", which its input doesn't have`,
      `realestate: teammate ask "reply" must run a command`,
    ]);
  });

  it('check the manifest’s own words', () => {
    const issues = manifestIssues({
      ...realestateAddon,
      teammate: {
        directory: ' ',
        lookups: [
          { ...LOOKUP, tool: 'deals' },
          { ...LOOKUP, operation: 'realestate.homes', tool: 'realestate_homes' },
          { ...LOOKUP, tool: 'realestate_homes' },
        ],
        asks: [
          {
            operation: 'pm.lease.add',
            tool: 'realestate_lease',
            description: 'A lease.',
            record: 'deal id',
          },
        ],
      },
    }).map((i) => i.message);
    expect(issues).toEqual([
      'teammate.directory must be 1–200 characters',
      'teammate tool "deals" must start with "realestate_", in lowercase words',
      `teammate tool "realestate_lease" runs "pm.lease.add", which isn't one of this add-on's`,
      `teammate look-up "realestate_homes" runs "realestate.homes": look-ups are its portal's ("realestate.portal.*")`,
      `teammate ask "realestate_lease" names its record by "deal id", which isn't an input key`,
      'teammate tool "realestate_homes" is declared twice',
    ]);
  });
});

describe('the teammate’s switch for each add-on', () => {
  it('is off until an owner turns it on, and the change is kept in its history', () => {
    const before = emptyTeammateConfig();
    expect(before.addons).toEqual({});
    expect(teammateUsesAddon(before, 'realestate')).toBe(false);
    const after = { ...before, addons: { realestate: { on: true } } };
    expect(teammateUsesAddon(after, 'realestate')).toBe(true);
    expect(
      diffTeammateConfigs(before, after, { addons: { realestate: 'Real Estate Agent' } }),
    ).toContain('Uses Real Estate Agent: off → on');
  });
});
