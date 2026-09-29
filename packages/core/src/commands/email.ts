import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  emailAddresses,
  emailDomains,
  emailInboundUnmatched,
  emailSuppressions,
  mailboxConnections,
  workspaces,
} from '@hfos/db/schema';
import { fullName, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import { SHARED_MAIL_DOMAIN } from '../messaging/email';
import { scheduleJob, workspaceMessaging } from '../messaging/store';
import {
  EmailAddressCreateInput,
  EmailAddressCreateOutput,
  EmailAddressReassignInput,
  EmailAddressReassignOutput,
  EmailAddressUpdateInput,
  EmailAddressUpdateOutput,
  EmailClaimUnmatchedInput,
  EmailClaimUnmatchedOutput,
  EmailDomainAddInput,
  EmailDomainReceivingOutput,
  EmailDomainRecordInput,
  EmailDomainRecordOutput,
  EmailDomainRecordReceivingInput,
  EmailDomainRefInput,
  EmailDomainRefOutput,
  EmailSuppressionAddInput,
  EmailSuppressionRefOutput,
  EmailSuppressionReleaseInput,
  EmailUnmatchedRefInput,
  EmailUnmatchedRefOutput,
  HANDSFREEOS_DOMAIN,
  INBOUND_MX_HOST,
  MAX_EMAIL_DOMAINS,
  MailboxActivateInput,
  MailboxConnectInput,
  MailboxConnectOutput,
  MailboxFailInput,
  MailboxRefInput,
  MailboxRefOutput,
  MailboxSystemOutput,
  isConsumerMailDomain,
  isHandsFreeOsDomain,
  isReservedLocalPart,
} from '../schemas/email';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How long a mailbox sign-in state stays good. */
const STATE_TTL_MS = 10 * 60_000;
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

// The same rules kernel/pg-errors raises when the database guard catches these first. Here they can name
// the address or domain.
const reserved = (localPart: string, domain: string | null) =>
  HfosError.rule(
    'email_local_part_reserved',
    400,
    domain === HANDSFREEOS_DOMAIN
      ? `“${localPart}” is kept for HandsFreeOS itself on ${HANDSFREEOS_DOMAIN}: the support desk or HandsFreeOS’s own mail uses it. Pick another name.`
      : `“${localPart}” is kept for HandsFreeOS itself on the shared address. Pick another name.`,
  );
/** Where the reserved names are HandsFreeOS's: the shared subdomain, and handsfreeos.com itself (M19). */
const namesReserved = (domain: string | null) => !domain || domain === HANDSFREEOS_DOMAIN;
const unverified = (domain: string) =>
  HfosError.rule(
    'email_domain_unverified',
    409,
    `${domain} isn’t verified yet. Add its DNS records, then click Check now under Use your own domain in Settings → Email.`,
  );
const addressTaken = (address: string) =>
  HfosError.rule('email_address_taken', 409, `${address} is already taken. Pick another name.`);

/** A person's own address (M19): on the business's own domain, never the default, and only for someone here. */
async function checkOwner(
  ctx: CommandContext,
  ownerUserId: string,
  address: string,
  domain: { domain: string } | null,
  isDefault: boolean,
) {
  if (!domain)
    throw HfosError.rule(
      'email_address_owner_domain',
      400,
      `A person’s own address has to be on your own domain, like chris@lonestarhvac.com, not on ${SHARED_MAIL_DOMAIN}. Add your domain under Use your own domain in Settings → Email first.`,
    );
  if (isDefault)
    throw HfosError.rule(
      'email_address_owner_default',
      409,
      `${address} is one person’s own address, so it can’t be the business’s default. Make a team address the default instead.`,
    );
  const [here] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.works_in(${ownerUserId}::uuid, ${ctx.scope.workspaceId!}::uuid) as ok`,
  );
  if (!here?.ok)
    throw HfosError.rule(
      'email_address_owner_not_here',
      400,
      `The person you picked for ${address} isn’t on this business’s team. Invite them in Settings → Team first.`,
    );
}

/** HandsFreeOS's own business (M19): the one workspace that may use handsfreeos.com. */
async function isOwnBusiness(ctx: CommandContext): Promise<boolean> {
  const [w] = await ctx.tx
    .select({ isPlatform: workspaces.isPlatform })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.scope.workspaceId!));
  return w?.isPlatform ?? false;
}

async function loadDomain(ctx: CommandContext, emailDomainId: string) {
  const [d] = await ctx.tx
    .select()
    .from(emailDomains)
    .where(
      and(eq(emailDomains.id, emailDomainId), eq(emailDomains.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!d)
    throw HfosError.notFound(
      'That domain isn’t there anymore. It may have been removed. Refresh and try again.',
    );
  return d;
}

async function loadAddress(ctx: CommandContext, emailAddressId: string) {
  const [a] = await ctx.tx
    .select()
    .from(emailAddresses)
    .where(
      and(
        eq(emailAddresses.id, emailAddressId),
        eq(emailAddresses.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!a)
    throw HfosError.notFound(
      'That sending address isn’t there anymore. It may have been removed. Refresh and try again.',
    );
  return a;
}

/** Only the columns people may read: the column grants keep sealed tokens and sign-in secrets from them. */
async function loadMailbox(ctx: CommandContext, connectionId: string) {
  const [m] = await ctx.tx
    .select({
      id: mailboxConnections.id,
      provider: mailboxConnections.provider,
      accountEmail: mailboxConnections.accountEmail,
      shared: mailboxConnections.shared,
      status: mailboxConnections.status,
    })
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.id, connectionId),
        eq(mailboxConnections.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!m)
    throw HfosError.notFound(
      'That mailbox isn’t connected here anymore. Refresh Settings → Email to see your connected mailboxes.',
    );
  return m;
}

async function loadUnmatched(ctx: CommandContext, unmatchedId: string) {
  const [u] = await ctx.tx
    .select({
      id: emailInboundUnmatched.id,
      fromAddress: emailInboundUnmatched.fromAddress,
      subject: emailInboundUnmatched.subject,
      resolvedAt: emailInboundUnmatched.resolvedAt,
      dismissedAt: emailInboundUnmatched.dismissedAt,
    })
    .from(emailInboundUnmatched)
    .where(
      and(
        eq(emailInboundUnmatched.id, unmatchedId),
        eq(emailInboundUnmatched.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!u)
    throw HfosError.notFound(
      'That email isn’t there anymore. It may have been filed or dismissed. Refresh and try again.',
    );
  return u;
}

const alreadyHandled = () =>
  HfosError.rule(
    'unmatched_resolved',
    409,
    'Someone already filed or dismissed this email. Refresh to see where it went.',
  );

/** One default per workspace (a partial unique index), so the old one steps down before a new one is set. */
async function clearDefault(ctx: CommandContext) {
  const [previous] = await ctx.tx
    .update(emailAddresses)
    .set({ isDefault: false })
    .where(
      and(
        eq(emailAddresses.workspaceId, ctx.scope.workspaceId!),
        eq(emailAddresses.isDefault, true),
      ),
    )
    .returning({ id: emailAddresses.id, address: emailAddresses.address });
  return previous ?? null;
}

// ---------- the business's own domains ----------

export const emailDomainAdd = defineCommand({
  name: 'email_domain.add',
  description:
    'Add the business’s own domain for sending email. HandsFreeOS sets it up with Postmark and shows the DNS records to add.',
  risk: 2,
  input: EmailDomainAddInput,
  output: EmailDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.added'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const domain = input.domain;
    // handsfreeos.com itself is HandsFreeOS's own business's (M19); its subdomains are nobody's.
    const ours = domain === HANDSFREEOS_DOMAIN && (await isOwnBusiness(ctx));
    if (isHandsFreeOsDomain(domain) && !ours)
      throw HfosError.rule(
        'email_domain_ours',
        400,
        'That domain is HandsFreeOS’s own. Use a domain your business owns, like lonestarhvac.com.',
      );
    if (isConsumerMailDomain(domain))
      throw HfosError.rule(
        'email_domain_consumer',
        400,
        `${domain} is a public email service, so it can’t send for your business. Use a domain your business owns, like lonestarhvac.com.`,
      );
    const [held] = await ctx.tx
      .select({ n: count() })
      .from(emailDomains)
      .where(eq(emailDomains.workspaceId, workspaceId));
    if ((held?.n ?? 0) >= MAX_EMAIL_DOMAINS)
      throw HfosError.rule(
        'email_domain_limit',
        409,
        `A business can have up to ${MAX_EMAIL_DOMAINS} domains. Remove one under Use your own domain in Settings → Email to add another.`,
      );
    const [row] = await ctx.tx
      .insert(emailDomains)
      .values({ workspaceId, domain, createdBy: userIdOf(ctx.actor) })
      .onConflictDoNothing({ target: emailDomains.domain })
      .returning({ id: emailDomains.id });
    // A domain lives in one workspace; which one holds it is not ours to say.
    if (!row)
      throw HfosError.rule(
        'email_domain_taken',
        409,
        `${domain} is already set up in HandsFreeOS. If it isn’t listed under Use your own domain here, it’s in another business: remove it there first, or ask HandsFreeOS support through Get help.`,
      );
    await ctx.emit({
      type: 'email_domain.added',
      entityType: 'email_domain',
      entityId: row.id,
      payload: { domain },
      after: { domain, status: 'pending' },
    });
    return { emailDomainId: row.id };
  },
});

export const emailDomainVerify = defineCommand({
  name: 'email_domain.verify',
  description:
    'Ask Postmark to check the domain’s DKIM and Return-Path records now. The answer shows in Settings → Email.',
  risk: 1,
  input: EmailDomainRefInput,
  output: EmailDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.verify_requested'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    await ctx.emit({
      type: 'email_domain.verify_requested',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { domain: d.domain, providerDomainId: d.providerDomainId },
      after: { domain: d.domain, status: d.status },
    });
    return { emailDomainId: d.id };
  },
});

export const emailDomainRemove = defineCommand({
  name: 'email_domain.remove',
  description:
    'Remove one of the business’s domains and the addresses on it. The default address has to live elsewhere first.',
  risk: 3,
  input: EmailDomainRefInput,
  output: EmailDomainRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.removed'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    const onIt = await ctx.tx
      .select({ address: emailAddresses.address, isDefault: emailAddresses.isDefault })
      .from(emailAddresses)
      .where(eq(emailAddresses.emailDomainId, d.id));
    if (onIt.some((a) => a.isDefault))
      throw HfosError.rule(
        'email_domain_in_use',
        409,
        `${onIt.find((a) => a.isDefault)!.address} is your default address, and it’s on ${d.domain}. Click Make default on an address on another domain first, then remove ${d.domain}.`,
      );
    // Its addresses go with it (on delete cascade).
    const [gone] = await ctx.tx
      .delete(emailDomains)
      .where(eq(emailDomains.id, d.id))
      .returning({ id: emailDomains.id });
    if (!gone) throw HfosError.forbidden();
    await ctx.emit({
      type: 'email_domain.removed',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { domain: d.domain, providerDomainId: d.providerDomainId },
      before: { domain: d.domain, status: d.status, addresses: onIt.map((a) => a.address) },
    });
    return { emailDomainId: d.id };
  },
});

export const emailDomainRecord = defineCommand({
  name: 'email_domain.record',
  description:
    'Worker: what Postmark said about a domain: its DNS records and whether DKIM and Return-Path verify.',
  risk: 1,
  input: EmailDomainRecordInput,
  output: EmailDomainRecordOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.checked'],
  actors: ['system'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    const now = new Date();
    // A check Postmark did not report keeps its last answer, so an API error cannot unverify a domain.
    const wasVerified = d.status === 'verified';
    const dkim = input.dkimVerified ?? wasVerified;
    const returnPath = input.returnPathVerified ?? wasVerified;
    const status =
      dkim && returnPath
        ? ('verified' as const)
        : input.error
          ? ('failed' as const)
          : ('pending' as const);
    const patch: Partial<typeof emailDomains.$inferInsert> = {
      status,
      lastCheckedAt: now,
      lastError: input.error ?? null,
    };
    if (input.providerDomainId !== undefined) patch.providerDomainId = input.providerDomainId;
    if (input.dkimHost !== undefined) patch.dkimHost = input.dkimHost;
    if (input.dkimValue !== undefined) patch.dkimValue = input.dkimValue;
    if (input.returnPathHost !== undefined) patch.returnPathHost = input.returnPathHost;
    if (input.returnPathValue !== undefined) patch.returnPathValue = input.returnPathValue;
    if (input.dkimVerified && !d.dkimVerifiedAt) patch.dkimVerifiedAt = now;
    if (input.returnPathVerified && !d.returnPathVerifiedAt) patch.returnPathVerifiedAt = now;
    // A record a check found missing loses its stamp, so Settings → Email shows it as not found again.
    if (input.dkimVerified === false) patch.dkimVerifiedAt = null;
    if (input.returnPathVerified === false) patch.returnPathVerifiedAt = null;
    await ctx.tx.update(emailDomains).set(patch).where(eq(emailDomains.id, d.id));
    const changed = status !== d.status;
    // Broadcast every check so Settings → Email updates its "last checked" live; `from` tells the worker whether
    // a domain just verified or stopped verifying (the owners get an email for either).
    await ctx.emit({
      type: 'email_domain.checked',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { status, changed, from: d.status },
      before: { status: d.status },
      after: { domain: d.domain, status, ...(input.error ? { error: input.error } : {}) },
    });
    return { emailDomainId: d.id, status, changed };
  },
});

// ---------- receiving mail at the business's own domain (M19) ----------

export const emailDomainReceive = defineCommand({
  name: 'email_domain.receive',
  description: `Start receiving the business’s mail at one of its verified domains. Once its MX record points at ${INBOUND_MX_HOST}, mail to every address there arrives in the Inbox.`,
  risk: 2,
  input: EmailDomainRefInput,
  output: EmailDomainReceivingOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.receiving_requested'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    if (d.status !== 'verified') throw unverified(d.domain);
    // Each domain needs its own Postmark server, and creating them comes later (M19 step 6). Until then only
    // handsfreeos.com receives, through the support desk's server.
    if (!(await isOwnBusiness(ctx)))
      throw HfosError.rule(
        'email_receiving_not_yet',
        409,
        `Receiving mail at your own domain isn’t open to every business yet. Until it is, mail to ${d.domain} keeps arriving where it does now, and replies to what you send still come back to your Inbox.`,
      );
    if (d.receiving === 'pending' || d.receiving === 'on')
      return { emailDomainId: d.id, receiving: d.receiving, changed: false };
    await ctx.tx
      .update(emailDomains)
      .set({ receiving: 'pending' })
      .where(eq(emailDomains.id, d.id));
    await ctx.emit({
      type: 'email_domain.receiving_requested',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { domain: d.domain },
      before: { receiving: d.receiving },
      after: { domain: d.domain, receiving: 'pending' },
    });
    return { emailDomainId: d.id, receiving: 'pending' as const, changed: true };
  },
});

export const emailDomainStopReceiving = defineCommand({
  name: 'email_domain.stop_receiving',
  description:
    'Stop receiving the business’s mail at one of its domains. Mail sent there is no longer filed here, so point its MX record somewhere else first.',
  risk: 3,
  input: EmailDomainRefInput,
  output: EmailDomainReceivingOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.receiving_stopped'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    if (d.receiving === 'off')
      return { emailDomainId: d.id, receiving: 'off' as const, changed: false };
    await ctx.tx.update(emailDomains).set({ receiving: 'off' }).where(eq(emailDomains.id, d.id));
    await ctx.emit({
      type: 'email_domain.receiving_stopped',
      entityType: 'email_domain',
      entityId: d.id,
      payload: { domain: d.domain, inboundServerId: d.inboundServerId },
      before: { domain: d.domain, receiving: d.receiving },
      after: { receiving: 'off' },
    });
    return { emailDomainId: d.id, receiving: 'off' as const, changed: true };
  },
});

export const emailDomainRecordReceiving = defineCommand({
  name: 'email_domain.record_receiving',
  description: `Worker: whether a receiving domain’s MX record points at ${INBOUND_MX_HOST}.`,
  risk: 1,
  input: EmailDomainRecordReceivingInput,
  output: EmailDomainReceivingOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_domain.receiving_checked'],
  actors: ['system'],
  async handler(ctx, input) {
    const d = await loadDomain(ctx, input.emailDomainId);
    // Turned off while the check ran: nothing to say about a domain that no longer receives.
    if (d.receiving === 'off')
      return { emailDomainId: d.id, receiving: 'off' as const, changed: false };
    const now = new Date();
    // DNS not answering is no news: the domain keeps what it had.
    const receiving =
      input.mxFound === true
        ? ('on' as const)
        : input.mxFound === false && d.receiving === 'on'
          ? ('lapsed' as const)
          : d.receiving;
    await ctx.tx
      .update(emailDomains)
      .set({
        receiving,
        mxCheckedAt: now,
        ...(input.mxFound ? { mxVerifiedAt: now } : {}),
      })
      .where(eq(emailDomains.id, d.id));
    const changed = receiving !== d.receiving;
    if (changed)
      await ctx.emit({
        type: 'email_domain.receiving_checked',
        entityType: 'email_domain',
        entityId: d.id,
        payload: { receiving, changed, from: d.receiving },
        before: { receiving: d.receiving },
        after: { domain: d.domain, receiving },
      });
    return { emailDomainId: d.id, receiving, changed };
  },
});

// ---------- sending addresses ----------

export const emailAddressCreate = defineCommand({
  name: 'email_address.create',
  description:
    'Add a sending address on the shared subdomain or on a verified domain of the business’s own, optionally as the default.',
  risk: 2,
  input: EmailAddressCreateInput,
  output: EmailAddressCreateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_address.created'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const domain = input.emailDomainId ? await loadDomain(ctx, input.emailDomainId) : null;
    if (namesReserved(domain?.domain ?? null) && isReservedLocalPart(input.localPart))
      throw reserved(input.localPart, domain?.domain ?? null);
    if (domain && domain.status !== 'verified') throw unverified(domain.domain);
    const where = `${input.localPart}@${domain?.domain ?? SHARED_MAIL_DOMAIN}`;
    if (input.ownerUserId) await checkOwner(ctx, input.ownerUserId, where, domain, input.isDefault);
    const previous = input.isDefault ? await clearDefault(ctx) : null;
    // The database fills in the address from the name and domain; this copy only satisfies the insert.
    const [row] = await ctx.tx
      .insert(emailAddresses)
      .values({
        workspaceId,
        emailDomainId: domain?.id ?? null,
        localPart: input.localPart,
        address: `${input.localPart}@${domain?.domain ?? SHARED_MAIL_DOMAIN}`,
        displayName: input.displayName,
        isDefault: input.isDefault,
        // It can send from the start: the shared subdomain and a verified domain both already pass Postmark.
        verifiedAt: new Date(),
        createdBy: userIdOf(ctx.actor),
        ownerUserId: input.ownerUserId ?? null,
      })
      .onConflictDoNothing({ target: emailAddresses.address })
      .returning({ id: emailAddresses.id, address: emailAddresses.address });
    if (!row) throw addressTaken(`${input.localPart}@${domain?.domain ?? SHARED_MAIL_DOMAIN}`);
    await ctx.emit({
      type: 'email_address.created',
      entityType: 'email_address',
      entityId: row.id,
      payload: {
        address: row.address,
        emailDomainId: domain?.id ?? null,
        isDefault: input.isDefault,
        ...(previous ? { previousDefaultId: previous.id } : {}),
      },
      after: {
        address: row.address,
        displayName: input.displayName,
        isDefault: input.isDefault,
        ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
        ...(previous ? { previousDefault: previous.address } : {}),
      },
    });
    return { emailAddressId: row.id, address: row.address };
  },
});

export const emailAddressUpdate = defineCommand({
  name: 'email_address.update',
  description:
    'Change the name customers see on an address, rename it while it has not sent mail, or make it the default.',
  risk: 2,
  input: EmailAddressUpdateInput,
  output: EmailAddressUpdateOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_address.updated'],
  async handler(ctx, input) {
    const a = await loadAddress(ctx, input.emailAddressId);
    const domain = a.emailDomainId ? await loadDomain(ctx, a.emailDomainId) : null;
    const patch: {
      displayName?: string;
      localPart?: string;
      isDefault?: boolean;
      ownerUserId?: string | null;
    } = {};
    if (input.ownerUserId !== undefined && input.ownerUserId !== a.ownerUserId) {
      // Taking an address from its person takes their mail with it: an owner does that, once they have left.
      if (a.ownerUserId)
        throw HfosError.rule(
          'email_address_owner_is_theirs',
          409,
          `${a.address} is one person’s own address, and its mail is theirs. Once they’ve left the business, an owner can make it the team’s or give it to someone else.`,
        );
      await checkOwner(ctx, input.ownerUserId!, a.address, domain, a.isDefault);
      patch.ownerUserId = input.ownerUserId;
    }
    if (input.displayName !== undefined && input.displayName !== a.displayName)
      patch.displayName = input.displayName;
    if (input.localPart !== undefined && input.localPart !== a.localPart) {
      if (namesReserved(domain?.domain ?? null) && isReservedLocalPart(input.localPart))
        throw reserved(input.localPart, domain?.domain ?? null);
      patch.localPart = input.localPart;
    }
    // The workspace always has a default; it moves by picking another one.
    if (input.isDefault === false && a.isDefault)
      throw HfosError.rule(
        'email_default_required',
        409,
        `${a.address} is your default address, and there always has to be one. Click Make default on another address instead.`,
      );
    if (input.isDefault === true && !a.isDefault) {
      if (domain && domain.status !== 'verified') throw unverified(domain.domain);
      if (a.ownerUserId || patch.ownerUserId)
        throw HfosError.rule(
          'email_address_owner_default',
          409,
          `${a.address} is one person’s own address, so it can’t be the business’s default. Make a team address the default instead.`,
        );
      patch.isDefault = true;
    }
    const updated = Object.keys(patch);
    if (updated.length === 0) return { emailAddressId: a.id, address: a.address, updated };
    const previous = patch.isDefault ? await clearDefault(ctx) : null;
    let row: { address: string } | undefined;
    try {
      [row] = await ctx.tx
        .update(emailAddresses)
        .set(patch)
        .where(eq(emailAddresses.id, a.id))
        .returning({ address: emailAddresses.address });
    } catch (e) {
      if (isUniqueViolation(e, 'email_addresses_address_key'))
        throw addressTaken(
          `${patch.localPart ?? a.localPart}@${domain?.domain ?? SHARED_MAIL_DOMAIN}`,
        );
      throw e; // an address that has sent mail keeps its name: the guard's rule, via pg-errors
    }
    if (!row) throw HfosError.forbidden();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = { address: row.address };
    if (patch.displayName !== undefined) {
      before.displayName = a.displayName;
      after.displayName = patch.displayName;
    }
    if (patch.localPart !== undefined) before.address = a.address;
    if (patch.isDefault) {
      before.isDefault = false;
      after.isDefault = true;
      if (previous) after.previousDefault = previous.address;
    }
    if (patch.ownerUserId !== undefined) {
      before.ownerUserId = null;
      after.ownerUserId = patch.ownerUserId;
    }
    await ctx.emit({
      type: 'email_address.updated',
      entityType: 'email_address',
      entityId: a.id,
      payload: { fields: updated, ...(previous ? { previousDefaultId: previous.id } : {}) },
      before,
      after,
    });
    return { emailAddressId: a.id, address: row.address, updated };
  },
});

/**
 * What becomes of the address of someone who has left (M19), and of their mail on it: an owner makes it the team's,
 * gives it to someone else, or removes it with its mail. Until then new mail to it goes to the default address.
 * The SQL checks all of it again for itself: an owner, a person who has left.
 */
export const emailAddressReassign = defineCommand({
  name: 'email_address.reassign',
  description:
    'Owners: decide what becomes of the own address of someone who has left, and of their mail on it: the team’s, someone else’s, or removed.',
  risk: 3,
  input: EmailAddressReassignInput,
  output: EmailAddressReassignOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_address.reassigned'],
  async handler(ctx, input) {
    const a = await loadAddress(ctx, input.emailAddressId);
    const [row] = await rows<{
      was: string;
      threads: number;
      media: { bucket?: string; objectPath?: string }[];
    }>(
      ctx.tx,
      sql`select was, threads, media from private.reassign_email_address(
            ${a.id}::uuid, ${input.to === 'person' ? input.userId! : null}::uuid, ${input.to === 'remove'})`,
    );
    if (!row) throw HfosError.forbidden();
    // The files the removed mail carried: the worker takes them out of storage. A job's payload, which nobody
    // reads, rather than the history, which owners do.
    const files = input.to === 'remove' ? row.media.filter((m) => m.bucket && m.objectPath) : [];
    if (files.length > 0)
      await scheduleJob(ctx.tx, {
        kind: 'email.remove_files',
        dedupeKey: `remove-files:${a.id}`,
        runAt: new Date(),
        payload: { files },
        workspaceId: ctx.scope.workspaceId!,
        organizationId: (await workspaceMessaging(ctx.tx, ctx.scope.workspaceId!)).organizationId,
      });
    await ctx.emit({
      type: 'email_address.reassigned',
      entityType: 'email_address',
      entityId: a.id,
      payload: { to: input.to, userId: input.userId ?? null, threads: row.threads },
      before: { address: a.address, ownerUserId: row.was },
      after: {
        address: a.address,
        to: input.to === 'team' ? 'the team' : input.to === 'remove' ? 'removed' : 'another person',
        ...(input.userId ? { ownerUserId: input.userId } : {}),
        threads: row.threads,
      },
    });
    return { emailAddressId: a.id, to: input.to, threads: row.threads };
  },
});

// ---------- connected mailboxes ----------

export const mailboxConnect = defineCommand({
  name: 'mailbox.connect',
  description:
    'Start connecting an Outlook or Gmail mailbox. Returns a one-time state; the browser signs in to Microsoft or Google through the worker.',
  risk: 3,
  input: MailboxConnectInput,
  output: MailboxConnectOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['mailbox.connect_started'],
  // The state is a one-time secret: never kept in a stored answer.
  shownOnce: ['state'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const workspaceId = ctx.scope.workspaceId!;
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
    // People may insert only these columns, and the query builder would name every column, so this is SQL.
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.mailbox_connections
            (workspace_id, provider, user_id, shared, status, oauth_state_hash, oauth_state_expires_at, created_by)
          values (${workspaceId}, ${input.provider}::app.mailbox_provider, ${me.userId}, ${input.shared}, 'pending',
            ${sha256Hex(state)}, ${expiresAt}::timestamptz, ${me.userId})
          returning id`,
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'mailbox.connect_started',
      entityType: 'mailbox',
      entityId: row.id,
      payload: { provider: input.provider, shared: input.shared },
      after: { provider: input.provider, shared: input.shared },
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const mailboxDisconnect = defineCommand({
  name: 'mailbox.disconnect',
  description:
    'Disconnect a mailbox. HandsFreeOS forgets its sign-in and stops syncing; mail already in the inbox stays.',
  risk: 2,
  input: MailboxRefInput,
  output: MailboxRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['mailbox.disconnected'],
  // The worker too: deleting an account disconnects the mailboxes the person connected.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const m = await loadMailbox(ctx, input.connectionId);
    if (m.status === 'disconnected') return { connectionId: m.id };
    // For people the update guard clears the sealed tokens and the sync schedule; the worker's own scope passes
    // that guard, so it clears them itself. The subscription id is not readable by people, so the worker reads it
    // from the row, which keeps it.
    const [row] = await ctx.tx
      .update(mailboxConnections)
      .set({
        status: 'disconnected',
        ...(ctx.actor.type === 'human'
          ? {}
          : {
              disconnectedAt: new Date(),
              tokenEnc: null,
              pkceVerifierEnc: null,
              nextSyncAt: null,
            }),
      })
      .where(eq(mailboxConnections.id, m.id))
      .returning({ id: mailboxConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'mailbox.disconnected',
      entityType: 'mailbox',
      entityId: m.id,
      payload: { provider: m.provider },
      before: { status: m.status },
      after: { account: m.accountEmail, provider: m.provider, status: 'disconnected' },
    });
    return { connectionId: m.id };
  },
});

export const mailboxResync = defineCommand({
  name: 'mailbox.resync',
  description: 'Check a connected mailbox for new mail now instead of waiting for the next sync.',
  risk: 1,
  input: MailboxRefInput,
  output: MailboxRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['mailbox.resync_requested'],
  async handler(ctx, input) {
    const m = await loadMailbox(ctx, input.connectionId);
    if (m.status !== 'active')
      throw HfosError.rule(
        'mailbox_not_active',
        409,
        `${m.accountEmail ?? 'This mailbox'} isn’t connected right now, so it can’t check for mail. Connect it again under Connected mailboxes in Settings → Email.`,
      );
    await ctx.emit({
      type: 'mailbox.resync_requested',
      entityType: 'mailbox',
      entityId: m.id,
      payload: { provider: m.provider },
      after: { account: m.accountEmail, provider: m.provider },
    });
    return { connectionId: m.id };
  },
});

export const mailboxActivate = defineCommand({
  name: 'mailbox.activate',
  description:
    'Worker: the owner signed in to Microsoft or Google and the mailbox is connected. It replaces an older connection to the same account.',
  risk: 1,
  input: MailboxActivateInput,
  output: MailboxSystemOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['mailbox.connected', 'mailbox.disconnected'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const m = await loadMailbox(ctx, input.connectionId);
    if (m.status === 'active' && m.accountEmail === input.accountEmail)
      return { connectionId: m.id, status: 'active' as const, changed: false };
    if (m.status !== 'pending')
      throw HfosError.rule(
        'mailbox_not_pending',
        409,
        'This sign-in was already used or cancelled. Click Connect Gmail or Connect Outlook in Settings → Email to start again.',
      );
    const now = new Date();
    // One live connection per account (a partial unique index): a reconnect retires the older one first.
    const replaced = await ctx.tx
      .update(mailboxConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        tokenEnc: null,
        pkceVerifierEnc: null,
        nextSyncAt: null,
      })
      .where(
        and(
          eq(mailboxConnections.workspaceId, workspaceId),
          eq(mailboxConnections.provider, m.provider),
          eq(mailboxConnections.accountEmail, input.accountEmail),
          ne(mailboxConnections.status, 'disconnected'),
          ne(mailboxConnections.id, m.id),
        ),
      )
      .returning({ id: mailboxConnections.id });
    for (const old of replaced)
      await ctx.emit({
        type: 'mailbox.disconnected',
        entityType: 'mailbox',
        entityId: old.id,
        payload: { provider: m.provider, replacedBy: m.id },
        after: { account: input.accountEmail, provider: m.provider, status: 'disconnected' },
      });
    await ctx.tx
      .update(mailboxConnections)
      .set({
        status: 'active',
        accountEmail: input.accountEmail,
        displayName: input.displayName || null,
        scopes: input.scopes,
        tokenEnc: input.tokenEnc,
        tokenKeyId: input.tokenKeyId,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        connectedAt: now,
        disconnectedAt: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        pkceVerifierEnc: null,
        lastError: null,
      })
      .where(eq(mailboxConnections.id, m.id));
    // Never the tokens: events, audit rows and the output carry who and which provider only.
    await ctx.emit({
      type: 'mailbox.connected',
      entityType: 'mailbox',
      entityId: m.id,
      payload: { provider: m.provider, shared: m.shared, replaced: replaced.map((r) => r.id) },
      before: { status: m.status },
      after: { account: input.accountEmail, provider: m.provider },
    });
    return { connectionId: m.id, status: 'active' as const, changed: true };
  },
});

