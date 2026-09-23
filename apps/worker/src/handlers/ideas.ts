/**
 * What the worker does about ideas (0100): it tells people.
 *
 * When the team moves an idea along the roadmap, ships it in What's new or folds it into another idea, everybody
 * following it gets one email. When the team answers an idea in its comments, whoever shared it gets one too.
 * These are HandsFreeOS's own events, with no business in scope, which is why the outbox lets `platform.*` events
 * through without one and why the people to tell are asked of `private.idea_followers_to_tell`: the worker can
 * read the board, but not app.users, while it holds no business.
 *
 * Retries tell nobody twice. Each email sent is written down at once, in its own transaction, before the next
 * one goes (platform.idea_update_deliveries, idea_comments.author_told_at), so a run that fails half way picks up
 * where it stopped.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { IdeaStatus } from '@hfos/core/server';
import { ideaTeamAnswerEmail, ideaUpdateEmail } from '../emails/templates';
import type { EventHandler, HandlerContext } from './types';

/** Where an email link lands: the web works out which business to open it in (app/app/ideas/[ideaId]). */
const ideaLink = (ctx: HandlerContext, ideaId: string) => `${ctx.webUrl}/app/ideas/${ideaId}`;

type UpdateRow = {
  id: string;
  kind: 'status' | 'merged' | 'merged_in';
  to_status: IdeaStatus | null;
  note: string;
  notify: boolean;
  notified_at: string | null;
  idea_id: string;
  number: string | number;
  title: string;
  author_user_id: string | null;
  other_number: string | number | null;
  other_title: string | null;
  whats_new_title: string | null;
  by: string | null;
};

/** Everybody following the idea an update is about, who has not been told about it yet. */
async function tellFollowers(ctx: HandlerContext, updateId: string): Promise<void> {
  const [update] = await asWorker(ctx.db, {}, (tx) =>
    rows<UpdateRow>(
      tx,
      sql`select d.id, d.kind::text as kind, d.to_status::text as to_status, d.note, d.notify, d.notified_at,
            i.id as idea_id, i.number, i.title, i.author_user_id,
            o.number as other_number, o.title as other_title,
            w.title as whats_new_title,
            nullif(btrim(s.display_name), '') as by
          from platform.idea_updates d
          join platform.ideas i on i.id = d.idea_id
          left join platform.ideas o on o.id = d.other_idea_id
          left join platform.whats_new w on w.id = d.whats_new_id
          left join platform.staff s on s.user_id = d.actor_user_id
          where d.id = ${updateId}`,
    ),
  );
  if (!update || !update.notify || update.notified_at || update.kind === 'merged_in') return;
  const change =
    update.kind === 'merged'
      ? {
          kind: 'merged' as const,
          intoNumber: Number(update.other_number ?? 0),
          intoTitle: update.other_title ?? '',
        }
      : {
          kind: 'status' as const,
          status: update.to_status ?? 'under_review',
          whatsNewTitle: update.whats_new_title,
        };
  const people = await asWorker(ctx.db, {}, (tx) =>
    rows<{ user_id: string; email: string; first_name: string }>(
      tx,
      sql`select user_id, email, first_name from private.idea_followers_to_tell(${updateId})`,
    ),
  );
  for (const person of people) {
    const email = ideaUpdateEmail({
      firstName: person.first_name,
      title: update.title,
      number: Number(update.number),
      yours: person.user_id === update.author_user_id,
      change,
      note: update.note,
      by: update.by ?? '',
      link: ideaLink(ctx, update.idea_id),
    });
    await ctx.mailer.send({ to: person.email, ...email });
    await asWorker(ctx.db, {}, (tx) =>
      rows(
        tx,
        sql`insert into platform.idea_update_deliveries (update_id, user_id)
            values (${updateId}, ${person.user_id}) on conflict do nothing`,
      ),
    );
  }
  await asWorker(ctx.db, {}, (tx) =>
    rows(tx, sql`update platform.idea_updates set notified_at = now() where id = ${updateId}`),
  );
  ctx.log.info({ updateId, told: people.length }, 'idea followers told');
}

/** The team moved an idea (or said something new about where it stands). */
export const onIdeaStatusChanged: EventHandler = async (ctx) => {
  const { updateId, notify } = ctx.event.payload as { updateId?: string; notify?: boolean };
  if (!updateId || notify === false) return;
  await tellFollowers(ctx, updateId);
};

/** A duplicate was folded into the idea it repeats: its followers hear where it went. */
export const onIdeaMerged: EventHandler = async (ctx) => {
  const { updateId, notify } = ctx.event.payload as { updateId?: string; notify?: boolean };
  if (!updateId || notify === false) return;
  await tellFollowers(ctx, updateId);
};

/** The team answered an idea in its comments: whoever shared it hears, unless they stopped following it. */
export const onIdeaCommented: EventHandler = async (ctx) => {
  const { commentId, fromTeam } = ctx.event.payload as { commentId?: string; fromTeam?: boolean };
  if (!commentId || !fromTeam) return;
  const [answer] = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      idea_id: string;
      number: string | number;
      title: string;
      body: string;
      author_user_id: string | null;
      commenter: string | null;
      told: boolean;
      hidden: boolean;
    }>(
      tx,
      sql`select i.id as idea_id, i.number, i.title, c.body, i.author_user_id,
            nullif(btrim(s.display_name), '') as commenter,
            c.author_told_at is not null as told, c.hidden_at is not null as hidden
          from platform.idea_comments c
          join platform.ideas i on i.id = c.idea_id
          left join platform.staff s on s.user_id = c.author_user_id
          where c.id = ${commentId} and c.author_user_id is distinct from i.author_user_id`,
    ),
  );
  if (!answer || answer.told || answer.hidden || !answer.author_user_id) return;
  // The same answer to the same question: whoever shared it, if they still follow it and still take part.
  const [person] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ email: string; first_name: string }>(
      tx,
      sql`select email, first_name from private.idea_author_to_tell(${answer.idea_id})`,
    ),
  );
  if (person) {
    const email = ideaTeamAnswerEmail({
      firstName: person.first_name,
      title: answer.title,
      number: Number(answer.number),
      by: answer.commenter ?? '',
      comment: answer.body,
      link: ideaLink(ctx, answer.idea_id),
    });
    await ctx.mailer.send({ to: person.email, ...email });
  }
  await asWorker(ctx.db, {}, (tx) =>
    rows(tx, sql`update platform.idea_comments set author_told_at = now() where id = ${commentId}`),
  );
};

export const ideaHandlers = {
  'platform.idea_status_changed': [onIdeaStatusChanged],
  'platform.idea_merged': [onIdeaMerged],
  'platform.idea_commented': [onIdeaCommented],
};
