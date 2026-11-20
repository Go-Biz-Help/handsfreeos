/**
 * Referring people the person talked with on posts asking for a recommendation (docs/outreach.md, decision 174). Core
 * holds who may be referred, what the model is asked and what it may answer (packages/core/src/addons/outreach/
 * referrals.ts), and `outreach.referral.save` keeps what it found.
 *
 * - A post the check says asks for a recommendation (`outreach.post.checked` with `asks`) queues one look for it, once.
 * - The look takes the post's reader's people who wrote back at least twice and may be referred, the most recent talks
 *   first, and asks the AI to pick one or nobody; then the AI writes the comment naming them and the heads-up to them,
 *   from their playbook's words. A draft that names a group (decision 157) or leaves a blank is thrown out.
 * - What it found waits on Today for the person (9a), and their phone hears of it once (`outreach.referral.found`);
 *   under Autopilot on Facebook their computer does it with no OK, and no push (decision 185).
 * - No month between referrals of the same person, and no daily cap: referral comments count toward the day's comments
 *   (decision 185). The heads-up goes to the same person at most once a week; sooner, it's the comment alone.
 * - Once someone was referred twice (`outreach.referral.done`), the ask that they send people the person's way too is
 *   queued for three days on (`outreach.refer_ask`); it waits again while the chat isn't quiet, then the AI writes it
 *   from the playbook's Asking them back words (decision 185).
 */
import { referAskSave, referralSave } from '@hfos/core/addons/outreach/ops/referrals';
import { theirWorkFact, type Reach } from '@hfos/core/addons/outreach/local';
import { draftOfferOf } from '@hfos/core/addons/outreach/today';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { namesAGroup, withoutGroupLines } from '@hfos/core/addons/outreach/no-groups';
import {
  leftBlank,
  pickedOf,
  REFER_ASK_AFTER,
  REFER_ASK_QUIET_DAYS,
  REFER_ASK_SCHEMA,
  REFER_ASK_SYSTEM,
  REFER_CANDIDATES_MOST,
  REFER_NOTE_EVERY_DAYS,
  REFER_PICK_SCHEMA,
  REFER_PICK_SYSTEM,
  REFER_POST_DAYS,
  REFER_REPLIES,
  REFER_SAID_MOST,
  REFER_TEXT_MOST,
  REFER_WHY_MOST,
  REFER_WRITE_SCHEMA,
  REFER_WRITE_SYSTEM,
  referAskPrompt,
  ReferAskWritten,
  ReferPickAnswer,
  referPickPrompt,
  ReferWriteAnswer,
  referWritePrompt,
  withPostLink,
  type ReferCandidate,
} from '@hfos/core/addons/outreach/referrals';
import { refersOf, scriptOf, startingScript } from '@hfos/core/addons/outreach/script';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download-read';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { executeCommand, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import { callLinkFor, leadLinkFor } from './times';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const FIND_REFERRAL_JOB = 'outreach.find_referral';
export const REFER_ASK_JOB = 'outreach.refer_ask';
const TODAY_HREF = '/a/outreach?view=today';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Queues the one look for someone to refer on a post. */
export async function queueReferral(tx: Tx, ctx: AddonScopeContext, postId: string): Promise<void> {
  await scheduleAddonJob(
    tx,
    { id: ctx.manifest.id, generation: ctx.generation },
    {
      kind: FIND_REFERRAL_JOB,
      dedupeKey: `${FIND_REFERRAL_JOB}:${postId}`,
      runAt: new Date(),
      payload: { postId },
      workspaceId: ctx.scope.workspaceId,
      organizationId: ctx.scope.organizationId,
    },
  );
}

type PostRow = {
  id: string;
  user_id: string;
  body: string;
  asks: string | null;
  url: string;
  profile_id: string;
  group: string | null;
  platform: Platform;
  usable: boolean;
};

type CandidateRow = {
  id: string;
  name: string;
  intro: string[];
  about: string | null;
  work: string | null;
  area: string | null;
  reach: Reach | null;
  recent: DownloadMessage[] | null;
  playbook_id: string | null;
  /** They had a heads-up this week (decision 185). */
  noted_lately?: boolean;
};

/**
 * Someone the AI picks from, as it's told of them: what they do, where, and whom they serve (decision 177), so it sees
 * they work where the post asks; never a line that names a group (decision 157).
 */