export const mailboxFail = defineCommand({
  name: 'mailbox.fail',
  description:
    'Worker: a mailbox needs its owner to sign in again, or stopped syncing with an error.',
  risk: 1,
  input: MailboxFailInput,
  output: MailboxSystemOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['mailbox.reauth_required', 'mailbox.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const m = await loadMailbox(ctx, input.connectionId);
    if (m.status === 'disconnected')
      return { connectionId: m.id, status: 'disconnected' as const, changed: false };
    await ctx.tx
      .update(mailboxConnections)
      .set({ status: input.status, lastError: input.error })
      .where(eq(mailboxConnections.id, m.id));
    const changed = m.status !== input.status;
    // Once per change: a mailbox that keeps failing does not email the owners again on every sync.
    if (changed)
      await ctx.emit({
        type: input.status === 'reauth_required' ? 'mailbox.reauth_required' : 'mailbox.failed',
        entityType: 'mailbox',
        entityId: m.id,
        payload: { provider: m.provider, error: input.error },
        before: { status: m.status },
        after: {
          account: m.accountEmail,
          provider: m.provider,
          status: input.status,
          error: input.error,
        },
      });
    return { connectionId: m.id, status: input.status, changed };
  },
});

// ---------- mail from people we don't know ----------

export const emailClaimUnmatched = defineCommand({
  name: 'email.claim_unmatched',
  description:
    'File an email from an unknown sender under a customer. It joins their conversation and timeline.',
  risk: 1,
  input: EmailClaimUnmatchedInput,
  output: EmailClaimUnmatchedOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['email.unmatched_claimed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const u = await loadUnmatched(ctx, input.unmatchedId);
    if (u.resolvedAt || u.dismissedAt) throw alreadyHandled();
    const person = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    if (person.archivedAt)
      throw HfosError.rule(
        'person_archived',
        409,
        `${fullName(person.firstName, person.lastName) || 'This customer'} is archived. Restore them from their page first, then file this email under them.`,
      );
    // Still open when written: two people claiming at once cannot both win.
    const [row] = await ctx.tx
      .update(emailInboundUnmatched)
      .set({ resolvedPersonId: person.id, resolvedAt: new Date(), resolvedBy: me.userId })
      .where(
        and(
          eq(emailInboundUnmatched.id, u.id),
          isNull(emailInboundUnmatched.resolvedAt),
          isNull(emailInboundUnmatched.dismissedAt),
        ),
      )
      .returning({ id: emailInboundUnmatched.id });
    if (!row) throw alreadyHandled();
    await ctx.emit({
      type: 'email.unmatched_claimed',
      entityType: 'email_unmatched',
      entityId: u.id,
      payload: { unmatchedId: u.id, personId: person.id },
      after: {
        from: u.fromAddress,
        subject: u.subject,
        person: fullName(person.firstName, person.lastName),
      },
    });
    return { unmatchedId: u.id, personId: person.id };
  },
});

