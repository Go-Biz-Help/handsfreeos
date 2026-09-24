/**
 * A business's own domain on the pages its customers see (M17).
 *
 * **The email sending domain's shape, one milestone on.** `email_domain.add` / `.verify` / `.record` /
 * `.remove` already solved this: a business adds a name, we hand back the DNS records, a job checks them, a
 * status moves, and a daily job re-checks. The same four commands, the same `channels.manage`, the same
 * split — a person adds and removes, and everything the host said is the worker's, enforced by
 * `private.guard_branded_domain_update()` rather than by these handlers being careful.
 *
 * **It hangs off the booking site.** That row is already the business's public identity — the `lonestar` in
 * `/book/lonestar` and `/f/lonestar/quote` — and a branded domain is another name for exactly that. One per
 * site, so "which business is this host?" always has one answer.
 *
 * **But it is not only for booking.** Forms, estimates, invoices and payment links all live on it too, so a
 * business that has never set up a booking page still gets one: `ensureBookingSite` names it the way
 * publishing a form does, switched off, and the domain points at that.
 */
import { rows, sql } from '@hfos/db/client';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { brandedDomains } from '@hfos/db/schema';
import { ensureBookingSite } from '../calendar/site';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  BrandedDomainAddInput,
  BrandedDomainRecordInput,
  BrandedDomainRefInput,
  BrandedDomainRefOutput,
  isOurHost,
} from '../schemas/branded-domain';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type DomainRow = typeof brandedDomains.$inferSelect;

async function loadDomain(ctx: CommandContext, domainId: string): Promise<DomainRow> {
  const [row] = await ctx.tx
    .select()
    .from(brandedDomains)
    .where(
      and(eq(brandedDomains.id, domainId), eq(brandedDomains.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!row) throw HfosError.notFound('No domain with that id.');
  return row;
}

export const brandedDomainAdd = defineCommand({
  name: 'branded_domain.add',
  description:
    'Put the business’s booking page, forms and links on a domain it owns. HandsFreeOS shows the DNS records to add and checks them.',
  risk: 2,
  input: BrandedDomainAddInput,
  output: BrandedDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['branded_domain.added'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;

    // One of our own names is nobody's to claim by typing it. Which of them may be claimed, and by which
    // single workspace, is written down in `platform.claimable_hosts` — so this asks rather than guesses,
    // and the trigger on the table refuses anything that gets past here.
    if (isOurHost(input.domain)) {
      const [claim] = await rows<{ workspace_id: string | null }>(
        ctx.tx,
        sql`select private.claimable_host_workspace(${input.domain}) as workspace_id`,
      );
      if (claim?.workspace_id !== workspaceId)
        throw HfosError.rule(
          'branded_domain_is_ours',
          403,
          'That is one of our own addresses. Use a domain your business owns.',
        );
    }

    // Asking again for the one already there is not a second domain; changing it is removing and adding,
    // because a name that has been in somebody's DNS for a week is not something to silently repoint.
    const [existing] = await ctx.tx
      .select()
      .from(brandedDomains)
      .where(eq(brandedDomains.workspaceId, workspaceId));
    if (existing) {
      if (existing.domain === input.domain)
        return { domainId: existing.id, status: existing.status };
      throw HfosError.rule(
        'branded_domain_exists',
        409,
        `This business is already on ${existing.domain}. Remove that one first.`,
      );
    }

    // The site is the thing being renamed. A business that only sends forms or payment links has never
    // needed a booking page, so it gets its link name here rather than being sent off to make one.
    const site = await ensureBookingSite(ctx.tx, workspaceId, userIdOf(ctx.actor));
    const [made] = await ctx.tx
      .insert(brandedDomains)
      .values({
        workspaceId,
        siteId: site.id,
        domain: input.domain,
        createdBy: userIdOf(ctx.actor),
      })
      .returning();
    if (!made) throw HfosError.forbidden();
    await ctx.emit({
      type: 'branded_domain.added',
      entityType: 'branded_domain',
      entityId: made.id,
      payload: { domain: input.domain },
      after: { domain: input.domain, status: 'waiting for DNS' },
    });
    return { domainId: made.id, status: made.status };
  },
});

export const brandedDomainVerify = defineCommand({
  name: 'branded_domain.verify',
  description: 'Check the domain’s DNS records now, rather than waiting for the daily check.',
  risk: 1,
  input: BrandedDomainRefInput,
  output: BrandedDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['branded_domain.check_requested'],
  async handler(ctx, input) {
    const row = await loadDomain(ctx, input.domainId);
    if (row.status === 'verified' && row.certificateReady)
      return { domainId: row.id, status: row.status };
    await ctx.emit({
      type: 'branded_domain.check_requested',
      entityType: 'branded_domain',
      entityId: row.id,
      payload: { domain: row.domain },
      after: { domain: row.domain, checking: true },
    });
    return { domainId: row.id, status: row.status };
  },
});

export const brandedDomainRemove = defineCommand({
  name: 'branded_domain.remove',
  description:
    'Take the business off its own domain. Links go back to handsfreeos.com at once; links already sent on the old domain stop working.',
  // A three, not a two: every QR code, flyer and text already carrying that address stops working the moment
  // this runs, and there is nothing we can do about the ones already printed.
  risk: 3,
  input: BrandedDomainRefInput,
  output: BrandedDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['branded_domain.removed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const row = await loadDomain(ctx, input.domainId);
    await ctx.tx.delete(brandedDomains).where(eq(brandedDomains.id, row.id));
    await ctx.emit({
      type: 'branded_domain.removed',
      entityType: 'branded_domain',
      entityId: row.id,
      // The worker needs the name to take it off the host; the row is gone by the time it reads this.
      payload: { domain: row.domain },
      before: { domain: row.domain, status: row.status },
      after: null,
    });
    return { domainId: row.id, status: row.status };
  },
});

/** Worker: what the host said. The only path by which any of these columns ever change. */
export const brandedDomainRecord = defineCommand({
  name: 'branded_domain.record',
  description: 'Worker: the DNS records a domain needs, and whether it is serving yet.',
  risk: 1,
  input: BrandedDomainRecordInput,
  output: BrandedDomainRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['branded_domain.status_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const row = await loadDomain(ctx, input.domainId);
    const nowServing = input.status === 'verified' && input.certificateReady;
    await ctx.tx
      .update(brandedDomains)
      .set({
        status: input.status,
        verificationHost: input.verificationHost,
        verificationValue: input.verificationValue,
        cnameHost: input.cnameHost,
        cnameValue: input.cnameValue,
        certificateReady: input.certificateReady,
        // Stamped once, on the way in. A domain that has been working since March did not start working
        // again this morning because a daily check looked at it.
        verifiedAt: nowServing ? (row.verifiedAt ?? dsql`now()`) : null,
        lastCheckedAt: dsql`now()`,
        lastError: input.lastError,
        nextCheckAt: input.nextCheckAt ? new Date(input.nextCheckAt) : null,
      })
      .where(eq(brandedDomains.id, row.id));
    const before = row.status === 'verified' && row.certificateReady;
    if (before !== nowServing || row.status !== input.status)
      await ctx.emit({
        type: 'branded_domain.status_changed',
        entityType: 'branded_domain',
        entityId: row.id,
        payload: { domain: row.domain, status: input.status, serving: nowServing },
        before: { status: row.status },
        after: { domain: row.domain, status: nowServing ? 'working' : input.status },
      });
    return { domainId: row.id, status: input.status };
  },
});

export const brandedDomainCommands = [
  brandedDomainAdd,
  brandedDomainVerify,
  brandedDomainRemove,
  brandedDomainRecord,
];
