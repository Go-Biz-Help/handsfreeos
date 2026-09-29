import { createHash, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { header, recordDelivery, type HttpDeps } from './common';

/** Postmark allows 35 MB of attachments on inbound mail, sent base64. */
const INBOUND_BODY_LIMIT = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PostmarkParty {
  Email?: string;
  Name?: string;
  MailboxHash?: string;
}
interface PostmarkAttachment {
  Name?: string;
  Content?: string;
  ContentType?: string;
  ContentID?: string;
}
interface PostmarkInbound {
  MessageID?: string;
  ToFull?: PostmarkParty[];
  CcFull?: PostmarkParty[];
  BccFull?: PostmarkParty[];
  OriginalRecipient?: string;
  Attachments?: PostmarkAttachment[];
  [key: string]: unknown;
}

/** Postmark signs nothing, so every webhook carries the basic auth we gave it (compared in constant time). */
function authorized(deps: HttpDeps, req: FastifyRequest): boolean {
  const given = Buffer.from(header(req, 'authorization') ?? '');
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${deps.email.webhookUser}:${deps.email.webhookPassword}`).toString('base64')}`,
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface InboundRoute {
  workspaceId: string;
  organizationId: string;
  emailAddressId: string | null;
  replyToken: string | null;
}

/**
 * Which workspace inbound mail is for: a reply token (the +hash on one of our addresses) names the
 * conversation; otherwise the address itself names the workspace.
 */
async function routeInbound(
  deps: HttpDeps,
  recipients: PostmarkParty[],
): Promise<InboundRoute | null> {
  for (const r of recipients) {
    const email = (r.Email ?? '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1 || email.slice(at + 1) !== deps.email.mailDomain) continue;
    const local = email.slice(0, at);
    const plus = local.indexOf('+');
    const base = plus === -1 ? local : local.slice(0, plus);
    const token = (r.MailboxHash || (plus === -1 ? '' : local.slice(plus + 1))).toLowerCase();
    if (/^[a-z2-7]{10}$/.test(token)) {
      const [c] = await asWorker(deps.httpDb, {}, (tx) =>
        rows<{ workspace_id: string; organization_id: string; email_address_id: string | null }>(
          tx,
          sql`select workspace_id, organization_id, email_address_id from private.conversation_by_reply_token(${token})`,
        ),
      );
      if (c)
        return {
          workspaceId: c.workspace_id,
          organizationId: c.organization_id,
          emailAddressId: c.email_address_id,
          replyToken: token,
        };
    }
    const [a] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ email_address_id: string; workspace_id: string; organization_id: string }>(
        tx,
        sql`select email_address_id, workspace_id, organization_id
            from private.email_address_route(${`${base}@${deps.email.mailDomain}`})`,
      ),
    );
    if (a)
      return {
        workspaceId: a.workspace_id,
        organizationId: a.organization_id,
        emailAddressId: a.email_address_id,
        replyToken: null,
      };
  }
  return null;
}

/**
 * Mail to a business's own domain once it receives there (M19): the address's own lane, or the business's default
 * address when nobody has that name.
 */
async function routeReceiving(
  deps: HttpDeps,
  candidates: readonly PostmarkParty[],
): Promise<InboundRoute | null> {
  const tried = new Set<string>();
  for (const r of candidates) {
    const email = (r.Email ?? '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1) continue;
    const domain = email.slice(at + 1);
    if (domain === deps.email.mailDomain) continue;
    const local = email.slice(0, at);
    const plus = local.indexOf('+');
    // chris+invoices@ is chris@: no address has a + in it.
    const address = `${plus === -1 ? local : local.slice(0, plus)}@${domain}`;
    if (tried.has(address)) continue;
    tried.add(address);
    const [a] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ email_address_id: string; workspace_id: string; organization_id: string }>(
        tx,
        sql`select email_address_id, workspace_id, organization_id
            from private.email_receiving_route(${address})`,
      ),
    );
    if (a)
      return {
        workspaceId: a.workspace_id,
        organizationId: a.organization_id,
        emailAddressId: a.email_address_id,
        replyToken: null,
      };
  }
  return null;
}

/**
 * Mail to HandsFreeOS's own support address (M13). It is checked before the businesses' routing and answered
 * separately. HandsFreeOS's own business may receive the rest of handsfreeos.com (M19), but never support@ or
 * help@: those are always the support desk's.
 */
