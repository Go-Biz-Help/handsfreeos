/**
 * What variety on the calendar reads (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decisions 34 to 37;
 * docs/socialcontent.md, "Variety"): the business's posts before, most recent first, with their kinds and topics, and
 * the ideas waiting. The plans themselves are pure, in core (packages/core/src/addons/socialcontent/variety.ts).
 */
import { isOfferList } from '@hfos/core/server';
import {
  VARIETY,
  type CreatorPost,
  type PostBefore,
  type Topic,
} from '@hfos/core/addons/socialcontent/variety';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AddonScopeContext } from '../types';

export interface PostSeen extends PostBefore {
  readonly title: string;
  readonly hook: string | null;
}

export const topicOf = (list: string | null, line: string | null): Topic | null =>
  isOfferList(list) && line ? { list, line } : null;

/**
 * The business's posts, most recently written first, with how each was shown (decision 39): the AI's drafts from
 * before the mix (no kind, untouched, decision 37) are left out, since they're about to be written again.
 */
export async function postsBefore(ctx: AddonScopeContext): Promise<PostSeen[]> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      title: string;
      hook: string | null;
      angle: string | null;
      topic_list: string | null;
      topic: string | null;
      fact: boolean;
      format: string;
      photo: boolean;
      network: string;
    }>(
      tx,
      sql`select r.name as title, c.hook, c.angle, c.topic_list, c.topic, (i.source_url is not null) as fact,
            c.format, (c.picture_way = 'photo') as photo, c.network
          from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          left join addon_socialcontent.ideas i on i.id = c.idea_id and i.workspace_id = c.workspace_id
          where c.workspace_id = ${ctx.scope.workspaceId}
            and not (c.made_by = 'ai' and c.state = 'draft' and c.angle is null and c.created_by is null)
          order by c.updated_at desc
          limit ${VARIETY.topicsRemembered}`,
    ),
  );
  return found.map((p) => ({
    title: p.title,
    hook: p.hook,
    angle: p.angle,
    topic: topicOf(p.topic_list, p.topic),
    fact: p.fact,
    format: p.format,
    photo: p.photo,
    network: p.network,
  }));
}

/** The ideas waiting (new or saved), newest first, as the plans see them before they're written. */
export async function ideasBefore(ctx: AddonScopeContext): Promise<PostBefore[]> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ angle: string | null; topic_list: string | null; topic: string | null }>(
      tx,
      sql`select angle, topic_list, topic from addon_socialcontent.ideas
          where workspace_id = ${ctx.scope.workspaceId} and state in ('new', 'saved')
          order by created_at desc
          limit ${VARIETY.topicsRemembered}`,
    ),
  );
  return found.map((i) => ({ angle: i.angle, topic: topicOf(i.topic_list, i.topic) }));
}

/** The studied creators' posts with words, standouts and the ones that did best first (pick 3a). */
export async function creatorPosts(ctx: AddonScopeContext): Promise<CreatorPost[]> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      caption: string;
      network: string;
      standout: boolean;
      times: number | string | null;
      why: string | null;
    }>(
      tx,
      sql`select p.caption, c.network, p.standout, p.engagement_times as times, p.notes ->> 'why' as why
          from addon_socialcontent.posts p
          join addon_socialcontent.creators c on c.id = p.creator_id
          where p.workspace_id = ${ctx.scope.workspaceId} and coalesce(p.caption, '') <> ''
          order by p.standout desc, p.engagement_times desc nulls last, p.posted_at desc
          limit 300`,
    ),
  );
  return found.map((p) => ({
    caption: p.caption,
    network: p.network,
    standout: p.standout,
    times: p.times === null ? null : Math.round(Number(p.times) * 10) / 10,
    why: p.why,
  }));
}

/** What a post is about, in words to match creators' posts on: its topic and its idea. */
export function aboutOf(
  topic: Topic | null,
  idea: { title: string; hook: string | null; outline: string | null } | null,
): string {
  return [topic?.line, idea?.title, idea?.hook, idea?.outline].filter(Boolean).join(' ');
}
