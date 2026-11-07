/**
 * The last settings the Assistant used to hand back (packages/core/src/assistant/tools-settings-more.ts): add-ons and
 * their own settings, the Deleted bin (moving things in, and bringing them back), partners and Settings → Safety. Each card is read from what is there now, so it says what will
 * really change; a request that changes nothing is turned back before a card is drawn. On Confirm, the screen's own
 * command runs as the person.
 */
import {
  ADDON_CATALOG,
  BIN_WORDS,
  binContentsTotal,
  binDeleteBox,
  binDeletedWords,
  HfosError,
  type BinContents,
  type BinKind,
} from '@hfos/core';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query, rehearse } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const has = (args: Args, key: string) => args[key] !== undefined;
const nothingChanges = (why: string) => HfosError.validation([], `Nothing would change. ${why}`);
const href = (ctx: ToolContext, path: string) => `/app/w/${ctx.workspaceId}/${path}`;

// ---------- add-ons ----------

const LIFECYCLE = {
  install: 'install',
  turn_on: 'enable',
  turn_off: 'disable',
  uninstall: 'uninstall',
} as const;
/** Each move's command, written out in full: the Assistant's coverage check reads the names as they are written. */
const LIFECYCLE_COMMAND = {
  install: 'addon.install',
  turn_on: 'addon.enable',
  turn_off: 'addon.disable',
  uninstall: 'addon.uninstall',
} as const;
type Move = keyof typeof LIFECYCLE;

interface Impact {
  outcome: 'plan' | 'already' | 'refused';
  moves: { addonId: string; action: string; name: string }[];
  needsAgreement: string[];
  question: string | null;
  refusal: { rule: string; message: string } | null;
  optionalFor: { addonId: string; name: string }[];
  capabilitiesLost: { id: string; label: string }[];
}

const MOVE_WORDS: Record<string, string> = {
  install: 'Added',
  enable: 'Turned on',
  disable: 'Turned off',
  uninstall: 'Uninstalled',
};

const impactOf = (db: Db, ctx: ToolContext, args: Args) =>
  query<Impact>(db, ctx, 'addon.impact', {
    addonId: args['addonId'],
    action: LIFECYCLE[args['action'] as Move],
  });

const manageAddOn: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = args['action'] as Move;
    const impact = await impactOf(db, ctx, args);
    if (impact.outcome === 'refused' && impact.refusal)
      throw HfosError.rule(impact.refusal.rule, 409, impact.refusal.message);
    if (impact.outcome === 'already')
      throw nothingChanges('That add-on is already where you asked.');
    const self = impact.moves.find((m) => m.addonId === args['addonId']);
    const name = self?.name ?? String(args['addonId']);
    const others = impact.moves.filter((m) => m.addonId !== args['addonId']);
    const fields: Field[] = [
      { label: 'Add-on', value: name },
      ...others.map((m) => ({ label: MOVE_WORDS[m.action] ?? 'Also', value: m.name })),
      ...(impact.capabilitiesLost.length
        ? [
            {
              label: 'Stops working',
              value: impact.capabilitiesLost.map((c) => c.label).join(', '),
            },
          ]
        : []),
      ...(impact.optionalFor.length
        ? [
            {
              label: 'Loses the features that use it',
              value: impact.optionalFor.map((o) => o.name).join(', '),
            },
          ]
        : []),
    ];
    const titles: Record<Move, string> = {
      install: `Add ${name}`,
      turn_on: `Turn on ${name}`,
      turn_off: `Turn off ${name}`,
      uninstall: `Uninstall ${name}`,
    };
    const notes: Record<Move, string> = {
      install: 'It turns on for everyone in the business once it’s set up, in a minute or so.',
      turn_on:
        'It comes back for everyone in the business, with its data and settings as they were.',
      turn_off:
        'Its screens and records are hidden from everyone in the business. Its data and settings are kept for when it comes back.',
      uninstall:
        'It stops for everyone, and lets go of what it holds outside HandsFreeOS. Its data is kept until an owner deletes it on the Add-ons page.',
    };
    return {
      card: settingsCard(toolCallId, 'manage_add_on', {
        title: titles[act],
        fields,
        confirmLabel: impact.question
          ? `Yes, ${titles[act].charAt(0).toLowerCase()}${titles[act].slice(1)} and the rest`
          : titles[act],
        warnings: [
          { kind: act === 'install' || act === 'turn_on' ? 'note' : 'caution', text: notes[act] },
          ...(impact.question ? [{ kind: 'note', text: impact.question }] : []),
        ],
      }),
      result: { waiting: true, moves: impact.moves.map((m) => `${m.action} ${m.name}`) },
    };
  },

  async commit(db, ctx, args) {
    const act = args['action'] as Move;
    // The person agreed to what the card showed: whatever else has to move with it.
    const impact = await impactOf(db, ctx, args);
    if (impact.outcome === 'refused' && impact.refusal)
      throw HfosError.rule(impact.refusal.rule, 409, impact.refusal.message);
    await command(db, ctx, LIFECYCLE_COMMAND[act], {
      addonId: args['addonId'],
      include: impact.needsAgreement,
    });
    const self = impact.moves.find((m) => m.addonId === args['addonId'])?.name ?? 'The add-on';
    const outcomes: Record<Move, string> = {
      install: `${self} is being set up`,
      turn_on: `${self} is on`,
      turn_off: `${self} is off`,
      uninstall: `${self} is uninstalled`,
    };
    return {
      outcome: outcomes[act],
      href: href(ctx, 'add-ons'),
      command: LIFECYCLE_COMMAND[act],
    };
  },
};

