/**
 * Add-on operations as the Assistant's tools, and what `find_capabilities` answers (docs/addon-readiness-audit.md §8),
 * over made-up modules for the fixture add-ons: offered only while the add-on runs and to people who hold the
 * permission, never with the business's ids in the model's hands, never looser than the operation's risk, named for
 * their add-on, and in the same order every time so the cached prompt holds. Pure.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolInputSchema } from '../../src/assistant/tools';
import {
  AI_TOOL_NAME,
  ADDON_SERVER_MODULES,
  addonAiIssues,
  addonAssistantIssues,
  addonAiToolByName,
  addonAiTools,
  addonDirectory,
  addonModuleIssues,
  addonOperationInput,
  addonToolArguments,
  addonToolAutonomy,
  addonToolDescription,
  allAddonAiTools,
  assistantTools,
  autonomyFloor,
  commands,
  defineAddonCommand,
  defineAddonQuery,
  findCapabilities,
  isAddonAiTool,
  queries,
  type AddonManifest,
  type AddonServerModule,
  type CapabilityContext,
  type CommandDef,
  type InstallationState,
  type OperationAi,
  type Permission,
  type QueryDef,
  type RiskLevel,
} from '../../src/server';
import { FIXTURE_CATALOG, TWELVE, fxprop, fxrent, syntheticCatalog } from './fixtures';

const ws = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const elsewhere = '33333333-3333-4333-8333-333333333333';
const scope = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const nothing = z.object({});
const perm = (key: string) => key as Permission;

/** A look-up in an add-on, offered to the AI as `tool`. */
function lookUp(
  m: AddonManifest,
  name: string,
  permission: string | null,
  ai: OperationAi | undefined,
  input: z.ZodType = z.object({ workspaceId: z.uuid(), q: z.string().max(80).optional() }),
): QueryDef {
  return defineAddonQuery(m, {
    name: `${m.id}.${name}` as `${string}.${string}`,
    description: `Look up ${name.replace(/[._]/g, ' ')}.`,
    input,
    output: nothing,
    permission: permission === null ? null : perm(permission),
    scope: scope as (i: unknown) => ReturnType<typeof scope>,
    ...(ai ? { ai } : {}),
    handler: async () => ({}),
  }) as unknown as QueryDef;
}

/** A change in an add-on, at a risk, offered to the AI as `tool`. */
function change(
  m: AddonManifest,
  name: string,
  risk: RiskLevel,
  permission: string | null,
  ai: OperationAi | undefined,
  input: z.ZodType = z.object({ workspaceId: z.uuid(), title: z.string().min(1).max(80) }),
): CommandDef {
  return defineAddonCommand(m, {
    name: `${m.id}.${name}` as `${string}.${string}`,
    description: `Change ${name.replace(/[._]/g, ' ')}.`,
    risk,
    input,
    output: nothing,
    permission: permission === null ? null : perm(permission),
    scope: scope as (i: unknown) => ReturnType<typeof scope>,
    emits: [],
    ...(ai ? { ai } : {}),
    handler: async () => ({}),
  }) as unknown as CommandDef;
}

