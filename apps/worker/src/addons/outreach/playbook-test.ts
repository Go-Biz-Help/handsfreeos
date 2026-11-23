/**
 * A playbook's Test console (`outreach.playbook.test`; docs/outreach.md, decision 164;
 * packages/core/src/addons/outreach/playbook-test.ts): the message that would go to someone made up, one move at a
 * time. Each is written by the same writer as Today's drafts (./today.ts `writeDrafts`), from the playbook as it is on
 * the person's screen, saved or not, with the business's real main offer and lists for content, its Knowledge, the
 * open times on the playbook's booking page and its videos, in the person's own voice. So what it shows is what would
 * go out.
 *
 * **Try a comment** (decision 165) is the `comment` move: the comment that would wait under a post whose words are
 * handed in, a warm-up's or an expert's, written and checked as a real one (`writeDrafts` and core's `realComments`),
 * with About you as the person saved it. A post that gives it nothing real to say gets none, and says so.
 *
 * Nothing is sent, queued, booked or kept: no answer is noted, no opener is counted, no times are held. The console
 * keeps the chat and where it is, and sends them with each move. It counts against the business's daily AI limit
 * like any other use.
 */
import { messageNotesOf, ownWordsFor, type Answer } from '@hfos/core/addons/outreach/conversation';
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import { contactIn, isTimeKind, openTimeOf } from '@hfos/core/addons/outreach/meeting-times';
import { aboutOwnerFor } from '@hfos/core/addons/outreach/ops/about-owner';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { writingNoteFor } from '@hfos/core/addons/outreach/ops/comment-research';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import {
  checkedPlay,
  PlaybookTestInput,
  TEST_COMMENTS,
  TEST_PLAY_SCHEMA,
  TEST_PLAY_SYSTEM,
  TEST_READ,
  TEST_START,
  TEST_WORDS,
  testAnswered,
  testDeclined,
  testLabel,
  testMove,
  testNext,
  testPersonLines,
  TestPlayAnswer,
  testPlayPrompt,
  type PlaybookTestOutput,
  type TestKind,
  type TestMessage,
  type TestState,
} from '@hfos/core/addons/outreach/playbook-test';
import {
  paceOf,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { firstMessageChoices } from '@hfos/core/addons/outreach/openers';
import {
  firstMessagesOf,
  hasWays,
  networkingOf,
  startsAChat,
} from '@hfos/core/addons/outreach/script';
import {
  answerOf,
  tookOf,
  draftOfferOf,
  unansweredOf,
  wayOf,
  type DraftOffer,
  type WayChoice,
} from '@hfos/core/addons/outreach/today';
import { libraryOf, sentLinks, type DraftVideos } from '@hfos/core/addons/outreach/video-library';
import { HfosError, listsOf, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { businessKnows } from './knows';
import { callLinkFor, leadLinkFor, meetingFor, offeredWords } from './times';
import { draftRefusal, writeDrafts, type DraftBase } from './today';

export const PLAYBOOK_TEST_ACTION = 'outreach.playbook.test';

const DAY_MS = 86_400_000;

/** The test chat as a draft reads one: each message a minute apart, the last one `gapDays` ago. */
function recentOf(chat: readonly TestMessage[], now: number, gapDays: number): DownloadMessage[] {
  const last = now - gapDays * DAY_MS;
  return chat.map((m, i) => ({
    fromMe: m.fromMe,
    text: m.text,
    at: new Date(last - (chat.length - 1 - i) * 60_000).toISOString(),
  }));
}

export const playbookTest: AddonWorkerAction<PlaybookTestInput> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_test_playbook',
    description:
      'Test a Social Outreach playbook on someone made up, as the playbook’s Test it does: give a person (name, network, what they do, what their page says, how the owner knows them) and a move, and get the message that would go to them, what the AI read in their reply, and what happens next. Moves: start (the first message, or Reconnect for someone talked with a while ago), reply (with text: what they write back), quiet (the next follow-up or check-in), play (the AI writes their reply as interested, skeptical, busy or not_interested, then answers it). Pass back the chat so far and the state from the last move. Try a comment is the move comment: give post (what a post says, its caption) and comment (warm for a warm-up’s short reaction, expert for a take from the owner’s field), and get the comment that would wait for an OK under it, the post’s words it is about, or a note that there would be none; it uses About you as the person saved it. Give playbookId for a saved playbook, or details to test changes not saved yet. Nothing is sent, booked or saved.',
    autonomy: 'auto',
    keywords: [
      'test playbook',
      'test console',
      'what would it send',
      'try a first message',
      'how would the conversation go',
      'try a comment',
      'what would it comment',
    ],
  },
  input: PlaybookTestInput,
  async run(ctx, raw): Promise<PlaybookTestOutput> {
    const input = PlaybookTestInput.parse(raw);
    const ws = ctx.scope.workspaceId!;
    const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
      const [business] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ws}`,
      );
      // The live main offer and its lists for content: someone new is pitched with the live one.
      const [offer] = await rows<{ version: number; parts: unknown; lists: unknown }>(
        tx,
        sql`select v.version, v.parts, o.lists from app.main_offers o
            join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
            where o.workspace_id = ${ws}`,
      );
      const playbooks = await rows<{ id: string; name: string; details: unknown }>(
        tx,
        sql`select id, name, details from addon_outreach.playbooks
            where workspace_id = ${ws} and archived_at is null and ${FOR_CUSTOMERS} order by name`,
      );
      const [installed] = await rows<{ settings: unknown }>(
        tx,
        sql`select settings from app.addon_installations
            where workspace_id = ${ws} and addon_id = 'outreach'`,
      );
      const [said] = await rows<{ message_notes: unknown }>(
        tx,
        sql`select message_notes from addon_outreach.setup
            where workspace_id = ${ws} and user_id = ${ctx.userId}`,
      );
      return {
        business,
        offer: offer ?? null,
        playbooks,
        library: installed ? outreachSettings(installed.settings).videos : undefined,
        notes: messageNotesOf(said?.message_notes),
        voice: await voiceFor(tx, ws, ctx.userId),
        // How people write on the network picked, as a real message there is told (decision 191).
        writing: await writingNoteFor(tx, input.person.platform),
        // About you (decision 165), as their real messages are written with it.
        aboutOwner: await aboutOwnerFor(tx, ctx.userId),
        // Their own name, for an introduction (decision 168).
        ownerName:
          (
            await rows<{ full_name: string }>(
              tx,
              sql`select full_name from app.users where id = ${ctx.userId}`,
            )
          )[0]?.full_name?.trim() || null,
      };
    });
    // The playbook as it is on screen, else the saved one, else the first in use.
    const saved = input.playbookId
      ? found.playbooks.find((p) => p.id === input.playbookId)
      : input.details === undefined
        ? found.playbooks[0]
        : undefined;
    if (input.details === undefined && !saved)
      throw HfosError.notFound(
        input.playbookId
          ? 'That playbook isn’t there anymore. Open Social Outreach → Playbooks and pick one to test.'
          : 'There’s no playbook to test yet. Write one under Social Outreach → Playbooks first.',
      );
    const read = PlaybookDetails.safeParse(
      upgradePlaybookDetails(input.details !== undefined ? input.details : saved!.details),
    );
    if (!read.success)
      throw HfosError.rule(
        'outreach_playbook_test_unfinished',
        422,
        `This playbook isn’t ready to test yet: ${read.error.issues[0]?.message ?? 'a part of it is missing'} Fix it in the playbook, then press Test it again.`,
      );
    const details = read.data;
    const playbookName = input.name || saved?.name || 'Playbook';
    const pace = paceOf(details.pace);
    const { person } = input;
    const name = person.name;
    const lines = testPersonLines(person);
    const parts = found.offer ? MainOfferParts.safeParse(found.offer.parts) : null;
    const offer: DraftOffer | null =
      found.offer && parts?.success ? draftOfferOf(found.offer.version, parts.data) : null;
    // The business's videos (decision 154): its library, or this playbook's short video until it's saved.
    const library =
      found.library === undefined
        ? []
        : libraryOf(found.library, [{ name: playbookName, details }]);
    // The ways the first message may go (decision 183), as a real one picks from them: those with what they need, and
    // the pitch with the version picked here in place of the one whose turn it is.
    const pitches = firstMessagesOf(details).filter((f) => f.way === 'pitch');
    const version = pitches.length ? input.version % pitches.length : 0;
    const ways: WayChoice[] = firstMessageChoices(details, new Map(), {
      proof: !!details.proof?.length || !!offer?.proof.length,
      useful: !!details.usefulWhat?.trim(),
      video: library.length > 0 || !!details.videoLink,
    }).map((c) => ({
      way: c.way,
      text: c.way === 'pitch' ? (pitches[version]?.text ?? c.opener.text) : c.opener.text,
    }));

    const chat: TestMessage[] = [...input.chat];
    try {
      // Their side this move: typed, or written by the AI as the kind of person picked.
      let theirs: string | null = input.move === 'reply' ? input.text : null;
      if (input.move === 'play') {
        if (!chat.some((m) => m.fromMe))
          throw HfosError.rule(
            'outreach_playbook_test_not_started',
            409,
            'There’s no message of yours for them to answer yet. Press See the first message, then let the AI play them.',
          );
        const { value } = await askStructured(ctx, ctx.scope, {
          system: TEST_PLAY_SYSTEM,
          messages: [
            { role: 'user', content: testPlayPrompt({ person, persona: input.persona, chat }) },
          ],
          schema: TEST_PLAY_SCHEMA,
          zod: TestPlayAnswer,
          maxTokens: 300,
          usage: { source: 'addon', addonId: ctx.manifest.id },
        });
        theirs = checkedPlay(value);
        if (!theirs)
          throw HfosError.rule(
            'ai_failed',
            502,
            'The AI couldn’t write their reply just now. Try again, or type one yourself.',
          );
      }
      if (theirs) chat.push({ fromMe: false, text: theirs });

      const now = Date.now();
      // Everything a message for them is written from, as Today's drafts build it for someone real.
      const baseFor = async (o: {
        readonly state: TestState;
        readonly gapDays: number;
        readonly times: boolean;
      }): Promise<DraftBase> => {
        const recent = recentOf(chat, now, o.gapDays);
        const declined = testDeclined(o.state);
        const theirWords = chat.filter((m) => !m.fromMe).map((m) => m.text);
        const videos: DraftVideos | null = library.length
          ? {
              videos: library,
              sent: sentLinks(
                library,
                chat.filter((m) => m.fromMe).map((m) => m.text),
              ),
            }
          : null;
        // A demo books on their own Lead calendar first (decision 178), the playbook's link as the backup; after a yes
        // to a networking call (decision 173), on their Networking calendar or own calendar, not the demo page.
        const bookLink = await leadLinkFor(ctx, ctx.userId, details.link);
        const call = o.state.call && o.state.step === 'link';
        const onLink = call ? await callLinkFor(ctx, ctx.userId, bookLink) : bookLink;
        // The networking chat's wrap-up (decision 176): its call offer carries the person's own calendar.
        const wrapLink =
          o.state.step === 'intro' && networkingOf(details).call
            ? await callLinkFor(ctx, ctx.userId, bookLink)
            : null;
        const meeting =
          o.times && !declined
            ? await meetingFor(ctx, {
                link: onLink,
                userId: ctx.userId,
                lines: [...lines.facts, ...lines.lookup],
                country: null,
              }).catch((e: unknown) => {
                ctx.log.warn({ err: e }, 'outreach: open times for a playbook test failed');
                return null;
              })
            : null;
        return {
          platform: person.platform,
          told: {
            business: found.business?.name ?? 'the business',
            aboutOwner: found.aboutOwner,
            name,
            facts: lines.facts,
            lookup: lines.lookup,
            recent,
            playbook: { name: playbookName, ...details, link: onLink },
            offer,
            lists: listsOf(found.offer?.lists),
            conversation: o.state.step
              ? { step: o.state.step, sent: o.state.sent, followUps: pace.followUps, call }
              : null,
            callLink: wrapLink,
            post: null,
            opener: null,
            ways,
            // Their name for an introduction's [your first name], and whether they just connected (decision 168).
            ownerName: found.ownerName,
            fresh: person.known === 'new',
            voice: found.voice,
            writing: found.writing,
            lastAt: recent.at(-1)?.at ?? new Date(now - o.gapDays * DAY_MS),
            now,
            requests: false,
            knows: await businessKnows(ctx, theirWords.slice(-2)),
            declined,
            videos,
          },
          avoid: details.avoid,
          groupNames: [],
          meeting,
          contact: contactIn(theirWords),
          link: onLink,
          videoLink: details.videoLink ?? null,
          // Their notes on this part of their messages (decision 87) are followed here too. What they wrote of it
          // themselves is theirs for a saved playbook only, and never changes what the playbook words.
          own: (kind) =>
            ownWordsFor(
              kind,
              null,
              found.notes,
              o.state.step ? { step: o.state.step, sent: o.state.sent } : null,
            ),
        };
      };
      const out = (o: {
        readonly answer?: Answer | null;
        readonly kind: TestKind | null;
        readonly drafts?: readonly string[];
        readonly note?: string | null;
        readonly unanswered?: string | null;
        readonly state: TestState;
        readonly label?: string | null;
      }): PlaybookTestOutput => ({
        theirs,
        answer: o.answer ?? null,
        read: theirs ? TEST_READ[o.answer ?? 'none'] : null,
        kind: o.drafts?.length ? o.kind : null,
        label: o.drafts?.length ? (o.label ?? null) : null,
        message: o.drafts?.[0] ?? null,
        others: o.drafts?.slice(1) ?? [],
        note: o.kind && !o.drafts?.length ? TEST_WORDS.nothing : (o.note ?? null),
        next: testNext(o.state, pace),
        unanswered: o.unanswered ?? null,
        state: o.state,
        about: null,
        aboutYou: !!found.aboutOwner,
        way: null,
        why: null,
      });

      // Try a comment (decision 165): the comment that would wait under a post with these words, written and checked as
      // a real one. It stands apart from the chat, so nothing of the chat is told and where the chat is stays as it was.
      if (input.move === 'comment') {
        const warm = input.comment === 'warm';
        const base = await baseFor({ state: TEST_START, gapDays: 0, times: false });
        const made = await writeDrafts(
          ctx,
          {
            ...base,
            told: {
              ...base.told,
              recent: [],
              conversation: null,
              post: { text: input.post, group: null, warm, said: [], asking: false },
              // What the business knows that the post's words match (decision 122), as a real comment is told.
              knows: await businessKnows(ctx, [input.post]),
              declined: null,
              videos: null,
            },
          },
          'comment',
        );
        return {
          ...out({ kind: 'comment', drafts: made.drafts, state: input.state }),
          label: made.drafts.length ? TEST_COMMENTS[input.comment].label : null,
          note: made.drafts.length ? null : TEST_WORDS.comment.none,
          next: TEST_WORDS.comment.next,
          about: made.drafts.length ? made.value.about.trim() || null : null,
        };
      }

      if (input.move === 'start' || input.move === 'quiet') {
        const step = testMove(input.move, input.state, person, pace);
        if (!step.kind) return out({ kind: null, note: step.note, state: input.state });
        // A playbook with no way ticked starts no chats (decision 183).
        if (step.kind === 'opener' && !hasWays(details))
          return out({ kind: null, note: TEST_WORDS.noWays, state: input.state });
        const base = await baseFor({
          state: input.state,
          gapDays: step.gapDays,
          // A follow-up offers times only after the ask for one (decision 149).
          times: isTimeKind(step.kind) && input.state.step === 'link',
        });
        const made = await writeDrafts(ctx, base, step.kind);
        // The way the AI picked for them (decision 183): one that starts a chat goes on as an introduction does.
        const way = step.kind === 'opener' ? wayOf(made.value, ways) : null;
        const state =
          way && startsAChat(way)
            ? testMove(input.move, input.state, person, pace, true).state
            : step.state;
        return {
          ...out({
            kind: step.kind,
            drafts: made.drafts,
            note: step.note,
            // A message that didn't come moves nothing along.
            state: made.drafts.length ? state : input.state,
            label: testLabel(step.kind, {
              version,
              versions: pitches.length,
              way,
              followUp: step.state.sent,
              followUps: pace.followUps,
              step: input.state.step,
            }),
          }),
          way: made.drafts.length ? way : null,
          // Why, when it had a few to pick from.
          why:
            made.drafts.length && way && ways.length > 1 ? made.value.wayWhy.trim() || null : null,
        };
      }

      // They wrote: the reply reads their answer, and a yes to the first message gets the ask for a time instead. In the
      // networking chat after an introduction (decision 173) a reply offers no times, and only a yes to a demo or a
      // networking call is one.
      const base = await baseFor({
        state: input.state,
        gapDays: 0,
        times: input.state.step !== 'intro',
      });
      let made = await writeDrafts(ctx, base, 'reply');
      const answer = answerOf('reply', made.value, base.told.recent, input.state.step);
      const took = tookOf(made.value, input.state.step);
      // A time of theirs that's open is booked by a real reply, so no ask follows it (decision 149).
      const picked = base.meeting
        ? openTimeOf(made.value.time, base.meeting.open, base.meeting.zone)
        : null;
      const after = picked
        ? { kind: 'reply' as const, state: testAnswered(input.state, null, pace).state }
        : testAnswered(input.state, answer, pace, took);
      // The ask for a time with its own times: on the person's own calendar for a networking call (decision 173).
      const asks =
        after.kind === 'pitch'
          ? input.state.step === 'intro'
            ? await baseFor({ state: after.state, gapDays: 0, times: true })
            : base
          : null;
      if (asks) made = await writeDrafts(ctx, asks, 'pitch');
      const offered =
        asks?.meeting && after.kind === 'pitch' ? offeredWords(asks.meeting).join(', ') : '';
      return out({
        answer,
        kind: after.kind,
        drafts: made.drafts,
        note: picked
          ? 'They picked a time that’s open on your booking page. A real reply books it once they give an email or a mobile number. Nothing is booked here.'
          : offered
            ? `The times are really open on your booking page right now: ${offered}.`
            : null,
        unanswered: unansweredOf(after.kind, made.value, base.told.recent),
        state: made.drafts.length ? after.state : input.state,
        label: testLabel(after.kind, { call: after.state.call }),
      });
    } catch (e) {
      throw draftRefusal(e);
    }
  },
};
