/**
 * The ways a business is reached, set up by asking (M12, step four): texting and calls, the business number, the
 * carrier registration, email, and the chat box on the website.
 *
 * This is where the Assistant touches money and reach, so the cards do the work: getting a number says it costs
 * every month, giving one up says customers who call it reach nobody, and the registration is read back in full
 * before it goes to the carriers, because they take days to answer and a wrong answer means starting again.
 */

import { HfosError, money } from '@hfos/core';
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

const manageEmailSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const status = await emailStatus(db, ctx);
    const address = status?.addresses.find((a) => a.id === args['emailAddressId']);
    const domain = status?.domains.find((d) => d.id === args['emailDomainId']);
    const card = (title: string, fields: Field[], confirmLabel: string, warn?: string) =>
      settingsCard(toolCallId, 'manage_email_settings', {
        title,
        fields,
        confirmLabel,
        warnings: warn ? [{ kind: 'note', text: warn }] : [],
      });
    switch (act) {
      case 'add_address':
        return {
          card: card(
            'Add a sending address',
            [
              {
                label: 'Address',
                value: `${str(args['localPart'])}@${status?.sharedDomain ?? 'your domain'}`,
              },
              { label: 'From', value: str(args['displayName']) ?? '' },
              ...(args['isDefault'] === true ? [{ label: 'Default', value: 'Yes' }] : []),
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
          ...defined({ isDefault: bool(args['isDefault']) }),
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

interface WidgetList {
  widgets: {
    id: string;
    allowedOrigins: string[];
    greeting: string | null;
    launcherLabel: string;
    paused: boolean;
    teammateId: string | null;
  }[];
}

const widgetsOf = (db: Db, ctx: ToolContext) =>
  query<WidgetList>(db, ctx, 'chat_widget.list').catch(() => ({ widgets: [] }));

const manageWebsiteChat: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { widgets } = await widgetsOf(db, ctx);
    const current = widgets.find((w) => w.id === args['widgetId']) ?? widgets[0];
    const sites = list<string>(args['websites']);
    if (act === 'turn_on' || act === 'turn_off') {
      const on = act === 'turn_on';
      return {
        card: settingsCard(toolCallId, 'manage_website_chat', {
          title: on ? 'Turn the website chat on' : 'Turn the website chat off',
          fields: [{ label: 'Chat box', value: on ? 'On' : 'Off' }],
          confirmLabel: on ? 'Turn it on' : 'Turn it off',
          warnings: on
            ? []
            : [{ kind: 'note', text: 'Visitors won’t see it until it is turned back on.' }],
        }),
        result: { waiting: true },
      };
    }
    const creating = act === 'create';
    return {
      card: settingsCard(toolCallId, 'manage_website_chat', {
        title: creating ? 'Set up the website chat' : 'Change the website chat',
        fields: [
          ...(sites ? [{ label: 'Shows on', value: sites.join(', ') }] : []),
          ...(str(args['greeting']) ? [{ label: 'Greeting', value: str(args['greeting'])! }] : []),
          ...(str(args['buttonLabel'])
            ? [{ label: 'Button', value: str(args['buttonLabel'])! }]
            : []),
          ...(str(args['color']) ? [{ label: 'Colour', value: str(args['color'])! }] : []),
          ...(bool(args['answeredByAi']) === undefined
            ? []
            : [
                {
                  label: 'Answered by',
                  value: args['answeredByAi'] ? 'Your AI teammate' : 'Your team',
                },
              ]),
          ...(bool(args['askForSmsConsent']) === undefined
            ? []
            : [{ label: 'Asks to text them', value: args['askForSmsConsent'] ? 'Yes' : 'No' }]),
        ],
        confirmLabel: creating ? 'Set it up' : 'Save the change',
        warnings: creating
          ? [
              {
                kind: 'note',
                text: 'It shows up once the snippet is on your site — I’ll give you that next.',
              },
            ]
          : [],
      }),
      result: { waiting: true, widgetId: current?.id ?? null },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const { widgets } = await widgetsOf(db, ctx);
    const current = widgets.find((w) => w.id === args['widgetId']) ?? widgets[0];
    const href = `/app/w/${ctx.workspaceId}/settings/website-chat`;
    if (act === 'turn_on' || act === 'turn_off') {
      await command(db, ctx, act === 'turn_on' ? 'chat_widget.resume' : 'chat_widget.pause', {
        widgetId: current?.id,
      });
      return {
        outcome: act === 'turn_on' ? 'The chat box is on' : 'The chat box is off',
        href,
        command: act === 'turn_on' ? 'chat_widget.resume' : 'chat_widget.pause',
      };
    }
    const fields = defined({
      greeting: str(args['greeting']),
      launcherLabel: str(args['buttonLabel']),
      accentColor: str(args['color']),
      smsConsent: bool(args['askForSmsConsent']),
    });
    if (act === 'create') {
      await command(db, ctx, 'chat_widget.create', {
        allowedOrigins: list<string>(args['websites']) ?? [],
        ...fields,
      });
      return { outcome: 'The chat box is set up', href, command: 'chat_widget.create' };
    }
    await command(db, ctx, 'chat_widget.update', {
      widgetId: current?.id,
      ...(list<string>(args['websites']) ? { allowedOrigins: list<string>(args['websites']) } : {}),
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