function candidateOf(row: CandidateRow, groups: readonly string[]): ReferCandidate {
  const said = (row.recent ?? [])
    .filter((m) => !m.fromMe && m.text.trim())
    .slice(-REFER_SAID_MOST)
    .map((m) => m.text.replace(/\s+/g, ' ').trim().slice(0, 300));
  const work = theirWorkFact({
    work: row.work,
    area: row.area,
    reach: row.reach,
    miles: null,
    near: false,
  });
  return {
    name: row.name,
    facts: withoutGroupLines(
      [...(work ? [work] : []), ...row.intro, ...(row.about ? [row.about] : [])],
      groups,
    ),
    said: withoutGroupLines(said, groups),
  };
}

/** `outreach.find_referral`: picks someone to refer on a post, has the comment and the heads-up written, and keeps them. */
export async function findReferralJob(ctx: AddonJobContext): Promise<JobResult> {
  const postId = (ctx.job.payload as { postId?: string } | null)?.postId;
  if (!postId) return;
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [post] = await rows<PostRow>(
      tx,
      sql`select po.id, po.user_id, po.body, po.asks, po.url, po.profile_id, g.name as group, wp.platform,
            (po.skipped_at is null
              and po.seen_at >= now() - make_interval(days => ${REFER_POST_DAYS}::int)
              and not exists (select 1 from addon_outreach.referrals r where r.post_id = po.id)) as usable
          from addon_outreach.posts po
          join addon_outreach.profiles wp on wp.id = po.profile_id
          left join addon_outreach.groups g on g.id = po.group_id
          where po.workspace_id = ${ws} and po.id = ${postId}`,
    );
    if (!post?.asks || !post.usable) return null;
    // The reader's people who wrote back at least twice (7a), the most recent talks first: never the post's writer, the
    // person themselves, someone they marked not a fit, or on Don't pitch or Never contact. Referred lately or not
    // (decision 185): only the heads-up is kept to once a week.
    const candidates = await rows<CandidateRow>(
      tx,
      sql`select pr.id, pr.name, pr.intro, ck.about, pr.work, pr.area, pr.reach, fc.recent, ou.playbook_id,
            exists (select 1 from addon_outreach.referrals r
              where r.workspace_id = ${ws} and r.profile_id = pr.id and r.note is not null and r.state <> 'skipped'
                and r.created_at > now() - make_interval(days => ${REFER_NOTE_EVERY_DAYS}::int)) as noted_lately
          from addon_outreach.profiles pr
          join (select profile_id, max(seen_at) as last from addon_outreach.replies
                where workspace_id = ${ws} and user_id = ${post.user_id}
                group by profile_id having count(*) >= ${REFER_REPLIES}) rp on rp.profile_id = pr.id
          left join lateral (select c.about from addon_outreach.checks c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = ${post.user_id}
                order by c.checked_at desc nulls last limit 1) ck on true
          left join lateral (select c.recent from addon_outreach.file_chats c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = ${post.user_id}
                order by c.last_at desc limit 1) fc on true
          left join addon_outreach.opener_uses ou
            on ou.workspace_id = ${ws} and ou.user_id = ${post.user_id} and ou.profile_id = pr.id
          where pr.workspace_id = ${ws} and pr.id <> ${post.profile_id} and pr.friendship <> 'self'
            and not pr.dont_pitch and not pr.never_contact
            and not exists (select 1 from addon_outreach.stages st
              where st.profile_id = pr.id and st.user_id = ${post.user_id} and st.mark = 'lost'
                and st.marked_by = 'person')
          order by rp.last desc
          limit ${REFER_CANDIDATES_MOST}`,
    );
    const playbooks = await rows<{ id: string; details: unknown }>(
      tx,
      sql`select id, details from addon_outreach.playbooks where workspace_id = ${ws}`,
    );
    const [business] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    const [owner] = await rows<{ full_name: string | null }>(
      tx,
      sql`select full_name from app.users where id = ${post.user_id}`,
    );
    const groups = await rows<{ name: string }>(
      tx,
      sql`select name from addon_outreach.groups where workspace_id = ${ws} and name is not null`,
    );
    return { post, candidates, playbooks, business, owner, groups: groups.map((g) => g.name) };
  });
  if (!found) return;
  const { post } = found;
  const asks = post.asks!;
  const details = new Map(
    found.playbooks.flatMap((p) => {
      const d = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
      return d.success ? [[p.id, d.data] as const] : [];
    }),
  );
  // Only those whose playbook refers (decision 174): one with none, or one let go, does.
  const open = found.candidates.filter((c) => {
    const d = c.playbook_id ? details.get(c.playbook_id) : undefined;
    return refersOf(d ?? null);
  });
  if (!open.length) return;
  const groups = [...new Set([...found.groups, ...(post.group ? [post.group] : [])])];
  const people = open.map((c) => candidateOf(c, groups));

  const usage = { source: 'addon' as const, addonId: ctx.manifest.id };

  let saved: {
    profileId: string;
    why: string | null;
    comment: string;
    note: string | null;
  } | null = null;
  try {
    const { value: picked } = await askStructured(ctx, ctx.scope, {
      system: REFER_PICK_SYSTEM,
      messages: [
        { role: 'user', content: referPickPrompt({ post: post.body, asks, candidates: people }) },
      ],
      schema: REFER_PICK_SCHEMA,
      zod: ReferPickAnswer,
      maxTokens: 200,
      usage,
    });
    const at = pickedOf(
      picked,
      open.map((c, i) => ({ row: c, person: people[i]! })),
    );
    if (!at) return;
    const d = at.row.playbook_id ? details.get(at.row.playbook_id) : undefined;
    const says = d ? scriptOf(d) : startingScript('demo');
    const { value: written } = await askStructured(ctx, ctx.scope, {
      system: REFER_WRITE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: referWritePrompt({
            business: found.business?.name ?? 'the business',
            ownerName: found.owner?.full_name ?? null,
            post: post.body,
            asks,
            person: at.person,
            says: { comment: says.referComment, note: says.referNote },
          }),
        },
      ],
      schema: REFER_WRITE_SCHEMA,
      zod: ReferWriteAnswer,
      maxTokens: 600,
      usage,
    });
    const comment = written.comment.trim();
    const note = written.note.trim() ? withPostLink(written.note, post.url) : '';
    // Nothing kept that names a group (decision 157), leaves a blank, or runs too long.
    const bad = (t: string) =>
      !t || t.length > REFER_TEXT_MOST || leftBlank(t) || namesAGroup(t, groups);
    if (bad(comment) || bad(note)) return;
    saved = {
      profileId: at.row.id,
      why: picked.why.replace(/\s+/g, ' ').trim().slice(0, REFER_WHY_MOST) || null,
      comment,
      // A heads-up this week already: this time it's the comment alone (decision 185).
      note: at.row.noted_lately ? null : note,
    };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // The day's limit or an empty balance: it waits a few hours. Not set up, or an answer it can't use: no referral.
    if (e.code === 'budget_reached' || e.code === 'wallet_empty')
      return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
    if (e.retryable && ctx.attempt < 3) throw e;
    return;
  }
  await executeCommand(
    ctx.db,
    referralSave,
    { workspaceId: ws, postId: post.id, ...saved },
    ctx.actor,
    ctx.meta,
  );
}