export const emailDismissUnmatched = defineCommand({
  name: 'email.dismiss_unmatched',
  description: 'Dismiss an email from an unknown sender without filing it under anyone.',
  risk: 1,
  input: EmailUnmatchedRefInput,
  output: EmailUnmatchedRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['email.unmatched_dismissed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const u = await loadUnmatched(ctx, input.unmatchedId);
    if (u.resolvedAt || u.dismissedAt) throw alreadyHandled();
    const [row] = await ctx.tx
      .update(emailInboundUnmatched)
      .set({ dismissedAt: new Date(), dismissedBy: me.userId })
      .where(
        and(
          eq(emailInboundUnmatched.id, u.id),
          isNull(emailInboundUnmatched.resolvedAt),
          isNull(emailInboundUnmatched.dismissedAt),
        ),
      )
      .returning({ id: emailInboundUnmatched.id });
    if (!row) throw alreadyHandled();
    await ctx.emit({
      type: 'email.unmatched_dismissed',
      entityType: 'email_unmatched',
      entityId: u.id,
      payload: { unmatchedId: u.id },
      after: { from: u.fromAddress, subject: u.subject },
    });
    return { unmatchedId: u.id };
  },
});

// ---------- suppressions ----------

export const emailSuppressionAdd = defineCommand({
  name: 'email_suppression.add',
  description: 'Stop email to an address. Nothing goes to it until the suppression is released.',
  risk: 2,
  input: EmailSuppressionAddInput,
  output: EmailSuppressionRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_suppression.added'],
  async handler(ctx, input) {
    // One active suppression per address (a partial unique index); a released one can be added again.
    const [row] = await ctx.tx
      .insert(emailSuppressions)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        address: input.address,
        reason: 'manual',
        createdBy: userIdOf(ctx.actor),
      })
      .onConflictDoNothing()
      .returning({ id: emailSuppressions.id });
    if (!row)
      throw HfosError.rule(
        'email_already_suppressed',
        409,
        `Email to ${input.address} is already stopped. It’s listed under Blocked addresses in Settings → Email.`,
      );
    await ctx.emit({
      type: 'email_suppression.added',
      entityType: 'email_suppression',
      entityId: row.id,
      payload: { address: input.address, reason: 'manual' },
      after: { address: input.address, reason: 'manual' },
    });
    return { suppressionId: row.id };
  },
});