// ---------- an add-on's own settings ----------

/** `addon.settings`: both null for someone its settings permission doesn't cover. */
interface AddonSettingsNow {
  settings: Record<string, unknown> | null;
  flags: Record<string, boolean> | null;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Key order never counts as a change: a set of days read back can come in any order. */
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : isPlain(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
/** `keepClosedYears` or `under_contract` → "Keep closed years", "Under contract": for a setting with no words of its own. */
const keyWords = (k: string) => {
  const w = k
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const dayWords = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/** A setting's value as the card says it: a person's or a calendar's name for its id, On or Off, a day as a date. */
function valueWords(v: unknown, names: ReadonlyMap<string, string>): string {
  if (v === null || v === undefined || v === '') return 'None';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (names.has(v.toLowerCase())) return names.get(v.toLowerCase())!;
    return cut(DAY.test(v) ? dayWords(v) : v);
  }
  if (Array.isArray(v))
    return v.length ? cut(v.map((x) => valueWords(x, names)).join(', ')) : 'None';
  if (isPlain(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return 'None';
    return cut(
      entries
        .map(([k, x]) =>
          DAY.test(k)
            ? `${dayWords(k)}${typeof x === 'string' && x ? ` (${x})` : ''}`
            : `${keyWords(k)}: ${valueWords(x, names).toLowerCase()}`,
        )
        .join('; '),
    );
  }
  return cut(String(v));
}

/** Who and what an id in a setting can be: someone on the team, or a calendar. Null when either couldn't be read. */
async function idNames(db: Db, ctx: ToolContext): Promise<Map<string, string> | null> {
  const [team, calendars] = await Promise.all([
    query<{ members: Member[] }>(db, ctx, 'workspace.members').catch(() => null),
    query<{ items: CalendarRow[] }>(db, ctx, 'calendar.list').catch(() => null),
  ]);
  if (!team || !calendars) return null;
  return new Map([
    ...team.members.map((p) => [p.userId.toLowerCase(), p.fullName || p.email] as const),
    ...calendars.items.map((c) => [c.id.toLowerCase(), c.name] as const),
  ]);
}

type SchemaDef = {
  type?: string;
  innerType?: unknown;
  in?: unknown;
  shape?: Record<string, unknown>;
};
const defOf = (s: unknown) => (s as { _zod?: { def?: SchemaDef } } | undefined)?._zod?.def;
/**
 * A group of settings' parts by name, from the add-on's schema: an object's fields, through a default or an optional
 * around it. Null for anything else, a set of days (a record) among them.
 */
function groupOf(s: unknown): Record<string, unknown> | null {
  for (let def = defOf(s), i = 0; def && i < 8; def = defOf(def.innerType ?? def.in), i++)
    if (def.type === 'object') return def.shape ?? null;
  return null;
}
const takesNull = (s: unknown) =>
  typeof (s as { safeParse?: unknown } | undefined)?.safeParse === 'function' &&
  (s as { safeParse: (v: unknown) => { success: boolean } }).safeParse(null).success;

/**
 * `changes` put on `base`: a group of settings (an object in the add-on's schema) takes only the parts named, deeper
 * down too, and a null for a part that can't be null takes it out (a daily limit back to none); a list, a set of days
 * or a value is replaced whole.
 */
function mergedOnto(
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
  parts: Readonly<Record<string, unknown>>,
  inGroup = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(changes)) {
    const group = groupOf(parts[k]);
    if (inGroup && v === null && !takesNull(parts[k])) delete out[k];
    else out[k] = group && isPlain(v) && isPlain(base[k]) ? mergedOnto(base[k], v, group, true) : v;
  }
  return out;
}

/**
 * The parts named in a group of settings that the group doesn't have, deeper down too, each with the group it was named
 * in: a part the schema doesn't know would be dropped as it's checked, and the save would quietly change nothing.
 */
function strangeParts(
  changes: Record<string, unknown>,
  parts: Readonly<Record<string, unknown>>,
  at = '',
): { path: string; group: string; known: readonly string[] }[] {
  return Object.entries(changes).flatMap(([k, v]) => {
    const group = groupOf(parts[k]);
    if (!group || !isPlain(v)) return [];
    const known = Object.keys(group);
    return [
      ...Object.keys(v)
        .filter((p) => !Object.hasOwn(group, p))
        .map((p) => ({ path: `${at}${k}.${p}`, group: `${at}${k}`, known })),
      ...strangeParts(v, group, `${at}${k}.`),
    ];
  });
}

/**
 * The card's lines for one setting. A group with groups inside says each part that changes on a line of its own
 * ("Rules → Daily limits: Friend request: 20"), so the change shows however deep it is; anything else, a group of
 * plain settings like a set of switches among them, is said whole, as it will be.
 */
function changedLines(
  label: string,
  before: unknown,
  after: unknown,
  part: unknown,
  names: ReadonlyMap<string, string>,
): Field[] {
  const group = groupOf(part);
  if (!group || !isPlain(before) || !isPlain(after) || !Object.values(group).some(groupOf))
    return [{ label, value: valueWords(after, names) }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !same(before[k], after[k]))
    .flatMap((k) =>
      changedLines(`${label} → ${keyWords(k)}`, before[k], after[k], group[k], names),
    );
}

/** At most ten lines fit on a card; the last says how many more there are. */
const capFields = (fields: Field[]): Field[] =>
  fields.length <= 10
    ? fields
    : [...fields.slice(0, 9), { label: 'And', value: `${fields.length - 9} more changes` }];

/**
 * The add-on's settings with the model's changes put on what is set now (a setting it didn't name, or a part of a
 * group it didn't name, stays as it is), checked with the add-on's own schema, and the card's lines for what really
 * changes.
 */
async function addonSettingsPlan(db: Db, ctx: ToolContext, args: Args) {
  const addonId = str(args['addonId']) ?? '';
  const m = ADDON_CATALOG.find((a) => a.id === addonId);
  if (!m)
    throw HfosError.notFound(
      'No add-on has that id. The business’s add-ons are in get_settings (area add_ons).',
    );
  const now = await query<AddonSettingsNow>(db, ctx, 'addon.settings', { addonId: m.id });
  if (now.settings === null || now.flags === null)
    throw HfosError.forbidden(
      `You don’t have permission to change ${m.name}’s settings. An owner of this business can give it to you in Settings → Permissions.`,
    );
  const schema = m.settings?.workspace;
  const shape =
    (schema as { shape?: Record<string, { description?: string }> } | undefined)?.shape ?? {};
  const known = Object.keys(shape);
  const declared = m.settings?.flags ?? {};
  const changes = isPlain(args['settings']) ? args['settings'] : {};
  const flagChanges = isPlain(args['flags']) ? (args['flags'] as Record<string, boolean>) : {};
  if (!Object.keys(changes).length && !Object.keys(flagChanges).length)
    throw HfosError.validation(
      [],
      `Say which of ${m.name}’s settings to change. What is set now is in read_addon_settings.`,
    );
  if (Object.keys(changes).length && !schema)
    throw HfosError.validation(
      [{ path: 'settings', message: `${m.name} has no settings of its own.` }],
      `${m.name} has no settings of its own to change.${Object.keys(declared).length ? ' Its switches go in flags.' : ''}`,
    );
  const strange = known.length ? Object.keys(changes).filter((k) => !known.includes(k)) : [];
  if (strange.length)
    throw HfosError.validation(
      strange.map((k) => ({
        path: `settings.${k}`,
        message: `${m.name} has no setting by that name.`,
      })),
      `${m.name} has no setting called ${strange.join(', ')}. Its settings are ${known.join(', ')}.`,
    );
  const strangeDeeper = strangeParts(changes, groupOf(schema) ?? {});
  if (strangeDeeper.length) {
    const first = strangeDeeper[0]!;
    throw HfosError.validation(
      strangeDeeper.map((s) => ({
        path: `settings.${s.path}`,
        message: `${m.name} has no setting by that name.`,
      })),
      `${m.name} has no setting called ${strangeDeeper.map((s) => s.path).join(', ')}. The parts of ${first.group} are ${first.known.join(', ')}.`,
    );
  }
  const strangeFlags = Object.keys(flagChanges).filter((k) => !Object.hasOwn(declared, k));
  if (strangeFlags.length)
    throw HfosError.validation(
      strangeFlags.map((k) => ({
        path: `flags.${k}`,
        message: `${m.name} has no switch by that name.`,
      })),
      Object.keys(declared).length
        ? `${m.name} has no switch called ${strangeFlags.join(', ')}. Its switches are ${Object.keys(declared).join(', ')}.`
        : `${m.name} has no switches. Its settings go in settings.`,
    );

  // What is set now, with its defaults filled in the way the screen shows it; the model's changes go on top.
  const stored = now.settings;
  const read = schema?.safeParse(stored);
  const current = read?.success && isPlain(read.data) ? read.data : stored;
  const merged = mergedOnto(current, changes, groupOf(schema) ?? {});
  const label = (k: string) => shape[k]?.description ?? keyWords(k);
  const checked = schema?.safeParse(merged);
  if (checked && !checked.success) {
    const issue = checked.error.issues[0]!;
    const what = String(issue.path[0] ?? '');
    const why = issue.message.replace(/[.!?]?$/, '.');
    throw HfosError.validation(
      checked.error.issues.map((i) => ({
        path: `settings.${i.path.join('.')}`,
        message: i.message,
      })),
      `That won’t work for “${what ? label(what) : m.name}”: ${why} What is set now is in read_addon_settings.`,
    );
  }
  const next = (checked?.success && isPlain(checked.data) ? checked.data : merged) as Record<
    string,
    unknown
  >;
  const changedKeys = Object.keys(changes).filter((k) => !same(current[k], next[k]));
  const flags = Object.fromEntries(
    Object.entries(flagChanges).filter(([k, on]) => now.flags![k] !== on),
  );

  // An id the setting didn't hold before has to be someone on the team or a calendar here, so nothing is sent to,
  // or put on, nobody.
  const ids = (v: unknown) =>
    (JSON.stringify(v ?? null).match(UUID) ?? []).map((s) => s.toLowerCase());
  const added = changedKeys.flatMap((k) => {
    const before = new Set(ids(current[k]));
    return ids(next[k]).filter((id) => !before.has(id));
  });
  const names = changedKeys.some((k) => ids(next[k]).length) ? await idNames(db, ctx) : null;
  const unknownIds = names ? added.filter((id) => !names.has(id)) : [];
  if (unknownIds.length) {
    const message =
      'One of those ids isn’t anyone on the team or any calendar here. People are in get_settings (area team), calendars in get_settings (area calendars).';
    throw HfosError.validation([{ path: 'settings', message }], message);
  }

  const fields: Field[] = capFields([
    ...changedKeys.flatMap((k) =>
      changedLines(label(k), current[k], next[k], shape[k], names ?? new Map()),
    ),
    ...Object.entries(flags).map(([k, on]) => ({
      label: declared[k]!.label,
      value: on ? 'On' : 'Off',
    })),
  ]);
  // Where its business settings are: where it says, else its page keyed `settings`.
  const settingsPath = m.ui?.settingsPath ?? m.ui?.nav?.find((n) => n.key === 'settings')?.path;
  return {
    m,
    fields,
    save: {
      addonId: m.id,
      ...(changedKeys.length ? { settings: next } : {}),
      ...(Object.keys(flags).length ? { flags } : {}),
    },
    path:
      settingsPath === undefined
        ? 'add-ons'
        : `a/${m.id}${settingsPath ? `/${settingsPath.replace(/^\/+/, '')}` : ''}`,
  };
}

const updateAddonSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await addonSettingsPlan(db, ctx, args);
    if (!plan.fields.length) throw nothingChanges(`${plan.m.name} is already set that way.`);
    // Tried as the person and rolled back, so what the save itself refuses (someone picked who can't count for a
    // setting) is said before any card.
    await rehearse(db, ctx, 'addon.save_settings', plan.save);
    return {
      card: settingsCard(toolCallId, 'update_addon_settings', {
        title: `Change ${plan.m.name}’s settings`,
        fields: plan.fields,
        confirmLabel: 'Save the change',
        warnings: [
          {
            kind: 'note',
            text: `Only what is listed changes. The rest of ${plan.m.name}’s settings stay as they are.`,
          },
        ],
      }),
      result: { waiting: true, changes: plan.fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const plan = await addonSettingsPlan(db, ctx, args);
    await command(db, ctx, 'addon.save_settings', plan.save);
    return {
      outcome: `Saved ${plan.m.name}’s settings`,
      href: href(ctx, plan.path),
      command: 'addon.save_settings',
    };
  },
};

// ---------- the Deleted bin ----------

interface BinItem {
  id: string;
  kind: string;
  name: string;
  deletedBy: { name: string } | null;
  deletedAt: string;
  purgeAfter: string;
  emptying: boolean;
}

const KIND_WORDS: Record<string, string> = {
  person: 'Customer',
  conversation: 'Conversation',
  appointment: 'Appointment',
  lead: 'Lead',
  company: 'Company',
  custom_record: 'Record',
};

async function binItemOf(db: Db, ctx: ToolContext, id: unknown): Promise<BinItem> {
  const items: BinItem[] = [];
  let cursor: string | null = null;
  // The bin holds 30 days of deletes; a page at a time, as the screen reads it.
  for (let page = 0; page < 20; page++) {
    const got: { items: BinItem[]; nextCursor: string | null } = await query(db, ctx, 'bin.list', {
      ...(cursor ? { cursor } : {}),
    });
    items.push(...got.items);
    const found = items.find((i) => i.id === id);
    if (found) return found;
    if (!got.nextCursor) break;
    cursor = got.nextCursor;
  }
  throw HfosError.notFound(
    'That isn’t in the Deleted bin anymore: it may have been brought back, or its 30 days are up. Look under Settings → Deleted bin.',
  );
}

const dateWords = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );

const restoreFromBin: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const item = await binItemOf(db, ctx, args['binItemId']);
    if (item.emptying)
      throw HfosError.conflict(
        `${item.name} is being deleted for good right now, so it can’t come back.`,
        'bin_emptying',
      );
    return {
      card: settingsCard(toolCallId, 'restore_from_bin', {
        title: `Bring back ${item.name}`,
        fields: [
          { label: KIND_WORDS[item.kind] ?? 'Item', value: item.name },
          {
            label: 'Deleted',
            value: `${dateWords(item.deletedAt, ctx.timezone)}${item.deletedBy ? ` by ${item.deletedBy.name}` : ''}`,
          },
        ],
        confirmLabel: 'Bring it back',
        warnings: [
          {
            kind: 'note',
            text: 'It comes back as it was, with what was deleted with it. Workflows it was in don’t start again.',
          },
        ],
      }),
      result: { waiting: true, name: item.name },
    };
  },

  async commit(db, ctx, args) {
    const back = await command<{ name: string; joined: number }>(db, ctx, 'bin.restore', {
      binItemId: args['binItemId'],
    });
    return {
      outcome: `${back.name} is back${back.joined ? ', joined to the conversation that carried on' : ''}`,
      href: href(ctx, 'settings/deleted-bin'),
      command: 'bin.restore',
    };
  },
};