/** `outreach.referral.found`: the person who read the post hears of it once, opening Today on its network. */
export async function referralFound(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { referralId?: string };
  if (!p.referralId) return;
  const referralId = p.referralId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [r] = await rows<{
      user_id: string;
      name: string;
      person_id: string | null;
      asks: string | null;
      platform: Platform;
    }>(
      tx,
      sql`select r.user_id, pr.name, pr.person_id, po.asks, wp.platform
          from addon_outreach.referrals r
          join addon_outreach.profiles pr on pr.id = r.profile_id
          join addon_outreach.posts po on po.id = r.post_id
          join addon_outreach.profiles wp on wp.id = po.profile_id
          where r.workspace_id = ${ctx.scope.workspaceId} and r.id = ${referralId} and r.state = 'waiting'`,
    );
    // One their computer does under Autopilot (decision 185) waits for nobody, so it pushes nothing.
    if (!r) return;
    await pushAddonNotice(ctx, tx, {
      key: `refer:${referralId}`,
      userIds: [r.user_id],
      permission: 'outreach.use',
      title: `You could refer ${r.name}`,
      body: r.asks
        ? `Someone is asking for ${r.asks}. Your comment and their heads-up are ready on Today.`
        : 'Someone is asking for what they do. Your comment and their heads-up are ready on Today.',
      href: r.platform === 'facebook' ? TODAY_HREF : `${TODAY_HREF}&net=${r.platform}`,
      collapseKey: `refer-${referralId}`,
      personId: r.person_id,
    });
  });
}

// ---- The ask after two (decision 185) ----

