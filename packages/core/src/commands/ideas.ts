/**
 * Ideas, the roadmap and What's new (0102). What the people who use HandsFreeOS do on the board — share an idea,
 * fix its words, vote, follow it, comment — and what the team does with it: move it along the roadmap, merge a
 * duplicate, take down spam, keep the list of areas, and write What's new.
 *
 * The board is nobody's business data. A person's commands are their own (`account` scope), and the database
 * decides who takes part and what they may touch (0102's policies and guards), so the same rules hold whatever
 * calls them. The team's commands are `platform` scope, like the support desk's.
 *
 * Nothing here sends an email. A move along the roadmap is written down with what the team said, and the worker
 * tells the people following the idea — so a slow mail server never holds up the person pressing the button.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { ideas, whatsNew } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { OPEN_IDEA_STATUSES, type IdeaStatus } from '../ideas/words';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  IdeaAreaSaveInput,
  IdeaAreaSaveOutput,
  IdeaCommentHiddenInput,
  IdeaCommentHiddenOutput,
  IdeaCommentInput,
  IdeaCommentOutput,
  IdeaEditInput,
  IdeaFollowInput,
  IdeaFollowOutput,
  IdeaMergeInput,
  IdeaMergeOutput,
  IdeaSetHiddenInput,
  IdeaSetHiddenOutput,
  IdeaSetStatusInput,
  IdeaSetStatusOutput,
  IdeaShareInput,
  IdeaShareOutput,
  IdeaVoteInput,
  IdeaVoteOutput,
  IdeaWriteOutput,
  WhatsNewPublishInput,
  WhatsNewPublishOutput,
  WhatsNewRefInput,
  WhatsNewRefOutput,
  WhatsNewSaveInput,
  WhatsNewSaveOutput,
  WhatsNewSeenInput,
  WhatsNewSeenOutput,
} from '../schemas/ideas';

const onAccount = () => ({ kind: 'account' as const });
const onPlatform = () => ({ kind: 'platform' as const });

interface IdeaRow {
  id: string;
  number: number;
  title: string;
  body: string;
  areaId: string;
  status: IdeaStatus;
  authorUserId: string | null;
  mergedInto: string | null;
  hiddenAt: Date | null;
}

/** Somebody who works in a business here, or here: the same question every policy on the board asks. */
async function assertTakesPart(ctx: CommandContext): Promise<void> {
  const [row] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.takes_part_in_ideas() as ok`,
  );
  if (!row?.ok)
    throw HfosError.forbidden(
      'Ideas are for the people who run a business on HandsFreeOS. Set up your business first.',
      'ideas_closed',
    );
}

/** Whether the signed-in person holds a staff permission. Asked of the database, which is what enforces it. */
async function staffCan(ctx: CommandContext, permission: string): Promise<boolean> {
  const [row] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.staff_can(${permission}) as ok`,
  );
  return row?.ok === true;
}

/** The idea, or a plain "no such thing": one nobody here may see does not exist for them. */
async function ideaOr404(ctx: CommandContext, ideaId: string): Promise<IdeaRow> {
  const [row] = await ctx.tx
    .select({
      id: ideas.id,
      number: ideas.number,
      title: ideas.title,
      body: ideas.body,
      areaId: ideas.areaId,
      status: ideas.status,
      authorUserId: ideas.authorUserId,
      mergedInto: ideas.mergedInto,
      hiddenAt: ideas.hiddenAt,
    })
    .from(ideas)
    .where(eq(ideas.id, ideaId));
  if (!row) throw HfosError.notFound('No idea with that id.');
  return row;
}

/** Where a duplicate went, in words: "#12". */
async function mergedWords(ctx: CommandContext, idea: IdeaRow): Promise<string> {
  if (!idea.mergedInto) return 'another idea';
  const [into] = await ctx.tx
    .select({ number: ideas.number })
    .from(ideas)
    .where(eq(ideas.id, idea.mergedInto));
  return into ? `#${into.number}` : 'another idea';
}