function routeSupport(
  deps: HttpDeps,
  recipients: readonly PostmarkParty[],
): { replyToken: string | null } | null {
  for (const r of recipients) {
    const email = (r.Email ?? '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1 || email.slice(at + 1) !== deps.support.mailDomain) continue;
    const local = email.slice(0, at);
    const plus = local.indexOf('+');
    const base = plus === -1 ? local : local.slice(0, plus);
    if (!deps.support.addresses.includes(base)) continue;
    const token = (r.MailboxHash || (plus === -1 ? '' : local.slice(plus + 1))).toLowerCase();
    return { replyToken: /^[a-z2-7]{10}$/.test(token) ? token : null };
  }
  return null;
}

const safeName = (name: string) =>
  name
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .slice(0, 120) || 'attachment';

/** Support mail, stored whole with its attachments, then filed as a ticket by the delivery loop. */
async function recordSupportInbound(
  deps: HttpDeps,
  p: PostmarkInbound,
  replyToken: string | null,
): Promise<void> {
  const folder = createHash('sha256')
    .update(p.MessageID ?? '')
    .digest('hex')
    .slice(0, 24);
  const media: {
    bucket: string;
    objectPath: string;
    contentType: string;
    sizeBytes: number;
    name: string;
    contentId: string | null;
  }[] = [];
  for (const [i, a] of (p.Attachments ?? []).entries()) {
    if (!a.Content) continue;
    const data = Buffer.from(a.Content, 'base64');
    const name = safeName(a.Name ?? `attachment-${i + 1}`);
    const contentType = a.ContentType || 'application/octet-stream';
    const objectPath = `support/${folder}/${i}-${name}`;
    await deps.store.upload('telephony', objectPath, data, contentType, { upsert: true });
    media.push({
      bucket: 'telephony',
      objectPath,
      contentType,
      sizeBytes: data.length,
      name,
      contentId: a.ContentID ?? null,
    });
  }
  await recordDelivery(deps, {
    provider: 'postmark',
    kind: 'support.inbound',
    dedupeKey: `support:${p.MessageID}`,
    accountRef: null,
    url: '/webhooks/postmark/inbound',
    params: { ...p, Attachments: media, support: { replyToken } } as never,
    // Support mail belongs to no business, and that is exactly how it is stored.
    workspaceId: null,
    organizationId: null,
  });
}

/**
 * Postmark's inbound mail and delivery events. Both are stored and answered at once, then processed by the
 * webhook loop; inbound attachments go straight to storage so the stored webhook stays small.
 */
export function registerEmailRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/webhooks/postmark/inbound', { bodyLimit: INBOUND_BODY_LIMIT }, async (req, reply) => {
    if (!authorized(deps, req)) {
      deps.log.warn('rejected an inbound mail webhook without the right credentials');
      // A 403 tells Postmark to stop retrying.
      return reply.code(403).send();
    }
    const p = (req.body ?? {}) as PostmarkInbound;
    if (!p.MessageID) return reply.code(400).send();
    const recipients = [
      ...(p.ToFull ?? []),
      ...(p.CcFull ?? []),
      ...(p.BccFull ?? []),
      ...(p.OriginalRecipient ? [{ Email: p.OriginalRecipient }] : []),
    ];
    const support = routeSupport(deps, recipients);
    if (support) {
      await recordSupportInbound(deps, p, support.replyToken);
      return reply.code(200).send({ ok: true });
    }
    // The envelope first when it is on a business's receiving domain: each such domain has its own Postmark server
    // (M19), and the copy a server posts is for the address it was delivered to, whatever the headers say. Then a
    // reply token or a mail.handsfreeos.com address, then a receiving domain the headers name.
    const route =
      (await routeReceiving(deps, p.OriginalRecipient ? [{ Email: p.OriginalRecipient }] : [])) ??
      (await routeInbound(deps, recipients)) ??
      (await routeReceiving(deps, [
        ...(p.ToFull ?? []),
        ...(p.CcFull ?? []),
        ...(p.BccFull ?? []),
      ]));
    // Mail for an address nobody owns is accepted (so Postmark stops) and dropped.
    if (!route) return reply.code(200).send({ ok: true });
    const folder = createHash('sha256').update(p.MessageID).digest('hex').slice(0, 24);
    const media: {
      bucket: string;
      objectPath: string;
      contentType: string;
      sizeBytes: number;
      name: string;
      contentId: string | null;
    }[] = [];
    for (const [i, a] of (p.Attachments ?? []).entries()) {
      if (!a.Content) continue;
      const data = Buffer.from(a.Content, 'base64');
      const name = safeName(a.Name ?? `attachment-${i + 1}`);
      const contentType = a.ContentType || 'application/octet-stream';
      const objectPath = `${route.workspaceId}/email/${folder}/${i}-${name}`;
      await deps.store.upload('telephony', objectPath, data, contentType, { upsert: true });
      media.push({
        bucket: 'telephony',
        objectPath,
        contentType,
        sizeBytes: data.length,
        name,
        contentId: a.ContentID ?? null,
      });
    }
    await recordDelivery(deps, {
      provider: 'postmark',
      kind: 'email.inbound',
      dedupeKey: `inbound:${p.MessageID}`,
      accountRef: null,
      url: '/webhooks/postmark/inbound',
      params: {
        ...p,
        Attachments: media,
        route: { emailAddressId: route.emailAddressId, replyToken: route.replyToken },
      } as never,
      workspaceId: route.workspaceId,
      organizationId: route.organizationId,
    });
    return reply.code(200).send({ ok: true });
  });

  app.post('/webhooks/postmark/events', async (req, reply) => {
    if (!authorized(deps, req)) {
      deps.log.warn('rejected a mail event webhook without the right credentials');
      return reply.code(403).send();
    }
    const p = (req.body ?? {}) as {
      RecordType?: string;
      MessageID?: string;
      Email?: string;
      Recipient?: string;
      BouncedAt?: string;
      DeliveredAt?: string;
      Metadata?: Record<string, string>;
    };
    const workspaceId = p.Metadata?.['workspaceId'] ?? '';
    const organizationId = p.Metadata?.['organizationId'] ?? '';
    // Platform mail (invitations, alerts) carries no workspace: nothing to record.
    if (!p.RecordType || !p.MessageID || !UUID.test(workspaceId) || !UUID.test(organizationId))
      return reply.code(200).send({ ok: true });
    const trace = header(req, 'x-pm-webhook-trace-id');
    await recordDelivery(deps, {
      provider: 'postmark',
      kind: 'email.event',
      dedupeKey: trace
        ? `event:${trace}`
        : `event:${p.RecordType}:${p.MessageID}:${p.Email ?? p.Recipient ?? ''}:${p.BouncedAt ?? p.DeliveredAt ?? ''}`,
      accountRef: null,
      url: '/webhooks/postmark/events',
      params: p as never,
      workspaceId,
      organizationId,
    });
    return reply.code(200).send({ ok: true });
  });
}