/**
 * `outreach.referral.done`: once the person referred someone twice (by hand or their computer), the ask that they send
 * people the person's way too is queued three days on, once, unless it was written already.
 */
export async function referralDone(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { profileId?: string; userId?: string };
  if (!p.profileId || !p.userId) return;
  const { profileId, userId } = p;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [n] = await rows<{ done: number; asked: boolean }>(
      tx,
      sql`select (select count(*)::int from addon_outreach.referrals r
              where r.workspace_id = ${ctx.scope.workspaceId} and r.user_id = ${userId}
                and r.profile_id = ${profileId} and r.state = 'done') as done,
            exists (select 1 from addon_outreach.refer_asks a
              where a.workspace_id = ${ctx.scope.workspaceId} and a.user_id = ${userId}
                and a.profile_id = ${profileId}) as asked`,
    );
    if (!n || n.asked || n.done < REFER_ASK_AFTER) return;
    await scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: REFER_ASK_JOB,
        dedupeKey: `${REFER_ASK_JOB}:${userId}:${profileId}`,
        runAt: new Date(Date.now() + REFER_ASK_QUIET_DAYS * DAY),
        payload: { userId, profileId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    );
  });
}

type AskRow = CandidateRow & {
  done: number;
  asked: boolean;
  /** When the chat last moved: their message or the person's, read or sent. */
  last_at: Date | string | null;
  asked_for: string[];
};

/**
 * `outreach.refer_ask`: the ask to someone referred twice, written once the chat has been quiet three days (the
 * owner's 3a): sooner, it looks again three days after the chat's last message. Never to someone on Don't pitch or
 * Never contact, marked not a fit, or asked before.
 */