/** An area that still takes new ideas. */
async function assertAreaOpen(ctx: CommandContext, areaId: string): Promise<void> {
  const [row] = await rows<{ archived: boolean }>(
    ctx.tx,
    sql`select archived_at is not null as archived from platform.idea_areas where id = ${areaId}`,
  );
  if (!row || row.archived)
    throw HfosError.validation([
      { path: 'areaId', message: 'Pick what it is about from the list.' },
    ]);
}

/** The business a person shares or votes from: one they really work in, or none at all. */
async function assertWorksIn(ctx: CommandContext, workspaceId: string | undefined): Promise<void> {
  if (!workspaceId) return;
  const [row] = await rows<{ role: string | null }>(
    ctx.tx,
    sql`select private.effective_workspace_role(${workspaceId})::text as role`,
  );
  if (!row?.role) throw HfosError.notFound('Workspace not found.');
}

/**
 * A line in an idea's story, column by column: a person's grant on idea_updates names these and nothing else,
 * and the policy wants it in their own name.
 */
async function recordUpdate(
  ctx: CommandContext,
  u: {
    ideaId: string;
    kind: 'status' | 'merged' | 'merged_in';
    fromStatus?: IdeaStatus;
    toStatus?: IdeaStatus;
    note?: string;
    otherIdeaId?: string;
    whatsNewId?: string;
    notify: boolean;
  },
): Promise<string> {
  const me = requireHuman(ctx).userId;
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into platform.idea_updates
          (idea_id, kind, from_status, to_status, note, other_idea_id, whats_new_id, notify, actor_user_id)
        values (${u.ideaId}, ${u.kind}::platform.idea_update_kind, ${u.fromStatus ?? null}::platform.idea_status,
          ${u.toStatus ?? null}::platform.idea_status, ${u.note ?? ''}, ${u.otherIdeaId ?? null}::uuid,
          ${u.whatsNewId ?? null}::uuid, ${u.notify}, ${me})
        returning id`,
  );
  if (!row) throw HfosError.forbidden();
  return row.id;
}

async function voteCountOf(ctx: CommandContext, ideaId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ voteCount: ideas.voteCount })
    .from(ideas)
    .where(eq(ideas.id, ideaId));
  return row?.voteCount ?? 0;
}

// ---------- taking part ----------

export const ideaShare = defineCommand({
  name: 'idea.share',
  description:
    'Share an idea for HandsFreeOS. It starts under review with your vote on it, and you hear when it moves.',
  risk: 1,
  input: IdeaShareInput,
  output: IdeaShareOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_shared'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    await assertTakesPart(ctx);
    await assertAreaOpen(ctx, input.areaId);
    await assertWorksIn(ctx, input.workspaceId);
    // Column by column: a person's grant on ideas names these and nothing else. The author's vote and follow
    // are the database's (0102), so an idea never exists without them.
    const [row] = await rows<{ id: string; number: string }>(
      ctx.tx,
      sql`insert into platform.ideas (title, body, area_id, author_user_id, workspace_id)
          values (${input.title}, ${input.body}, ${input.areaId}, ${me}, ${input.workspaceId ?? null})
          returning id, number`,
    );
    if (!row) throw HfosError.forbidden();
    const number = Number(row.number);
    await ctx.emit({
      type: 'platform.idea_shared',
      entityType: 'idea',
      entityId: row.id,
      payload: { number, areaId: input.areaId },
      after: { title: input.title, areaId: input.areaId },
    });
    return { ideaId: row.id, number };
  },
});

export const ideaEdit = defineCommand({
  name: 'idea.edit',
  description:
    'Change an idea’s title, details or area: its author, until the team has answered it, or the team.',
  risk: 1,
  input: IdeaEditInput,
  output: IdeaWriteOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_edited'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const idea = await ideaOr404(ctx, input.ideaId);
    if (!(await staffCan(ctx, 'platform.ideas.moderate'))) {
      if (idea.authorUserId !== me)
        throw HfosError.forbidden(
          'Only the person who shared an idea, or the HandsFreeOS team, changes it.',
          'idea_protected',
        );
      if (idea.status !== 'under_review' || idea.mergedInto || idea.hiddenAt)
        throw HfosError.conflict(
          'The team has already answered this idea, so its words stay as they are. Add a comment instead.',
          'idea_answered',
        );
    }
    if (input.areaId !== idea.areaId) await assertAreaOpen(ctx, input.areaId);
    const changed = await ctx.tx
      .update(ideas)
      .set({ title: input.title, body: input.body, areaId: input.areaId })
      .where(eq(ideas.id, idea.id))
      .returning({ id: ideas.id });
    if (!changed.length) throw HfosError.forbidden();
    await ctx.emit({
      type: 'platform.idea_edited',
      entityType: 'idea',
      entityId: idea.id,
      payload: { number: idea.number },
      before: { title: idea.title, areaId: idea.areaId },
      after: { title: input.title, areaId: input.areaId },
    });
    return { ideaId: idea.id };
  },
});

export const ideaVote = defineCommand({
  name: 'idea.vote',
  description: 'Vote for an idea. You hear when it moves along the roadmap.',
  risk: 0,
  input: IdeaVoteInput,
  output: IdeaVoteOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_voted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    await assertTakesPart(ctx);
    const idea = await ideaOr404(ctx, input.ideaId);
    if (idea.hiddenAt) throw HfosError.notFound('No idea with that id.');
    if (idea.mergedInto)
      throw HfosError.conflict(
        `This idea was merged into ${await mergedWords(ctx, idea)}. Vote there instead.`,
        'idea_merged',
      );
    if (!OPEN_IDEA_STATUSES.includes(idea.status))
      throw HfosError.conflict('Voting on this idea has closed.', 'idea_voting_closed');
    await assertWorksIn(ctx, input.workspaceId);
    const cast = await rows<{ idea_id: string }>(
      ctx.tx,
      sql`insert into platform.idea_votes (idea_id, user_id, workspace_id)
          values (${idea.id}, ${me}, ${input.workspaceId ?? null})
          on conflict (idea_id, user_id) do nothing
          returning idea_id`,
    );
    // A second press is the same vote: nothing to record.
    if (cast.length)
      await ctx.emit({
        type: 'platform.idea_voted',
        entityType: 'idea',
        entityId: idea.id,
        payload: { number: idea.number },
      });
    return { ideaId: idea.id, voted: true, voteCount: await voteCountOf(ctx, idea.id) };
  },
});

export const ideaUnvote = defineCommand({
  name: 'idea.unvote',
  description: 'Take your vote back from an idea.',
  risk: 0,
  input: IdeaVoteInput,
  output: IdeaVoteOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_unvoted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const idea = await ideaOr404(ctx, input.ideaId);
    const taken = await rows<{ idea_id: string }>(
      ctx.tx,
      sql`delete from platform.idea_votes where idea_id = ${idea.id} and user_id = ${me}
          returning idea_id`,
    );
    if (taken.length)
      await ctx.emit({
        type: 'platform.idea_unvoted',
        entityType: 'idea',
        entityId: idea.id,
        payload: { number: idea.number },
      });
    return { ideaId: idea.id, voted: false, voteCount: await voteCountOf(ctx, idea.id) };
  },
});

export const ideaFollow = defineCommand({
  name: 'idea.follow',
  description:
    'Hear by email when an idea moves along the roadmap, or stop hearing about it. Sharing, voting and commenting follow an idea on their own.',
  risk: 0,
  input: IdeaFollowInput,
  output: IdeaFollowOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_followed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    await assertTakesPart(ctx);
    const idea = await ideaOr404(ctx, input.ideaId);
    await rows(
      ctx.tx,
      sql`insert into platform.idea_followers (idea_id, user_id, following)
          values (${idea.id}, ${me}, ${input.following})
          on conflict (idea_id, user_id) do update set following = excluded.following`,
    );
    await ctx.emit({
      type: 'platform.idea_followed',
      entityType: 'idea',
      entityId: idea.id,
      payload: { number: idea.number, following: input.following },
      after: { following: input.following },
    });
    return { ideaId: idea.id, following: input.following };
  },
});

export const ideaComment = defineCommand({
  name: 'idea.comment',
  description:
    'Comment on an idea. From the HandsFreeOS team, it is shown as the team’s answer and its author hears about it.',
  risk: 1,
  input: IdeaCommentInput,
  output: IdeaCommentOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_commented'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    await assertTakesPart(ctx);
    const idea = await ideaOr404(ctx, input.ideaId);
    if (idea.mergedInto)
      throw HfosError.conflict(
        `This idea was merged into ${await mergedWords(ctx, idea)}. Comment there instead.`,
        'idea_merged',
      );
    // Whether it is the team's answer is the database's to say, from who wrote it (0102).
    const [row] = await rows<{ id: string; from_team: boolean }>(
      ctx.tx,
      sql`insert into platform.idea_comments (idea_id, author_user_id, body)
          values (${idea.id}, ${me}, ${input.body})
          returning id, from_team`,
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'platform.idea_commented',
      entityType: 'idea',
      entityId: idea.id,
      payload: { number: idea.number, commentId: row.id, fromTeam: row.from_team },
    });
    return { commentId: row.id };
  },
});

export const ideaSetCommentHidden = defineCommand({
  name: 'idea.set_comment_hidden',
  description:
    'Take a comment down (your own, or any as the team), or put one back (the team only).',
  risk: 1,
  input: IdeaCommentHiddenInput,
  output: IdeaCommentHiddenOutput,
  permission: null,
  scope: onAccount,
  emits: ['platform.idea_comment_hidden'],
  async handler(ctx, input) {
    const [comment] = await rows<{ idea_id: string; hidden: boolean }>(
      ctx.tx,
      sql`select idea_id, hidden_at is not null as hidden from platform.idea_comments where id = ${input.commentId}`,
    );
    if (!comment) throw HfosError.notFound('No comment with that id.');
    if (comment.hidden === input.hidden)
      return { commentId: input.commentId, hidden: input.hidden };
    // Who may is the database's to say (private.guard_idea_comment): the author takes their own down, the team
    // takes any down and puts it back. The stamp is its clock and names whoever did it.
    const changed = await rows<{ id: string }>(
      ctx.tx,
      sql`update platform.idea_comments
          set hidden_at = ${input.hidden ? sql`now()` : sql`null`}
          where id = ${input.commentId}
          returning id`,
    );
    if (!changed.length)
      throw HfosError.forbidden(
        'Only the person who wrote a comment, or the HandsFreeOS team, takes it down.',
        'idea_comment_protected',
      );
    await ctx.emit({
      type: 'platform.idea_comment_hidden',
      entityType: 'idea',
      entityId: comment.idea_id,
      payload: { commentId: input.commentId, hidden: input.hidden },
      after: { hidden: input.hidden },
    });
    return { commentId: input.commentId, hidden: input.hidden };
  },
});

export const whatsNewMarkSeen = defineCommand({
  name: 'whats_new.mark_seen',
  description: 'Note that you have read What’s new, so nothing in it shows as new to you.',
  risk: 0,
  input: WhatsNewSeenInput,
  output: WhatsNewSeenOutput,
  permission: null,
  scope: onAccount,
  // Where somebody has read up to is theirs alone, and nothing else changes: no event.
  emits: [],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await rows<{ seen_at: Date | string }>(
      ctx.tx,
      sql`insert into platform.whats_new_reads (user_id, seen_at) values (${me}, now())
          on conflict (user_id) do update set seen_at = excluded.seen_at
          returning seen_at`,
    );
    return { seenAt: new Date(row?.seen_at ?? Date.now()).toISOString() };
  },
});

// ---------- the team ----------

export const ideaSetStatus = defineCommand({
  name: 'idea.set_status',
  description:
    'Move an idea along the roadmap, with a note for the people following it, who are emailed unless you say not to.',
  risk: 2,
  input: IdeaSetStatusInput,
  output: IdeaSetStatusOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.idea_status_changed'],
  async handler(ctx, input) {
    const idea = await ideaOr404(ctx, input.ideaId);
    if (idea.mergedInto)
      throw HfosError.conflict(
        `This idea was merged into ${await mergedWords(ctx, idea)}. Move that one instead.`,
        'idea_merged',
      );
    // The same status and nothing to say is no change at all. The same status with a note is an update the
    // followers hear about ("still planned, now for spring").
    if (idea.status === input.status && !input.note)
      return { ideaId: idea.id, status: idea.status, updateId: null };
    if (idea.status !== input.status)
      await ctx.tx.update(ideas).set({ status: input.status }).where(eq(ideas.id, idea.id));
    const updateId = await recordUpdate(ctx, {
      ideaId: idea.id,
      kind: 'status',
      fromStatus: idea.status,
      toStatus: input.status,
      note: input.note,
      notify: input.notify,
    });
    await ctx.emit({
      type: 'platform.idea_status_changed',
      entityType: 'idea',
      entityId: idea.id,
      payload: {
        number: idea.number,
        updateId,
        from: idea.status,
        to: input.status,
        notify: input.notify,
      },
      before: { status: idea.status },
      after: { status: input.status },
    });
    return { ideaId: idea.id, status: input.status, updateId };
  },
});

export const ideaMerge = defineCommand({
  name: 'idea.merge',
  description:
    'Fold a duplicate into the idea it repeats. Its votes and followers go with it, and its followers are told where.',
  risk: 2,
  input: IdeaMergeInput,
  output: IdeaMergeOutput,
  permission: 'platform.ideas.moderate',
  scope: onPlatform,
  emits: ['platform.idea_merged'],
  async handler(ctx, input) {
    const idea = await ideaOr404(ctx, input.ideaId);
    const into = await ideaOr404(ctx, input.intoIdeaId);
    const [moved] = await rows<{ moved_votes: number; moved_followers: number }>(
      ctx.tx,
      sql`select moved_votes, moved_followers from private.merge_idea(${idea.id}, ${into.id})`,
    );
    const updateId = await recordUpdate(ctx, {
      ideaId: idea.id,
      kind: 'merged',
      otherIdeaId: into.id,
      note: input.note,
      notify: input.notify,
    });
    // The idea it joined says so too, for the team reading its story later. Nobody is emailed about that half.
    await recordUpdate(ctx, {
      ideaId: into.id,
      kind: 'merged_in',
      otherIdeaId: idea.id,
      notify: false,
    });
    await ctx.emit({
      type: 'platform.idea_merged',
      entityType: 'idea',
      entityId: idea.id,
      payload: {
        number: idea.number,
        intoIdeaId: into.id,
        intoNumber: into.number,
        updateId,
        notify: input.notify,
        movedVotes: Number(moved?.moved_votes ?? 0),
      },
      after: { mergedInto: into.id },
    });
    return {
      ideaId: idea.id,
      intoIdeaId: into.id,
      movedVotes: Number(moved?.moved_votes ?? 0),
      movedFollowers: Number(moved?.moved_followers ?? 0),
    };
  },
});

export const ideaSetHidden = defineCommand({
  name: 'idea.set_hidden',
  description:
    'Take an idea off the board (spam, or not an idea at all), or put it back. Its author still sees it.',
  risk: 1,
  input: IdeaSetHiddenInput,
  output: IdeaSetHiddenOutput,
  permission: 'platform.ideas.moderate',
  scope: onPlatform,
  emits: ['platform.idea_hidden'],
  async handler(ctx, input) {
    const idea = await ideaOr404(ctx, input.ideaId);
    if (Boolean(idea.hiddenAt) === input.hidden) return { ideaId: idea.id, hidden: input.hidden };
    // The stamp and who did it are the database's (private.guard_idea).
    await rows(
      ctx.tx,
      sql`update platform.ideas set hidden_at = ${input.hidden ? sql`now()` : sql`null`}
          where id = ${idea.id}`,
    );
    await ctx.emit({
      type: 'platform.idea_hidden',
      entityType: 'idea',
      entityId: idea.id,
      payload: { number: idea.number, hidden: input.hidden },
      after: { hidden: input.hidden },
    });
    return { ideaId: idea.id, hidden: input.hidden };
  },
});

export const ideaAreaSave = defineCommand({
  name: 'idea_area.save',
  description:
    'Add a part of HandsFreeOS ideas can be about, rename one, reorder it, or archive it (its ideas keep it).',
  risk: 1,
  input: IdeaAreaSaveInput,
  output: IdeaAreaSaveOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.idea_area_saved'],
  async handler(ctx, input) {
    if (input.archived && input.id === 'other')
      throw HfosError.validation([
        { path: 'archived', message: '“Something else” is where every idea can go. It stays.' },
      ]);
    const [row] = await rows<{ created: boolean }>(
      ctx.tx,
      sql`insert into platform.idea_areas (id, name, description, sort, archived_at)
          values (${input.id}, ${input.name}, ${input.description}, ${input.sort},
            ${input.archived ? sql`now()` : sql`null`})
          on conflict (id) do update set
            name = excluded.name,
            description = excluded.description,
            sort = excluded.sort,
            archived_at = case when ${input.archived}
              then coalesce(platform.idea_areas.archived_at, now()) else null end
          returning (xmax = 0) as created`,
    );
    const created = row?.created === true;
    await ctx.emit({
      type: 'platform.idea_area_saved',
      entityType: 'idea_area',
      entityId: null,
      payload: { areaId: input.id, created },
      after: { name: input.name, archived: input.archived },
    });
    return { id: input.id, created };
  },
});

// ---------- What's new ----------

export const whatsNewSave = defineCommand({
  name: 'whats_new.save',
  description:
    'Write or change an entry in What’s new, and say which ideas it delivers. It stays a draft until published.',
  risk: 1,
  input: WhatsNewSaveInput,
  output: WhatsNewSaveOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.whats_new_saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    if (input.areaId) await assertAreaExists(ctx, input.areaId);
    const ideaIds = [...new Set(input.ideaIds)];
    if (ideaIds.length) {
      const found = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from platform.ideas where id in (${sql.join(
          ideaIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
      if (found.length !== ideaIds.length)
        throw HfosError.validation([{ path: 'ideaIds', message: 'One of those ideas is gone.' }]);
    }
    const values = {
      title: input.title,
      body: input.body,
      kind: input.kind,
      areaId: input.areaId,
    };
    let id = input.id;
    const created = !id;
    if (id) {
      const changed = await ctx.tx
        .update(whatsNew)
        .set(values)
        .where(eq(whatsNew.id, id))
        .returning({ id: whatsNew.id });
      if (!changed.length) throw HfosError.notFound('No What’s new entry with that id.');
    } else {
      const [row] = await ctx.tx
        .insert(whatsNew)
        .values({ ...values, authorUserId: me })
        .returning({ id: whatsNew.id });
      id = row!.id;
    }
    await rows(ctx.tx, sql`delete from platform.whats_new_ideas where whats_new_id = ${id}`);
    for (const ideaId of ideaIds)
      await rows(
        ctx.tx,
        sql`insert into platform.whats_new_ideas (whats_new_id, idea_id) values (${id}, ${ideaId})`,
      );
    await ctx.emit({
      type: 'platform.whats_new_saved',
      entityType: 'whats_new',
      entityId: id,
      payload: { created, ideaCount: ideaIds.length },
      after: { title: input.title, kind: input.kind },
    });
    return { id, created };
  },
});

async function assertAreaExists(ctx: CommandContext, areaId: string): Promise<void> {
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from platform.idea_areas where id = ${areaId}`,
  );
  if (!row)
    throw HfosError.validation([{ path: 'areaId', message: 'Pick an area from the list.' }]);
}