/** Property Management: every kind of operation the rules have to sort. */
const PROP: AddonServerModule = {
  manifest: fxprop,
  queries: [
    lookUp(fxprop, 'lease.list', 'fxprop.read', {
      tool: 'fxprop_list_leases',
      description: 'Leases with their rent and due day',
      keywords: ['rent roll', 'tenancy'],
    }),
    // No permission: anyone who works in the business.
    lookUp(fxprop, 'unit.count', null, { tool: 'fxprop_count_units' }),
    // Digits are fine in a name (the ledgers take them since 20261013000500).
    lookUp(fxprop, 'form.list', 'fxprop.read', { tool: 'fxprop_list_1099s' }),
    // Kept from the AI on purpose, and a look-up that asks to wait for an OK (which it can't).
    lookUp(fxprop, 'ledger.export', 'fxprop.read', {
      tool: 'fxprop_export_ledger',
      autonomy: 'never',
    }),
    lookUp(fxprop, 'owner.statement', 'fxprop.read', {
      tool: 'fxprop_owner_statement',
      autonomy: 'confirm',
    }),
    // Not offered to the AI at all.
    lookUp(fxprop, 'unit.list', 'fxprop.read', undefined),
  ],
  commands: [
    change(fxprop, 'note.add', 1, 'fxprop.write', { tool: 'fxprop_add_note' }),
    change(fxprop, 'lease.end', 2, 'fxprop.write', { tool: 'fxprop_end_lease' }),
    // Stricter than its risk: fine. Looser than its risk: ignored.
    change(fxprop, 'unit.rename', 0, 'fxprop.write', {
      tool: 'fxprop_rename_unit',
      autonomy: 'confirm',
    }),
    change(fxprop, 'tenant.notify', 3, 'fxprop.write', {
      tool: 'fxprop_notify_tenant',
      autonomy: 'auto',
    }),
    // Risk 4 is never the AI's; a command with no permission is HandsFreeOS's own work.
    change(fxprop, 'data.wipe', 4, 'fxprop.write', { tool: 'fxprop_wipe_data' }),
    change(fxprop, 'rent.sweep', 1, null, { tool: 'fxprop_sweep_rent' }),
    // An input that also names the organization gets both ids from the executor.
    change(
      fxprop,
      'owner.invite',
      2,
      'fxprop.write',
      { tool: 'fxprop_invite_owner' },
      z.object({ workspaceId: z.uuid(), organizationId: z.uuid(), email: z.email() }),
    ),
  ],
};

/** Rent Collection: a refined input and a strict one, and one the model could never be given. */
const RENT: AddonServerModule = {
  manifest: fxrent,
  queries: [
    lookUp(
      fxrent,
      'overdue.list',
      'fxrent.use',
      { tool: 'fxrent_list_overdue' },
      z
        .object({ workspaceId: z.uuid(), from: z.string().optional(), to: z.string().optional() })
        .refine((v) => !v.from || !v.to || v.from <= v.to, { error: 'From comes before to.' }),
    ),
  ],
  commands: [
    change(
      fxrent,
      'reminder.send',
      2,
      'fxrent.use',
      { tool: 'fxrent_send_reminder' },
      z.strictObject({ workspaceId: z.uuid(), leaseId: z.uuid(), message: z.string().max(500) }),
    ),
    change(
      fxrent,
      'fee.apply',
      2,
      'fxrent.use',
      { tool: 'fxrent_apply_fee' },
      z.discriminatedUnion('kind', [
        z.object({ workspaceId: z.uuid(), kind: z.literal('flat'), cents: z.int() }),
        z.object({ workspaceId: z.uuid(), kind: z.literal('percent'), percent: z.number() }),
      ]),
    ),
  ],
};

const MODULES: readonly AddonServerModule[] = [PROP, RENT];
const names = (tools: readonly { name: string }[]) => tools.map((t) => t.name);
const PROP_ALL = ['fxprop.read', 'fxprop.write'];