export async function referAskJob(ctx: AddonJobContext): Promise<JobResult> {
  const p = (ctx.job.payload as { userId?: string; profileId?: string } | null) ?? {};
  if (!p.userId || !p.profileId) return;
  const { userId, profileId } = p;
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [person] = await rows<AskRow>(
      tx,
      sql`select pr.id, pr.name, pr.intro, ck.about, pr.work, pr.area, pr.reach, fc.recent, ou.playbook_id,
            (select count(*)::int from addon_outreach.referrals r
              where r.workspace_id = ${ws} and r.user_id = ${userId} and r.profile_id = pr.id
                and r.state = 'done') as done,
            exists (select 1 from addon_outreach.refer_asks a
              where a.workspace_id = ${ws} and a.user_id = ${userId} and a.profile_id = pr.id) as asked,
            greatest(
              (select max(c.last_at) from addon_outreach.file_chats c
                where c.workspace_id = ${ws} and c.user_id = ${userId} and c.profile_id = pr.id),
              (select max(t.at) from addon_outreach.touches t
                where t.workspace_id = ${ws} and t.user_id = ${userId} and t.profile_id = pr.id
                  and t.kind = 'message'),
              (select max(r.seen_at) from addon_outreach.replies r
                where r.workspace_id = ${ws} and r.user_id = ${userId} and r.profile_id = pr.id),
              (select max(r.noted_at) from addon_outreach.referrals r
                where r.workspace_id = ${ws} and r.user_id = ${userId} and r.profile_id = pr.id)
            ) as last_at,
            array(select po.asks from addon_outreach.referrals r
                join addon_outreach.posts po on po.id = r.post_id
              where r.workspace_id = ${ws} and r.user_id = ${userId} and r.profile_id = pr.id
                and r.state = 'done' and po.asks is not null
              order by r.done_at desc limit 3) as asked_for
          from addon_outreach.profiles pr
          left join lateral (select c.about from addon_outreach.checks c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = ${userId}
                order by c.checked_at desc nulls last limit 1) ck on true
          left join lateral (select c.recent from addon_outreach.file_chats c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = ${userId}
                order by c.last_at desc limit 1) fc on true
          left join addon_outreach.opener_uses ou
            on ou.workspace_id = ${ws} and ou.user_id = ${userId} and ou.profile_id = pr.id
          where pr.workspace_id = ${ws} and pr.id = ${profileId}
            and not pr.dont_pitch and not pr.never_contact
            and not exists (select 1 from addon_outreach.stages st
              where st.profile_id = pr.id and st.user_id = ${userId} and st.mark = 'lost'
                and st.marked_by = 'person')`,
    );
    if (!person || person.asked || person.done < REFER_ASK_AFTER) return null;
    const playbooks = person.playbook_id
      ? await rows<{ details: unknown }>(
          tx,
          sql`select details from addon_outreach.playbooks
              where workspace_id = ${ws} and id = ${person.playbook_id}`,
        )
      : [];
    const [business] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    const [owner] = await rows<{ full_name: string | null }>(
      tx,
      sql`select full_name from app.users where id = ${userId}`,
    );
    const [offer] = await rows<{ version: number; parts: unknown }>(
      tx,
      sql`select v.version, v.parts from app.main_offer_versions v
          join app.main_offers o on o.workspace_id = v.workspace_id and o.live_version = v.version
          where v.workspace_id = ${ws}`,
    );
    const groups = await rows<{ name: string }>(
      tx,
      sql`select name from addon_outreach.groups where workspace_id = ${ws} and name is not null`,
    );
    return {
      person,
      details: playbooks[0]?.details ?? null,
      business,
      owner,
      offer,
      groups: groups.map((g) => g.name),
    };
  });
  if (!found) return;
  const { person } = found;
  // Not quiet three days yet: it looks again three days after the chat's last message.
  const last = person.last_at ? new Date(person.last_at).getTime() : 0;
  const quietFrom = last + REFER_ASK_QUIET_DAYS * DAY;
  if (quietFrom > ctx.now) return { rescheduleAt: new Date(quietFrom + HOUR) };
  const parsed = found.details
    ? PlaybookDetails.safeParse(upgradePlaybookDetails(found.details))
    : null;
  const details = parsed?.success ? parsed.data : null;
  // A playbook with Refer them on posts turned off since: no ask either.
  if (details && !refersOf(details)) return;
  const says = details ? scriptOf(details) : startingScript('demo');
  const parts = found.offer ? MainOfferParts.safeParse(found.offer.parts) : null;
  const offer =
    found.offer && parts?.success ? draftOfferOf(found.offer.version, parts.data) : null;
  const calendarLink = await callLinkFor(
    ctx,
    userId,
    await leadLinkFor(ctx, userId, details?.link),
  );
  const groups = found.groups;
  const usage = { source: 'addon' as const, addonId: ctx.manifest.id };
  let text: string;
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: REFER_ASK_SYSTEM,
      messages: [
        {
          role: 'user',
          content: referAskPrompt({
            business: found.business?.name ?? 'the business',
            ownerName: found.owner?.full_name ?? null,
            person: candidateOf(person, groups),
            asked: person.asked_for,
            offer: [offer?.line, offer?.outcome].filter((l): l is string => !!l),
            calendarLink,
            says: says.referAsk,
          }),
        },
      ],
      schema: REFER_ASK_SCHEMA,
      zod: ReferAskWritten,
      maxTokens: 400,
      usage,
    });
    text = value.text.trim();
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.code === 'budget_reached' || e.code === 'wallet_empty')
      return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
    if (e.retryable && ctx.attempt < 3) throw e;
    return;
  }
  // Nothing kept that names a group (decision 157), leaves a blank, or runs too long.
  if (!text || text.length > REFER_TEXT_MOST || leftBlank(text) || namesAGroup(text, groups))
    return;
  await executeCommand(
    ctx.db,
    referAskSave,
    { workspaceId: ws, userId, profileId, text },
    ctx.actor,
    ctx.meta,
  );
}

/** `outreach.refer_ask.found`: one waiting for the person is pushed to them once, opening Today on its network. */
export async function referAskFound(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { askId?: string };
  if (!p.askId) return;
  const askId = p.askId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [a] = await rows<{
      user_id: string;
      name: string;
      person_id: string | null;
      platform: Platform;
    }>(
      tx,
      sql`select a.user_id, pr.name, pr.person_id, pr.platform
          from addon_outreach.refer_asks a
          join addon_outreach.profiles pr on pr.id = a.profile_id
          where a.workspace_id = ${ctx.scope.workspaceId} and a.id = ${askId} and a.state = 'waiting'`,
    );
    if (!a) return;
    await pushAddonNotice(ctx, tx, {
      key: `refer-ask:${askId}`,
      userIds: [a.user_id],
      permission: 'outreach.use',
      title: `Ask ${a.name} to send people your way`,
      body: 'You’ve referred them twice. A short note asking them back is ready on Today.',
      href: a.platform === 'facebook' ? TODAY_HREF : `${TODAY_HREF}&net=${a.platform}`,
      collapseKey: `refer-ask-${askId}`,
      personId: a.person_id,
    });
  });
}
