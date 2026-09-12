import { and, asc, desc, eq, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { emailAddresses, emailDomains, mailboxConnections, users } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { SHARED_MAIL_DOMAIN } from '../messaging/email';
import {
  EmailSetupStatusInput,
  EmailSetupStatusOutput,
  EmailSuppressionListInput,
  EmailSuppressionListOutput,
  EmailUnmatchedListInput,
  EmailUnmatchedListOutput,
} from '../schemas/email';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const userOut = (id: string | null, name: string | null) =>
  id ? { id, fullName: name ?? 'Former member' } : null;

export const emailSetupStatus = defineQuery({
  name: 'email.setup_status',
  description:
    'Where email stands: the sending addresses, the business’s own domains with their DNS records, connected mailboxes, and what waits in suppressions and unmatched mail.',
  input: EmailSetupStatusInput,
  output: EmailSetupStatusOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const workspaceId = input.workspaceId;
    const addresses = await ctx.tx
      .select({ a: emailAddresses, domain: emailDomains.domain, domainStatus: emailDomains.status })
      .from(emailAddresses)
      .leftJoin(emailDomains, eq(emailDomains.id, emailAddresses.emailDomainId))
      .where(eq(emailAddresses.workspaceId, workspaceId))
      .orderBy(desc(emailAddresses.isDefault), asc(emailAddresses.createdAt));
    const domains = await ctx.tx
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.workspaceId, workspaceId))
      .orderBy(asc(emailDomains.createdAt));
    // Column grants: people read a mailbox's state, never its sealed tokens. A sign-in nobody finished
    // (its state lasts ten minutes) is not a mailbox yet, so it stays out of the list.
    const mailboxes = await ctx.tx
      .select({
        id: mailboxConnections.id,
        provider: mailboxConnections.provider,
        accountEmail: mailboxConnections.accountEmail,
        displayName: mailboxConnections.displayName,
        userId: mailboxConnections.userId,
        userName: users.fullName,
        userEmail: users.email,
        shared: mailboxConnections.shared,
        status: mailboxConnections.status,
        lastSyncedAt: mailboxConnections.lastSyncedAt,
        lastError: mailboxConnections.lastError,
        connectedAt: mailboxConnections.connectedAt,
      })
      .from(mailboxConnections)
      .leftJoin(users, eq(users.id, mailboxConnections.userId))
      .where(
        and(
          eq(mailboxConnections.workspaceId, workspaceId),
          ne(mailboxConnections.status, 'disconnected'),
          dsql`(${mailboxConnections.status} <> 'pending' or ${mailboxConnections.createdAt} > now() - interval '10 minutes')`,
        ),
      )
      .orderBy(asc(mailboxConnections.createdAt));
    const [counts] = await rows<{ suppressions: number; unmatched: number }>(
      ctx.tx,
      sql`select
            (select count(*) from app.email_suppressions s
              where s.workspace_id = ${workspaceId} and s.released_at is null)::int as suppressions,
            (select count(*) from app.email_inbound_unmatched u
              where u.workspace_id = ${workspaceId} and u.resolved_at is null and u.dismissed_at is null)::int as unmatched`,
    );
    return {
      sharedDomain: SHARED_MAIL_DOMAIN,
      addresses: addresses.map(({ a, domain, domainStatus }) => ({
        id: a.id,
        address: a.address,
        localPart: a.localPart,
        displayName: a.displayName,
        isDefault: a.isDefault,
        emailDomainId: a.emailDomainId,
        domain: a.emailDomainId ? domain : null,
        usable: !a.emailDomainId || domainStatus === 'verified',
      })),
      domains: domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        status: d.status,
        dkimHost: d.dkimHost,
        dkimValue: d.dkimValue,
        returnPathHost: d.returnPathHost,
        returnPathValue: d.returnPathValue,
        dkimVerifiedAt: iso(d.dkimVerifiedAt),
        returnPathVerifiedAt: iso(d.returnPathVerifiedAt),
        lastCheckedAt: iso(d.lastCheckedAt),
        lastError: d.lastError,
        createdAt: iso(d.createdAt)!,
      })),
      mailboxes: mailboxes.map((m) => ({
        id: m.id,
        provider: m.provider,
        accountEmail: m.accountEmail,
        displayName: m.displayName,
        userId: m.userId,
        userName: m.userId ? m.userName || m.userEmail || 'Former member' : null,
        shared: m.shared,
        status: m.status,
        lastSyncedAt: iso(m.lastSyncedAt),
        lastError: m.lastError,
        connectedAt: iso(m.connectedAt),
      })),
      counts: { suppressions: counts?.suppressions ?? 0, unmatched: counts?.unmatched ?? 0 },
    };
  },
});

type SuppressionRow = {
  id: string;
  address: string;
  reason: 'hard_bounce' | 'spam_complaint' | 'manual';
  origin: string | null;
  created_at: Date;
  created_by: string | null;
  created_by_name: string | null;
  released_at: Date | null;
  released_by: string | null;
  released_by_name: string | null;
  sort_key: string;
};

export const emailSuppressionList = defineQuery({
  name: 'email_suppression.list',
  description:
    'Addresses email cannot go to (bounces, spam complaints, stopped by hand), newest first; released ones on request.',
  input: EmailSuppressionListInput,
  output: EmailSuppressionListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const list = await rows<SuppressionRow>(
      ctx.tx,
      sql`select * from (
            select s.id, s.address, s.reason::text as reason, s.origin, s.created_at, s.created_by,
              coalesce(nullif(cu.full_name, ''), cu.email::text) as created_by_name,
              s.released_at, s.released_by, coalesce(nullif(ru.full_name, ''), ru.email::text) as released_by_name,
              ${SORT_KEY(sql`s.created_at`)} as sort_key
            from app.email_suppressions s
            left join app.users cu on cu.id = s.created_by
            left join app.users ru on ru.id = s.released_by
            where s.workspace_id = ${input.workspaceId}
            ${input.includeReleased ? sql`` : sql`and s.released_at is null`}
          ) x
          ${cursor ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key desc, x.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => ({
        id: r.id,
        address: r.address,
        reason: r.reason,
        origin: r.origin,
        createdAt: iso(r.created_at)!,
        createdBy: userOut(r.created_by, r.created_by_name),
        releasedAt: iso(r.released_at),
        releasedBy: userOut(r.released_by, r.released_by_name),
      })),
      nextCursor: result.nextCursor,
    };
  },
});

type UnmatchedRow = {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
  to_address: string | null;
  sort_key: string;
};

export const emailUnmatchedList = defineQuery({
  name: 'email.unmatched_list',
  description:
    'Email from senders who are not customers yet, waiting to be filed under someone or dismissed, newest first.',
  input: EmailUnmatchedListInput,
  output: EmailUnmatchedListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const list = await rows<UnmatchedRow>(
      ctx.tx,
      sql`select * from (
            select u.id, u.from_address, u.from_name, u.subject, u.snippet, u.received_at,
              coalesce(a.address, u.to_addresses[1]) as to_address,
              ${SORT_KEY(sql`u.received_at`)} as sort_key
            from app.email_inbound_unmatched u
            left join app.email_addresses a on a.id = u.email_address_id
            where u.workspace_id = ${input.workspaceId} and u.resolved_at is null and u.dismissed_at is null
          ) x
          ${cursor ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key desc, x.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => ({
        id: r.id,
        fromAddress: r.from_address,
        fromName: r.from_name,
        subject: r.subject,
        snippet: r.snippet,
        receivedAt: iso(r.received_at)!,
        toAddress: r.to_address,
      })),
      nextCursor: result.nextCursor,
    };
  },
});