describe('which add-on tools a person is offered', () => {
  it('none while nothing runs, whatever they hold', () => {
    expect(addonAiTools(MODULES, { active: [], permissions: PROP_ALL })).toEqual([]);
    expect(addonAiTools(MODULES, { active: ['fxacct'], permissions: PROP_ALL })).toEqual([]);
  });

  it('only the running add-on’s, and only what the person’s permissions allow', () => {
    const owner = addonAiTools(MODULES, { active: ['fxprop'], permissions: PROP_ALL });
    expect(names(owner)).toEqual([
      'fxprop_list_leases',
      'fxprop_count_units',
      'fxprop_list_1099s',
      'fxprop_add_note',
      'fxprop_end_lease',
      'fxprop_rename_unit',
      'fxprop_notify_tenant',
      'fxprop_invite_owner',
    ]);
    // Reads only: the look-ups; nothing that changes anything.
    expect(
      names(addonAiTools(MODULES, { active: ['fxprop'], permissions: ['fxprop.read'] })),
    ).toEqual(['fxprop_list_leases', 'fxprop_count_units', 'fxprop_list_1099s']);
    // None of its permissions: only the look-up anyone in the business may do.
    expect(
      names(addonAiTools(MODULES, { active: ['fxprop'], permissions: ['records.read'] })),
    ).toEqual(['fxprop_count_units']);
    // Rent Collection's permission without Rent Collection running gives nothing of it.
    expect(
      names(addonAiTools(MODULES, { active: ['fxprop'], permissions: ['fxrent.use'] })),
    ).toEqual(['fxprop_count_units']);
    expect(
      names(addonAiTools(MODULES, { active: ['fxprop', 'fxrent'], permissions: ['fxrent.use'] })),
    ).toEqual(['fxprop_count_units', 'fxrent_list_overdue', 'fxrent_send_reminder']);
  });

  it('never a tool that isn’t offered to the AI, is too risky, or has no permission to hold', () => {
    const all = names(allAddonAiTools(MODULES));
    for (const kept of [
      'fxprop_export_ledger',
      'fxprop_owner_statement',
      'fxprop_wipe_data',
      'fxprop_sweep_rent',
      'fxrent_apply_fee',
    ])
      expect(all).not.toContain(kept);
    expect(all.some((n) => n.includes('unit_list'))).toBe(false);
    expect(addonAiToolByName(MODULES, 'fxprop_wipe_data')).toBeUndefined();
    // A waiting card is confirmed with the tool whatever runs now: the kernel checks the rest.
    expect(addonAiToolByName(MODULES, 'fxprop_end_lease')?.op.name).toBe('fxprop.lease.end');
  });

  it('is told apart from core’s own tools, and never takes one of their names', () => {
    const [tool] = addonAiTools(MODULES, { active: ['fxprop'], permissions: PROP_ALL });
    expect(isAddonAiTool(tool!)).toBe(true);
    expect(assistantTools.some((t) => isAddonAiTool(t))).toBe(false);
    const clash: AddonServerModule = {
      manifest: { ...fxprop, id: 'search' },
      queries: [
        lookUp({ ...fxprop, id: 'search' }, 'customer.list', null, { tool: 'search_customers' }),
      ],
    };
    expect(allAddonAiTools([clash])).toEqual([]);
    expect(addonAiIssues([clash])).toEqual([
      'search.customer.list\'s AI tool "search_customers" is the Assistant\'s own',
    ]);
  });
});

describe('what the model sees and sends', () => {
  const tool = (name: string) => addonAiToolByName(MODULES, name)!;

  it('never shows the business’s ids to the model', () => {
    for (const t of allAddonAiTools(MODULES)) {
      expect(Object.keys(t.input.shape)).not.toContain('workspaceId');
      expect(Object.keys(t.input.shape)).not.toContain('organizationId');
      const schema = toolInputSchema(t);
      expect(schema).toMatchObject({ type: 'object' });
      expect(Object.keys((schema['properties'] ?? {}) as object)).not.toContain('workspaceId');
      expect(Object.keys((schema['properties'] ?? {}) as object)).not.toContain('organizationId');
    }
    expect(Object.keys(tool('fxprop_invite_owner').input.shape)).toEqual(['email']);
    expect(tool('fxprop_invite_owner').scope).toEqual(['workspaceId', 'organizationId']);
    expect(tool('fxprop_list_leases').scope).toEqual(['workspaceId']);
  });

  it('drops the ids and anything undeclared from the model’s arguments, and puts the business’s on last', () => {
    const t = tool('fxprop_invite_owner');
    const args = addonToolArguments(t, {
      email: 'owner@example.com',
      workspaceId: elsewhere,
      organizationId: elsewhere,
      sneaky: true,
    });
    expect(args).toEqual({ email: 'owner@example.com' });
    // Even arguments that still carried them could never choose the business.
    expect(
      addonOperationInput(
        t,
        { email: 'owner@example.com', workspaceId: elsewhere, organizationId: elsewhere },
        { workspaceId: ws, organizationId: org },
      ),
    ).toEqual({ email: 'owner@example.com', workspaceId: ws, organizationId: org });
    // An operation that doesn't take the organization isn't handed one.
    expect(
      addonOperationInput(
        tool('fxprop_add_note'),
        { title: 'Gate code 1234' },
        { workspaceId: ws, organizationId: org },
      ),
    ).toEqual({ title: 'Gate code 1234', workspaceId: ws });
    expect(addonToolArguments(t, null)).toEqual({});
    expect(addonToolArguments(t, ['a'])).toEqual({});
  });

  it('keeps a strict input strict and lets the kernel run a refined one’s refinements', () => {
    const strict = tool('fxrent_send_reminder');
    expect(Object.keys(strict.input.shape)).toEqual(['leaseId', 'message']);
    expect(strict.input.safeParse({ leaseId: ws, message: 'Hi', extra: 1 }).success).toBe(false);
    const refined = tool('fxrent_list_overdue');
    expect(Object.keys(refined.input.shape)).toEqual(['from', 'to']);
    // The model's view takes it; the operation's own schema, which the kernel parses, still refuses it.
    const backwards = { from: '2026-10-01', to: '2026-09-01' };
    expect(refined.input.safeParse(backwards).success).toBe(true);
    expect(
      refined.op.input.safeParse(
        addonOperationInput(refined, backwards, { workspaceId: ws, organizationId: org }),
      ).success,
    ).toBe(false);
  });

  it('describes a tool with its add-on and the words search should find it by', () => {
    expect(tool('fxprop_list_leases').description).toBe('Leases with their rent and due day');
    expect(addonToolDescription(tool('fxprop_list_leases'))).toBe(
      'Leases with their rent and due day. From the Property Management add-on. Also: rent roll, tenancy.',
    );
    // Without its own words for the AI, the operation's description.
    expect(tool('fxprop_add_note').description).toBe('Change note add.');
    expect(addonToolDescription(tool('fxprop_add_note'))).toBe(
      'Change note add. From the Property Management add-on.',
    );
  });
});

