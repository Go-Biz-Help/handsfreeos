/**
 * The client portal's sign-in (Real Estate round two; core, for every portal). Chris decided (2026-09-30): a client
 * gets in with a private link, and on a new device types a 6-digit code emailed to them; no password.
 *
 * - **People in the business** let a customer in (`portal_access.give`, which also sends the link again) and turn
 *   it off (`portal_access.revoke`, which signs every device out and retires every link sent). The worker emails
 *   the link when it hears `portal.access_given`, because the link is signed with the worker's key.
 * - **The worker, for the customer** on the portal's public pages: sends a code to the email on file
 *   (`portal_code.send`), checks the one typed back and signs the device in (`portal_code.check`), notes a device
 *   still in use (`portal_session.seen`) and signs one out (`portal_session.end`).
 *
 * Codes and devices keep only hashes (`verify/code.ts`, and the bearer's sha256 that the worker passes in).
 */
import { and, desc, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { portalAccess, portalCodes, portalSessions } from '@hfos/db/schema';
import { userNames } from '../calendar/load';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  PortalAccessGetInput,
  PortalAccessGetOutput,
  PortalAccessGiveInput,
  PortalAccessGiveOutput,
  PortalAccessRevokeInput,
  PortalAccessRevokeOutput,
  PortalCheckCodeInput,
  PortalCheckCodeOutput,
  PortalSendCodeInput,
  PortalSendCodeOutput,
  PortalSessionEndInput,
  PortalSessionEndOutput,
  PortalSessionSeenInput,
  PortalSessionSeenOutput,
} from '../schemas/portal';
import {
  CODE_MINUTES,
  CODE_TRIES,
  CODES_PER_HOUR,
  codeHash,
  codeMatches,
  maskContact,
  newCode,
} from '../verify/code';

