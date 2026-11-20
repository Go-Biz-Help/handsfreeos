/**
 * Social Outreach's playbooks (docs/outreach.md): everyone using the add-on reads them, and owners and admins
 * (`outreach.manage`) write them. A playbook is archived rather than deleted, and can come back. The AI writes each
 * network's own words on a customers' playbook once (`outreach.playbook.words`, decision 92), never over the
 * person's.
 */
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { givenOnly } from '../loose';
import { outreachAddon } from '../manifest';
import {
  blankPlaybook,
  NEW_PLAYBOOK_WAYS,
  FIND_WORDS_PARTS,
  forPartners,
  Playbook as PlaybookOut,
  PlaybookDetails as PlaybookDetailsSchema,
  PLAYBOOK_GOAL_KEYS,
  type PlaybookChanges,
  followUpGapsFor,
  paceOf,
  PLAYBOOK_KEPT_KEYS,
  PlaybookArchiveInput,
  PlaybookListInput,
  PlaybookListOutput,
  PLAYBOOK_TEMPLATE_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookSaveInput,
  renumberQuestions,
  type PlaybookDetails,
  upgradePlaybookDetails,
  WORDS_PLATFORM_KEYS,
  type WordsPlatform,
} from '../playbooks';
import { hashtagOf } from '../posts';
import {
  chatOf,
  type FullScriptOut,
  LOCKED_RULES,
  type OpenWay,
  opensFor,
  type PlaybookChat,
  type PlaybookOpens,
  PlaybookScript,
  scriptOf,
  waysOf,
  withScriptChanges,
} from '../script';
import { playbooks } from '../tables';
import { cleanFindWords, PlaybookWordsInput, PlaybookWordsOutput, wordsDue } from '../topics';
import { inWorkspace, type Ctx } from './common';

const playbookOut = (p: typeof playbooks.$inferSelect): z.input<typeof PlaybookOut> => {
  // One saved before its questions had answers reads in today's shape (data version 2).
  const details = upgradePlaybookDetails(p.details) as z.input<typeof PlaybookDetails>;
  return {
    id: p.id,
    name: p.name,
    template: p.template,
    details,
    // Every part's words, its own or the starting ones (decision 164).
    says: saysOf(details),
    archivedAt: p.archivedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
};

/** A playbook's script in full, or nothing for details too old or odd to read a goal from. */
function saysOf(details: unknown): z.input<typeof FullScriptOut> | undefined {
  const d = (details ?? {}) as { goal?: unknown; script?: unknown };
  const goal = PLAYBOOK_GOAL_KEYS.find((g) => g === d.goal);
  if (!goal) return undefined;
  const script = PlaybookScript.safeParse(d.script ?? {});
  const says = scriptOf({ goal, script: script.success ? script.data : {} });
  return { ...says, first: [...says.first] };
}

async function loadPlaybook(ctx: Ctx, playbookId: string) {
  const [p] = await ctx.tx
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.id, playbookId), eq(playbooks.workspaceId, ctx.scope.workspaceId!)));
  if (!p)
    throw HfosError.notFound(
      'That playbook isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return p;
}

/** The networks whose words the AI has written, as saved (data version 8): the server's alone to change. */
export function wordsWrittenOf(stored: unknown): WordsPlatform[] {
  const was = (upgradePlaybookDetails(stored) ?? {}) as Record<string, unknown>;
  const written = Array.isArray(was['wordsWritten']) ? (was['wordsWritten'] as unknown[]) : [];
  return WORDS_PLATFORM_KEYS.filter((p) => written.includes(p));
}

/**
 * The parts data versions 3 to 8 added, as a save leaves them: one it leaves out keeps what's saved (or starts
 * empty), so a phone built before them never wipes them. The pace's follow-ups too. Which networks' words the AI has
 * written is never the save's to say: it keeps what's saved (`outreach.playbook.words` changes it).
 */
