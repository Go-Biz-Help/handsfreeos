/**
 * HandsFreeOS's own Admin area, as the Assistant's cards say it (staff only, the owner, 2026-10-27). A staff command
 * looks across businesses, so its input names what it acts on by id: its card names the business, person, ticket,
 * affiliate or seat instead, says an amount in dollars and a share as a percentage, and a stage or status in the
 * screens' words. It also puts on what the screens put on that the model never gives (a credit's reference), and
 * keeps what the screens send back as it was (an area's description, a sign-off) when the model leaves it out.
 */
import {
  ADDON_CATALOG,
  AFFILIATE_STATUS_WORDS,
  affiliateRateWords,
  affiliateSetMaxDiscount,
  affiliatesMakeCode,
  affiliatesSaveSettings,
  DESK_WALLET_STAGES,
  DESK_WALLET_WORDS,
  ideaAreaSave,
  IDEA_STATUS_WORDS,
  money,
  STAFF_ROLE_WORDS,
  supportStaffSaveProfile,
  TICKET_PRIORITY_WORDS,
  TICKET_STATUS_WORDS,
  walletAdjust,
  walletSetStage,
  type ScreenActionTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { personQuery } from './context';
import type { ToolContext } from './runtime';
import { cardFields } from './tools-addons';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

/** The card holds ten lines. */
const MOST_LINES = 10;

/** One of the desk's look-ups as the person, or null when it isn't there or isn't theirs to read. */
const lookUp =
  (db: Db, ctx: ToolContext) =>
  <T>(name: string, input: Args = {}): Promise<T | null> =>
    personQuery<T>(db, name, input, ctx.actor, ctx.correlationId).catch(() => null);

/** A look-up made once per card, however many of its lines need it. */
function once<T>(get: () => Promise<T | null>): () => Promise<T | null> {
  let got: Promise<T | null> | null = null;
  return () => (got ??= get());
}

interface Founding {
  offers: { offerId: string; name: string }[];
  applications: {
    applicationId: string;
    businessName: string;
    contactName: string;
    theirBusinesses: { organizationId: string; organizationName: string }[];
  }[];
  grants: { grantId: string; organizationId: string; organizationName: string | null }[];
}
interface Staff {
  staff: { userId: string; fullName: string; displayName: string }[];
  invitations: { id: string; email: string }[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The card's lines for a staff command: what it does, then each part it's given, the ones named by id said by name
 * and the rest as cardFields says them. A name that can't be looked up stays as it was given.
 */
export async function staffCardFields(
  db: Db,
  ctx: ToolContext,
  tool: Pick<ScreenActionTool, 'input' | 'description' | 'command'>,
  values: Args,
): Promise<Field[]> {
  const look = lookUp(db, ctx);
  const workspaceId = str(values['workspaceId']);
  const business = once(() =>
    workspaceId
      ? look<{ business: { name: string; organizationId: string } }>('platform.business.get', {
          workspaceId,
        })
      : Promise.resolve(null),
  );
  const founding = once(() => look<Founding>('platform.founding', { limit: 200 }));
  const staff = once(() => look<Staff>('support.staff.list'));
  // Which desk it's on, by the start of its name: a ticket's, an affiliate's or an idea's words for a status.
  const [area, part] = tool.command.name.split('.');
  const onTicket = area === 'support' && part === 'ticket';
  const shares = area === 'affiliate' || area === 'affiliates';

  const personName = async (userId: unknown) => {
    const s = (await staff())?.staff.find((p) => p.userId === userId);
    return s ? s.displayName || s.fullName : null;
  };

  /** Each part said by name; null leaves it to cardFields, a line with no value leaves it off. */
  const named: Record<string, (v: unknown) => Promise<Field | null>> = {
    workspaceId: async () => {
      const b = await business();
      return b ? { label: 'Business', value: b.business.name } : null;
    },
    organizationId: async (v) => {
      // The business it's on already says whose it is.
      if ((await business())?.business.organizationId === v) return { label: '', value: '' };
      const f = await founding();
      const name =
        f?.grants.find((g) => g.organizationId === v)?.organizationName ??
        f?.applications.flatMap((a) => a.theirBusinesses).find((b) => b.organizationId === v)
          ?.organizationName;
      return name ? { label: 'Business', value: name } : null;
    },
    applicationId: async (v) => {
      const a = (await founding())?.applications.find((x) => x.applicationId === v);
      return a
        ? {
            label: 'Application',
            value: a.contactName ? `${a.businessName} (${a.contactName})` : a.businessName,
          }
        : null;
    },
    grantId: async (v) => {
      const g = (await founding())?.grants.find((x) => x.grantId === v);
      return g?.organizationName ? { label: 'Their seat', value: g.organizationName } : null;
    },
    offerId: async (v) => {
      const o = (await founding())?.offers.find((x) => x.offerId === v);
      return o ? { label: 'Offer', value: o.name } : null;
    },
    affiliateId: async (v) => {
      // No affiliate: a house code, or a business no affiliate gets credit for.
      if (v === null)
        return {
          label: 'Affiliate',
          value: tool.command.name === affiliatesMakeCode.name ? 'None: a house code' : 'Nobody',
        };
      const a = await look<{ affiliate: { name: string; email: string } }>('platform.affiliate', {
        affiliateId: v,
      });
      return a ? { label: 'Affiliate', value: a.affiliate.name || a.affiliate.email } : null;
    },
    userId: async (v) => {
      const name = await personName(v);
      return name ? { label: 'Person', value: name } : null;
    },
    assigneeUserId: async (v) => {
      if (v === null) return { label: 'Assign to', value: 'Nobody' };
      const name = await personName(v);
      return name ? { label: 'Assign to', value: name } : null;
    },
    invitationId: async (v) => {
      const i = (await staff())?.invitations.find((x) => x.id === v);
      return i ? { label: 'Invitation', value: i.email } : null;
    },
    ticketId: async (v) => {
      const t = await look<{ ticket: { number: number; subject: string } }>('support.ticket.get', {
        ticketId: v,
      });
      return t ? { label: 'Ticket', value: `#${t.ticket.number} ${t.ticket.subject}` } : null;
    },
    ideaId: async (v) => ideaLine('Idea', v),
    intoIdeaId: async (v) => ideaLine('Into', v),
    addonId: async (v) => {
      const m = ADDON_CATALOG.find((x) => x.id === v);
      return m ? { label: 'Add-on', value: m.name } : null;
    },
    amountCents: async (v) =>
      typeof v !== 'number'
        ? null
        : tool.command.name === walletAdjust.name
          ? { label: v < 0 ? 'Take back' : 'Credit', value: money(Math.abs(v)) }
          : { label: 'Amount', value: money(v) },
    amountOffCents: async (v) =>
      typeof v === 'number' ? { label: 'Takes off', value: money(v) } : null,
    rateBp: async (v) =>
      typeof v === 'number'
        ? {
            label: tool.command.name === affiliatesSaveSettings.name ? 'Everyone’s share' : 'Share',
            value: affiliateRateWords(v),
          }
        : v === null
          ? { label: 'Share', value: 'Back to everyone’s' }
          : null,
    maxDiscountBp: async (v) =>
      typeof v === 'number'
        ? { label: 'Most a code takes off', value: affiliateRateWords(v) }
        : v === null && tool.command.name === affiliateSetMaxDiscount.name
          ? { label: 'Most a code takes off', value: 'Back to everyone’s' }
          : null,
    percentOffBp: async (v) =>
      typeof v === 'number' ? { label: 'Takes off', value: affiliateRateWords(v) } : null,
    stage: async (v) =>
      typeof v === 'string' && v in DESK_WALLET_STAGES
        ? {
            label: 'Move to',
            value: DESK_WALLET_STAGES[v as keyof typeof DESK_WALLET_STAGES].label,
          }
        : null,
    status: async (v) => {
      if (typeof v !== 'string') return null;
      const words: Readonly<Record<string, string>> | null = onTicket
        ? TICKET_STATUS_WORDS
        : shares
          ? AFFILIATE_STATUS_WORDS
          : area === 'idea'
            ? IDEA_STATUS_WORDS
            : null;
      return words?.[v] ? { label: 'Status', value: words[v]! } : null;
    },
    priority: async (v) =>
      onTicket && typeof v === 'string' && v in TICKET_PRIORITY_WORDS
        ? {
            label: 'Priority',
            value: TICKET_PRIORITY_WORDS[v as keyof typeof TICKET_PRIORITY_WORDS],
          }
        : null,
    role: async (v) =>
      typeof v === 'string' && v in STAFF_ROLE_WORDS
        ? { label: 'Role', value: STAFF_ROLE_WORDS[v as keyof typeof STAFF_ROLE_WORDS] }
        : null,
  };

  async function ideaLine(label: string, ideaId: unknown): Promise<Field | null> {
    const i = await look<{ idea: { number: number; title: string } }>('idea.get', { ideaId });
    return i ? { label, value: `#${i.idea.number} ${i.idea.title}` } : null;
  }

  const keys = Object.keys(tool.input.shape).filter((k) => k in named && k in values);
  const said = await Promise.all(keys.map((k) => named[k]!(values[k])));
  const byName = new Map(keys.flatMap((k, i) => (said[i] ? [[k, said[i]!] as const] : [])));
  // The rest as any card says them, in the input's order.
  const rest = Object.fromEntries(Object.entries(values).filter(([k]) => !byName.has(k)));
  const [what, ...others] = cardFields(tool, rest);
  const lines = [...[...byName.values()].filter((f) => f.value), ...others];
  const fitted =
    lines.length > MOST_LINES - 1
      ? [
          ...lines.slice(0, MOST_LINES - 2),
          { label: 'And', value: `${lines.length - (MOST_LINES - 2)} more` },
        ]
      : lines;
  return [what!, ...fitted];
}

/**
 * What a staff card warns of beyond its fixed warning, as the screen's own dialog says it: moving a business off Paid
 * by the agency writes off what they ran up, and Stopped at zero stops their outgoing texts and calls.
 */
export async function staffCautions(
  db: Db,
  ctx: ToolContext,
  tool: Pick<ScreenActionTool, 'command'>,
  input: Args,
): Promise<string[]> {
  if (tool.command.name !== walletSetStage.name) return [];
  const wallet = await lookUp(db, ctx)<{ stage: string; balanceCents: number }>(
    'platform.wallet.get',
    { workspaceId: input['workspaceId'] },
  );
  return [
    ...(wallet?.stage === 'agency' && wallet.balanceCents < 0 && input['stage'] !== 'agency'
      ? [DESK_WALLET_WORDS.writtenOff(-wallet.balanceCents)]
      : []),
    ...(input['stage'] === 'enforce' ? [DESK_WALLET_WORDS.enforceWarning] : []),
  ];
}

/** The most a credit's reference may be (wallet.adjust's input). */
const REFERENCE_MOST = 100;

/**
 * What the screens put on a staff command that the model doesn't give, by the command's own name: a credit's
 * reference, one per card as the screen makes one per dialog, so a second credit is never mistaken for the first
 * and the same card confirmed twice is still one; and, left out, an area's description, place and archived state and
 * the person's own sign-off, as they are now, since the screens always send them back.
 */
export async function staffKept(
  db: Db,
  ctx: ToolContext,
  tool: Pick<ScreenActionTool, 'command'>,
  args: Args,
  toolCallId: string,
): Promise<Args> {
  const look = lookUp(db, ctx);
  switch (tool.command.name) {
    case walletAdjust.name:
      return {
        reference: `assistant:${String(args['workspaceId'])}:${toolCallId}`.slice(
          0,
          REFERENCE_MOST,
        ),
      };
    case ideaAreaSave.name: {
      const areas = await look<{
        areas: { id: string; description: string; sort: number; archived: boolean }[];
      }>('idea.areas');
      const area = areas?.areas.find((a) => a.id === args['id']);
      if (!area) return {};
      return Object.fromEntries(
        (['description', 'sort', 'archived'] as const)
          .filter((k) => args[k] === undefined)
          .map((k) => [k, area[k]]),
      );
    }
    case supportStaffSaveProfile.name: {
      if (args['signature'] !== undefined) return {};
      const me = await look<{ staff: { signature: string } | null }>('platform.me');
      return me?.staff ? { signature: me.staff.signature } : {};
    }
    default:
      return {};
  }
}
