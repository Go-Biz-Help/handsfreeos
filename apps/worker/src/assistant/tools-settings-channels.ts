/**
 * The ways a business is reached, set up by asking (M12, step four): texting and calls, the business number, the
 * carrier registration, email, and the chat box on the website.
 *
 * This is where the Assistant touches money and reach, so the cards do the work: getting a number says it costs
 * every month, giving one up says customers who call it reach nobody, and the registration is filled in where its
 * steps pick it up and sent by the person from Before it goes, after the checks that step runs.
 */

import {
  businessAddressOf,
  CHAT_DEFAULT_GREETING,
  chatChannelsOf,
  chatSnippet,
  chatSnippetSrc,
  emailDomainRecords,
  HfosError,
  money,
  movesWithSidsAlone,
  normalizeChatOrigins,
  transferRequestText,
  whoAnswersChat,
  type EmailDnsRecord,
  type EmailDomainRecordsLike,
} from '@hfos/core';
import { emailAddressReassign } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { hasPermission, parseBody } from '../http/common';
import {
  connectedTwilioNumbers,
  disconnectTwilioAccount,
  HostInput,
  lookupNumberHost,
  ownAccountNumbers,
  type NumberImportDeps,
} from '../http/number-import';
import { phoneAccountOf, rcsSendersOf } from '../http/telephony-reads';
import type { WorkerServices } from '../services';
import type { TelephonyProvider } from '../telephony/provider';
import type { ToolContext, ToolOutcome } from './runtime';
import { command, query, rehearse } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';
import type { ScreenActionCard } from './tools-workflow';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const action = (args: Args) => String(args['action'] ?? '');

/** "+17135551212" as people read it. */
const phoneLine = (e164: string) => {
  const digits = e164.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
    : e164;
};

interface Routing {
  forwarding: { e164: string; label: string; enabled: boolean }[];
  ringSeconds: number;
  voicemailEnabled: boolean;
  voicemailGreeting: string | null;
  forwardedCallerId: 'customer' | 'business';
}
interface PhoneStatus {
  number: { id: string; e164: string; status: string; routing: Routing } | null;
  settings: {
    quietHours: { enabled: boolean; start: string; end: string };
    unansweredReminderMinutes: number;
  };
}

const phoneStatus = (db: Db, ctx: ToolContext) =>
  query<PhoneStatus>(db, ctx, 'phone.setup_status').catch(() => null);

// ---------- texting and calls ----------

const updateTextingSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const status = await phoneStatus(db, ctx);
    // The calls settings are the number's: with none yet, saying "Saved" would be untrue.
    if (
      !status?.number &&
      (routingFrom(args, status) || bool(args['showCustomerNumber']) !== undefined)
    )
      throw HfosError.rule(
        'no_number',
        409,
        'This business has no number yet, so there are no calls to set up. Get one under Get a business number in Settings → Texting & calls first.',
      );
    const fields: Field[] = [];
    const quiet = quietFrom(args, status);
    if (quiet)
      fields.push({
        label: 'Quiet hours',
        value: quiet.enabled ? `${quiet.start}–${quiet.end}` : 'Off',
      });
    const remind = num(args['remindTeamAfterMinutes']);
    if (remind !== undefined)
      fields.push({
        label: 'Remind the team',
        value: remind === 0 ? 'Never' : `After ${remind} min waiting`,
      });
    const phones = list<{ number: string; label: string; enabled?: boolean }>(args['ringPhones']);
    if (phones)
      fields.push({
        label: 'Phones that ring',
        value: phones.length
          ? phones.map((p) => `${p.label} ${phoneLine(p.number)}`).join(', ')
          : 'Only the browsers',
      });
    const ring = num(args['ringSeconds']);
    if (ring !== undefined) fields.push({ label: 'Rings for', value: `${ring} seconds` });
    const voicemail = bool(args['voicemailEnabled']);
    if (voicemail !== undefined)
      fields.push({ label: 'Voicemail', value: voicemail ? 'On' : 'Off' });
    if (args['voicemailGreeting'] !== undefined)
      fields.push({
        label: 'Greeting',
        value: str(args['voicemailGreeting']) ?? 'The standard one',
      });
    const showCustomer = bool(args['showCustomerNumber']);
    if (showCustomer !== undefined)
      fields.push({
        label: 'Forwarded calls show',
        value: showCustomer ? 'The customer’s number' : 'Your business number',
      });
    return {
      card: settingsCard(toolCallId, 'update_texting_settings', {
        title: 'Change texting and calls',
        fields,
        confirmLabel: 'Save the change',
        warnings:
          quiet?.enabled === false
            ? [
                {
                  kind: 'quiet_hours',
                  text: 'Texts can go out at any hour once quiet hours are off.',
                },
              ]
            : [],
      }),
      result: { waiting: true, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const status = await phoneStatus(db, ctx);
    const href = `/app/w/${ctx.workspaceId}/settings/texting`;
    const quiet = quietFrom(args, status);
    const remind = num(args['remindTeamAfterMinutes']);
    if (quiet || remind !== undefined)
      await command(db, ctx, 'phone.update_settings', {
        ...(quiet ? { quietHours: quiet } : {}),
        ...(remind === undefined ? {} : { unansweredReminderMinutes: remind }),
      });
    const routing = routingFrom(args, status);
    if (routing && status?.number)
      await command(db, ctx, 'phone_number.set_routing', {
        phoneNumberId: status.number.id,
        routing,
      });
    const showCustomer = bool(args['showCustomerNumber']);
    if (showCustomer !== undefined && status?.number)
      await command(db, ctx, 'phone_number.set_caller_id', {
        phoneNumberId: status.number.id,
        forwardedCallerId: showCustomer ? 'customer' : 'business',
      });
    return { outcome: 'Saved', href, command: 'phone.update_settings' };
  },
};

/** Quiet hours as the command takes them: whole, with anything unsaid left as it is. */
function quietFrom(args: Args, status: PhoneStatus | null) {
  const enabled = bool(args['quietHoursEnabled']);
  const start = str(args['quietHoursStart']);
  const end = str(args['quietHoursEnd']);
  if (enabled === undefined && !start && !end) return null;
  const now = status?.settings.quietHours ?? { enabled: true, start: '20:00', end: '08:00' };
  return {
    enabled: enabled ?? now.enabled,
    start: start ?? now.start,
    end: end ?? now.end,
  };
}

/** Routing is a whole document too: what nobody mentioned comes back from the number as it stands. */
function routingFrom(args: Args, status: PhoneStatus | null) {
  const phones = list<{ number: string; label: string; enabled?: boolean }>(args['ringPhones']);
  const ring = num(args['ringSeconds']);
  const voicemail = bool(args['voicemailEnabled']);
  const greeting = args['voicemailGreeting'];
  if (!phones && ring === undefined && voicemail === undefined && greeting === undefined)
    return null;
  const now = status?.number?.routing;
  return {
    forwarding:
      phones?.map((p) => ({ e164: p.number, label: p.label, enabled: p.enabled !== false })) ??
      now?.forwarding ??
      [],
    ringSeconds: ring ?? now?.ringSeconds ?? 20,
    voicemailEnabled: voicemail ?? now?.voicemailEnabled ?? true,
    voicemailGreeting:
      greeting === undefined ? (now?.voicemailGreeting ?? null) : (str(greeting) ?? null),
  };
}

// ---------- the business number ----------

/**
 * What a number costs a month, as Settings → Usage & balance prices it, read as the person: null when their role may
 * not see prices, and then the card says only that it costs money every month.
 */
async function numberMonthly(
  db: Db,
  ctx: ToolContext,
  numberType: 'local' | 'toll_free',
): Promise<string | null> {
  const prices = await query<{ items: { key: string | null; cents: number }[] }>(
    db,
    ctx,
    'usage.prices',
  ).catch(() => null);
  const key = numberType === 'toll_free' ? 'number.tollfree.month' : 'number.local.month';
  const cents = prices?.items.find((i) => i.key === key)?.cents;
  return cents === undefined ? null : `${money(cents)} a month`;
}

