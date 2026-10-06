/**
 * Lockboxes, the worker's side (round seven, step 4; Chris 2026-10-05: read their emails, guard codes).
 *
 * - SentriLock's and Supra's "opened" emails, arriving in the business's Inbox, are read into the listing they're
 *   about (by the lockbox's serial, then the home's address), behind Deal settings' switch (`lockboxEmails`).
 * - An opening that fits no booked showing raises an alert to the listing's agents.
 * - A code shown again (core's addon_sealed.viewed) is kept in the deal's history.
 * - The code itself is read back only here, for core's sealed routes and the access email (./showings.ts).
 */
import {
  lockboxCodeViewed,
  lockboxOpened,
  LOCKBOX_KIND_LABELS,
} from '@hfos/core/addons/realestate/ops/lockboxes';
import type { LockboxKind } from '@hfos/core/addons/realestate/tables';
import { addressKey } from '@hfos/core/addons/realestate/homes';
import { PROPERTY_TYPE_KEY } from '@hfos/core/addons/realestate/words';
import { executeCommand, localInstant } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { raiseAddonAlert } from '../alerts';
import type { AddonEventContext, AddonSealedReader } from '../types';
import { readLockboxEmail } from './lockbox-emails';

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The sealed code of one lockbox on a listing, for core's /v1/addons/sealed/reveal. */
export const readLockboxCode: AddonSealedReader = async (tx, at) => {
  const [l] = await rows<{ code_enc: string | null }>(
    tx,
    sql`select code_enc from addon_realestate.lockboxes
        where workspace_id = ${at.workspaceId}::uuid and deal_record_id = ${at.recordId}::uuid
          and id = ${at.itemId}::uuid and removed_at is null`,
  );
  return l?.code_enc ?? null;
};

export interface AccessLockbox {
  readonly id: string;
  readonly kind: LockboxKind;
  readonly place: string | null;
  readonly codeEnc: string | null;
}

/** A listing's lockboxes, with their sealed codes, for the access email. */
export async function lockboxesForAccess(
  tx: Tx,
  workspaceId: string,
  dealId: string,
): Promise<AccessLockbox[]> {
  const list = await rows<{
    id: string;
    kind: LockboxKind;
    place: string | null;
    code_enc: string | null;
  }>(
    tx,
    sql`select id, kind, place, code_enc from addon_realestate.lockboxes
        where workspace_id = ${workspaceId}::uuid and deal_record_id = ${dealId}::uuid and removed_at is null
        order by created_at`,
  );
  return list.map((l) => ({ id: l.id, kind: l.kind, place: l.place, codeEnc: l.code_enc }));
}

/**
 * How the access email names a lockbox, and the marker its stored body keeps in place of the code: "SentriLock on
 * the side gate: [Lockbox code, kept locked]". The code goes in only as the email is sent.
 */
export function lockboxLines(boxes: readonly AccessLockbox[]): {
  readonly lines: string[];
  readonly parts: { marker: string; sealed: string }[];
} {
  const coded = boxes.filter((b) => b.codeEnc);
  const lines: string[] = [];
  const parts: { marker: string; sealed: string }[] = [];
  coded.forEach((b, i) => {
    const marker =
      coded.length > 1 ? `[Lockbox code ${i + 1}, kept locked]` : '[Lockbox code, kept locked]';
    const where = b.place ? ` (${b.place.replace(/[.\s]+$/, '')})` : '';
    lines.push(`${LOCKBOX_KIND_LABELS[b.kind]}${where}: ${marker}`);
    parts.push({ marker, sealed: b.codeEnc! });
  });
  return { lines, parts };
}

/** SentriLock's or Supra's "opened" email: kept on the listing it's about. */
export async function lockboxEmail(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (p['channel'] !== 'email' || ctx.event.entityType !== 'message' || !ctx.event.entityId) return;
  const messageId = ctx.event.entityId;
  const [m] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      from_address: string | null;
      subject: string | null;
      body_text: string | null;
      tz: string;
    }>(
      tx,
      sql`select m.from_address, m.subject, m.body_text, w.timezone as tz
          from app.messages m join app.workspaces w on w.id = m.workspace_id
          where m.id = ${messageId} and m.workspace_id = ${ctx.scope.workspaceId}
            and m.direction = 'inbound'`,
    ),
  );
  if (!m) return;
  const read = readLockboxEmail(m.from_address, m.subject, m.body_text);
  if (!read) return;
  // The business can turn reading them off (Deal settings → Connections).
  const [on] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ on: boolean | null }>(
      tx,
      sql`select (settings ->> 'lockboxEmails')::boolean as on from app.addon_installations
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}`,
    ),
  );
  if (on?.on === false) return;
  const dealId = await listingOf(ctx, read.serial, read.address);
  if (!dealId) return;
  const openedAt =
    read.date && read.clock
      ? new Date(localInstant(read.date, read.clock, m.tz)).toISOString()
      : // No time it can read: when the email came, which is moments after.
        new Date(ctx.event.createdAt ?? Date.now()).toISOString();
  await executeCommand(
    ctx.db,
    lockboxOpened,
    {
      workspaceId: ctx.scope.workspaceId,
      dealId,
      messageId,
      vendor: read.vendor,
      openedAt,
      serial: read.serial,
      openedBy: read.openedBy,
      company: read.company,
      phone: read.phone,
    },
    ctx.actor,
    ctx.meta,
  );
}

