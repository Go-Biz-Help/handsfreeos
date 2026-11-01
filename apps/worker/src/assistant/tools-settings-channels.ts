/**
 * The ways a business is reached, set up by asking (M12, step four): texting and calls, the business number, the
 * carrier registration, email, and the chat box on the website.
 *
 * This is where the Assistant touches money and reach, so the cards do the work: getting a number says it costs
 * every month, giving one up says customers who call it reach nobody, and the registration is read back in full
 * before it goes to the carriers, because they take days to answer and a wrong answer means starting again.
 */

import { HfosError, money, normalizeChatOrigins } from '@hfos/core';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

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

const managePhoneNumber: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const getting = action(args) === 'get';
    const status = await phoneStatus(db, ctx);
    const number = str(args['number']) ?? status?.number?.e164 ?? '';
    return {
      card: settingsCard(toolCallId, 'manage_phone_number', {
        title: getting ? `Get ${phoneLine(number)}` : `Give up ${phoneLine(number)}`,
        fields: [
          { label: 'Number', value: phoneLine(number) },
          ...(getting
            ? [{ label: 'Kind', value: args['numberType'] === 'toll_free' ? 'Toll-free' : 'Local' }]
            : []),
        ],
        confirmLabel: getting ? 'Get this number' : 'Give it up',
        warnings: getting
          ? [{ kind: 'note', text: 'A business number costs money every month.' }]
          : [
              {
                kind: 'blocked',
                text: 'Gone for good. Anyone texting or calling it reaches nobody, and you can’t get it back.',
              },
            ],
      }),
      result: { waiting: true, number },
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

// ---------- the carrier registration ----------

const VOLUME_WORDS: Record<string, string> = {
  under_1000: 'Under 1,000 texts a month',
  '1000_10000': '1,000–10,000 a month',
  '10000_100000': '10,000–100,000 a month',
  over_100000: 'Over 100,000 a month',
};
const USE_WORDS: Record<string, string> = {
  customer_care: 'Answering customers',
  mixed: 'Answering customers and some marketing',
  marketing: 'Marketing',
};

/** What the carriers are sent, built the same way for the card and for the send. */
function registrationInput(args: Args) {
  return {
    kind: str(args['kind']) ?? 'a2p_10dlc',
    business: {
      legalName: args['legalName'],
      businessType: args['businessType'],
      ein: args['ein'] === undefined ? undefined : (str(args['ein']) ?? null),
      website: args['website'],
      address: {
        line1: args['addressLine1'],
        city: args['city'],
        state: args['state'],
        postalCode: args['postalCode'],
      },
      contact: {
        firstName: args['contactFirstName'],
        lastName: args['contactLastName'],
        email: args['contactEmail'],
        phone: args['contactPhone'],
      },
      useCase: args['useCase'],
      messageSamples: args['messageSamples'],
      optInDescription: args['optInDescription'],
      monthlyVolume: args['monthlyVolume'],
    },
  };
}

const submitCarrierRegistration: SettingsConfirmTool = {
  async prepare(_db, _ctx, args, toolCallId) {
    const samples = list<string>(args['messageSamples']) ?? [];
    return {
      card: settingsCard(toolCallId, 'submit_carrier_registration', {
        title: 'Send your texting registration',
        fields: [
          { label: 'Business', value: str(args['legalName']) ?? '' },
          { label: 'Kind', value: String(args['businessType'] ?? '').replace('_', ' ') },
          ...(str(args['ein']) ? [{ label: 'EIN', value: str(args['ein'])! }] : []),
          { label: 'Website', value: str(args['website']) ?? '' },
          {
            label: 'Address',
            value: [args['addressLine1'], args['city'], args['state'], args['postalCode']]
              .filter(Boolean)
              .join(', '),
          },
          {
            label: 'Contact',
            value:
              `${str(args['contactFirstName']) ?? ''} ${str(args['contactLastName']) ?? ''}, ${str(args['contactEmail']) ?? ''}`.trim(),
          },
          { label: 'Texts are for', value: USE_WORDS[String(args['useCase'])] ?? '' },
          { label: 'How many', value: VOLUME_WORDS[String(args['monthlyVolume'])] ?? '' },
          {
            label: 'Examples',
            value: samples.length === 1 ? samples[0]! : `${samples.length} example texts`,
          },
          { label: 'How customers agree', value: str(args['optInDescription']) ?? '' },
        ],
        confirmLabel: 'Send it to the carriers',
        warnings: [
          {
            kind: 'note',
            text: 'The carriers review this, which takes a few days. Texting turns on once they approve it.',
          },
          // 0105: a local registration's carrier fees are the business's, paid before it goes.
          ...((str(args['kind']) ?? 'a2p_10dlc') === 'a2p_10dlc'
            ? [
                {
                  kind: 'note' as const,
                  text: 'A local-number registration has carrier fees, passed on at cost. You pay them in Settings → Texting & calls, and it goes to the carriers once they’re paid.',
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const sent = await command<{ fee: { amountCents: number } | null }>(
      db,
      ctx,
      'registration.submit',
      registrationInput(args),
    );
    return {
      // With fees to pay, it waits for them: say where, rather than that it went.
      outcome: sent.fee
        ? `Saved. Pay ${money(sent.fee.amountCents)} in Settings → Texting & calls to send it to the carriers`
        : 'Sent to the carriers',
      href: `/app/w/${ctx.workspaceId}/settings/texting`,
      command: 'registration.submit',
    };
  },
};

// ---------- email ----------

interface EmailStatus {
  sharedDomain: string;
  addresses: { id: string; address: string; displayName: string; isDefault: boolean }[];
  domains: { id: string; domain: string; status: string }[];
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
/** Said on the card when an address becomes one person's own. */
const ownWarning = (name: string) =>
  `Only ${name} sends from it, and mail to it reaches only them.`;

const manageEmailSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const status = await emailStatus(db, ctx);
    const address = status?.addresses.find((a) => a.id === args['emailAddressId']);
    const domain = status?.domains.find((d) => d.id === args['emailDomainId']);
    const owner = await personNamed(db, ctx, str(args['ownerUserId']));
    const card = (title: string, fields: Field[], confirmLabel: string, warn?: string) =>
      settingsCard(toolCallId, 'manage_email_settings', {
        title,
        fields,
        confirmLabel,
        warnings: [
          ...(warn ? [{ kind: 'note', text: warn }] : []),
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
      case 'change_address':
        return {
          card: card(
            `Change ${address?.address ?? 'the address'}`,
            [
              { label: 'Address', value: address?.address ?? '' },
              ...(str(args['displayName'])
                ? [{ label: 'From', value: str(args['displayName'])! }]
                : []),
              ...(args['isDefault'] === true ? [{ label: 'Default', value: 'Yes' }] : []),
              ...whose,
            ],
            'Save the change',
          ),
          result: { waiting: true },
        };
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
            'Mail goes out from the shared address again.',
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
      case 'change_address':
        await command(db, ctx, 'email_address.update', {
          emailAddressId: args['emailAddressId'],
          ...defined({
            displayName: str(args['displayName']),
            localPart: str(args['localPart']),
            isDefault: bool(args['isDefault']),
            ownerUserId: str(args['ownerUserId']),
          }),
        });
        return { outcome: 'Changed', href, command: 'email_address.update' };
      case 'add_domain':
        await command(db, ctx, 'email_domain.add', { domain: args['domain'] });
        // The records themselves are on the Email screen: they are long, and they are copied, not read out.
        return {
          outcome: `${str(args['domain'])} is added. The records to copy are on the Email screen.`,
          href,
          command: 'email_domain.add',
        };
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
async function answerer(db: Db, ctx: ToolContext, ai: boolean | undefined, creating: boolean) {
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
  // The screen's own note: an AI teammate that is off, or whose Website chat channel is off, leaves it to the team.
  const note =
    teammate.status === 'off'
      ? `${teammate.name} is off, so your team answers for now. Turn it on from the AI teammate page.`
      : teammate.config?.channels?.chat !== true
        ? `${teammate.name}’s Website chat channel is off, so your team answers for now. Turn on Website chat under Channels on the AI teammate page.`
        : null;
  return { teammateId: teammate.id, who: `${teammate.name} (AI)`, note };
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
    greeting: str(args['greeting']),
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
    ...(str(args['greeting']) ? [{ label: 'Greeting', value: str(args['greeting'])! }] : []),
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
    const who = await answerer(db, ctx, bool(args['answeredByAi']), creating);
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
                  text: 'It shows up once its snippet is on your site. The snippet is under Add it to your site, on its page in Forms → Website chats.',
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
    const who = await answerer(db, ctx, bool(args['answeredByAi']), creating);
    const { fields } = lookOf(args);
    if (creating) {
      const made = await command<{ widgetId: string }>(db, ctx, 'chat_widget.create', {
        allowedOrigins: sites ?? [],
        teammateId: who?.teammateId ?? null,
        ...fields,
      });
      return {
        outcome:
          'The chat box is set up. Copy its snippet from Add it to your site on its page in Forms → Website chats, and paste it into your site.',
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

interface IntakeSource {
  kind: 'text' | 'call' | 'email';
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

const CHANNEL_WORDS = {
  text: 'someone texts you',
  call: 'a call is missed',
  email: 'someone emails you',
} as const;

const intakeOf = (db: Db, ctx: ToolContext) =>
  query<IntakeList>(db, ctx, 'intake.list').catch(() => null);

const channelOf = (args: Args): 'text' | 'call' | 'email' => {
  const c = str(args['channel']);
  return c === 'call' || c === 'email' ? c : 'text';
};

const manageLeadIntake: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const channel = channelOf(args);
    const list = await intakeOf(db, ctx);
    const current = list?.sources.find((s) => s.kind === channel);
    const active = bool(args['active']);
    const createLead = bool(args['createLead']);
    const pipeline = list?.pipelines.find((p) => p.id === args['pipelineId']);
    const stage = pipeline?.stages.find((s) => s.id === args['stageId']);
    const words = CHANNEL_WORDS[channel];
    const off = active === false;
    return {
      card: settingsCard(toolCallId, 'manage_lead_intake', {
        title: off ? `Stop opening leads when ${words}` : `Open a lead when ${words}`,
        fields: [
          ...(active === undefined
            ? []
            : [{ label: 'New customer and lead', value: active ? 'Yes' : 'No' }]),
          ...(createLead === undefined
            ? []
            : [{ label: 'Opens a lead', value: createLead ? 'Yes' : 'Customer only' }]),
          ...(pipeline ? [{ label: 'Lands in', value: pipeline.name }] : []),
          ...(stage ? [{ label: 'Stage', value: stage.name }] : []),
          ...(str(args['name']) ? [{ label: 'Filed under', value: str(args['name'])! }] : []),
          ...(num(args['dailyCap'])
            ? [{ label: 'Most a day', value: String(num(args['dailyCap'])) }]
            : []),
        ],
        confirmLabel: off ? 'Turn it off' : 'Save the change',
        warnings: off
          ? [
              {
                kind: 'note',
                text: 'Their message still reaches your inbox — nobody is added to your customers.',
              },
            ]
          : active === true && current?.active === false
            ? [{ kind: 'note', text: 'Wrong numbers and spam can become leads; archive those.' }]
            : [],
      }),
      result: { waiting: true, channel },
    };
  },

  async commit(db, ctx, args) {
    const channel = channelOf(args);
    await command(db, ctx, 'intake_source.update', {
      kind: channel,
      ...defined({
        active: bool(args['active']),
        createLead: bool(args['createLead']),
        pipelineId: args['pipelineId'] === null ? null : str(args['pipelineId']),
        stageId: args['stageId'] === null ? null : str(args['stageId']),
        name: str(args['name']),
        dailyCap: num(args['dailyCap']),
      }),
    });
    return {
      outcome:
        bool(args['active']) === false
          ? `No more leads when ${CHANNEL_WORDS[channel]}`
          : `Leads will come in when ${CHANNEL_WORDS[channel]}`,
      href: `/app/w/${ctx.workspaceId}/settings/lead-intake`,
      command: 'intake_source.update',
    };
  },
};

export const settingsChannelConfirmTools: Record<string, SettingsConfirmTool> = {
  update_texting_settings: updateTextingSettings,
  manage_phone_number: managePhoneNumber,
  submit_carrier_registration: submitCarrierRegistration,
  manage_email_settings: manageEmailSettings,
  manage_website_chat: manageWebsiteChat,
  manage_lead_intake: manageLeadIntake,
};