const managePhoneNumber: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const getting = action(args) === 'get';
    const status = await phoneStatus(db, ctx);
    const number = str(args['number']) ?? status?.number?.e164 ?? '';
    const numberType = args['numberType'] === 'toll_free' ? 'toll_free' : 'local';
    // The price it will cost, as the person may see it: the number and the price are both on the card.
    const monthly = getting ? await numberMonthly(db, ctx, numberType) : null;
    return {
      card: settingsCard(toolCallId, 'manage_phone_number', {
        title: getting ? `Get ${phoneLine(number)}` : `Give up ${phoneLine(number)}`,
        fields: [
          { label: 'Number', value: phoneLine(number) },
          ...(getting
            ? [
                { label: 'Kind', value: numberType === 'toll_free' ? 'Toll-free' : 'Local' },
                ...(monthly ? [{ label: 'Costs', value: monthly }] : []),
              ]
            : []),
        ],
        confirmLabel: getting ? 'Get this number' : 'Give it up',
        warnings: getting
          ? [
              {
                kind: 'caution',
                text: monthly
                  ? `This costs ${monthly}, from your balance, every month you keep it.`
                  : 'A business number costs money every month, from your balance, for as long as you keep it.',
              },
            ]
          : [
              {
                kind: 'blocked',
                text: 'Gone for good. Anyone texting or calling it reaches nobody, and you can’t get it back.',
              },
            ],
      }),
      result: { waiting: true, number, ...(monthly ? { costs: monthly } : {}) },
    };
  },

  async commit(db, ctx, args) {
    const href = `/app/w/${ctx.workspaceId}/settings/texting`;
    if (action(args) === 'get') {
      await command(db, ctx, 'phone_number.buy', {
        e164: args['number'],
        numberType: str(args['numberType']) ?? 'local',
      });
      return {
        outcome: `${phoneLine(String(args['number']))} is being set up`,
        href,
        command: 'phone_number.buy',
      };
    }
    const status = await phoneStatus(db, ctx);
    const id = str(args['phoneNumberId']) ?? status?.number?.id;
    await command(db, ctx, 'phone_number.release', {
      phoneNumberId: id,
      confirmE164: str(args['number']) ?? status?.number?.e164,
    });
    return { outcome: 'Given up', href, command: 'phone_number.release' };
  },
};

/** How far around the business's town the setup looks first, as Your business number does. */
const NEAR_MILES = 25;

/**
 * The carrier's free numbers, as Settings → Texting & calls and the setup's Your business number search for them:
 * through the worker's own telephony, which the API never holds, for someone who may get one. With nothing asked,
 * near the business's address, as the setup does first. Nothing is bought here.
 */
async function findPhoneNumbers(
  db: Db,
  ctx: ToolContext,
  args: Args,
  telephony: TelephonyProvider | null,
): Promise<ToolOutcome> {
  if (!(await hasPermission({ httpDb: db }, ctx.actor.userId, ctx.workspaceId, 'channels.manage')))
    throw HfosError.forbidden(
      'Only people who manage texting and calls here can look for a business number. Ask an owner or admin of this business.',
    );
  if (!telephony)
    throw HfosError.rule(
      'numbers_unavailable',
      503,
      'Numbers can’t be looked up from here right now. Look on Settings → Texting & calls, or try again in a minute.',
    );
  const numberType = args['numberType'] === 'toll_free' ? 'toll_free' : 'local';
  const areaCode = str(args['areaCode']);
  const contains = str(args['contains']);
  let city = numberType === 'local' ? str(args['city']) : undefined;
  let state = numberType === 'local' ? str(args['state'])?.toUpperCase() : undefined;
  const miles = num(args['withinMiles']);
  let withinMiles = city ? miles : undefined;
  if (city && !state)
    throw HfosError.validation(
      [{ path: 'state', message: 'A city needs its state with it.' }],
      `Add ${city}’s state too, like AL: many towns share a name.`,
    );
  // The carriers look by a city in its state, never a whole state: one alone would quietly search somewhere else.
  if (state && !city)
    throw HfosError.validation(
      [{ path: 'city', message: 'A state needs a city in it.' }],
      `Name a city in ${state} too, or give an area code there instead.`,
    );
  // Nothing asked for: near the business, as the setup looks first.
  let near = false;
  if (numberType === 'local' && !city && !areaCode && !contains && args['anywhere'] !== true) {
    const ws = await query<{ workspace: { settings: Args } }>(db, ctx, 'workspace.get').catch(
      () => null,
    );
    const address = businessAddressOf(ws?.workspace.settings);
    if (address) {
      city = address.city;
      state = address.state.toUpperCase();
      // "Within 50 miles of us" widens it; nothing said is the setup's own 25.
      withinMiles = miles ?? NEAR_MILES;
      near = true;
    }
  }
  const found = await telephony.searchNumbers({
    numberType,
    ...(areaCode ? { areaCode } : {}),
    ...(contains ? { contains } : {}),
    ...(city && state ? { city, state } : {}),
    ...(city && withinMiles ? { withinMiles } : {}),
    limit: 10,
  });
  const where =
    numberType === 'toll_free'
      ? [
          'Toll-free',
          areaCode ? `Starting ${areaCode}` : null,
          contains ? `Carrying ${contains}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : [
          near ? `Within ${withinMiles} miles of ${city}, ${state}, the business’s town` : null,
          !near && city
            ? `Near ${city}, ${state}${withinMiles ? ` (${withinMiles} miles)` : ''}`
            : null,
          areaCode ? `Area code ${areaCode}` : null,
          contains ? `Carrying ${contains}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Anywhere';
  const monthly = found.length ? await numberMonthly(db, ctx, numberType) : null;
  return {
    result: {
      searched: where,
      numberType,
      ...(monthly ? { eachCosts: monthly } : {}),
      numbers: found.map((n) => ({
        number: n.e164,
        shown: phoneLine(n.e164),
        ...(n.locality ? { town: n.locality } : {}),
        ...(n.region ? { state: n.region } : {}),
      })),
      note: found.length
        ? `Free right now, and not held: read them to the person${monthly ? ` with what each costs (${monthly})` : ''}, and get the one they pick with manage_phone_number (it costs money every month, so it waits for their OK on a card that says the number and the price).`
        : 'Nothing free matches all of that right now. Carriers sell only what they have on hand: ask for less (the area code alone, or anywhere) and look again.',
    },
  };
}

/** The ones that need the worker's telephony, which only the worker holds. */
export const numberSearchTools: Record<
  string,
  (
    db: Db,
    ctx: ToolContext,
    args: Args,
    telephony: TelephonyProvider | null,
  ) => Promise<ToolOutcome>
> = {
  find_phone_numbers: findPhoneNumbers,
};

// ---------- the phone account, and numbers brought from Twilio or HighLevel ----------

/** The worker's side of Settings → Texting & calls, reached as the person the way the screen reaches it. */
const numberDeps = (db: Db, services: WorkerServices | null): NumberImportDeps => {
  if (!services)
    throw HfosError.rule(
      'telephony_unavailable',
      503,
      'The phone carrier can’t be reached from here right now. Try again in a minute, or open Settings → Texting & calls.',
    );
  return {
    httpDb: db,
    telephony: services.telephony,
    sealer: services.sealer,
    publicUrl: services.publicUrl,
  };
};

const PHONE_STATE_WORDS = {
  on: 'On',
  turning_on: 'Turning on',
  off: 'Off',
} as const;
const OWN_NUMBER_WORDS = {
  new: 'Not set up here yet: do_number_import_start brings it in',
  coming: 'On its way here: do_number_import_check_now finishes it',
  elsewhere: 'Another business here still has it, so it can’t be set up here',
} as const;

/** The numbers moving here from HighLevel or Twilio, each with the request to send their support, filled in. */
async function transferRequests(
  db: Db,
  ctx: ToolContext,
  parentAccountSid: string | null,
): Promise<{ number: string; from: string; request: string }[]> {
  const list = await query<{
    imports: {
      display: string;
      source: 'highlevel' | 'twilio';
      status: string;
      sourceAccountSid: string | null;
      destinationAccountSid: string | null;
    }[];
  }>(db, ctx, 'number_import.list').catch(() => null);
  const name = await query<{ workspace: { name: string } }>(db, ctx, 'workspace.get').then(
    (w) => w.workspace.name,
    () => null,
  );
  return (list?.imports ?? [])
    .filter((i) => i.status === 'waiting' && i.destinationAccountSid)
    .map((i) => ({
      number: i.display,
      from: i.source === 'highlevel' ? 'HighLevel' : 'Twilio',
      request: transferRequestText({
        source: i.source,
        display: i.display,
        toAccountSid: i.destinationAccountSid!,
        parentAccountSid,
        fromAccountSid: i.sourceAccountSid,
        businessName: name,
      }),
    }));
}

/** The ones that read through the worker's own services, as the screen's worker routes do. */
export const channelReadServiceTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, services: WorkerServices | null) => Promise<ToolOutcome>
> = {
  async get_phone_account(db, ctx, _args, services) {
    const deps = numberDeps(db, services);
    if (!(await hasPermission(deps, ctx.actor.userId, ctx.workspaceId, 'channels.manage')))
      throw HfosError.forbidden(
        'Only people who manage texting and calls here can see the phone account. Ask an owner or admin of this business.',
      );
    const account = await phoneAccountOf(deps, ctx.workspaceId);
    const own =
      account.state === 'on'
        ? await ownAccountNumbers(deps, ctx.actor.userId, { workspaceId: ctx.workspaceId })
        : null;
    const moving = await transferRequests(db, ctx, account.parentAccountSid);
    return {
      result: {
        phoneAndTexting: PHONE_STATE_WORDS[account.state],
        ...(account.lastError ? { problem: account.lastError } : {}),
        ...(account.accountSid
          ? { accountSid: account.accountSid, parentAccountSid: account.parentAccountSid }
          : {}),
        ...(own
          ? {
              alreadySetUpHere: own.alreadyHere,
              numbersInTheAccount: own.numbers.map((n) => ({
                number: n.e164,
                shown: n.display,
                type: n.numberType === 'toll_free' ? 'Toll-free' : 'Local',
                usedBy: n.usedBy,
                ...(n.friendlyName ? { name: n.friendlyName } : {}),
                sid: n.sid,
                state: OWN_NUMBER_WORDS[n.state],
                ...(n.importId ? { importId: n.importId } : {}),
              })),
              ...(own.truncated ? { more: 'Only the first 500 are listed.' } : {}),
            }
          : {}),
        ...(moving.length
          ? {
              transferRequests: moving,
              aboutTransferRequests:
                'Each is the request the person sends the support of where the number is now, filled in, as Bring a number shows it. A preferred cutover window can be added at its end.',
            }
          : {}),
      },
    };
  },

  async check_number_host(db, ctx, args, services) {
    const found = await lookupNumberHost(
      numberDeps(db, services),
      ctx.actor.userId,
      parseBody(HostInput, { workspaceId: ctx.workspaceId, e164: String(args['e164'] ?? '') }),
    );
    return {
      result: {
        number: found.display,
        carrier: found.carrierName ?? 'Not known',
        ...(found.lineType ? { lineType: found.lineType } : {}),
        inTwilio: found.hostedInTwilio,
        alreadyHere:
          found.alreadyHere === 'yours'
            ? 'It’s already one of this business’s numbers.'
            : found.alreadyHere === 'elsewhere'
              ? 'Another business here already has it, so it can’t come here too.'
              : null,
        note: found.alreadyHere
          ? 'Nothing to bring.'
          : found.hostedInTwilio
            ? 'It sits in Twilio, so it can move account to account in days: do_number_import_start, with source highlevel for a HighLevel or LeadConnector number. Then the person opens a HighLevel support ticket and pastes in the request get_phone_account gives (transferRequests), and leaves everything running in HighLevel until it lands.'
            : 'It isn’t in Twilio, so it comes over by a carrier port, which takes a few weeks: do_number_port_start.',
        ...(found.alreadyHere
          ? {}
          : {
              keepIt:
                'Tell the person to keep the number where it is: not to release or delete it there. A released number goes back to the carrier and can be gone for good; it has to move while it’s still active.',
            }),
        ...(!found.alreadyHere && !movesWithSidsAlone(found.e164)
          ? {
              outsideUsAndCanada:
                'Numbers outside the US and Canada also need a Regulatory Bundle SID and an Address SID in the account they move to. HandsFreeOS doesn’t set those up yet, so the person talks to HandsFreeOS before asking HighLevel to move it.',
            }
          : {}),
      },
    };
  },

  async list_twilio_numbers(db, ctx, args, services) {
    const found = await connectedTwilioNumbers(numberDeps(db, services), ctx.actor.userId, {
      workspaceId: ctx.workspaceId,
      connectionId: String(args['connectionId'] ?? ''),
    });
    return {
      result: {
        account: found.connection.friendlyName ?? found.connection.accountSid,
        numbers: found.numbers.map((n) => ({
          number: n.e164,
          shown: n.display,
          sid: n.sid,
          ...(n.friendlyName ? { name: n.friendlyName } : {}),
          usedBy: n.usedBy,
          ...(n.heldBy ? { alreadyHere: n.heldBy.workspaceName ?? 'Another business here' } : {}),
          ...(n.comingTo ? { comingTo: n.comingTo.workspaceName } : {}),
        })),
        ...(found.truncated ? { more: 'Only the first 500 are listed.' } : {}),
        note: 'One that is neither here nor on its way comes here with do_number_import_start (source twilio, with its sid and the connection). The person keeps it in their Twilio account until it lands: releasing or deleting it there can lose it for good.',
      },
    };
  },

  async list_rcs_senders(db, ctx, _args, services) {
    const deps = numberDeps(db, services);
    if (!(await hasPermission(deps, ctx.actor.userId, ctx.workspaceId, 'channels.manage')))
      throw HfosError.forbidden(
        'Only people who manage texting and calls here can see the RCS senders. Ask an owner or admin of this business.',
      );
    const found = await rcsSendersOf(deps, ctx.workspaceId);
    return {
      result: {
        senders: found.senders.map((x) => ({
          senderId: x.senderId,
          name: x.displayName,
          state: x.state,
        })),
        note: found.accountSid
          ? found.senders.length
            ? 'Connect the one HandsFreeOS made with do_rcs_sender_connect and its senderId.'
            : 'There’s no RCS sender in the business’s account yet. HandsFreeOS makes it once the person asks for one on Settings → Texting & calls, which is paid on Stripe’s page.'
          : 'Phone & texting is off, so there’s no account to look in. Turn it on first (do_telephony_enable).',
      },
    };
  },
};