/** Each kind's delete, as the screens' Delete for good… runs it, and what its input calls the ids. */
const BIN_COMMANDS: Record<BinKind, { name: string; key: string }> = {
  person: { name: 'person.delete', key: 'personIds' },
  conversation: { name: 'conversation.delete', key: 'conversationIds' },
  appointment: { name: 'appointment.delete', key: 'appointmentId' },
  lead: { name: 'lead.delete', key: 'leadIds' },
  company: { name: 'company.delete', key: 'companyIds' },
  custom_record: { name: 'custom_record.delete', key: 'customRecordIds' },
};

interface BinPreview {
  items: {
    id: string;
    name: string | null;
    contents: BinContents;
    rule: string | null;
    message: string | null;
  }[];
}

/** The delete's own input: a booking is one at a time, and says whether its customers are told. */
function binDelete(args: Args): { kind: BinKind; name: string; input: Args } {
  const kind = String(args['kind']) as BinKind;
  const ids = Array.isArray(args['ids']) ? (args['ids'] as string[]) : [];
  const c = BIN_COMMANDS[kind];
  if (!c) throw HfosError.validation([{ path: 'kind', message: 'Pick what to delete.' }]);
  if (kind !== 'appointment') return { kind, name: c.name, input: { [c.key]: ids } };
  if (ids.length !== 1)
    throw HfosError.validation(
      [{ path: 'ids', message: 'One booking at a time.' }],
      'Bookings are deleted one at a time. Pick the one to delete first.',
    );
  return {
    kind,
    name: c.name,
    input: { appointmentId: ids[0], notify: args['tellCustomers'] !== false },
  };
}