/** A signed-in device lasts this long at most, and this long since it was last used. */
export const PORTAL_SESSION_DAYS = 90;
export const PORTAL_IDLE_DAYS = 30;
const DAY = 86_400_000;

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const nameOf = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`.trim() || 'This customer';

async function accessOf(ctx: CommandContext, workspaceId: string, accessId: string) {
  const [a] = await ctx.tx
    .select()
    .from(portalAccess)
    .where(and(eq(portalAccess.id, accessId), eq(portalAccess.workspaceId, workspaceId)));
  if (!a || a.revokedAt)
    throw HfosError.rule(
      'portal_access_off',
      410,
      'This link was turned off. Ask the business to send you a new one.',
    );
  return a;
}

async function businessName(ctx: CommandContext, workspaceId: string): Promise<string> {
  const [w] = await rows<{ name: string }>(
    ctx.tx,
    sql`select name from app.workspaces where id = ${workspaceId}`,
  );
  return w?.name ?? 'The business';
}

export const portalAccessGive = defineCommand({
  name: 'portal_access.give',
  description:
    'Lets a customer into their portal and emails them the private link; for someone already in, emails the link again.',
  risk: 2,
  input: PortalAccessGiveInput,
  output: PortalAccessGiveOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['portal.access_given'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const person = await requirePerson(ctx.tx, input.workspaceId, input.personId);
    if (!person.email)
      throw HfosError.rule(
        'portal_no_email',
        409,
        `${nameOf(person)} has no email address, so there’s nowhere to send their link or their code. Add their email on their page first.`,
      );
    const [had] = await ctx.tx
      .select()
      .from(portalAccess)
      .where(
        and(
          eq(portalAccess.workspaceId, input.workspaceId),
          eq(portalAccess.personId, input.personId),
        ),
      )
      .for('update');
    let access = had;
    if (!had) {
      [access] = await ctx.tx
        .insert(portalAccess)
        .values({ workspaceId: input.workspaceId, personId: input.personId, givenBy: me.userId })
        .returning();
    } else if (had.revokedAt) {
      // Back in after being turned off: a fresh link, so the old ones stay dead.
      [access] = await ctx.tx
        .update(portalAccess)
        .set({
          revokedAt: null,
          revokedBy: null,
          givenBy: me.userId,
          givenAt: new Date(),
          linkVersion: dsql`${portalAccess.linkVersion} + 1`,
        })
        .where(eq(portalAccess.id, had.id))
        .returning();
    }
    if (!access) throw HfosError.forbidden();
    const resent = !!had && !had.revokedAt;
    await ctx.emit({
      type: 'portal.access_given',
      entityType: 'person',
      entityId: input.personId,
      payload: {
        accessId: access.id,
        personId: input.personId,
        linkVersion: access.linkVersion,
        resent,
      },
      after: { resent },
    });
    return { accessId: access.id, resent, sentTo: maskContact('email', person.email) };
  },
});

export const portalAccessRevoke = defineCommand({
  name: 'portal_access.revoke',
  description:
    'Turns a customer’s portal off: every device they signed in on is signed out, and every link sent stops working.',
  risk: 2,
  input: PortalAccessRevokeInput,
  output: PortalAccessRevokeOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['portal.access_revoked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const person = await requirePerson(ctx.tx, input.workspaceId, input.personId);
    const [revoked] = await ctx.tx
      .update(portalAccess)
      .set({
        revokedAt: new Date(),
        revokedBy: me.userId,
        linkVersion: dsql`${portalAccess.linkVersion} + 1`,
      })
      .where(
        and(
          eq(portalAccess.workspaceId, input.workspaceId),
          eq(portalAccess.personId, input.personId),
          isNull(portalAccess.revokedAt),
        ),
      )
      .returning();
    if (!revoked)
      throw HfosError.rule(
        'portal_not_in',
        409,
        `${nameOf(person)} isn’t in the portal, so there’s nothing to turn off.`,
      );
    await ctx.emit({
      type: 'portal.access_revoked',
      entityType: 'person',
      entityId: input.personId,
      payload: { accessId: revoked.id, personId: input.personId },
      after: { on: false },
    });
    return { accessId: revoked.id, revokedAt: revoked.revokedAt!.toISOString() };
  },
});

export const portalAccessGet = defineQuery({
  name: 'portal_access.get',
  description:
    'Whether a customer is in the portal: when and by whom they were let in, when they last used it, and the devices signed in now.',
  input: PortalAccessGetInput,
  output: PortalAccessGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const person = await requirePerson(ctx.tx, input.workspaceId, input.personId);
    const [a] = await ctx.tx
      .select()
      .from(portalAccess)
      .where(
        and(
          eq(portalAccess.workspaceId, input.workspaceId),
          eq(portalAccess.personId, input.personId),
        ),
      );
    if (!a) return { email: person.email, access: null };
    const devices = a.revokedAt
      ? []
      : await ctx.tx
          .select({
            id: portalSessions.id,
            device: portalSessions.device,
            createdAt: portalSessions.createdAt,
            lastSeenAt: portalSessions.lastSeenAt,
          })
          .from(portalSessions)
          .where(
            and(
              eq(portalSessions.accessId, a.id),
              isNull(portalSessions.endedAt),
              gt(portalSessions.expiresAt, new Date()),
              gt(portalSessions.lastSeenAt, new Date(Date.now() - PORTAL_IDLE_DAYS * DAY)),
            ),
          )
          .orderBy(desc(portalSessions.lastSeenAt));
    const names = a.givenBy ? await userNames(ctx.tx, [a.givenBy]) : new Map<string, string>();
    return {
      email: person.email,
      access: {
        accessId: a.id,
        on: !a.revokedAt,
        givenAt: a.givenAt.toISOString(),
        givenBy: a.givenBy ? { id: a.givenBy, fullName: names.get(a.givenBy) ?? 'Someone' } : null,
        revokedAt: a.revokedAt?.toISOString() ?? null,
        lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
        devices: devices.map((d) => ({
          sessionId: d.id,
          device: d.device,
          signedInAt: d.createdAt.toISOString(),
          lastSeenAt: d.lastSeenAt.toISOString(),
        })),
      },
    };
  },
});

// ---------- the worker's, for the customer on the portal's public pages ----------

export const portalSendCode = defineCommand({
  name: 'portal_code.send',
  description:
    'Makes a six-digit code for a customer signing in to their portal on a new device, for the worker to email to the address on file.',
  risk: 1,
  input: PortalSendCodeInput,
  output: PortalSendCodeOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['portal.code_sent'],
  actors: ['system'],
  shownOnce: ['code'],
  async handler(ctx, input) {
    const access = await accessOf(ctx, input.workspaceId, input.accessId);
    const [recent] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.portal_codes
          where access_id = ${access.id} and created_at > now() - interval '1 hour'`,
    );
    if ((recent?.n ?? 0) >= CODES_PER_HOUR)
      throw HfosError.rule(
        'too_many_codes',
        429,
        `That’s ${CODES_PER_HOUR} codes this hour. Use the newest one we emailed you, or try again in an hour.`,
      );
    const person = await requirePerson(ctx.tx, input.workspaceId, access.personId);
    if (!person.email)
      throw HfosError.rule(
        'portal_no_email',
        409,
        'There’s no email address on file to send your code to. Ask the business to add it.',
      );
    const code = newCode();
    const [row] = await ctx.tx
      .insert(portalCodes)
      .values({
        workspaceId: input.workspaceId,
        accessId: access.id,
        codeHash: codeHash(access.id, code),
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      })
      .returning({ id: portalCodes.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'portal.code_sent',
      entityType: 'person',
      entityId: access.personId,
      payload: { accessId: access.id, codeId: row.id, _broadcast: false },
      broadcast: false,
    });
    return {
      codeId: row.id,
      code,
      to: person.email,
      sentTo: maskContact('email', person.email),
      business: await businessName(ctx, input.workspaceId),
      firstName: person.firstName,
    };
  },
});

