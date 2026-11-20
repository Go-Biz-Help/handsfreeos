/**
 * In your hands (messaging/hands.ts): the customers someone on the team has taken on, newest first, with whose hands
 * and how, and whether a message of theirs waits on a reply. Social Outreach's own list reads it too.
 */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { PersonInHandsInput, PersonInHandsOutput, type InHandsRow } from '../schemas/hands';

const iso = (d: Date | string) => new Date(d).toISOString();

export const personInHands = defineQuery({
  name: 'person.in_hands',
  description:
    'The customers in someone’s hands (they messaged or called them themselves, or pressed Take over), so the AI leaves them alone: whose hands, how, when, and whether one waits on a reply. Pass personId for one customer, mine for only yours.',
  input: PersonInHandsInput,
  output: PersonInHandsOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const where = sql`h.workspace_id = ${input.workspaceId}
      and p.merged_into_id is null and p.bin_item_id is null and p.erased_at is null
      ${input.personId ? sql`and h.person_id = ${input.personId}` : sql``}
      ${input.mine ? sql`and h.user_id = ${me}` : sql``}`;
    const list = await rows<{
      person_id: string;
      first_name: string;
      last_name: string;
      user_id: string | null;
      user_name: string | null;
      how: InHandsRow['how'];
      place: string | null;
      since: Date;
      last_at: Date;
      waiting_since: Date | null;
    }>(
      ctx.tx,
      sql`select h.person_id, p.first_name, p.last_name, h.user_id,
            coalesce(nullif(u.full_name, ''), u.email::text) as user_name, h.how, h.place, h.since, h.last_at,
            (select min(c.awaiting_reply_since) from app.conversations c
              where c.person_id = h.person_id and c.status = 'open') as waiting_since
          from app.people_in_hands h
          join app.people p on p.id = h.person_id
          left join app.users u on u.id = h.user_id
          where ${where}
          order by h.last_at desc, h.person_id
          limit ${input.limit}`,
    );
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.people_in_hands h join app.people p on p.id = h.person_id
          where ${where}`,
    );
    return {
      people: list.map((r) => ({
        personId: r.person_id,
        name: `${r.first_name} ${r.last_name}`.trim() || 'No name',
        user: r.user_id ? { id: r.user_id, fullName: r.user_name ?? 'Former teammate' } : null,
        how: r.how,
        place: r.place,
        since: iso(r.since),
        lastAt: iso(r.last_at),
        waitingSince: r.waiting_since ? iso(r.waiting_since) : null,
      })),
      total: count?.n ?? list.length,
    };
  },
});