/**
 * Moving things to the Deleted bin (the owner, 2026-10-27): the card is the screens' delete box — what goes with them,
 * what stays, and that they wait 30 days — read from what deleting them would take now. One that can't go yet is said
 * before any card, in the bin's own words.
 */
const moveToBin: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { kind } = binDelete(args);
    const { items } = await query<BinPreview>(db, ctx, 'bin.preview', { kind, ids: args['ids'] });
    if (items.length === 0)
      throw HfosError.notFound('None of those are here anymore: they may be deleted already.');
    const stopped = items.filter((i) => i.rule);
    if (stopped.length)
      throw HfosError.conflict(
        stopped
          .map((i) => i.message ?? `${i.name ?? 'One of them'} can’t be deleted yet.`)
          .join(' '),
        stopped[0]!.rule!,
      );
    const names = items.map((i) => i.name ?? BIN_WORDS.kinds[kind]);
    const box = binDeleteBox(kind, names, binContentsTotal(items.map((i) => i.contents)));
    const card = settingsCard(toolCallId, 'move_to_bin', {
      title: box.title,
      fields: [
        {
          label: BIN_WORDS.kinds[kind],
          value:
            names.length > 3
              ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
              : names.join(', '),
        },
      ],
      confirmLabel: BIN_WORDS.submit,
    });
    return {
      card: { ...card, body: box.lines.join('\n') },
      result: { waiting: true, deleting: names, says: box.lines },
    };
  },

  async commit(db, ctx, args) {
    const { kind, name, input } = binDelete(args);
    const out = await command<{ deleted: { name: string }[] }>(db, ctx, name, input);
    return {
      outcome: binDeletedWords(
        kind,
        out.deleted.map((d) => d.name),
      ),
      href: href(ctx, 'settings/deleted-bin'),
      command: name,
    };
  },
};