function keptParts(details: PlaybookDetails, stored: unknown): PlaybookDetails {
  const was = (upgradePlaybookDetails(stored) ?? {}) as Record<string, unknown>;
  const blank = blankPlaybook();
  const kept = Object.fromEntries(
    PLAYBOOK_KEPT_KEYS.filter((k) => details[k] === undefined).map((k) => [k, was[k] ?? blank[k]]),
  );
  const wasPace = paceOf(was['pace'] ?? blank.pace);
  const followUps = details.pace.followUps ?? wasPace.followUps;
  const pace = {
    messageAfterDays: details.pace.messageAfterDays,
    followUps,
    followUpGaps:
      details.pace.followUpGaps ??
      (wasPace.followUpGaps.length === followUps
        ? wasPace.followUpGaps
        : followUpGapsFor(followUps)),
  };
  // The ways it may start a chat (decision 183): a phone built before them sends only how it starts (`opens`), which
  // changes the one way a playbook saved with one of those has; one with other ways ticked keeps them.
  const wasWays = waysOf(was as { ways?: OpenWay[]; opens?: PlaybookOpens });
  const ways =
    details.ways ??
    (details.opens && wasWays.length === 1 && (wasWays[0] === 'pitch' || wasWays[0] === 'intro')
      ? [details.opens]
      : (kept['ways'] as OpenWay[] | undefined));
  return {
    ...details,
    ...kept,
    ...(ways?.length ? { ways: [...ways], opens: opensFor(ways) } : {}),
    wordsWritten: wordsWrittenOf(stored),
    pace: { ...pace, followUpGaps: [...pace.followUpGaps] },
  };
}

/**
 * A playbook's hashtags as people tag them (data version 8), each once: "#Austin Plumbing!" is austinplumbing. One
 * that makes no hashtag is refused, saying which.
 */
function cleanHashtags(details: PlaybookDetails): PlaybookDetails {
  if (!details.hashtags) return details;
  const tags: string[] = [];
  for (const line of details.hashtags) {
    const tag = hashtagOf(line);
    if (!tag)
      throw HfosError.rule(
        'outreach_playbook_hashtag',
        422,
        `“${line}” isn’t a hashtag anyone tags. Write a hashtag as people tag it, like austinroofing, under Hashtags on Instagram.`,
      );
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { ...details, hashtags: tags };
}

/** Two playbooks in use never share a name. */
async function namedOnce<T>(playbookName: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e, 'playbooks_name_idx'))
      throw HfosError.rule(
        'outreach_playbook_name_taken',
        409,
        `There’s already a playbook called “${playbookName}”. Give this one another name.`,
      );
    throw e;
  }
}

export const playbookList = defineAddonQuery(outreachAddon, {
  name: 'outreach.playbook.list',
  description:
    'The business’s playbooks for social outreach, the ones in use first, then any archived; one alone, or only those in use or archived; and the ready-made ones a new playbook can start from.',
  input: PlaybookListInput,
  output: PlaybookListOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_playbooks',
    description:
      'The business’s playbooks for social outreach (Social Outreach → Playbooks), each whole, the ones in use first, then any archived: one alone with playbookId (a long list reads better a playbook at a time), only those in use with archived false. Each one’s says is What it says in full: the words the AI writes every message from (first: the first message’s versions, for the Direct pitch way; intro: the introduction; valueFirst, trigger, compliment, opinion, socialProof, permission, sharedGround and problemCheck: how each other way to start a chat goes; details.ways are the ways ticked, and the AI picks one of them for each person; nudge, demoOffer, callOffer, sendPeople and callYes for the networking chat after a way that starts a chat, whose switches are details.networking and how it goes details.chat; referComment, referNote and referAsk, the comment naming someone the owner has talked with under a post asking for a recommendation, the heads-up to them, and the note to someone referred twice asking if they’d send people the owner’s way too, while details.refer is on; yes, question, later, no, followUp, checkIn and the rest), the business’s own where it changed them and the starting words where it didn’t. rules are the rules every message keeps whatever a playbook says. And the ready-made ones New playbook starts from (templates: CRM demos and the others, each with its line).',
    keywords: ['playbook', 'niche', 'who to reach', 'offer', 'playbook templates'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const rows = await ctx.tx
      .select()
      .from(playbooks)
      .where(
        and(
          eq(playbooks.workspaceId, ctx.scope.workspaceId!),
          input.playbookId ? eq(playbooks.id, input.playbookId) : undefined,
          input.archived === undefined
            ? undefined
            : input.archived
              ? isNotNull(playbooks.archivedAt)
              : isNull(playbooks.archivedAt),
        ),
      )
      .orderBy(asc(playbooks.createdAt));
    return {
      playbooks: [...rows.filter((p) => !p.archivedAt), ...rows.filter((p) => p.archivedAt)].map(
        playbookOut,
      ),
      templates: PLAYBOOK_TEMPLATE_KEYS.map((key) => ({
        key,
        name: PLAYBOOK_TEMPLATES[key].name,
        summary: PLAYBOOK_TEMPLATES[key].summary,
      })),
      rules: [...LOCKED_RULES],
    };
  },
});

