/**
 * The last settings the Assistant used to hand back (packages/core/src/assistant/tools-settings-more.ts): add-ons,
 * the Deleted bin, partners and Settings → Safety. Each card is read from what is there now, so it says what will
 * really change; a request that changes nothing is turned back before a card is drawn. On Confirm, the screen's own
 * command runs as the person.
 */
import { HfosError } from '@hfos/core';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
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
    await command(db, ctx, `addon.${LIFECYCLE[act]}`, {
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
      command: `addon.${LIFECYCLE[act]}`,
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
  if (next.calendarId !== now.settings.calendarId)
    fields.push({
      label: 'The calendar their links book',
      value: next.calendarId ? 'Changed' : 'None',
    });
  const termsChanged = next.terms !== now.settings.terms;
  if (termsChanged) fields.push({ label: 'Terms', value: next.terms || 'None' });
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
          ...(plan.termsChanged
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
  restore_from_bin: restoreFromBin,
  update_partner_settings: updatePartnerSettings,
  manage_partner: managePartner,
  update_safety_settings: updateSafetySettings,
};

/** What the panel says while each one runs. */
export const moreSettingsStepLabels: Record<string, string> = {
  manage_add_on: 'Getting the add-on change ready',
  restore_from_bin: 'Finding it in the Deleted bin',
  update_partner_settings: 'Changing how partners are paid',
  manage_partner: 'Changing the partner',
  update_safety_settings: 'Changing Safety',
};
