/**
 * Which openers work (../openers.ts, docs/outreach.md decision 23): the opener a first message to someone was drafted
 * with, as the person copied it, and for each of a playbook's openers the first messages sent with it, who wrote back
 * and who booked a demo. Each person's own; owners and admins can see everyone's.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { ACTIVITY_PERIODS } from '../activity';
import { outreachAddon } from '../manifest';
import {
  openerKey,
  openersOf,
  OpenersInput,
  OpenersOutput,
  OpenerUseInput,
  OpenerUseOutput,
  type OpenerKind,
  type OpenerResult,
} from '../openers';
import { openerUses, playbooks, profiles } from '../tables';
import { periodStart } from './activity';
import { inWorkspace, seesEveryone } from './common';
import { playbooksInUse } from './friends';

/** A message noted this soon before the copy still counts as sent with it: the copy and the send race. */
const SENT_SLACK = "interval '5 minutes'";

export const openerUse = defineAddonCommand(outreachAddon, {
  name: 'outreach.opener.use',
  description:
    'The person copied a first message to someone: note which of the playbook’s openers it was drafted with, for the results card. Once a first message to them is noted, the opener stays the one it was.',
  risk: 0,
  input: OpenerUseInput,
  output: OpenerUseOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.opener.used'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    const [playbook] = await ctx.tx
      .select({ id: playbooks.id })
      .from(playbooks)
      .where(and(eq(playbooks.workspaceId, ws), eq(playbooks.id, input.opener.playbookId)));
    if (!profile || !playbook)
      throw HfosError.notFound('That person or playbook isn’t here anymore. Reload your list.');
    const [had] = await rows<{ sent: boolean }>(
      ctx.tx,
      sql`select exists (select 1 from addon_outreach.touches t
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.profile_id = ${profile.id}
              and t.kind = 'message' and t.at >= u.used_at - ${sql.raw(SENT_SLACK)}) as sent
          from addon_outreach.opener_uses u
          where u.workspace_id = ${ws} and u.user_id = ${me} and u.profile_id = ${profile.id}`,
    );
    if (had?.sent) return { noted: false };
    const use = {
      playbookId: playbook.id,
      kind: input.opener.kind,
      text: input.opener.text,
      usedAt: at,
    };
    await ctx.tx
      .insert(openerUses)
      .values({ workspaceId: ws, userId: me, profileId: profile.id, ...use })
      .onConflictDoUpdate({
        target: [openerUses.workspaceId, openerUses.userId, openerUses.profileId],
        set: use,
      });
    await ctx.emit({
      type: 'outreach.opener.used',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: { playbookId: playbook.id, kind: input.opener.kind },
    });
    return { noted: true };
  },
});

export const openers = defineAddonQuery(outreachAddon, {
  name: 'outreach.openers',
  description:
    'Which openers work: for each playbook in use, its AI styles and the business’s own openers, with the first messages sent with each, who wrote back and who booked a demo, ever or in the last week or month. Everyone’s for owners and admins.',
  input: OpenersInput,
  output: OpenersOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_openers',
    keywords: ['first messages', 'which opener works', 'reply rate'],
  },
  // The worker asks on a person's behalf for the weekly report (../results.ts).
  actors: ['human', 'system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has outreach of their own.');
    const ws = ctx.scope.workspaceId!;
    if (input.everyone && !(await seesEveryone(ctx, me)))
      throw HfosError.forbidden(
        'Only owners and admins can see how everyone’s openers did. Ask an owner of this business if you need them.',
        'outreach_openers_everyone',
      );
    const whose = input.everyone ? sql`true` : sql`u.user_id = ${me}`;
    const since =
      input.period === 'all'
        ? sql`true`
        : sql`u.used_at >= ${await periodStart(ctx, ACTIVITY_PERIODS[input.period].days)}::timestamptz`;
    const counted = await rows<{
      playbook_id: string;
      kind: OpenerKind;
      text: string;
      sent: number;
      replies: number;
      demos: number;
    }>(
      ctx.tx,
      sql`select playbook_id, kind, text,
            count(*) filter (where sent)::int as sent,
            count(*) filter (where sent and replied)::int as replies,
            count(*) filter (where sent and demo)::int as demos
          from (
            select u.playbook_id, u.kind, u.text,
              exists (select 1 from addon_outreach.touches t
                where t.workspace_id = u.workspace_id and t.user_id = u.user_id and t.profile_id = u.profile_id
                  and t.kind = 'message' and t.at >= u.used_at - ${sql.raw(SENT_SLACK)}) as sent,
              (exists (select 1 from addon_outreach.replies r
                 where r.workspace_id = u.workspace_id and r.user_id = u.user_id
                   and r.profile_id = u.profile_id and r.seen_at > u.used_at)
               or exists (select 1 from addon_outreach.file_chats c
                 where c.workspace_id = u.workspace_id and c.user_id = u.user_id
                   and c.profile_id = u.profile_id and not c.last_from_me and c.last_at > u.used_at)) as replied,
              exists (select 1 from addon_outreach.demos d
                where d.workspace_id = u.workspace_id and d.user_id = u.user_id and d.profile_id = u.profile_id
                  and d.undone_at is null and d.at >= u.used_at - ${sql.raw(SENT_SLACK)}) as demo
            from addon_outreach.opener_uses u
            where u.workspace_id = ${ws} and u.playbook_id is not null and ${whose} and ${since}
          ) uses
          group by playbook_id, kind, text`,
    );
    const inUse = (await playbooksInUse(ctx)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      everyone: input.everyone,
      playbooks: inUse.map((p) => {
        const byKey = new Map<string, OpenerResult>();
        for (const o of openersOf(p.details))
          byKey.set(openerKey(o), { ...o, current: true, sent: 0, replies: 0, demos: 0 });
        for (const c of counted.filter((x) => x.playbook_id === p.id)) {
          const key = openerKey(c);
          const had = byKey.get(key) ?? {
            kind: c.kind,
            text: c.text,
            current: false,
            sent: 0,
            replies: 0,
            demos: 0,
          };
          byKey.set(key, {
            ...had,
            sent: had.sent + c.sent,
            replies: had.replies + c.replies,
            demos: had.demos + c.demos,
          });
        }
        // The playbook's own first, in its order; ones taken out after, with numbers to show.
        const results = [...byKey.values()].filter((r) => r.current || r.sent > 0);
        return { playbookId: p.id, name: p.name, openers: results };
      }),
    };
  },
});

export const openerCommands = [openerUse] as const;
export const openerQueries = [openers] as const;