/**
 * What a save holds: the whole playbook it was sent, or the parts it was sent put on what's saved (for a new one, on
 * its template, or a blank playbook), checked whole as the editor's are.
 */
function detailsToSave(
  input: z.output<typeof PlaybookSaveInput>,
  stored: unknown,
): z.output<typeof PlaybookDetailsSchema> {
  if (input.details) return input.details;
  // A new one starts with no way ticked to start a chat (decision 183): the changes give them.
  const base = input.playbookId
    ? upgradePlaybookDetails(stored)
    : {
        ...(input.template ? PLAYBOOK_TEMPLATES[input.template].details : blankPlaybook()),
        ways: [...NEW_PLAYBOOK_WAYS],
      };
  const changes = givenOnly(input.changes);
  const checked = PlaybookDetailsSchema.safeParse({
    ...(base as object),
    ...changes,
    // What it says changes a part at a time too (decision 164): the parts given, over the ones saved.
    ...(changes.script ? { script: scriptChanged(base, changes) } : {}),
    // So does How the chat goes (decision 180): the choices given, over the ones saved.
    ...(changes.chat
      ? {
          chat: { ...chatOf(base as { chat?: Partial<PlaybookChat> }), ...givenOnly(changes.chat) },
        }
      : {}),
  });
  if (checked.success) return checked.data;
  const issues = checked.error.issues.map((i) => ({
    path: ['details', ...i.path].map(String).join('.'),
    message: i.message,
  }));
  throw HfosError.validation(
    issues,
    issues[0]?.message ?? 'Some of that doesn’t fit a playbook. Check the parts and try again.',
  );
}

/**
 * A change to some parts of what a playbook says, on the ones saved, kept as only what differs from the starting
 * words for the goal it will have. Parts that don't read are left for the whole playbook's check to refuse.
 */
function scriptChanged(base: unknown, changes: Partial<PlaybookChanges>): unknown {
  const was = (base ?? {}) as { goal?: unknown; script?: unknown };
  const goal = PLAYBOOK_GOAL_KEYS.find((g) => g === (changes.goal ?? was.goal));
  const given = PlaybookScript.safeParse(changes.script);
  const saved = PlaybookScript.safeParse(was.script ?? {});
  if (!goal || !given.success) return changes.script;
  return withScriptChanges(goal, saved.success ? saved.data : {}, given.data);
}