export const portalCheckCode = defineCommand({
  name: 'portal_code.check',
  description:
    'Checks the code a customer typed on their portal. The right one, in time, signs their device in.',
  risk: 1,
  input: PortalCheckCodeInput,
  output: PortalCheckCodeOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['portal.signed_in'],
  actors: ['system'],
  async handler(ctx, input) {
    const access = await accessOf(ctx, input.workspaceId, input.accessId);
    const [latest] = await ctx.tx
      .select()
      .from(portalCodes)
      .where(
        and(
          eq(portalCodes.accessId, access.id),
          isNull(portalCodes.usedAt),
          gt(portalCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(portalCodes.createdAt))
      .limit(1)
      .for('update');
    if (!latest)
      throw HfosError.rule(
        'code_expired',
        409,
        'That code has expired or was already used. Ask for a new one.',
      );
    if (latest.attempts >= CODE_TRIES)
      throw HfosError.rule('too_many_tries', 429, 'Too many wrong tries. Ask for a new code.');
    if (!codeMatches(latest.codeHash, access.id, input.code)) {
      // Kept, not thrown: a thrown error would roll the counted try back.
      await ctx.tx
        .update(portalCodes)
        .set({ attempts: dsql`${portalCodes.attempts} + 1` })
        .where(eq(portalCodes.id, latest.id));
      return {
        verified: false,
        triesLeft: Math.max(0, CODE_TRIES - latest.attempts - 1),
        sessionId: null,
        expiresAt: null,
      };
    }
    const now = new Date();
    await ctx.tx.update(portalCodes).set({ usedAt: now }).where(eq(portalCodes.id, latest.id));
    const [session] = await ctx.tx
      .insert(portalSessions)
      .values({
        workspaceId: input.workspaceId,
        accessId: access.id,
        personId: access.personId,
        tokenHash: Buffer.from(input.tokenHash, 'hex'),
        device: input.device,
        expiresAt: new Date(now.getTime() + PORTAL_SESSION_DAYS * DAY),
      })
      .returning();
    if (!session) throw HfosError.forbidden();
    await ctx.tx
      .update(portalAccess)
      .set({ lastUsedAt: now })
      .where(eq(portalAccess.id, access.id));
    await ctx.emit({
      type: 'portal.signed_in',
      entityType: 'person',
      entityId: access.personId,
      payload: { accessId: access.id, sessionId: session.id, device: input.device },
      after: { device: input.device },
    });
    return {
      verified: true,
      triesLeft: 0,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    };
  },
});

export const portalSessionSeen = defineCommand({
  name: 'portal_session.seen',
  description:
    'Notes that a customer’s signed-in device is still in use, which keeps it signed in for another 30 days.',
  risk: 0,
  input: PortalSessionSeenInput,
  output: PortalSessionSeenOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const now = new Date();
    const [s] = await ctx.tx
      .update(portalSessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(portalSessions.id, input.sessionId),
          eq(portalSessions.workspaceId, input.workspaceId),
          isNull(portalSessions.endedAt),
        ),
      )
      .returning({ accessId: portalSessions.accessId });
    if (!s) throw HfosError.notFound('You’re signed out. Open your link again to sign back in.');
    await ctx.tx
      .update(portalAccess)
      .set({ lastUsedAt: now })
      .where(eq(portalAccess.id, s.accessId));
    return { lastSeenAt: now.toISOString() };
  },
});

export const portalSessionEnd = defineCommand({
  name: 'portal_session.end',
  description: 'Signs a customer’s device out of their portal.',
  risk: 0,
  input: PortalSessionEndInput,
  output: PortalSessionEndOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['portal.signed_out'],
  actors: ['system'],
  async handler(ctx, input) {
    const [s] = await ctx.tx
      .update(portalSessions)
      .set({ endedAt: new Date(), endedReason: 'signed_out' })
      .where(
        and(
          eq(portalSessions.id, input.sessionId),
          eq(portalSessions.workspaceId, input.workspaceId),
          isNull(portalSessions.endedAt),
        ),
      )
      .returning({ personId: portalSessions.personId, accessId: portalSessions.accessId });
    if (!s) return { ended: false };
    await ctx.emit({
      type: 'portal.signed_out',
      entityType: 'person',
      entityId: s.personId,
      payload: { accessId: s.accessId, sessionId: input.sessionId },
    });
    return { ended: true };
  },
});
