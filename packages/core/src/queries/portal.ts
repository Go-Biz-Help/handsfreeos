/**
 * The customer's own look-ups in their portal (Real Estate round two, core). Each runs as `portal_actor`, so row
 * security alone decides what it reads: the customer, their business's name, and the records they're on.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { BUILT_ADDONS } from '../addons/catalog';
import { HfosError } from '../errors';
import { requireCustomer } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  PortalDocumentsInput,
  PortalDocumentsOutput,
  PortalHomeInput,
  PortalHomeOutput,
} from '../schemas/portal';
import { isPortalPartner } from './partners';

/** The portal's first screen: whose business, who they are, and the add-ons that have pages for them. */
export const portalHome = defineQuery({
  name: 'portal.home',
  description:
    'A customer’s own portal: the business, their name, and the add-ons with pages about the records they’re on.',
  input: PortalHomeInput,
  output: PortalHomeOutput,
  permission: null,
  actors: ['customer'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx) {
    const me = requireCustomer(ctx);
    const [who] = await rows<{ business: string; first_name: string; last_name: string }>(
      ctx.tx,
      sql`select w.name as business, p.first_name, p.last_name
          from app.people p join app.workspaces w on w.id = p.workspace_id
          where p.id = ${me.personId}`,
    );
    if (!who)
      throw HfosError.notFound(
        'This portal isn’t there any more. Ask the business for a new link.',
      );
    const kinds = await rows<{ addon_id: string }>(
      ctx.tx,
      sql`select distinct k.addon_id from app.custom_records r
          join app.custom_record_types k on k.id = r.type_id
          where r.archived_at is null`,
    );
    const on = new Set(kinds.map((k) => k.addon_id));
    return {
      business: { name: who.business },
      person: { firstName: who.first_name, lastName: who.last_name },
      addons: BUILT_ADDONS.filter((m) => on.has(m.id) && (m.ui?.portal ?? []).length > 0).map(
        (m) => ({
          id: m.id,
          name: m.name,
          pages: (m.ui?.portal ?? [])
            .filter((p) => !p.path.includes(':'))
            .map((p) => ({ path: p.path, title: p.title })),
        }),
      ),
      partner: await isPortalPartner(ctx),
      documents: await documentCounts(ctx.tx),
    };
  },
});

type PortalDocumentRow = {
  signer_id: string;
  document_id: string;
  name: string;
  kind: 'signer' | 'copy';
  status: 'out' | 'completed' | 'declined' | 'expired';
  signer_status: 'waiting' | 'sent' | 'opened' | 'signed' | 'declined';
  your_turn: boolean;
  sent_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
  signed_copy: boolean;
};

/**
 * Their documents, newest first, under row security: their own place on each, and whether it's their turn (core's
 * `signersUp`: still to sign, at the lowest position of those who are, on a document still out and in time). Voided
 * ones aren't shown; one past its day reads as out of time before the sweep marks it.
 */
const portalDocumentRows = (tx: Tx) =>
  rows<PortalDocumentRow>(
    tx,
    sql`select s.id as signer_id, d.id as document_id, d.name, s.kind,
          case when d.status = 'out' and d.expires_at <= now() then 'expired' else d.status end as status,
          s.status as signer_status,
          (s.kind = 'signer' and s.status not in ('signed', 'declined') and d.status = 'out'
            and d.all_signed_at is null and d.expires_at > now()
            and s.position = (select min(o.position) from app.document_signers o
              where o.document_id = s.document_id and o.kind = 'signer' and o.status <> 'signed')) as your_turn,
          d.sent_at, d.expires_at, d.completed_at,
          (d.status = 'completed' and d.signed_file_id is not null) as signed_copy
        from app.document_signers s join app.documents d on d.id = s.document_id
        where s.id in (select portal.document_signer_ids())
        order by d.sent_at desc, s.id
        limit 100`,
  );

async function documentCounts(tx: Tx): Promise<{ total: number; toSign: number }> {
  const list = await portalDocumentRows(tx);
  return { total: list.length, toSign: list.filter((d) => d.your_turn).length };
}

const isoOf = (v: Date | string) => new Date(v).toISOString();

/** The documents a customer signs or gets a copy of, in their portal (answer 10b). */
export const portalDocuments = defineQuery({
  name: 'portal.documents',
  description:
    'The documents in a customer’s portal: those they sign or get a copy of, whose turn it is, and which are signed by everyone.',
  input: PortalDocumentsInput,
  output: PortalDocumentsOutput,
  permission: null,
  actors: ['customer'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx) {
    requireCustomer(ctx);
    const list = await portalDocumentRows(ctx.tx);
    return {
      documents: list.map((d) => ({
        signerId: d.signer_id,
        documentId: d.document_id,
        name: d.name,
        kind: d.kind,
        status: d.status,
        signerStatus: d.signer_status,
        yourTurn: d.your_turn,
        sentAt: isoOf(d.sent_at),
        expiresAt: isoOf(d.expires_at),
        completedAt: d.completed_at ? isoOf(d.completed_at) : null,
        signedCopy: d.signed_copy,
      })),
    };
  },
});

export const portalQueries = [portalHome, portalDocuments] as const;