export const playbookSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.save',
  description:
    'Write a playbook for social outreach, or change one: its name, goal and offer, who it’s for, where to look, the steps it takes, what it says (script: the words the AI writes every message from), how it sounds, the tags to use, and its short video (videoLink: a video or playlist link that someone who says yes gets before the booking link). The booking link (details.link) is a whole address: for one of the business’s own booking pages, use that calendar’s link exactly as the calendar settings give it, never one put together from a name. A save sends the whole playbook, or only the parts that change.',
  risk: 1,
  input: PlaybookSaveInput,
  output: PlaybookOut,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_save_playbook',
    what: (input) =>
      (input as PlaybookSaveInput).playbookId
        ? 'Change this outreach playbook'
        : 'Write a new outreach playbook',
    description:
      'Write a playbook for social outreach (Social Outreach → Playbooks), or change one: its name, goal and offer, who it’s for, where to look, the steps it takes (a step left out of steps is not done on the networks where no other playbook in use has it), what it says, how it sounds, the tags to use, and its short video (videoLink: a video or playlist link that someone who says yes gets before the booking link). What it says is script: the AI writes every message from these words. script.first is the first message, up to 3 versions that take turns, kept close to and fitted to each person; intro is the introduction that goes in its place when opens is intro; demoOffer, callOffer, sendPeople and callYes are the networking chat’s words after an introduction (offering a demo, offering a networking call, sending people their way, and the ask for a time once they say yes to a call), and nudge says how its one nudge goes; referComment is the comment naming someone the owner has talked with under a post asking for what they do, referNote the heads-up to them with the post’s link, and referAsk the note to someone referred twice, once the chat is quiet, asking if they’d send people the owner’s way too or have a quick call; yes is the message after they say yes; the rest say how a message goes (reconnect, question, later, no, followUp, checkIn, reminder, missed, comment, warmUp, postReply, groupReply, birthday, newJob). ways are the ways it may start a chat with someone new, at least one, and for each person the AI picks the one that fits best: pitch (Direct pitch: the first message’s question, then follow-ups), intro (Introduction: thanks for connecting, who they are and what they offer, and a question about them), valueFirst (a quick tip, or the free thing in usefulWhat; needs usefulWhat), trigger (something they just posted about, like a move or a new job), compliment (one real thing about their post or work, then a question), opinion (their quick take on what the owner is working on), socialProof (a real result for someone like them; needs proof), permission (asks to send a quick video; needs a video in the video library), sharedGround (something true they share: town, school, line of work or mutual friends, never a group) and problemCheck (a problem their page shows that the offer fixes). pitch, valueFirst, socialProof, permission and problemCheck ask about the offer, so a yes gets the ask for a time and quiet gets follow-ups; intro, trigger, compliment, opinion and sharedGround start a chat: a networking chat follows, one nudge if they stay quiet and a monthly check-in, and everyone who connects gets one while every playbook on that network starts chats only those ways. A new playbook starts with none ticked, so give ways when writing one. Each way has its own words in script, by the same name (intro and the eight others; pitch’s are script.first). opens is the old one-way choice (pitch or intro), kept for older phones: send ways instead. networking says what that chat may offer, each once: demo (a demo, after a quick answer, when they ask about the business), call (to wrap the chat up, a networking call with the link to the person’s own calendar) and sendPeople (in that same message, that the owner will mention them to anyone online looking for what they do in their area), each true or false, all true to start. chat says how that chat goes, following how keen they are: wrapAfter (1, 2 or 3: by which of their replies it offers the call; when they only answer the owner’s questions it wraps up then too, sooner when they go quiet, and when they ask the owner things back it keeps chatting and leads to the call; 2 to start), questions (rarely: only when the chat would stall; sometimes: every other reply at most; often: most replies; rarely to start), story (how often it shares a line of the business’s story: often, fits when it connects, or never; fits to start) and demoWhen (asked: a demo only when they ask about the business; problem: also when they name a problem it fixes; asked to start). refer says whether the playbook’s people may be referred on posts asking for a recommendation (true to start): the comment and the heads-up wait for the person’s OK on Today, except under Autopilot on Facebook, where the person’s computer posts them. Words in [square brackets] are filled in for each person: [first name], [their kind of business], [what your offer gets them], [what your offer is], [open times], [booking link], [calendar link], [your first name], [your business name], [a question about them], [what they do], [their area], [their name], [what they need], [post link]. Send only the parts of script that change: the rest stay, and a part never changed follows the starting words (outreach_playbooks gives every part’s words under says, and the rules no playbook changes under rules). Try a change with outreach_test_playbook before saving it. To change one, read it with outreach_playbooks (playbookId), then send its id, its name and only the parts that change in changes, by their names there: every part left out stays as it is. A new one can start from a ready-made one (template, from outreach_playbooks’ templates): it starts as that one, with changes laid over it. The booking link (link) is a whole address: for one of the business’s own booking pages, copy that calendar’s booking link from get_settings (area calendars) exactly, never one put together from a name.',
    autonomy: 'confirm',
    keywords: ['write a playbook', 'change a playbook', 'new playbook', 'start from a template'],
  },
  scope: inWorkspace,
  emits: ['outreach.playbook.saved'],
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    const at = changeMoment(ctx.meta);
    const was = input.playbookId ? await loadPlaybook(ctx, input.playbookId) : null;
    const given = detailsToSave(input, was?.details ?? null);
    // Its questions keep short names however often they come and go, and its hashtags are as people tag them.
    const details = cleanHashtags({
      ...given,
      questions: renumberQuestions(given.questions),
    });
    const saved = await namedOnce(input.name, async () => {
      if (was) {
        const [p] = await ctx.tx
          .update(playbooks)
          .set({
            name: input.name,
            details: keptParts(details, was.details),
            updatedBy: me,
            updatedAt: at,
          })
          .where(eq(playbooks.id, was.id))
          .returning();
        return p!;
      }
      const [p] = await ctx.tx
        .insert(playbooks)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          name: input.name,
          template: input.template ?? null,
          details: keptParts(details, null),
          createdBy: me,
          updatedBy: me,
        })
        .returning();
      return p!;
    });
    await ctx.emit({
      type: 'outreach.playbook.saved',
      entityType: 'outreach_playbook',
      entityId: saved.id,
      payload: { name: saved.name, created: !input.playbookId },
    });
    return playbookOut(saved);
  },
});