export const emailSuppressionRelease = defineCommand({
  name: 'email_suppression.release',
  description:
    'Let email go to an address again after a bounce, a spam complaint or a manual stop.',
  risk: 2,
  input: EmailSuppressionReleaseInput,
  output: EmailSuppressionRefOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['email_suppression.released'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const [s] = await ctx.tx
      .select({
        id: emailSuppressions.id,
        address: emailSuppressions.address,
        reason: emailSuppressions.reason,
        releasedAt: emailSuppressions.releasedAt,
      })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.id, input.suppressionId),
          eq(emailSuppressions.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!s)
      throw HfosError.notFound(
        'That blocked address isn’t there anymore. Refresh Settings → Email and try again.',
      );
    if (s.releasedAt) return { suppressionId: s.id };
    const [row] = await ctx.tx
      .update(emailSuppressions)
      .set({ releasedAt: new Date(), releasedBy: me.userId })
      .where(and(eq(emailSuppressions.id, s.id), isNull(emailSuppressions.releasedAt)))
      .returning({ id: emailSuppressions.id });
    if (!row) return { suppressionId: s.id };
    await ctx.emit({
      type: 'email_suppression.released',
      entityType: 'email_suppression',
      entityId: s.id,
      payload: { address: s.address, reason: s.reason },
      before: { released: false },
      after: { address: s.address, reason: s.reason, released: true },
    });
    return { suppressionId: s.id };
  },
});
