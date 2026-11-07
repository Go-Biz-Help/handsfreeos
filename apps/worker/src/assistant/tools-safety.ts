/**
 * The person's own safety, by asking (packages/core/src/assistant/tools-safety.ts): the phone's own commands, run as
 * them. Checking in, adding time and checking out change only their own check-in, so they run on their own. Asking
 * for help tells people at once, so its card first says to call 911 in danger and then exactly who is told, worked out
 * as the safety ladder does (apps/worker/src/safety/ladder.ts). Their own contacts change on a card.
 */
import { randomUUID } from 'node:crypto';
import {
  formatPhone,
  HfosError,
  namesList,
  SAFETY_CONTACT_WORDS,
  SAFETY_DEFAULTS,
  SAFETY_LIMITS,
  SAFETY_PHONE_WORDS,
  type SafetyContactStatus,
} from '@hfos/core';
import { localDateOf } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { atLabel, clockLabel } from './calendar-format';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, query, rehearse } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

interface Contact {
  id: string;
  contactUserId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  status: SafetyContactStatus;
}
interface CheckIn {
  id: string;
  place: string;
  plannedEndAt: string;
  state: 'in' | 'asked' | 'alerted' | 'ok' | 'out' | 'help';
  follows?: boolean;
  locatedAt?: string | null;
}
interface Mine {
  contacts: Contact[];
  open: CheckIn | null;
}
interface Person {
  userId: string;
  fullName: string;
  email: string;
  role?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;
const nameOf = (p: Person) => p.fullName || p.email;
const mineOf = (db: Db, ctx: ToolContext) => query<Mine>(db, ctx, 'safety.mine');
const page = (ctx: ToolContext) => `/app/w/${ctx.workspaceId}/safety`;
/** Who's told when the business's owners and admins can't be read by name. */
const MANAGERS = 'the business’s owners and admins';

/** "3:30 PM" today, "Fri, Sep 18 at 1:00 AM" past midnight. */
function untilLabel(at: string, timeZone: string): string {
  const ms = Date.parse(at);
  return localDateOf(ms, timeZone) === localDateOf(Date.now(), timeZone)
    ? clockLabel(ms, timeZone)
    : atLabel(ms, timeZone);
}

/** The team as Members lists it, or null when this person may not read it (they're then trusted as they were saved). */
async function teamOf(db: Db, ctx: ToolContext): Promise<Person[] | null> {
  return query<{ members: Person[]; organizationAdmins?: Person[] }>(db, ctx, 'workspace.members')
    .then((t) => [...t.members, ...(t.organizationAdmins ?? [])])
    .catch(() => null);
}

interface WhoIsTold {
  /** Who hears at once: their names. */
  readonly names: string[];
  /** Whose they are: the person's own contacts, the business's safety person, or its owners and admins. */
  readonly who: 'contacts' | 'safety_person' | 'owners_and_admins';
  /** In words, for a card: "Sam Lee in the app, and Ana Ruiz by text and email". */
  readonly how: string;
  /** Their own contacts who aren't told, and why. */
  readonly notTold: string[];
}

/**
 * Who is told if they don't check out or ask for help, as the ladder works it out: their teammate contacts still on
 * the team, in the app, and those outside who replied OK and never STOP, by text and email. With none of those, the
 * business's safety person (when it isn't them), and with none, its owners and admins.
 */
async function whoIsTold(
  db: Db,
  ctx: ToolContext,
  contacts: readonly Contact[],
): Promise<WhoIsTold> {
  const team = await teamOf(db, ctx);
  const onTeam = (userId: string) => !team || team.some((m) => m.userId === userId);
  const mates = contacts.filter((c) => c.status === 'teammate' && onTeam(c.contactUserId!));
  const outside = contacts.filter((c) => c.status === 'agreed');
  const notTold = contacts
    .filter((c) => !mates.includes(c) && !outside.includes(c))
    .map((c) =>
      c.status === 'teammate'
        ? `${c.name}: not on the team anymore`
        : `${c.name}: ${SAFETY_CONTACT_WORDS[c.status]}`,
    );
  if (mates.length || outside.length) {
    const how = [
      mates.length ? `${namesList(mates.map((c) => c.name))} in the app` : '',
      outside.length ? `${namesList(outside.map((c) => c.name))} by text and email` : '',
    ].filter(Boolean);
    return {
      names: [...mates, ...outside].map((c) => c.name),
      who: 'contacts',
      how: how.join(', and '),
      notTold,
    };
  }
  const settings = await query<{ safetyUserId: string | null; safetyPersonName: string | null }>(
    db,
    ctx,
    'safety.settings',
  ).catch(() => ({ safetyUserId: null, safetyPersonName: null }));
  const me = ctx.actor.userId;
  if (settings.safetyUserId && settings.safetyUserId !== me && onTeam(settings.safetyUserId)) {
    const name =
      team?.find((m) => m.userId === settings.safetyUserId)?.fullName ||
      settings.safetyPersonName ||
      'The business’s safety person';
    return {
      names: [name],
      who: 'safety_person',
      how: `${name}, the business’s safety person, in the app`,
      notTold,
    };
  }
  const managers = (team ?? []).filter(
    (m) => (m.role === 'owner' || m.role === 'admin') && m.userId !== me,
  );
  const names = managers.length ? managers.map(nameOf) : [MANAGERS];
  return {
    names,
    who: 'owners_and_admins',
    how: managers.length
      ? `${namesList(names)}, the business’s owners and admins, in the app`
      : `${MANAGERS}, in the app`,
    notTold,
  };
}

const toldWord = (names: readonly string[]) =>
  names.length === 1 && names[0] !== MANAGERS ? 'is' : 'are';
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Their open check-in, or a refusal that says how to start one. */
function openOf(mine: Mine): CheckIn {
  if (!mine.open)
    throw HfosError.rule(
      'safety_not_checked_in',
      409,
      'You’re not checked in anywhere right now. Say where you are and when you plan to leave, and I’ll check you in.',
    );
  return mine.open;
}

// ---------- checking in, adding time, checking out: their own, now ----------

async function myCheckIn(db: Db, ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const act = str(args['action']);
  const mine = await mineOf(db, ctx);
  const href = page(ctx);
  if (act === 'start') {
    const place = str(args['place']);
    const until = str(args['until']);
    if (!place || !until)
      throw HfosError.validation(
        [
          ...(place ? [] : [{ path: 'place', message: SAFETY_PHONE_WORDS.needsPlace }]),
          ...(until ? [] : [{ path: 'until', message: 'Say when you plan to leave.' }]),
        ],
        'Say where you are and when you plan to leave, and I’ll check you in.',
      );
    const appointmentId = str(args['appointmentId']);
    const out = await command<{ checkIn: CheckIn }>(db, ctx, 'safety.check_in', {
      id: randomUUID(),
      place,
      plannedEndAt: until,
      ...(appointmentId ? { appointmentId } : {}),
    });
    const time = untilLabel(out.checkIn.plannedEndAt, ctx.timezone);
    const told = await whoIsTold(db, ctx, mine.contacts);
    return {
      result: {
        checkedIn: out.checkIn.place,
        until: time,
        ifYouDontCheckOut: `HandsFreeOS asks you if you’re OK after ${time}, then ${namesList(told.names)} ${toldWord(told.names)} told where you were.`,
        ...(told.who === 'contacts'
          ? {}
          : {
              note: 'You have nobody of your own to tell yet: choose them with manage_my_safety_contacts, or on the phone in More, then Settings, then My safety.',
            }),
        ...(told.notTold.length ? { notTold: told.notTold } : {}),
        ...(mine.open && mine.open.id !== out.checkIn.id
          ? { checkedOutFirst: mine.open.place }
          : {}),
        sharingWhereYouAre:
          'Not from here: only the phone knows where it is. Check in on the phone with Share where I am on to share it.',
        then: 'my_check_in adds time or checks out.',
      },
      command: 'safety.check_in',
      record: { outcome: `Checked in at ${out.checkIn.place} until ${time}`, href },
    };
  }
  const open = openOf(mine);
  const wasTold = open.state === 'alerted' || open.state === 'help';
  if (act === 'add_time') {
    const minutes = typeof args['minutes'] === 'number' ? args['minutes'] : 15;
    const out = await command<{ checkIn: CheckIn }>(db, ctx, 'safety.extend', {
      checkInId: open.id,
      minutes,
    });
    const time = untilLabel(out.checkIn.plannedEndAt, ctx.timezone);
    return {
      result: {
        place: out.checkIn.place,
        until: time,
        said: SAFETY_PHONE_WORDS.added(time),
        ...(wasTold ? { told: 'Everyone who was told hears you’re OK.' } : {}),
      },
      command: 'safety.extend',
      record: { outcome: `Checked in at ${out.checkIn.place} until ${time}`, href },
    };
  }
  await command(db, ctx, 'safety.check_out', { checkInId: open.id });
  return {
    result: {
      checkedOut: open.place,
      said: SAFETY_PHONE_WORDS.checkedOut,
      ...(wasTold ? { told: 'Everyone who was told hears you’re OK.' } : {}),
    },
    command: 'safety.check_out',
    record: { outcome: `Checked out of ${open.place}`, href },
  };
}

// ---------- asking for help: on a card that says who is told ----------

const CALL_911 = 'In danger? Call 911 now. HandsFreeOS never calls 911.';

/** Where help is asked from: the check-in open now, or the place they said. */
function helpFrom(
  mine: Mine,
  args: Args,
): { checkInId: string; place: string } | { place: string } {
  if (mine.open) return { checkInId: mine.open.id, place: mine.open.place };
  const place = str(args['place']);
  if (!place)
    throw HfosError.validation(
      [{ path: 'place', message: 'Say where you are, so your contacts can find you.' }],
      `You’re not checked in anywhere, so say where you are and I’ll tell them. ${CALL_911}`,
    );
  return { place };
}

const askForHelp: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const mine = await mineOf(db, ctx);
    const from = helpFrom(mine, args);
    const told = await whoIsTold(db, ctx, mine.contacts);
    const fields: Field[] = [
      { label: 'Where', value: from.place },
      { label: 'Told at once', value: told.how },
      {
        label: 'Then',
        value: `Again every ${SAFETY_DEFAULTS.repeatMinutes} minutes, for an hour, until someone says you’re OK`,
      },
    ];
    if (told.notTold.length) fields.push({ label: 'Not told', value: told.notTold.join('; ') });
    return {
      card: settingsCard(toolCallId, 'ask_for_help', {
        title: 'Ask for help now',
        fields,
        confirmLabel: 'Tell them now',
        warnings: [
          { kind: 'caution', text: CALL_911 },
          {
            kind: 'note',
            text: `${capitalized(namesList(told.names))} ${toldWord(told.names)} told at once that you need help, and where you are${
              mine.open?.locatedAt ? ', with where your phone was last' : ''
            }. Where your phone is right now goes only from Help on the phone.`,
          },
        ],
      }),
      result: {
        waiting: true,
        callFirst: CALL_911,
        toldAtOnce: told.names,
        ...(told.who === 'contacts' ? {} : { because: 'They have nobody of their own to tell.' }),
      },
    };
  },

  async commit(db, ctx, args) {
    const mine = await mineOf(db, ctx);
    const from = helpFrom(mine, args);
    const told = await whoIsTold(db, ctx, mine.contacts);
    await command(
      db,
      ctx,
      'safety.help',
      'checkInId' in from ? { checkInId: from.checkInId } : { place: from.place },
    );
    return {
      outcome: `${capitalized(namesList(told.names[0] === MANAGERS ? told.names : told.names.map(firstOf)))} ${toldWord(told.names)} being told now, with where you are. If you’re in danger, call 911.`,
      href: page(ctx),
      command: 'safety.help',
    };
  },
};

