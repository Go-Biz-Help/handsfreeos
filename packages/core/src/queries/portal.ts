/**
 * The customer's own look-ups in their portal (Real Estate round two, core). Each runs as `portal_actor`, so row
 * security alone decides what it reads: the customer, their business's name, and the records they're on.
 */
import { rows, sql } from '@hfos/db/client';
import { BUILT_ADDONS } from '../addons/catalog';
import { HfosError } from '../errors';
import { requireCustomer } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { PortalHomeInput, PortalHomeOutput } from '../schemas/portal';

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
    };
  },
});

export const portalQueries = [portalHome] as const;