/** Letting a connected Twilio account go, as its Disconnect does: HandsFreeOS forgets it; numbers here stay. */
const disconnectTwilio: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const list = await query<{
      connections: {
        id: string;
        accountSid: string;
        friendlyName: string | null;
        status: string;
      }[];
    }>(db, ctx, 'twilio_connection.list').catch(() => null);
    const c = list?.connections.find((x) => x.id === str(args['connectionId']));
    if (!c || c.status === 'disconnected')
      throw HfosError.notFound(
        'That Twilio account isn’t connected. The connected ones are on Settings → Texting & calls, under Bring a number.',
      );
    return {
      card: settingsCard(toolCallId, 'disconnect_twilio_account', {
        title: `Disconnect ${c.friendlyName ?? c.accountSid}?`,
        fields: [{ label: 'Twilio account', value: c.accountSid }],
        confirmLabel: 'Disconnect it',
        warnings: [
          {
            kind: 'caution',
            text: 'HandsFreeOS forgets this Twilio account and what it was connected with. Numbers already brought here, or on their way, stay. Bringing more from it means connecting it again, which is the person’s own.',
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async commit(db, ctx, args, { services }) {
    await disconnectTwilioAccount(numberDeps(db, services ?? null), ctx.actor.userId, {
      workspaceId: ctx.workspaceId,
      connectionId: String(args['connectionId'] ?? ''),
    });
    return {
      outcome: 'Disconnected. Numbers already here stay.',
      href: `/app/w/${ctx.workspaceId}/settings/texting`,
      command: 'twilio_connection.disconnect',
    };
  },
};

// ---------- Text me a test ----------

/** Where the test goes and what it says, as Text me a test sends it: the person's own confirmed cell by default. */
async function testTextOf(db: Db, ctx: ToolContext, args: Args) {
  const typed = str(args['toPhone']);
  let toPhone = typed;
  if (!toPhone) {
    const mine = await query<{ phone: { e164: string; verifiedAt: string | null } | null }>(
      db,
      ctx,
      'user_phone.get',
    ).catch(() => null);
    if (!mine?.phone?.verifiedAt)
      throw HfosError.rule(
        'no_cell',
        409,
        'You haven’t confirmed a cell yet, so I don’t know where to text the test. Tell me the phone to text, or confirm your cell under Account.',
      );
    toPhone = mine.phone.e164;
  }
  const { workspace } = await query<{ workspace: { name: string } }>(db, ctx, 'workspace.get');
  return {
    toPhone,
    body: `This is a test text from ${workspace.name} on HandsFreeOS. Replies land in the inbox.`,
  };
}

const sendTestText: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const t = await testTextOf(db, ctx, args);
    return {
      card: settingsCard(toolCallId, 'send_test_text', {
        title: `Text a test to ${phoneLine(t.toPhone)}`,
        fields: [
          { label: 'To', value: phoneLine(t.toPhone) },
          { label: 'Says', value: t.body },
        ],
        confirmLabel: 'Send the test',
        warnings: [
          {
            kind: 'note',
            text: bool(args['duringQuietHours'])
              ? 'It’s quiet hours, and this goes now anyway, as you asked. It’s a real text from your business number.'
              : 'It’s a real text from your business number. Replies land in the inbox.',
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async commit(db, ctx, args) {
    const t = await testTextOf(db, ctx, args);
    await command(db, ctx, 'message.send', {
      toPhone: t.toPhone,
      channel: 'sms',
      body: t.body,
      acknowledgeQuietHours: bool(args['duringQuietHours']) ?? false,
    });
    return {
      outcome: `Texted a test to ${phoneLine(t.toPhone)}`,
      href: `/app/w/${ctx.workspaceId}/settings/texting`,
      command: 'message.send',
    };
  },
};

// ---------- the carrier registration ----------

const VOLUME_WORDS: Record<string, string> = {
  under_1000: 'Under 1,000 texts a month',
  '1000_10000': '1,000–10,000 a month',
  '10000_100000': '10,000–100,000 a month',
  over_100000: 'Over 100,000 a month',
};
const USE_WORDS: Record<string, string> = {
  customer_care: 'Appointments and customer care',
  mixed: 'Answering customers and some marketing',
  marketing: 'Marketing',
};
const OPT_IN_WORDS: Record<string, string> = {
  hosted: 'The sign-up page HandsFreeOS hosts',
  own_site: 'A box on their own website',
  in_person: 'In person or on the phone',
};

/**
 * The registration's answers as its steps in Settings → Texting & calls keep them (a2p-wizard.tsx WizardForm), with
 * the words each goes by there. Never the ticks on Before it goes: those are only the business's to give.
 */
const REGISTRATION_ANSWERS: Readonly<Record<string, string>> = {
  legalName: 'Legal name',
  businessType: 'Kind of business',
  ein: 'EIN',
  website: 'Website',
  line1: 'Street',
  city: 'City',
  state: 'State',
  postalCode: 'ZIP',
  contactFirst: 'Contact’s first name',
  contactLast: 'Contact’s last name',
  contactEmail: 'Contact’s email',
  contactPhone: 'Contact’s phone',
  useCase: 'Texts are for',
  volume: 'How many',
  sensitive: 'Topics the carriers treat differently',
  samples: 'Example texts',
  optInPath: 'How customers agree',
  optIn: 'In their words',
  optInUrl: 'The page with the box',
  optInProofUrl: 'Proof of how they agree',
  ownPolicyUrl: 'Privacy policy',
  ownTermsUrl: 'Terms',
  policyEmail: 'Email on the policy',
  policyPhone: 'Phone on the policy',
};
/** The steps the screen opens at (its STEPS): How customers agree to get texts, and Before it goes. */
const STEP_HOW_THEY_AGREE = { at: 5, title: 'How customers agree to get texts' } as const;
const STEP_BEFORE_IT_GOES = { at: 7, title: 'Before it goes' } as const;

/** One answer as the person reads it back. */
function answerLine(key: string, value: unknown): string {
  if (key === 'useCase') return USE_WORDS[String(value)] ?? String(value);
  if (key === 'volume') return VOLUME_WORDS[String(value)] ?? String(value);
  if (key === 'optInPath') return OPT_IN_WORDS[String(value)] ?? String(value);
  if (key === 'businessType') return String(value).replace('_', ' ');
  if ((key === 'ownPolicyUrl' || key === 'ownTermsUrl') && value === '')
    return 'The one HandsFreeOS hosts';
  if (key === 'sensitive')
    return Array.isArray(value) && value.length ? value.join(', ') : 'None of these';
  if (key === 'samples') return (value as string[]).filter(Boolean).join(' / ');
  return String(value);
}

/**
 * Fills in the registration the way its steps do: into the answers they save as the person types
 * (registration.save_draft, `{form, at}`), so the screen opens with them. Nothing goes to the carriers: Before it goes
 * runs its checks on those exact details and takes the person's ticks, and they send it from there.
 */
async function fillInCarrierRegistration(
  db: Db,
  ctx: ToolContext,
  args: Args,
): Promise<ToolOutcome> {
  const draft = await query<{ answers: Record<string, unknown> | null }>(
    db,
    ctx,
    'registration.get_draft',
  );
  const savedForm = (draft.answers?.['form'] ?? {}) as Record<string, unknown>;
  const given: Record<string, unknown> = {};
  for (const key of Object.keys(REGISTRATION_ANSWERS)) {
    const value = args[key];
    if (value === undefined) continue;
    if (key === 'ownPolicyUrl' || key === 'ownTermsUrl') given[key] = value ?? '';
    else if (key === 'samples') {
      // The screen keeps two; one given keeps the other as it was.
      const was = Array.isArray(savedForm['samples']) ? (savedForm['samples'] as unknown[]) : [];
      const now = value as string[];
      given[key] = [now[0] ?? '', now[1] ?? (typeof was[1] === 'string' ? was[1] : '')];
    } else given[key] = value;
  }
  if (!Object.keys(given).length)
    throw HfosError.rule(
      'nothing_to_fill_in',
      400,
      'There’s nothing to fill in yet. Ask the person for an answer first, such as the business’s legal name.',
    );
  const form = { ...savedForm, ...given };
  const step = form['optInPath'] ? STEP_BEFORE_IT_GOES : STEP_HOW_THEY_AGREE;
  await command(db, ctx, 'registration.save_draft', { answers: { form, at: step.at } });
  const has = (key: string) => {
    const v = form[key];
    return Array.isArray(v) ? v.length > 0 && v.every((x) => x !== '') : !!v || v === null;
  };
  const needed = [
    'legalName',
    'businessType',
    ...(form['businessType'] === 'sole_proprietor' ? [] : ['ein']),
    'website',
    'line1',
    'city',
    'state',
    'postalCode',
    'contactFirst',
    'contactLast',
    'contactEmail',
    'contactPhone',
    'useCase',
    'volume',
    'samples',
    'optInPath',
    ...(form['optInPath'] === 'own_site' ? ['optInUrl'] : []),
    ...(form['optInPath'] === 'in_person' ? ['optInProofUrl'] : []),
  ].filter((key) => !has(key));
  // "None of these" is an answer ([]); never answered is not.
  if (!Array.isArray(form['sensitive'])) needed.push('sensitive');
  const back = `/app/w/${ctx.workspaceId}/settings/texting`;
  const lines = Object.entries(given).map(
    ([key, value]) => `${REGISTRATION_ANSWERS[key]}: ${answerLine(key, value)}`,
  );
  return {
    result: {
      saved: Object.fromEntries(
        Object.entries(given).map(([key, value]) => [
          REGISTRATION_ANSWERS[key],
          answerLine(key, value),
        ]),
      ),
      opensAt: step.title,
      ...(needed.length ? { stillToAnswer: needed.map((key) => REGISTRATION_ANSWERS[key]) } : {}),
      sent: false,
      note: needed.length
        ? 'Saved, and nothing has gone to the carriers. Read back what you saved, then ask for what’s still to answer.'
        : 'Saved, and nothing has gone to the carriers. Read back what you saved. The person sends it from Before it goes in Settings → Texting & calls: it checks the website, privacy policy and terms and the sign-up page, and takes the ticks only they give. If something won’t go green there, do_registration_request_review asks HandsFreeOS to check it by hand.',
    },
    card: {
      type: 'done',
      toolCallId: '00000000-0000-0000-0000-000000000000',
      kind: 'note',
      title: 'Filled in your texting registration',
      detail: `${lines.join('; ')}. Nothing has gone to the carriers: it opens at ${step.title} in Settings → Texting & calls.`,
      href: back,
      undoable: false,
    },
    command: 'registration.save_draft',
    record: { outcome: 'Filled in your texting registration', href: back },
  };
}

/** The settings of these channels that change on their own (risk 0–1). */
export const settingsChannelAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  fill_in_carrier_registration: fillInCarrierRegistration,
};

// ---------- email ----------

interface EmailStatus {
  sharedDomain: string;
  inboundMxHost: string;
  addresses: {
    id: string;
    address: string;
    displayName: string;
    isDefault: boolean;
    emailDomainId: string | null;
    ownerUserId?: string | null;
    ownerName?: string | null;
    ownerLeft?: boolean;
  }[];
  domains: (EmailDomainRecordsLike & { id: string; status: string })[];
}

const emailStatus = (db: Db, ctx: ToolContext) =>
  query<EmailStatus>(db, ctx, 'email.setup_status').catch(() => null);

/** Who an address is being made the own address of, by name: the card says whose, not an id. */
const personNamed = async (db: Db, ctx: ToolContext, userId: string | undefined) => {
  if (!userId) return null;
  const team = await query<{ members: { userId: string; fullName: string; email: string }[] }>(
    db,
    ctx,
    'workspace.members',
  ).catch(() => ({ members: [] }));
  const m = team.members.find((x) => x.userId === userId);
  if (!m)
    throw HfosError.notFound(
      'Nobody on this business’s team has that id. The people are in list_team.',
    );
  return m.fullName || m.email;
};
/** Said on the card when an address becomes one person's own: what the rest of the team stops getting. */
const ownWarning = (name: string) =>
  `Only ${name} sends from it, and mail to it reaches only them: the rest of the team stops seeing it in the Inbox. It stays ${name}’s while they work here.`;

/**
 * What a domain's removal takes with it, said on its card: its addresses, and for one that is a person's own, that they
 * stop getting the mail sent to it (email_domain.remove deletes the addresses on it; their conversations stay).
 */
function domainLosses(status: EmailStatus | null, domainId: string | undefined): string[] {
  const on = (status?.addresses ?? []).filter((a) => a.emailDomainId === domainId);
  if (!on.length) return [];
  const owned = on.filter((a) => a.ownerUserId && !a.ownerLeft);
  return [
    `Its addresses go with it: ${on.map((a) => a.address).join(', ')}. Mail sent to them stops arriving here, and nobody can send from them. Their conversations stay in the inbox.`,
    ...owned.map(
      (a) =>
        `${a.ownerName ?? 'Its person'} stops getting the mail sent to ${a.address}, their own address.`,
    ),
  ];
}

/** The records to add for a domain, as Use your own domain lists them, from email.setup_status. */
const recordsOf = (status: EmailStatus | null, domainName: string) => {
  const d = status?.domains.find((x) => x.domain === domainName);
  return d ? emailDomainRecords(d, status!.inboundMxHost) : [];
};
const recordLine = (r: EmailDnsRecord) =>
  `${r.type} record, host ${r.host}, value ${r.value}${r.priority ? `, priority ${r.priority}` : ''} (${r.purpose})`;

const manageEmailSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const status = await emailStatus(db, ctx);
    const address = status?.addresses.find((a) => a.id === args['emailAddressId']);
    const domain = status?.domains.find((d) => d.id === args['emailDomainId']);
    const owner = await personNamed(db, ctx, str(args['ownerUserId']));
    const card = (
      title: string,
      fields: Field[],
      confirmLabel: string,
      warn?: string | readonly string[],
    ) =>
      settingsCard(toolCallId, 'manage_email_settings', {
        title,
        fields,
        confirmLabel,
        warnings: [
          ...(typeof warn === 'string' ? [warn] : (warn ?? [])).map((text) => ({
            kind: 'note',
            text,
          })),
          ...(owner ? [{ kind: 'note', text: ownWarning(owner) }] : []),
        ],
      });
    const whose = owner ? [{ label: 'Whose', value: `${owner}’s own` }] : [];
    switch (act) {
      case 'add_address':
        if (args['emailDomainId'] !== undefined && !domain)
          throw HfosError.notFound(
            'That isn’t one of this business’s domains. Its domains are in get_settings (area email).',
          );
        return {
          card: card(
            'Add a sending address',
            [
              {
                label: 'Address',
                value: `${str(args['localPart'])}@${domain?.domain ?? status?.sharedDomain ?? 'your domain'}`,
              },
              { label: 'From', value: str(args['displayName']) ?? '' },
              ...(args['isDefault'] === true ? [{ label: 'Default', value: 'Yes' }] : []),
              ...whose,
            ],
            'Add it',
          ),
          result: { waiting: true },
        };
      case 'change_address': {
        // Name customers see is one name, saved on every address, as the screen's Save does.
        const every = (status?.addresses.length ?? 0) > 1;
        const localPart = str(args['localPart']);
        // Only the name changes: it's the business's, not one address's, so the card names no address.
        const onlyName =
          every && !!str(args['displayName']) && !localPart && !owner && args['isDefault'] !== true;
        return {
          card: card(
            onlyName
              ? 'Change the name customers see'
              : `Change ${address?.address ?? 'the address'}`,
            [
              ...(address && !onlyName
                ? [
                    {
                      label: 'Address',
                      value: localPart
                        ? `${address.address} → ${localPart}@${address.address.split('@')[1] ?? ''}`
                        : address.address,
                    },
                  ]
                : []),
              ...(str(args['displayName'])
                ? [
                    {
                      label: 'Name customers see',
                      value: every
                        ? `${str(args['displayName'])!} (on every address)`
                        : str(args['displayName'])!,
                    },
                  ]
                : []),
              ...(args['isDefault'] === true ? [{ label: 'Default', value: 'Yes' }] : []),
              ...whose,
            ],
            'Save the change',
          ),
          result: { waiting: true },
        };
      }
      case 'add_domain':
        return {
          card: card(
            `Send from ${str(args['domain'])}`,
            [{ label: 'Domain', value: str(args['domain']) ?? '' }],
            'Add it',
            'I’ll give you the records to add where you bought the domain; it starts working once they are in.',
          ),
          result: { waiting: true },
        };
      case 'check_domain':
        return {
          card: card(
            `Check ${domain?.domain ?? 'the domain'}`,
            [{ label: 'Domain', value: domain?.domain ?? '' }],
            'Check it now',
          ),
          result: { waiting: true },
        };
      case 'remove_domain':
        return {
          card: card(
            `Stop sending from ${domain?.domain ?? 'the domain'}`,
            [{ label: 'Domain', value: domain?.domain ?? '' }],
            'Remove it',
            [
              ...domainLosses(status, domain?.id),
              `Mail goes out from ${status?.sharedDomain ? `the shared address on ${status.sharedDomain}` : 'the shared address'} again.`,
            ],
          ),
          result: { waiting: true },
        };
      default:
        return {
          card: card(
            'Unblock an address',
            [{ label: 'What happens', value: 'Mail can go to it again' }],
            'Unblock it',
            'It was blocked because mail to it bounced or was marked spam.',
          ),
          result: { waiting: true },
        };
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/settings/email`;
    switch (act) {
      case 'add_address': {
        const out = await command<{ address: string }>(db, ctx, 'email_address.create', {
          localPart: args['localPart'],
          displayName: args['displayName'],
          ...defined({
            isDefault: bool(args['isDefault']),
            emailDomainId: str(args['emailDomainId']),
            ownerUserId: str(args['ownerUserId']),
          }),
        });
        return { outcome: `Sending from ${out.address}`, href, command: 'email_address.create' };
      }
      case 'change_address': {
        const name = str(args['displayName']);
        const rest = defined({
          localPart: str(args['localPart']),
          isDefault: bool(args['isDefault']),
          ownerUserId: str(args['ownerUserId']),
        });
        if (Object.keys(rest).length || !name)
          await command(db, ctx, 'email_address.update', {
            emailAddressId: args['emailAddressId'],
            ...rest,
            ...(name ? { displayName: name } : {}),
          });
        // The name customers see goes on every address, as the screen's Save puts it.
        if (name)
          for (const a of (await emailStatus(db, ctx))?.addresses ?? [])
            if (a.displayName !== name)
              await command(db, ctx, 'email_address.update', {
                emailAddressId: a.id,
                displayName: name,
              });
        return { outcome: 'Changed', href, command: 'email_address.update' };
      }
      case 'add_domain': {
        const domainName = str(args['domain'])?.toLowerCase() ?? '';
        await command(db, ctx, 'email_domain.add', { domain: args['domain'] });
        // The records to copy, as Use your own domain lists them, once Postmark has made them (usually a moment).
        const records = recordsOf(await emailStatus(db, ctx), domainName);
        return {
          outcome: records.length
            ? `${domainName} is added. Add these where you bought the domain, then ask me to check it: ${records.map(recordLine).join('; ')}.`
            : `${domainName} is added. Its records are being made: ask me for them in a minute (they’re also under Use your own domain on Settings → Email).`,
          href,
          command: 'email_domain.add',
        };
      }
      case 'check_domain': {
        await command(db, ctx, 'email_domain.verify', { emailDomainId: args['emailDomainId'] });
        return { outcome: 'Checked', href, command: 'email_domain.verify' };
      }
      case 'remove_domain':
        await command(db, ctx, 'email_domain.remove', { emailDomainId: args['emailDomainId'] });
        return { outcome: 'Removed', href, command: 'email_domain.remove' };
      default:
        await command(db, ctx, 'email_suppression.release', {
          suppressionId: args['suppressionId'],
        });
        return { outcome: 'Unblocked', href, command: 'email_suppression.release' };
    }
  },
};

/**
 * The address of someone who has left, given to the team or to someone else, as its box on Settings → Email does: the
 * card names the address, whose it was and who gets it, and says what changes for whom. Removing it with its mail is
 * never offered (coverage.ts), so it stays the person's.
 */
const reassignCard: ScreenActionCard = {
  async prepare(db, ctx, args, tool) {
    const status = await emailStatus(db, ctx);
    const a = status?.addresses.find((x) => x.id === args['emailAddressId']);
    if (!a)
      throw HfosError.notFound(
        'That isn’t one of this business’s addresses. Its addresses are in get_settings (area email).',
      );
    const was = a.ownerName ?? 'Its person';
    const to = args['to'] === 'person' ? await personNamed(db, ctx, str(args['userId'])) : null;
    return {
      card: settingsCard(tool.toolCallId, tool.name, {
        title: to ? `Give ${a.address} to ${to}` : `Give ${a.address} to the team`,
        fields: [
          { label: 'Address', value: a.address },
          { label: 'Was', value: `${was}’s, who no longer works here` },
          { label: 'Goes to', value: to ? `Only ${to}` : 'The team, in the Inbox' },
        ],
        confirmLabel: 'Give it',
        warnings: [
          {
            kind: 'caution',
            text: to
              ? `The mail ${was} had on it, sealed until now, becomes ${to}’s alone, and new mail to it reaches only ${to}: the team’s Inbox stops getting it. It stays ${to}’s while they work here.`
              : `The mail ${was} had on it, sealed until now, opens to everyone who reads email here, and new mail to it keeps coming to the team’s Inbox.`,
          },
        ],
      }),
      result: { waiting: true },
    };
  },
  async done(db, ctx, args, output) {
    const status = await emailStatus(db, ctx);
    const address = status?.addresses.find((x) => x.id === args['emailAddressId'])?.address;
    const threads = typeof output['threads'] === 'number' ? output['threads'] : null;
    const to = args['to'] === 'person' ? await personNamed(db, ctx, str(args['userId'])) : null;
    return {
      outcome: `${address ?? 'The address'} and its mail${threads === null ? '' : ` (${threads} ${threads === 1 ? 'conversation' : 'conversations'})`} are ${to ? `${to}’s` : 'the team’s'} now`,
      href: `/app/w/${ctx.workspaceId}/settings/email`,
    };
  },
};

/** The Email screen's commands drawn on cards of their own, by the commands' own names: they stay screen actions. */
export const emailScreenCards: Readonly<Record<string, ScreenActionCard>> = {
  [emailAddressReassign.name]: reassignCard,
};

// ---------- the chat box on the website ----------

type AskMode = 'never' | 'when_needed' | 'after_first_message' | 'before_chat';
const ASK_FIELDS = ['name', 'phone', 'email'] as const;
/** The screen's words for each detail, and for when it is asked. */
const ASK_LABELS = { name: 'Name', phone: 'Mobile', email: 'Email' } as const;
const ASK_WORDS: Record<AskMode, string> = {
  never: 'Don’t ask',
  when_needed: 'When needed',
  after_first_message: 'After their first message',
  before_chat: 'Before the chat starts',
};

interface Widget {
  id: string;
  name: string;
  allowedOrigins: string[];
  teammate: { id: string; name: string } | null;
  paused: boolean;
}
interface ChatTeammate {
  teammate: {
    id: string;
    name: string;
    status: string;
    config?: { channels?: { chat?: unknown; widgetId?: unknown } };
  } | null;
}

/**
 * The business's chat box: the one named, or else its first, as Settings → Website chat shows it. Forms → Website
 * chats lists every one, with the id get_settings (area website_chat) gives.
 */
async function chatBox(db: Db, ctx: ToolContext, widgetId: string | undefined) {
  const { items } = await query<{ items: Widget[] }>(db, ctx, 'chat_widget.list');
  if (!widgetId) return items[0] ?? null;
  const named = items.find((w) => w.id === widgetId);
  if (!named)
    throw HfosError.notFound(
      'That isn’t one of this business’s website chats. Its chats are in get_settings (area website_chat).',
    );
  return named;
}

const noChat = () =>
  HfosError.rule(
    'no_chat',
    409,
    'This business has no website chat yet. Say which website it goes on and I’ll set it up.',
  );

/** The sites as they will be saved, www twins added, or the screen's own words for a site it can't take. */
function sitesOf(args: Args): string[] | undefined {
  const typed = list<string>(args['websites']);
  if (!typed) return undefined;
  const { origins, issues } = normalizeChatOrigins(typed);
  if (issues.length)
    throw HfosError.validation(
      issues.map((i) => ({
        path: i.index === null ? 'websites' : `websites.${i.index}`,
        message: i.message,
      })),
      issues[0]!.message,
    );
  return origins;
}
const siteWords = (origins: readonly string[]) =>
  origins.map((o) => o.replace(/^https:\/\//, '')).join(', ');

/**
 * Who answers, as the screen's Who answers sets it: the business's AI teammate, or only the team. A new chat box
 * starts with the teammate when there is one, as the screen's set-up does. Undefined leaves it as it is.
 */
async function answerer(
  db: Db,
  ctx: ToolContext,
  ai: boolean | undefined,
  creating: boolean,
  widgetId: string | null,
) {
  if (ai === false) return { teammateId: null, who: 'Only your team', note: null };
  if (ai === undefined && !creating) return undefined;
  const { teammate } = await query<ChatTeammate>(db, ctx, 'ai_teammate.get');
  if (!teammate) {
    if (ai === undefined) return { teammateId: null, who: 'Only your team', note: null };
    throw HfosError.rule(
      'no_teammate',
      409,
      'This business has no AI teammate yet, so only your team can answer website chats. Set one up under AI teammate first, then I can have it answer.',
    );
  }
  // The screen's own note: an AI teammate that is off, whose Website chat channel is off, or that answers another
  // chat, leaves this one to the team.
  const now = whoAnswersChat(
    { id: widgetId ?? '', teammate: { id: teammate.id } },
    {
      ...chatChannelsOf(teammate.config),
      id: teammate.id,
      name: teammate.name,
      status: teammate.status,
    },
  );
  return { teammateId: teammate.id, who: `${teammate.name} (AI)`, note: now.ai ? null : now.words };
}

const CORNER_WORDS = { right: 'Bottom right', left: 'Bottom left' } as const;
const BUTTON_WORDS = { label: 'Label and icon', icon: 'Icon only', hidden: 'Hidden' } as const;

/** A colour, or the word for the one picked for you (null); undefined leaves it as it is. */
function colourArg(v: unknown, auto: string): string | null | undefined {
  if (v === auto) return null;
  return str(v);
}

/** What changes besides the sites and who answers, as the command takes it, and as the card reads it. */
function lookOf(args: Args) {
  const away = typeof args['awayMessage'] === 'string' ? args['awayMessage'].trim() : undefined;
  const name = typeof args['name'] === 'string' ? args['name'].trim() : undefined;
  const ask = (args['askFor'] ?? {}) as Partial<Record<(typeof ASK_FIELDS)[number], AskMode>>;
  const askFor = defined(Object.fromEntries(ASK_FIELDS.map((f) => [f, ask[f]])));
  const position = str(args['position']) as 'right' | 'left' | undefined;
  const phoneCorner = str(args['phonePosition']) as
    'right' | 'left' | 'same_as_computer' | undefined;
  const textColor = colourArg(args['textColor'], 'automatic');
  const topBar = colourArg(args['topBarColor'], 'same_as_button');
  const computerButton = str(args['computerButton']) as 'label' | 'icon' | undefined;
  const phoneButton = str(args['phoneButton']) as 'label' | 'icon' | 'hidden' | undefined;
  const whenAway = str(args['whenNobodyAnswers']) as 'chat' | 'away_form' | undefined;
  const fields = defined({
    name,
    // Empty or null shows no greeting, as clearing the box does.
    greeting: args['greeting'] === null || args['greeting'] === '' ? null : str(args['greeting']),
    launcherLabel: str(args['buttonLabel']),
    accentColor: str(args['color']),
    textColor,
    headerColor: topBar,
    showLogo: bool(args['showLogo']),
    position,
    mobilePosition: phoneCorner === 'same_as_computer' ? null : phoneCorner,
    desktopLift: num(args['computerLift']),
    mobileLift: num(args['phoneLift']),
    desktopButton: computerButton,
    mobileButton: phoneButton,
    awayMessage: away,
    whenAway,
    askFor: Object.keys(askFor).length ? askFor : undefined,
    smsConsent: bool(args['askForSmsConsent']),
    dailyCap: num(args['dailyCap']),
  });
  const lift = (n: number) => (n ? `${n} px higher` : 'Its usual spot');
  const words: Field[] = [
    ...(name === undefined ? [] : [{ label: 'Name', value: name || 'Its first site' }]),
    ...(num(args['dailyCap'])
      ? [{ label: 'New chats a day', value: String(args['dailyCap']) }]
      : []),
    ...(str(args['greeting'])
      ? [{ label: 'Greeting', value: str(args['greeting'])! }]
      : args['greeting'] === null || args['greeting'] === ''
        ? [{ label: 'Greeting', value: 'None' }]
        : []),
    ...(str(args['buttonLabel']) ? [{ label: 'Button', value: str(args['buttonLabel'])! }] : []),
    ...(str(args['color']) ? [{ label: 'Colour', value: str(args['color'])! }] : []),
    ...(textColor === undefined
      ? []
      : [{ label: 'Words on the button and top bar', value: textColor ?? 'Automatic' }]),
    ...(topBar === undefined
      ? []
      : [{ label: 'Top bar of the chat', value: topBar ?? 'Same as the button' }]),
    ...(bool(args['showLogo']) === undefined
      ? []
      : [{ label: 'Logo', value: args['showLogo'] ? 'Shown' : 'Initials instead' }]),
    ...(position
      ? [
          {
            label: phoneCorner ? 'Corner on computers' : 'Position',
            value: CORNER_WORDS[position],
          },
        ]
      : []),
    ...(phoneCorner
      ? [
          {
            label: 'Corner on phones',
            value:
              phoneCorner === 'same_as_computer'
                ? 'Same as on computers'
                : CORNER_WORDS[phoneCorner],
          },
        ]
      : []),
    ...(num(args['computerLift']) === undefined
      ? []
      : [{ label: 'Height on computers', value: lift(args['computerLift'] as number) }]),
    ...(num(args['phoneLift']) === undefined
      ? []
      : [{ label: 'Height on phones', value: lift(args['phoneLift'] as number) }]),
    ...(computerButton
      ? [{ label: 'Button on computers', value: BUTTON_WORDS[computerButton] }]
      : []),
    ...(phoneButton ? [{ label: 'Button on phones', value: BUTTON_WORDS[phoneButton] }] : []),
    ...(whenAway
      ? [
          {
            label: 'While nobody is answering',
            value:
              whenAway === 'chat' ? 'They can chat anyway' : 'The away message and a short form',
          },
        ]
      : []),
    ...(away === undefined ? [] : [{ label: 'Away message', value: away || 'The standard words' }]),
    ...ASK_FIELDS.filter((f) => ask[f]).map((f) => ({
      label: `Ask for their ${ASK_LABELS[f].toLowerCase()}`,
      value: ASK_WORDS[ask[f]!],
    })),
    ...(bool(args['askForSmsConsent']) === undefined
      ? []
      : [
          {
            label: 'Box to get texts',
            value: args['askForSmsConsent'] ? 'Offered' : 'Not offered',
          },
        ]),
  ];
  return { fields, words };
}

const manageWebsiteChat: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const creating = act === 'create';
    const box = await chatBox(db, ctx, str(args['widgetId']));
    if (!creating && !box) throw noChat();
    if (act === 'turn_on' || act === 'turn_off') {
      const on = act === 'turn_on';
      return {
        card: settingsCard(toolCallId, 'manage_website_chat', {
          title: on ? 'Turn the website chat on' : 'Turn the website chat off',
          fields: [
            { label: 'Chat box', value: on ? 'On' : 'Off' },
            { label: 'Shows on', value: siteWords(box!.allowedOrigins) },
          ],
          confirmLabel: on ? 'Turn it on' : 'Turn it off',
          warnings: on
            ? []
            : [{ kind: 'note', text: 'Visitors won’t see it until it is turned back on.' }],
        }),
        result: { waiting: true, widgetId: box!.id },
      };
    }
    const sites = sitesOf(args);
    if (creating && !sites)
      throw HfosError.validation(
        [{ path: 'websites', message: 'Say which website the chat goes on, like acme.com.' }],
        'Say which website the chat goes on, like acme.com.',
      );
    const who = await answerer(
      db,
      ctx,
      bool(args['answeredByAi']),
      creating,
      creating ? null : (box?.id ?? null),
    );
    const { words } = lookOf(args);
    const fields: Field[] = [
      ...(sites ? [{ label: 'Shows on', value: siteWords(sites) }] : []),
      ...(who ? [{ label: 'Who answers', value: who.who }] : []),
      ...words,
    ];
    if (!fields.length)
      throw HfosError.rule(
        'nothing_to_change',
        400,
        'Nothing to change was given. Say what to change on the chat, like its greeting or who answers.',
      );
    return {
      card: settingsCard(toolCallId, 'manage_website_chat', {
        title: creating ? 'Set up the website chat' : `Change the website chat on ${box!.name}`,
        fields,
        confirmLabel: creating ? 'Set it up' : 'Save the change',
        warnings: [
          ...(who?.note ? [{ kind: 'note' as const, text: who.note }] : []),
          ...(creating && box
            ? [
                {
                  kind: 'note' as const,
                  text: `This adds another chat beside the one on ${box.name}. Only one chat shows on a page, so give it its own sites.`,
                },
              ]
            : []),
          ...(creating
            ? [
                {
                  kind: 'note' as const,
                  text: 'It shows up once its snippet is on your site. The snippet is under Add it to your site, on its page under Website chats on the Forms page.',
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, widgetId: box?.id ?? null },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const creating = act === 'create';
    const box = await chatBox(db, ctx, str(args['widgetId']));
    const pageOf = (id: string) => `/app/w/${ctx.workspaceId}/forms/chats/${id}`;
    const href = box ? pageOf(box.id) : `/app/w/${ctx.workspaceId}/forms#website-chats`;
    if (!creating && !box) throw noChat();
    if (act === 'turn_on' || act === 'turn_off') {
      const name = act === 'turn_on' ? 'chat_widget.resume' : 'chat_widget.pause';
      await command(db, ctx, name, { widgetId: box!.id });
      return {
        outcome: act === 'turn_on' ? 'The chat box is on' : 'The chat box is off',
        href,
        command: name,
      };
    }
    const sites = sitesOf(args);
    const who = await answerer(
      db,
      ctx,
      bool(args['answeredByAi']),
      creating,
      creating ? null : (box?.id ?? null),
    );
    const { fields } = lookOf(args);
    if (creating) {
      const made = await command<{ widgetId: string; publicKey: string }>(
        db,
        ctx,
        'chat_widget.create',
        // A new chat starts with the greeting the screen's set-up fills in.
        {
          allowedOrigins: sites ?? [],
          teammateId: who?.teammateId ?? null,
          greeting: CHAT_DEFAULT_GREETING,
          ...fields,
        },
      );
      // The snippet as Add it to your site copies it. Its address is a path here, which the executor writes out whole
      // on the business's own domain when one is serving (full-links.ts), as the screen does.
      const snippet = chatSnippet(chatSnippetSrc('', made.publicKey));
      return {
        outcome: `The chat box is set up. Its snippet, to paste just before </body> on every page of the site: ${snippet} It’s also under Add it to your site, on its page under Website chats on the Forms page.`,
        href: pageOf(made.widgetId),
        command: 'chat_widget.create',
      };
    }
    await command(db, ctx, 'chat_widget.update', {
      widgetId: box!.id,
      ...(sites ? { allowedOrigins: sites } : {}),
      ...(who ? { teammateId: who.teammateId } : {}),
      ...fields,
    });
    return { outcome: 'Changed', href, command: 'chat_widget.update' };
  },
};

// ---------- lead intake: leads that arrive on their own ----------

/** Each way in on Settings → Lead intake, as its card says it. */
const CHANNEL_WORDS = {
  text: 'someone texts you',
  call: 'a call is missed',
  email: 'someone emails you',
  messenger: 'someone messages your Facebook Page',
  instagram: 'someone messages your Instagram account',
  facebook_lead_ad: 'someone sends your lead ad’s form',
  indeed: 'Indeed emails you about an applicant',
} as const;
type Channel = keyof typeof CHANNEL_WORDS;

interface IntakeSource {
  kind: string;
  name: string;
  active: boolean;
  createLead: boolean;
  pipelineId: string | null;
  stageId: string | null;
  dailyCap: number;
}
interface IntakeList {
  sources: IntakeSource[];
  pipelines: { id: string; name: string; stages: { id: string; name: string; kind: string }[] }[];
}
interface MetaList {
  accounts: { platform: 'facebook' | 'instagram'; status: string }[];
}

const channelOf = (args: Args): Channel => {
  const c = str(args['channel']);
  return c && c in CHANNEL_WORDS ? (c as Channel) : 'text';
};

interface IntakeInput {
  kind: Channel;
  active?: boolean;
  createLead?: boolean;
  pipelineId?: string | null;
  stageId?: string | null;
  name?: string;
  dailyCap?: number;
}

/** What the command is given: the channel, and only what was asked. */
const intakeInput = (args: Args): IntakeInput => ({
  kind: channelOf(args),
  ...(defined({
    active: bool(args['active']),
    createLead: bool(args['createLead']),
    pipelineId: args['pipelineId'] === null ? null : str(args['pipelineId']),
    stageId: args['stageId'] === null ? null : str(args['stageId']),
    name: str(args['name']),
    dailyCap: num(args['dailyCap']),
  }) as Omit<IntakeInput, 'kind'>),
});

/** Messages and lead ads arrive only from what's connected on Settings → Facebook & Instagram. */
async function metaNote(db: Db, ctx: ToolContext, channel: Channel): Promise<string | null> {
  if (channel !== 'messenger' && channel !== 'instagram' && channel !== 'facebook_lead_ad')
    return null;
  const meta = await query<MetaList>(db, ctx, 'meta_account.list').catch(() => null);
  if (!meta) return null;
  const platform = channel === 'instagram' ? 'instagram' : 'facebook';
  if (meta.accounts.some((a) => a.platform === platform && a.status !== 'disconnected'))
    return null;
  return channel === 'instagram'
    ? 'No Instagram account is connected yet, so nothing comes in this way until one is. Connecting it is yours to do, with Connect Facebook in Settings → Facebook & Instagram.'
    : 'No Facebook Page is connected yet, so nothing comes in this way until one is. Connecting it is yours to do, with Connect Facebook in Settings → Facebook & Instagram.';
}

/** What turning a channel off means for the people who arrive on it. */
const OFF_WORDS: Record<Channel, string> = {
  text: 'Their texts still reach your inbox. Nobody is added to your customers or leads.',
  call: 'Their calls and voicemails still reach your inbox. Nobody is added to your customers or leads.',
  email: 'Their emails still reach your inbox. Nobody is added to your customers or leads.',
  messenger: 'Their messages still reach your inbox. Nobody is added to your customers or leads.',
  instagram: 'Their messages still reach your inbox. Nobody is added to your customers or leads.',
  facebook_lead_ad: 'Lead ad forms sent while it’s off aren’t added to your customers or leads.',
  indeed:
    'Applicants Indeed emails you about aren’t added to your customers or leads. The emails still arrive.',
};

const manageLeadIntake: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const input = intakeInput(args);
    const channel = input.kind;
    const words = CHANNEL_WORDS[channel];
    const list = await query<IntakeList>(db, ctx, 'intake.list');
    const current = list.sources.find((s) => s.kind === channel);
    const asked = Object.keys(input).filter((k) => k !== 'kind');
    if (!asked.length)
      throw HfosError.rule(
        'nothing_to_change',
        400,
        `Say what to change about leads when ${words}: on or off, whether a lead opens, where it lands, what it’s filed under, or the most a day.`,
      );
    const active = input.active;
    if (asked.length === 1 && active !== undefined && current?.active === active)
      throw HfosError.rule(
        'nothing_to_change',
        400,
        active
          ? `Nothing would change. Leads already come in when ${words}.`
          : `Nothing would change. It’s already off, so nobody becomes a lead when ${words}.`,
      );
    const fields: Field[] = [];
    if (active !== undefined)
      fields.push({ label: 'New customer and lead', value: active ? 'Yes' : 'No' });
    if (input.createLead !== undefined)
      fields.push({ label: 'Opens a lead', value: input.createLead ? 'Yes' : 'Customer only' });
    if (input.pipelineId !== undefined || input.stageId !== undefined) {
      const pipelineId =
        input.pipelineId === undefined ? (current?.pipelineId ?? null) : input.pipelineId;
      const pipeline = list.pipelines.find((p) => p.id === pipelineId);
      if (pipelineId && !pipeline)
        throw HfosError.validation(
          [{ path: 'pipelineId', message: 'Pick one of your pipelines.' }],
          'No pipeline has that id. Pick one from get_settings (area lead_intake).',
        );
      const stage = pipeline?.stages.find((s) => s.id === input.stageId);
      if (input.stageId && pipeline && !stage)
        throw HfosError.validation(
          [{ path: 'stageId', message: 'Pick a stage in that pipeline.' }],
          `That stage isn’t in ${pipeline.name}. Pick one of its stages from get_settings (area lead_intake).`,
        );
      fields.push(
        { label: 'Lands in', value: pipeline?.name ?? 'Your first pipeline' },
        { label: 'Stage', value: stage?.name ?? 'Its first open stage' },
      );
    }
    if (input.name) fields.push({ label: 'Filed under', value: input.name });
    if (input.dailyCap) fields.push({ label: 'Most a day', value: String(input.dailyCap) });
    // The command's own rules refuse anything else before any card is drawn.
    await rehearse(db, ctx, 'intake_source.update', { ...input });

    const off = active === false;
    const turningOn = active === true && current?.active === false;
    const warnings: { kind: 'note' | 'caution'; text: string }[] = [];
    if (off)
      warnings.push({
        kind: channel === 'facebook_lead_ad' || channel === 'indeed' ? 'caution' : 'note',
        text: OFF_WORDS[channel],
      });
    if (!off) {
      const meta = await metaNote(db, ctx, channel);
      if (meta) warnings.push({ kind: 'note', text: meta });
    }
    if (turningOn && channel === 'indeed')
      warnings.push({
        kind: 'note',
        text: 'Indeed’s emails need to reach a connected inbox, or one you forward them to.',
      });
    else if (turningOn && (channel === 'text' || channel === 'call' || channel === 'email'))
      warnings.push({
        kind: 'note',
        text: 'Wrong numbers and spam can become leads; archive those.',
      });

    return {
      card: settingsCard(toolCallId, 'manage_lead_intake', {
        title: off
          ? `Stop opening leads when ${words}`
          : active
            ? `Open a lead when ${words}`
            : `Change the leads that come in when ${words}`,
        fields,
        confirmLabel: off ? 'Turn it off' : 'Save the change',
        warnings,
      }),
      result: { waiting: true, channel },
    };
  },

  async commit(db, ctx, args) {
    const input = intakeInput(args);
    await command(db, ctx, 'intake_source.update', { ...input });
    const words = CHANNEL_WORDS[input.kind];
    return {
      outcome:
        input.active === false
          ? `No more leads when ${words}`
          : input.active === true
            ? `Leads will come in when ${words}`
            : 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/lead-intake`,
      command: 'intake_source.update',
    };
  },
};

export const settingsChannelConfirmTools: Record<string, SettingsConfirmTool> = {
  send_test_text: sendTestText,
  disconnect_twilio_account: disconnectTwilio,
  update_texting_settings: updateTextingSettings,
  manage_phone_number: managePhoneNumber,
  manage_email_settings: manageEmailSettings,
  manage_website_chat: manageWebsiteChat,
  manage_lead_intake: manageLeadIntake,
};