// ---------- their own safety contacts: on a card ----------

async function contactPlan(db: Db, ctx: ToolContext, args: Args) {
  const act = str(args['action']);
  const mine = await mineOf(db, ctx);
  if (act === 'remove') {
    const contact = mine.contacts.find((c) => c.id === args['contactId']);
    if (!contact)
      throw HfosError.notFound(
        'That isn’t one of your safety contacts anymore. Read who’s there now with read_safety_mine.',
      );
    return { act, mine, contact, input: { id: contact.id } } as const;
  }
  if (act === 'add_teammate') {
    const contactUserId = str(args['contactUserId']);
    if (!contactUserId)
      throw HfosError.validation(
        [{ path: 'contactUserId', message: 'Pick a teammate.' }],
        'Say which teammate to tell. Their id is in list_team.',
      );
    if (mine.contacts.some((c) => c.contactUserId === contactUserId))
      throw HfosError.rule(
        'safety_contact_already',
        409,
        `${mine.contacts.find((c) => c.contactUserId === contactUserId)!.name} is already one of your safety contacts.`,
      );
    const input = { contactUserId };
    const saved = await rehearse<{ contact: Contact }>(db, ctx, 'safety_contact.save', input);
    return { act, mine, contact: saved.contact, input } as const;
  }
  const name = str(args['name']);
  const phone = str(args['phone']);
  const email = str(args['email']);
  if (!name || (!phone && !email))
    throw HfosError.validation(
      [{ path: 'name', message: 'Enter their name, with their phone or email.' }],
      'Say their name and their cell, their email or both.',
    );
  const input = { name, ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
  const saved = await rehearse<{ contact: Contact }>(db, ctx, 'safety_contact.save', input);
  return { act: 'add_outside', mine, contact: saved.contact, input } as const;
}

const manageMySafetyContacts: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await contactPlan(db, ctx, args);
    const c = plan.contact;
    const now = plan.mine.contacts.map((k) => k.name);
    if (plan.act === 'remove') {
      const left = plan.mine.contacts.filter((k) => k.id !== c.id);
      const nobodyLeft = !left.some((k) => k.status === 'teammate' || k.status === 'agreed');
      return {
        card: settingsCard(toolCallId, 'manage_my_safety_contacts', {
          title: `Remove ${c.name}`,
          fields: [
            { label: 'Who', value: c.name },
            { label: 'How they’re told now', value: SAFETY_CONTACT_WORDS[c.status] },
            {
              label: 'Still told',
              value: left.length ? namesList(left.map((k) => k.name)) : 'Nobody of your own',
            },
          ],
          confirmLabel: 'Remove them',
          warnings: [
            {
              kind: 'caution',
              text: `${firstOf(c.name)} won’t be told if you don’t check out or ask for help.`,
            },
            ...(nobodyLeft
              ? [
                  {
                    kind: 'note',
                    text: 'With nobody of your own to tell, the business’s safety person is told instead, or its owners and admins.',
                  },
                ]
              : []),
          ],
        }),
        result: { waiting: true },
      };
    }
    const outside = plan.act === 'add_outside';
    const fields: Field[] = outside
      ? [
          { label: 'Name', value: c.name },
          ...(c.phone ? [{ label: 'Phone', value: formatPhone(c.phone) }] : []),
          ...(c.email ? [{ label: 'Email', value: c.email }] : []),
        ]
      : [
          { label: 'Teammate', value: c.name },
          { label: 'How they’re told', value: SAFETY_CONTACT_WORDS.teammate },
        ];
    fields.push({
      label: 'Who’s told now',
      value: `${now.length ? namesList(now) : 'Nobody of your own'} (${now.length} of ${SAFETY_LIMITS.contacts})`,
    });
    return {
      card: settingsCard(toolCallId, 'manage_my_safety_contacts', {
        title: `Tell ${c.name} if you don’t check out`,
        fields,
        confirmLabel: 'Add them',
        warnings: outside
          ? [
              { kind: 'note', text: SAFETY_PHONE_WORDS.outsideNote },
              ...(c.phone
                ? []
                : [
                    {
                      kind: 'caution',
                      text: 'With an email alone they’re never asked, so they’re never told. Add their cell for that.',
                    },
                  ]),
            ]
          : [
              {
                kind: 'note',
                text: `${firstOf(c.name)} gets an alert in the app if you don’t check out or ask for help.`,
              },
            ],
      }),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const plan = await contactPlan(db, ctx, args);
    if (plan.act === 'remove') {
      await command(db, ctx, 'safety_contact.remove', plan.input);
      return {
        outcome: `Removed ${plan.contact.name}`,
        href: page(ctx),
        command: 'safety_contact.remove',
      };
    }
    await command(db, ctx, 'safety_contact.save', plan.input);
    return {
      outcome:
        plan.act === 'add_outside' && plan.contact.phone
          ? `Added ${plan.contact.name}: they get a text asking them to reply OK`
          : `Added ${plan.contact.name}`,
      href: page(ctx),
      command: 'safety_contact.save',
    };
  },
};

export const safetyAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  my_check_in: myCheckIn,
};

export const safetyConfirmTools: Record<string, SettingsConfirmTool> = {
  ask_for_help: askForHelp,
  manage_my_safety_contacts: manageMySafetyContacts,
};

/** What the panel says while each one runs. */
export const safetyStepLabels: Record<string, string> = {
  my_check_in: 'Changing your check-in',
  ask_for_help: 'Getting help ready',
  manage_my_safety_contacts: 'Getting who’s told ready',
};
