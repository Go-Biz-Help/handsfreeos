/**
 * What Real Estate's connections are used for (round five, step 10), for its Connections tab (boards 62, 63): when
 * one stops working, the business sees what it affects ("3 listings and 5 buyers' searches use it"), and that nothing
 * is marked done because of it. Core's `addon_connection.list` says how each connection is; this says what hangs on it.
 */
import { rows, sql } from '@hfos/db/client';
import { defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import { RealestateConnectionsUsesInput, RealestateConnectionsUsesOutput } from '../schemas';
import { inWorkspace } from './common';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 listings and 5 buyers’ searches use it" */
export function usesWords(parts: readonly string[]): string {
  const said = parts.filter(Boolean);
  if (!said.length) return 'Nothing uses it yet.';
  const list = said.length === 1 ? said[0]! : `${said.slice(0, -1).join(', ')} and ${said.at(-1)!}`;
  return `${list} ${said.length === 1 && /^1 /.test(said[0]!) ? 'uses' : 'use'} it.`;
}

export const connectionsUses = defineAddonQuery(realestateAddon, {
  name: 'realestate.connections.uses',
  description:
    'What the business’s Real Estate connections are used for: the open listings and buyers’ searches on the listing feed, the documents out for signing, and the ShowingTime emails read this month.',
  input: RealestateConnectionsUsesInput,
  output: RealestateConnectionsUsesOutput,
  permission: 'realestate.manage',
  ai: { tool: 'realestate_connections_uses' },
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [n] = await rows<{
      listings: number;
      searches: number;
      signing: number;
      showingtime: number;
      reading: boolean | null;
    }>(
      ctx.tx,
      sql`select
            (select count(*)::int from addon_realestate.deals d
              join app.custom_records r on r.id = d.record_id and r.archived_at is null
              where d.workspace_id = ${ws} and d.side = 'listing' and d.outcome is null) as listings,
            (select count(*)::int from addon_realestate.buyer_profiles p
              join addon_realestate.deals d on d.workspace_id = p.workspace_id and d.record_id = p.deal_record_id
              join app.custom_records r on r.id = d.record_id and r.archived_at is null
              where p.workspace_id = ${ws} and p.search_on and d.outcome is null) as searches,
            (select count(*)::int from addon_realestate.esign_envelopes e
              where e.workspace_id = ${ws} and e.state in ('preparing', 'draft', 'sent')) as signing,
            (select count(*)::int from addon_realestate.showings s
              where s.workspace_id = ${ws} and s.source = 'showingtime'
                and s.created_at >= date_trunc('month', now())) as showingtime,
            (select (settings ->> 'showingTimeEmails')::boolean from app.addon_installations
              where workspace_id = ${ws} and addon_id = 'realestate') as reading`,
    );
    const listings = n?.listings ?? 0;
    const searches = n?.searches ?? 0;
    const signing = n?.signing ?? 0;
    const read = n?.showingtime ?? 0;
    return {
      listingData: {
        listings,
        searches,
        words: usesWords([
          listings ? plural(listings, 'listing', 'listings') : '',
          searches ? plural(searches, 'buyer’s search', 'buyers’ searches') : '',
        ]),
      },
      esign: {
        out: signing,
        words: signing
          ? `${plural(signing, 'document is', 'documents are')} out for signing.`
          : 'Nothing is out for signing.',
      },
      showingTime: {
        on: n?.reading !== false,
        readThisMonth: read,
        words: `${read} read this month · each one waits for you to check it`,
      },
    };
  },
});

export const connectionQueries = [connectionsUses];