describe('how much a tool may do on its own', () => {
  const q = lookUp(fxprop, 'x.list', 'fxprop.read', { tool: 'fxprop_x' });
  const at = (risk: RiskLevel, autonomy?: OperationAi['autonomy']) =>
    change(fxprop, 'x.do', risk, 'fxprop.write', {
      tool: 'fxprop_y',
      ...(autonomy ? { autonomy } : {}),
    });

  it('starts from the operation: look-ups and risk 0–1 on their own, 2–3 ask, 4 never', () => {
    expect(autonomyFloor(q)).toBe('auto');
    expect(([0, 1, 2, 3, 4] as const).map((r) => autonomyFloor(at(r)))).toEqual([
      'auto',
      'auto',
      'confirm',
      'confirm',
      'never',
    ]);
  });

  it('lets an add-on make it stricter, never looser', () => {
    expect(addonToolAutonomy(at(0, 'confirm'))).toBe('confirm');
    expect(addonToolAutonomy(at(1, 'never'))).toBe('never');
    expect(addonToolAutonomy(at(2, 'auto'))).toBe('confirm');
    expect(addonToolAutonomy(at(3, 'auto'))).toBe('confirm');
    expect(addonToolAutonomy(at(4, 'auto'))).toBe('never');
    expect(addonToolAutonomy(at(4, 'confirm'))).toBe('never');
    // A look-up that asks to wait for an OK is never offered.
    expect(
      addonToolAutonomy(lookUp(fxprop, 'z', null, { tool: 'fxprop_z', autonomy: 'confirm' })),
    ).toBe('never');
    const offered = allAddonAiTools(MODULES);
    const autonomy = Object.fromEntries(offered.map((t) => [t.name, t.autonomy]));
    expect(autonomy).toMatchObject({
      fxprop_list_leases: 'auto',
      fxprop_add_note: 'auto',
      fxprop_end_lease: 'confirm',
      fxprop_rename_unit: 'confirm',
      fxprop_notify_tenant: 'confirm',
      fxrent_send_reminder: 'confirm',
    });
  });
});