/** The open listing a lockbox email is about: the one whose lockbox has that serial, else the one at that address. */
async function listingOf(
  ctx: AddonEventContext,
  serial: string | null,
  address: string | null,
): Promise<string | null> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    if (serial) {
      const [bySerial] = await rows<{ deal_id: string }>(
        tx,
        sql`select l.deal_record_id as deal_id from addon_realestate.lockboxes l
            join addon_realestate.deals d on d.workspace_id = l.workspace_id and d.record_id = l.deal_record_id
            where l.workspace_id = ${ctx.scope.workspaceId} and lower(l.serial) = lower(${serial})
              and l.removed_at is null and d.side = 'listing' and d.outcome is null
            order by l.created_at desc limit 1`,
      );
      if (bySerial) return bySerial.deal_id;
    }
    if (!address) return null;
    const key = addressKey(address.split(',')[0] ?? address);
    const deals = await rows<{ deal_id: string; address: string }>(
      tx,
      sql`select r.id as deal_id, pr.name as address
          from addon_realestate.deals d
          join app.custom_records r on r.id = d.record_id and r.archived_at is null
          join app.relationships rel on rel.a_custom_record_id = r.id
          join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = ${PROPERTY_TYPE_KEY}
          join app.custom_records pr on pr.id = rel.b_custom_record_id
          where d.workspace_id = ${ctx.scope.workspaceId} and d.side = 'listing' and d.outcome is null`,
    );
    return (
      deals.find((d) => addressKey(d.address.split(',')[0] ?? d.address) === key)?.deal_id ?? null
    );
  });
}

/** Opened with no showing booked: the listing's agents are told, once per opening. */
export async function lockboxOpenedAlert(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const dealId = str(p['dealId']);
  const openingId = str(p['openingId']);
  if (!dealId || !openingId || p['booked'] === true) return;
  const [deal] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ owner_user_id: string | null; team: string[] | null; tz: string }>(
      tx,
      sql`select r.owner_user_id, r.team_user_ids as team, w.timezone as tz
          from app.custom_records r join app.workspaces w on w.id = r.workspace_id
          where r.id = ${dealId}::uuid and r.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!deal) return;
  const agents = [
    ...new Set([deal.owner_user_id, ...(deal.team ?? [])].filter((u): u is string => !!u)),
  ];
  const who = [str(p['openedBy']), str(p['company'])].filter(Boolean).join(' of ');
  const at = str(p['openedAt']);
  const when = at
    ? new Date(at).toLocaleString('en-US', {
        timeZone: deal.tz,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  await raiseAddonAlert(ctx, {
    key: `lockbox:${openingId}`,
    severity: 'at_risk',
    title:
      `The lockbox at ${str(p['name']) ?? 'a listing'} was opened with no showing booked`.slice(
        0,
        200,
      ),
    detail: [
      `${who || 'Someone'} opened it${when ? ` ${when}` : ''}, as ${p['vendor'] === 'supra' ? 'Supra' : 'SentriLock'}’s email says.`,
      'If you didn’t expect it, call them, then the seller.',
    ].join(' '),
    href: `/a/realestate/deals/${dealId}/showings`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: agents,
    assigneeUserId: deal.owner_user_id,
    notify: true,
    email: true,
  });
}

/** A lockbox's code shown again (core's addon_sealed.viewed): kept in the deal's history. */
export async function lockboxCodeShown(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (p['key'] !== 'lockbox_code') return;
  const dealId = ctx.event.entityId;
  const lockboxId = str(p['itemId']);
  const viewedBy = str(p['viewedBy']);
  if (!dealId || !lockboxId || !viewedBy) return;
  await executeCommand(
    ctx.db,
    lockboxCodeViewed,
    { workspaceId: ctx.scope.workspaceId, dealId, lockboxId, viewedBy },
    ctx.actor,
    ctx.meta,
  );
}
