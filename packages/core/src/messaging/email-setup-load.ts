/**
 * What the business email step starts from, read from the database (server only), as the person setting it up,
 * under row-level security: the business's addresses, its domains with their records and plans, mailboxes, and who
 * is setting it up. The step's screens, its command and Home's card all read it this way.
 */
import { asc, desc, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { emailAddresses, emailDomains, mailboxConnections } from '@hfos/db/schema';
import { ownershipHost } from '../schemas/branded-domain';
import { HANDSFREEOS_DOMAIN, INBOUND_MX_HOST, normalizeEmailDomain } from '../schemas/email';
import { emailDomainRecords } from './email-records';
import {
  emailDomainPlanOf,
  MAIL_HOSTS,
  type EmailSetupState,
  type MailHost,
} from './email-setup';

const SHARED = 'mail.handsfreeos.com';
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const mailHostOf = (v: string | null): MailHost | null =>
  (MAIL_HOSTS as readonly string[]).includes(v ?? '') ? (v as MailHost) : null;

/** The website's domain: "https://www.BellasSalon.com/book" → "bellassalon.com". */
export const websiteDomainOf = (website: string | null | undefined): string | null => {
  const d = normalizeEmailDomain(website ?? '').replace(/^www\./, '');
  return /^([a-z0-9-]+\.)+[a-z]{2,63}$/.test(d) ? d : null;
};

export async function loadEmailSetupState(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<EmailSetupState> {
  const [ws] = await rows<{
    name: string;
    slug: string;
    website: string | null;
    myEmail: string | null;
    myName: string | null;
    canManage: boolean;
  }>(
    tx,
    sql`select w.name, w.slug::text as slug,
          coalesce((select k.url from app.knowledge_sources k where k.workspace_id = w.id limit 1),
                   nullif(btrim(w.settings->>'website'), '')) as website,
          (select u.email::text from app.users u where u.id = ${userId}) as "myEmail",
          (select nullif(btrim(u.full_name), '') from app.users u where u.id = ${userId}) as "myName",
          private.has_permission(w.id, 'channels.manage') as "canManage"
        from app.workspaces w where w.id = ${workspaceId}`,
  );
  const addresses = await tx
    .select({
      id: emailAddresses.id,
      address: emailAddresses.address,
      localPart: emailAddresses.localPart,
      displayName: emailAddresses.displayName,
      isDefault: emailAddresses.isDefault,
      emailDomainId: emailAddresses.emailDomainId,
      ownerUserId: emailAddresses.ownerUserId,
      domain: emailDomains.domain,
    })
    .from(emailAddresses)
    .leftJoin(emailDomains, eq(emailDomains.id, emailAddresses.emailDomainId))
    .where(eq(emailAddresses.workspaceId, workspaceId))
    .orderBy(desc(emailAddresses.isDefault), asc(emailAddresses.createdAt));
  const domains = await tx
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.workspaceId, workspaceId))
    .orderBy(asc(emailDomains.createdAt));
  const mailboxes = await tx
    .select({
      provider: mailboxConnections.provider,
      accountEmail: mailboxConnections.accountEmail,
      status: mailboxConnections.status,
      userId: mailboxConnections.userId,
    })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.workspaceId, workspaceId))
    .orderBy(asc(mailboxConnections.createdAt));

  const sender = addresses.find((a) => a.isDefault) ?? null;
  const free = addresses.find((a) => !a.emailDomainId && !a.ownerUserId) ?? null;
  const mine = addresses.find((a) => a.ownerUserId === userId) ?? null;
  return {
    sharedDomain: SHARED,
    inboundMxHost: INBOUND_MX_HOST,
    businessName: ws?.name ?? '',
    websiteDomain: websiteDomainOf(ws?.website),
    slug: ws?.slug ?? '',
    myEmail: ws?.myEmail ?? null,
    myFirstName: ws?.myName?.split(/\s+/)[0] ?? null,
    sender: sender
      ? {
          address: sender.address,
          localPart: sender.localPart,
          domain: sender.emailDomainId ? sender.domain : null,
          displayName: sender.displayName,
        }
      : null,
    free: free
      ? {
          id: free.id,
          localPart: free.localPart,
          address: free.address,
          displayName: free.displayName,
          isDefault: free.isDefault,
        }
      : null,
    domains: domains.map((d) => {
      const plan = emailDomainPlanOf(d.plan);
      const mailHost = mailHostOf(d.mailHost);
      const like = {
        domain: d.domain,
        dkimHost: d.dkimHost,
        dkimValue: d.dkimValue,
        returnPathHost: d.returnPathHost,
        returnPathValue: d.returnPathValue,
        dkimVerifiedAt: iso(d.dkimVerifiedAt),
        returnPathVerifiedAt: iso(d.returnPathVerifiedAt),
        ownershipHost: d.domain === HANDSFREEOS_DOMAIN ? null : ownershipHost(d.domain),
        ownershipToken: d.ownershipToken,
        ownershipProvedAt: iso(d.ownershipProvedAt),
        receiving: d.receiving,
        mxVerifiedAt: iso(d.mxVerifiedAt),
      };
      return {
        id: d.id,
        domain: d.domain,
        status: d.status,
        receiving: d.receiving,
        mailHost,
        dnsHost: d.dnsHost,
        plan,
        records: emailDomainRecords(like, INBOUND_MX_HOST),
        lastCheckedAt: iso(d.lastCheckedAt),
        lastError: d.lastError,
      };
    }),
    mine: mine ? { address: mine.address } : null,
    mailboxes: mailboxes
      .filter((m) => m.status !== 'disconnected' && m.status !== 'pending')
      .map((m) => ({
        provider: m.provider,
        accountEmail: m.accountEmail,
        status: m.status,
        mine: m.userId === userId,
      })),
    canManage: !!ws?.canManage,
  };
}