describe('the rules every add-on module is held to', () => {
  it('names each tool for its add-on, in the characters the model and the ledgers take', () => {
    for (const t of allAddonAiTools(MODULES)) {
      expect(t.name).toMatch(AI_TOOL_NAME);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(t.name.startsWith(`${t.addonId}_`)).toBe(true);
    }
    expect(addonModuleIssues({ commands, queries }, MODULES)).toEqual([]);
  });

  it('prints what would keep an operation from the AI', () => {
    expect(addonAiIssues(MODULES)).toEqual([
      "fxprop.owner.statement is a look-up and can't wait for an OK: use 'never' to keep it from the AI",
      "fxprop.data.wipe is risk 4, which the AI is never offered: say autonomy 'never'",
      'fxprop.rent.sweep has no permission, so the AI is never offered it',
      "fxrent.fee.apply's input must be one object with a workspaceId to be an AI tool",
    ]);
  });

  it('prints what a person does that the Assistant isn’t given, and isn’t kept from with why', () => {
    expect(addonAssistantIssues(MODULES)).toEqual([
      'fxprop.unit.list is something a person does: give it `ai`, or add it to notForTheAssistant with why',
    ]);
    const listed: AddonServerModule = {
      ...PROP,
      notForTheAssistant: {
        'fxprop.unit.list': 'A list only the screen draws.',
        'fxprop.note.add': 'Changed its mind.',
        'fxprop.unit.gone': 'Taken out last week.',
        'fxprop.lease.end': ' ',
      },
    };
    expect(addonAssistantIssues([listed, RENT])).toEqual([
      'fxprop.note.add declares `ai` and is on notForTheAssistant: keep one',
      'fxprop.lease.end declares `ai` and is on notForTheAssistant: keep one',
      "notForTheAssistant names fxprop.unit.gone, which fxprop doesn't have",
      'fxprop.lease.end is on notForTheAssistant without a why',
    ]);
  });

  it('holds for every add-on that ships', () => {
    expect(addonAiIssues(ADDON_SERVER_MODULES)).toEqual([]);
    // The Assistant does whatever the person can (the owner, 2026-10-26): a new add-on's too.
    expect(addonAssistantIssues(ADDON_SERVER_MODULES)).toEqual([]);
    expect(addonModuleIssues({ commands, queries }, ADDON_SERVER_MODULES)).toEqual([]);
  });
});

/** Three tools for an add-on: a look-up, a note and a change that asks. */
function threeTools(m: AddonManifest): AddonServerModule {
  const permission = m.permissions[0]?.key ?? null;
  return {
    manifest: m,
    queries: [lookUp(m, 'item.list', permission, { tool: `${m.id}_list_items` })],
    commands: [
      change(m, 'item.note', 1, permission, { tool: `${m.id}_note_item` }),
      change(m, 'item.remove', 2, permission, { tool: `${m.id}_remove_item` }),
    ],
  };
}

describe('a busy business: twelve add-ons on', () => {
  const twelve = FIXTURE_CATALOG.filter((m) => (TWELVE as readonly string[]).includes(m.id));
  const modules = twelve.map(threeTools);
  const permissions = twelve.flatMap((m) => m.permissions.map((p) => p.key));

  it('offers every one of their tools, each named once, in the modules’ order', () => {
    const tools = addonAiTools(modules, { active: TWELVE, permissions });
    expect(tools).toHaveLength(36);
    expect(new Set(names(tools)).size).toBe(36);
    expect(names(tools).slice(0, 3)).toEqual([
      'fxprop_list_items',
      'fxprop_note_item',
      'fxprop_remove_item',
    ]);
    expect([...new Set(tools.map((t) => t.addonId))]).toEqual(twelve.map((m) => m.id));
    for (const t of tools) expect(t.name.startsWith(`${t.addonId}_`)).toBe(true);
  });

  it('gives the same tools in the same order every time, whatever order the add-ons come in', () => {
    const once = addonAiTools(modules, { active: TWELVE, permissions });
    const reversed = addonAiTools(modules, {
      active: [...TWELVE].reverse(),
      permissions: [...permissions].reverse(),
    });
    expect(names(reversed)).toEqual(names(once));
    // The very same objects: nothing about them changes between questions.
    expect(reversed.every((t, i) => t === once[i])).toBe(true);
    expect(allAddonAiTools(modules)).toBe(allAddonAiTools(modules));
  });

  it('tells the model what the running add-ons cover, one line each, only while they run', () => {
    expect(addonDirectory(FIXTURE_CATALOG, TWELVE)).toEqual([
      'Property Management (fxprop_…): properties, units, tenants and leases',
    ]);
    expect(addonDirectory(FIXTURE_CATALOG, [...TWELVE].reverse())).toEqual(
      addonDirectory(FIXTURE_CATALOG, TWELVE),
    );
    expect(addonDirectory(FIXTURE_CATALOG, ['fxacct'])).toEqual([]);
    expect(addonDirectory(FIXTURE_CATALOG, [])).toEqual([]);
  });

  it('picks thirty add-ons’ tools quickly enough to do it on every question', () => {
    const thirty = syntheticCatalog(30);
    const many = thirty.map(threeTools);
    const ids = thirty.map((m) => m.id);
    const held = thirty.flatMap((m) => m.permissions.map((p) => p.key));
    const started = performance.now();
    for (let i = 0; i < 200; i++) addonAiTools(many, { active: ids, permissions: held });
    const took = performance.now() - started;
    expect(addonAiTools(many, { active: ids, permissions: held })).toHaveLength(90);
    // 200 questions' worth, well under a millisecond each.
    expect(took).toBeLessThan(200);
  });
});