// ---------- partners ----------

interface PartnerSettingsNow {
  settings: {
    rateBp: number;
    terms: string;
    smallestPayoutCents: number;
    calendarId: string | null;
  };
  linkCalendar: { id: string; name: string } | null;
}
interface PartnerRow {
  partnerId: string;
  personId: string;
  name: string;
  status: 'active' | 'paused' | 'ended';
  rateBp: number;
  ownRate: boolean;
}

const percent = (bp: number) =>
  `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const bpOf = (pct: number) => Math.round(pct * 100);
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** The calendars a partner's link can book: active ones taking bookings on the booking page. */
interface CalendarRow {
  id: string;
  name: string;
  public: boolean;
  status: string;
}

/** Long terms on a card of ten lines: the start, so the person can tell which they are. */
const termsWords = (t: string) =>
  !t
    ? 'None: partners get their link without accepting any'
    : t.length > 300
      ? `${t.slice(0, 299)}…`
      : t;

/** The partner settings with the model's changes in, and the card's lines for what changed. */
async function partnerSettingsPlan(db: Db, ctx: ToolContext, args: Args) {
  const now = await query<PartnerSettingsNow>(db, ctx, 'partners.settings');
  const next = {
    rateBp:
      typeof args['sharePercent'] === 'number' ? bpOf(args['sharePercent']) : now.settings.rateBp,
    terms: typeof args['terms'] === 'string' ? args['terms'].trim() : now.settings.terms,
    smallestPayoutCents:
      typeof args['smallestPayout'] === 'number'
        ? Math.round(args['smallestPayout'] * 100)
        : now.settings.smallestPayoutCents,
    calendarId: has(args, 'calendarId')
      ? ((args['calendarId'] as string | null) ?? null)
      : now.settings.calendarId,
  };
  const fields: Field[] = [];
  if (next.rateBp !== now.settings.rateBp)
    fields.push(
      { label: 'Their share', value: percent(next.rateBp) },
      { label: 'Was', value: percent(now.settings.rateBp) },
    );
  if (next.smallestPayoutCents !== now.settings.smallestPayoutCents)
    fields.push({ label: 'Smallest payout', value: money(next.smallestPayoutCents) });
  if (next.calendarId !== now.settings.calendarId) {
    const { items } = await query<{ items: CalendarRow[] }>(db, ctx, 'calendar.list');
    const calendar = items.find((c) => c.id === next.calendarId);
    // Checked before Confirm, the way the save checks it, so the card never offers a calendar nobody can book.
    if (next.calendarId && !calendar) {
      const message = 'No calendar has that id. They’re in get_settings (area calendars).';
      throw HfosError.validation([{ path: 'calendarId', message }], message);
    }
    if (calendar && (!calendar.public || calendar.status !== 'active')) {
      const message = `${calendar.name} isn’t taking bookings on the booking page, so partners’ clients couldn’t book it. Pick another, or turn it on and make it public in Settings → Calendars.`;
      throw HfosError.validation([{ path: 'calendarId', message }], message);
    }
    const first = items.find((c) => c.public && c.status === 'active');
    fields.push({
      label: 'The calendar their links book',
      value: calendar
        ? calendar.name
        : `The first on your booking page${first ? ` (${first.name})` : ''}`,
    });
  }
  const termsChanged = next.terms !== now.settings.terms;
  if (termsChanged) fields.push({ label: 'Terms', value: termsWords(next.terms) });
  return { next, fields, termsChanged };
}

const updatePartnerSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await partnerSettingsPlan(db, ctx, args);
    if (!plan.fields.length) throw nothingChanges('Partners are already paid that way.');
    return {
      card: settingsCard(toolCallId, 'update_partner_settings', {
        title: 'Change how partners are paid',
        fields: plan.fields,
        confirmLabel: 'Save the change',
        warnings: [
          {
            kind: 'caution',
            text: 'What partners earn is a promise to people outside the business. A partner with their own share keeps it.',
          },
          // Taking the terms off asks nobody anything: only new terms go out to be accepted.
          ...(plan.termsChanged && plan.next.terms
            ? [{ kind: 'note', text: 'Every partner is asked to accept the new terms.' }]
            : []),
        ],
      }),
      result: { waiting: true, changes: plan.fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const plan = await partnerSettingsPlan(db, ctx, args);
    await command(db, ctx, 'partners.save_settings', { settings: plan.next });
    return {
      outcome: 'Saved how partners are paid',
      href: href(ctx, 'settings/partners'),
      command: 'partners.save_settings',
    };
  },
};

type PartnerAct = 'add' | 'set_share' | 'pause' | 'end' | 'bring_back' | 'set_referral';

async function partnerOf(db: Db, ctx: ToolContext, id: unknown): Promise<PartnerRow> {
  const { partners } = await query<{ partners: PartnerRow[] }>(db, ctx, 'partner.list');
  const found = partners.find((p) => p.partnerId === id);
  if (!found)
    throw HfosError.notFound(
      'That partner isn’t there. Look at the list under Settings → Partners for who is.',
    );
  return found;
}

const customerName = (db: Db, ctx: ToolContext, personId: unknown) =>
  query<{ person: { fullName: string } }>(db, ctx, 'person.get', { personId }).then(
    (p) => p.person.fullName,
  );

const shareArg = (args: Args) =>
  typeof args['sharePercent'] === 'number' ? bpOf(args['sharePercent']) : null;

const managePartner: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = args['action'] as PartnerAct;
    const need = (what: string) => HfosError.validation([], what);
    let title: string;
    let fields: Field[];
    let note: string;
    switch (act) {
      case 'add': {
        if (!str(args['personId'])) throw need('Say which customer becomes a partner.');
        const name = await customerName(db, ctx, args['personId']);
        const own = shareArg(args);
        title = `Make ${name} a partner`;
        fields = [
          { label: 'Partner', value: name },
          { label: 'Their share', value: own ? percent(own) : 'The business’s' },
        ];
        note =
          'They get their own link and page, and earn their share on what the customers they send pay.';
        break;
      }
      case 'set_referral': {
        if (!str(args['personId'])) throw need('Say which customer the partner sent.');
        const name = await customerName(db, ctx, args['personId']);
        const partner = args['partnerId'] ? await partnerOf(db, ctx, args['partnerId']) : null;
        title = partner
          ? `Mark ${name} as sent by ${partner.name}`
          : `Mark ${name} as sent by no partner`;
        fields = [
          { label: 'Customer', value: name },
          { label: 'Sent by', value: partner?.name ?? 'No partner' },
        ];
        note = partner
          ? `${partner.name} earns their share on what ${name} pays from now on, for their first 12 months.`
          : 'A customer who has already earned a partner something stays theirs.';
        break;
      }
      default: {
        const p = await partnerOf(db, ctx, args['partnerId']);
        if (act === 'set_share') {
          const own = shareArg(args);
          if ((own ?? null) === (p.ownRate ? p.rateBp : null))
            throw nothingChanges(`${p.name} already earns that.`);
          title = `Change ${p.name}’s share`;
          fields = [
            { label: 'Their share', value: own ? percent(own) : 'The business’s' },
            { label: 'Was', value: `${percent(p.rateBp)}${p.ownRate ? '' : ' (the business’s)'}` },
          ];
          note = 'It counts on payments from now on. What they earned is kept.';
        } else {
          const status = act === 'pause' ? 'paused' : act === 'end' ? 'ended' : 'active';
          if (p.status === status)
            throw nothingChanges(
              `${p.name} is already ${status === 'active' ? 'working' : status}.`,
            );
          title =
            act === 'pause'
              ? `Pause ${p.name}`
              : act === 'end'
                ? `End ${p.name} as a partner`
                : `Bring ${p.name} back`;
          fields = [{ label: 'Partner', value: p.name }];
          note =
            act === 'bring_back'
              ? 'They earn their share again on payments from now on.'
              : 'They earn nothing on payments from now on. What they earned is kept and still paid.';
        }
      }
    }
    return {
      card: settingsCard(toolCallId, 'manage_partner', {
        title,
        fields,
        confirmLabel: 'Save it',
        warnings: [{ kind: 'note', text: note }],
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    const act = args['action'] as PartnerAct;
    const to = href(ctx, 'settings/partners');
    if (act === 'add') {
      const out = await command<{ created: boolean }>(db, ctx, 'partner.add', {
        personId: args['personId'],
        rateBp: shareArg(args),
      });
      return {
        outcome: out.created
          ? 'They’re a partner now'
          : 'They were a partner already, and are working again',
        href: to,
        command: 'partner.add',
      };
    }
    if (act === 'set_referral') {
      await command(db, ctx, 'partner.referral_set', {
        personId: args['personId'],
        partnerId: (args['partnerId'] as string | null | undefined) ?? null,
      });
      return { outcome: 'Saved who sent them', href: to, command: 'partner.referral_set' };
    }
    await command(db, ctx, 'partner.update', {
      partnerId: args['partnerId'],
      ...(act === 'set_share'
        ? { rateBp: shareArg(args) }
        : { status: act === 'pause' ? 'paused' : act === 'end' ? 'ended' : 'active' }),
    });
    const words: Record<string, string> = {
      set_share: 'Their share is saved',
      pause: 'They’re paused',
      end: 'They’re no longer a partner',
      bring_back: 'They’re back',
    };
    return { outcome: words[act] ?? 'Saved', href: to, command: 'partner.update' };
  },
};

// ---------- safety ----------

interface SafetyNow {
  askAfterMinutes: number;
  alertAfterMinutes: number;
  safetyUserId: string | null;
}
interface Member {
  userId: string;
  fullName: string;
  email: string;
}

const minutesWords = (n: number) => (n === 1 ? '1 minute' : `${n} minutes`);

async function safetyPlan(db: Db, ctx: ToolContext, args: Args) {
  const [now, { members }] = await Promise.all([
    query<SafetyNow>(db, ctx, 'safety.settings'),
    query<{ members: Member[] }>(db, ctx, 'workspace.members').catch(() => ({
      members: [] as Member[],
    })),
  ]);
  const next: SafetyNow = {
    askAfterMinutes:
      typeof args['askAfterMinutes'] === 'number' ? args['askAfterMinutes'] : now.askAfterMinutes,
    alertAfterMinutes:
      typeof args['alertAfterMinutes'] === 'number'
        ? args['alertAfterMinutes']
        : now.alertAfterMinutes,
    safetyUserId: has(args, 'safetyUserId')
      ? ((args['safetyUserId'] as string | null) ?? null)
      : now.safetyUserId,
  };
  const who = (id: string | null) =>
    id
      ? (members.find((m) => m.userId === id)?.fullName ?? 'Someone not on the team')
      : 'The owners and admins';
  const fields: Field[] = [];
  if (next.askAfterMinutes !== now.askAfterMinutes)
    fields.push({ label: 'Ask if they’re OK after', value: minutesWords(next.askAfterMinutes) });
  if (next.alertAfterMinutes !== now.alertAfterMinutes)
    fields.push({
      label: 'Tell their contacts after',
      value: `${minutesWords(next.alertAfterMinutes)} more`,
    });
  if (next.safetyUserId !== now.safetyUserId)
    fields.push(
      { label: 'Safety person', value: who(next.safetyUserId) },
      { label: 'Was', value: who(now.safetyUserId) },
    );
  return { next, fields };
}

const updateSafetySettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await safetyPlan(db, ctx, args);
    if (!plan.fields.length) throw nothingChanges('Safety is already set that way.');
    return {
      card: settingsCard(toolCallId, 'update_safety_settings', {
        title: 'Change Safety',
        fields: plan.fields,
        confirmLabel: 'Save the change',
        warnings: [
          {
            kind: 'caution',
            text: 'This decides how fast someone is checked on, and who hears when they may be in danger.',
          },
        ],
      }),
      result: { waiting: true, changes: plan.fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const plan = await safetyPlan(db, ctx, args);
    await command(db, ctx, 'safety.settings_save', { ...plan.next });
    return {
      outcome: 'Saved Safety',
      href: href(ctx, 'settings/safety'),
      command: 'safety.settings_save',
    };
  },
};

export const moreSettingsConfirmTools: Record<string, SettingsConfirmTool> = {
  manage_add_on: manageAddOn,
  update_addon_settings: updateAddonSettings,
  move_to_bin: moveToBin,
  restore_from_bin: restoreFromBin,
  update_partner_settings: updatePartnerSettings,
  manage_partner: managePartner,
  update_safety_settings: updateSafetySettings,
};

/** What the panel says while each one runs. */
export const moreSettingsStepLabels: Record<string, string> = {
  manage_add_on: 'Getting the add-on change ready',
  update_addon_settings: 'Changing the add-on’s settings',
  move_to_bin: 'Checking what goes with it',
  restore_from_bin: 'Finding it in the Deleted bin',
  update_partner_settings: 'Changing how partners are paid',
  manage_partner: 'Changing the partner',
  update_safety_settings: 'Changing Safety',
};