export const whatsNewPublish = defineCommand({
  name: 'whats_new.publish',
  description:
    'Publish an entry in What’s new. The ideas it delivers become Done, and the people following them are emailed.',
  risk: 2,
  input: WhatsNewPublishInput,
  output: WhatsNewPublishOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.whats_new_published', 'platform.idea_status_changed'],
  async handler(ctx, input) {
    const [entry] = await rows<{ id: string; title: string; published_at: Date | string | null }>(
      ctx.tx,
      sql`select id, title, published_at from platform.whats_new where id = ${input.id} for update`,
    );
    if (!entry) throw HfosError.notFound('No What’s new entry with that id.');
    // Pressing Publish twice publishes once.
    if (entry.published_at)
      return {
        id: entry.id,
        publishedAt: new Date(entry.published_at).toISOString(),
        ideasDone: 0,
      };
    const [published] = await rows<{ published_at: Date | string }>(
      ctx.tx,
      sql`update platform.whats_new set published_at = now() where id = ${entry.id} returning published_at`,
    );
    let ideasDone = 0;
    if (input.markIdeasDone) {
      const delivered = await rows<{ id: string; number: string; status: IdeaStatus }>(
        ctx.tx,
        sql`select i.id, i.number, i.status::text as status
            from platform.whats_new_ideas wi join platform.ideas i on i.id = wi.idea_id
            where wi.whats_new_id = ${entry.id} and i.merged_into is null and i.status <> 'done'
            order by i.number`,
      );
      for (const idea of delivered) {
        await ctx.tx.update(ideas).set({ status: 'done' }).where(eq(ideas.id, idea.id));
        const updateId = await recordUpdate(ctx, {
          ideaId: idea.id,
          kind: 'status',
          fromStatus: idea.status,
          toStatus: 'done',
          whatsNewId: entry.id,
          notify: true,
        });
        await ctx.emit({
          type: 'platform.idea_status_changed',
          entityType: 'idea',
          entityId: idea.id,
          payload: {
            number: Number(idea.number),
            updateId,
            from: idea.status,
            to: 'done',
            notify: true,
            whatsNewId: entry.id,
          },
          before: { status: idea.status },
          after: { status: 'done' },
        });
        ideasDone += 1;
      }
    }
    await ctx.emit({
      type: 'platform.whats_new_published',
      entityType: 'whats_new',
      entityId: entry.id,
      payload: { ideasDone },
      after: { published: true },
    });
    return {
      id: entry.id,
      publishedAt: new Date(published!.published_at).toISOString(),
      ideasDone,
    };
  },
});