describe('find_capabilities', () => {
  const on = (ids: readonly string[]) =>
    Object.fromEntries(ids.map((id) => [id, 'enabled' as InstallationState]));
  const CORE = ['records.read', 'inbox.use', 'appointments.write', 'assistant.use'];
  const base: CapabilityContext = {
    catalog: FIXTURE_CATALOG,
    installations: { ...on(['fxprop']), fxacct: 'disabled' },
    permissions: [...CORE, 'fxprop.read'],
  };
  const manager: CapabilityContext = {
    ...base,
    permissions: [...(base.permissions ?? []), 'addons.manage'],
  };

  it('puts what the person can do now first, best matches for their need at the top', () => {
    const found = findCapabilities(base, { need: 'track the leases on my rental properties' });
    expect(found.current[0]?.from).toBe('Property Management');
    expect(found.current.map((c) => c.id)).toEqual(
      expect.arrayContaining(['crm.contacts', 'fxprop.leases', 'fxprop.properties']),
    );
    // Without a need, core first, then the add-ons, as the catalogue has them.
    expect(findCapabilities(base, {}).current[0]?.id).toBe('crm.contacts');
  });

  it('says what an admin can give them or turn back on', () => {
    const found = findCapabilities(base, {});
    expect(found.restricted.map((c) => c.id)).toContain('money.invoices');
    expect(found.turnedOff.map((c) => c.from)).toEqual(['Accounting']);
    expect(found.say).toMatchObject({
      restricted: expect.stringMatching(/owner or admin can give them access/),
      turnedOff: expect.stringMatching(/turn it back on/),
    });
  });

  it('suggests an available add-on only to someone who can add one, only for a real gap, never planned', () => {
    const need = 'find influencers to promote the business and schedule social posts on instagram';
    const suggested = findCapabilities(manager, { need });
    expect(suggested.suggestions.map((s) => s.addonId)).toEqual(['fxsocial']);
    expect(suggested.suggestions[0]).toMatchObject({
      name: 'Social Media Scheduler',
      available: true,
    });
    expect(suggested.planned).toBeUndefined();
    // Someone who can't add add-ons is never pitched one.
    expect(findCapabilities(base, { need }).suggestions).toEqual([]);
    // Nothing asked, nothing suggested.
    expect(findCapabilities(manager, {}).suggestions).toEqual([]);
    // Something HandsFreeOS already does is no gap.
    expect(findCapabilities(manager, { need: 'text a customer back' }).suggestions).toEqual([]);
  });

  it('lists what is planned only when asked, only for someone who can add add-ons, and never as available', () => {
    const coming = findCapabilities(manager, { need: 'influencers', includePlanned: true });
    expect(coming.planned).toEqual([
      expect.objectContaining({ addonId: 'fxinflu', available: false }),
    ]);
    expect(coming.suggestions.map((s) => s.addonId)).not.toContain('fxinflu');
    expect(coming.say['planned']).toMatch(/never that they can add it/);
    expect(findCapabilities(base, { need: 'influencers', includePlanned: true }).planned).toBe(
      undefined,
    );
  });
});