export const playbookArchive = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.archive',
  description: 'Put a playbook away, or bring an archived one back.',
  risk: 1,
  input: PlaybookArchiveInput,
  output: PlaybookOut,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_archive_playbook',
    autonomy: 'confirm',
    keywords: ['archive playbook', 'restore playbook'],
  },
  scope: inWorkspace,
  emits: ['outreach.playbook.archived'],
  async handler(ctx, input) {
    const was = await loadPlaybook(ctx, input.playbookId);
    if (Boolean(was.archivedAt) === input.archived) return playbookOut(was);
    const me = userIdOf(ctx.actor);
    const saved = await namedOnce(was.name, async () => {
      const [p] = await ctx.tx
        .update(playbooks)
        .set(
          input.archived
            ? { archivedAt: changeMoment(ctx.meta), archivedBy: me }
            : { archivedAt: null, archivedBy: null },
        )
        .where(
          and(eq(playbooks.id, was.id), input.archived ? isNull(playbooks.archivedAt) : undefined),
        )
        .returning();
      return p ?? was;
    });
    await ctx.emit({
      type: 'outreach.playbook.archived',
      entityType: 'outreach_playbook',
      entityId: saved.id,
      payload: { name: saved.name, archived: input.archived },
    });
    return playbookOut(saved);
  },
});

export const playbookWords = defineAddonCommand(outreachAddon, {
  name: 'outreach.playbook.words',
  description:
    'Worker: the AI’s words for each network a customers’ playbook runs on: hashtags to look at on Instagram, phrases to search LinkedIn’s posts with, and kinds of business to search for on Alignable, with whether the business works with these clients online. A list is filled only while it’s empty and the AI hasn’t written it before, so the person’s own words, and a list they emptied, stay as they are; works online only while nobody has said.',
  risk: 0,
  input: PlaybookWordsInput,
  output: PlaybookWordsOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  // Never `outreach.playbook.saved`: that is what asks for the words, so the AI's writing can't ask again.
  emits: ['outreach.playbook.words_written'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [was] = await ctx.tx
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.id, input.playbookId), eq(playbooks.workspaceId, ws)))
      .for('update');
    if (!was)
      throw HfosError.notFound(
        'That playbook isn’t there anymore. Refresh the page to see the ones there are.',
      );
    const read = PlaybookDetailsSchema.safeParse(upgradePlaybookDetails(was.details));
    // One that doesn't read as a playbook now is left for the person to save again.
    if (!read.success) return { written: [], worksOnline: null };
    const d = read.data;
    if (forPartners(d))
      throw HfosError.rule(
        'outreach_playbook_partner_words',
        409,
        `“${was.name}” is a partner playbook, so it has no hashtags, post searches or kinds of business of its own: its partner searches go with its words for groups.`,
      );
    const unchanged = { written: [], worksOnline: d.worksOnline ?? null };
    if (was.archivedAt) return unchanged;
    // Only a list still empty that the AI hasn't written, on a network the playbook runs on.
    const written: WordsPlatform[] = [];
    const lists: Partial<Record<(typeof FIND_WORDS_PARTS)[WordsPlatform], string[]>> = {};
    for (const platform of wordsDue(d).networks) {
      const part = FIND_WORDS_PARTS[platform];
      const lines = cleanFindWords(platform, input[part] ?? []);
      if (!lines.length) continue;
      lists[part] = lines;
      written.push(platform);
    }
    const online =
      (d.worksOnline ?? null) === null && input.worksOnline !== undefined
        ? input.worksOnline
        : null;
    if (!written.length && online === null) return unchanged;
    const details: PlaybookDetails = {
      ...d,
      ...lists,
      worksOnline: online ?? d.worksOnline ?? null,
      wordsWritten: WORDS_PLATFORM_KEYS.filter(
        (p) => (d.wordsWritten ?? []).includes(p) || written.includes(p),
      ),
    };
    await ctx.tx
      .update(playbooks)
      .set({ details, updatedAt: changeMoment(ctx.meta) })
      .where(eq(playbooks.id, was.id));
    await ctx.emit({
      type: 'outreach.playbook.words_written',
      entityType: 'outreach_playbook',
      entityId: was.id,
      payload: { name: was.name, written, worksOnline: online },
    });
    return { written, worksOnline: details.worksOnline ?? null };
  },
});

export const playbookCommands = [playbookSave, playbookArchive, playbookWords] as const;
export const playbookQueries = [playbookList] as const;