export const whatsNewUnpublish = defineCommand({
  name: 'whats_new.unpublish',
  description:
    'Take an entry out of What’s new and back to a draft. Ideas it marked Done stay Done.',
  risk: 1,
  input: WhatsNewRefInput,
  output: WhatsNewRefOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.whats_new_unpublished'],
  async handler(ctx, input) {
    const changed = await ctx.tx
      .update(whatsNew)
      .set({ publishedAt: null })
      .where(eq(whatsNew.id, input.id))
      .returning({ id: whatsNew.id });
    if (!changed.length) throw HfosError.notFound('No What’s new entry with that id.');
    await ctx.emit({
      type: 'platform.whats_new_unpublished',
      entityType: 'whats_new',
      entityId: input.id,
      after: { published: false },
    });
    return { id: input.id };
  },
});

export const whatsNewDelete = defineCommand({
  name: 'whats_new.delete',
  description: 'Delete a draft in What’s new. A published entry is unpublished first.',
  risk: 2,
  input: WhatsNewRefInput,
  output: WhatsNewRefOutput,
  permission: 'platform.ideas.manage',
  scope: onPlatform,
  emits: ['platform.whats_new_deleted'],
  async handler(ctx, input) {
    const [entry] = await ctx.tx
      .select({ title: whatsNew.title, publishedAt: whatsNew.publishedAt })
      .from(whatsNew)
      .where(eq(whatsNew.id, input.id));
    if (!entry) throw HfosError.notFound('No What’s new entry with that id.');
    if (entry.publishedAt)
      throw HfosError.conflict(
        'This entry is published. Unpublish it first, so nobody loses it without meaning to.',
        'whats_new_published',
      );
    await ctx.tx.delete(whatsNew).where(eq(whatsNew.id, input.id));
    await ctx.emit({
      type: 'platform.whats_new_deleted',
      entityType: 'whats_new',
      entityId: input.id,
      before: { title: entry.title },
    });
    return { id: input.id };
  },
});

/** People's own: sharing, voting, following, commenting, and having read What's new. */
export const ideaCommands = [
  ideaShare,
  ideaEdit,
  ideaVote,
  ideaUnvote,
  ideaFollow,
  ideaComment,
  ideaSetCommentHidden,
  whatsNewMarkSeen,
  // The team's.
  ideaSetStatus,
  ideaMerge,
  ideaSetHidden,
  ideaAreaSave,
  whatsNewSave,
  whatsNewPublish,
  whatsNewUnpublish,
  whatsNewDelete,
] as const;
