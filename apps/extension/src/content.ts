/**
 * Runs in each Facebook tab. It reads the page when the background asks (the runner that works on its own, and what
 * the person asks of the extension from HandsFreeOS), and answers only the extension.
 *
 * As the person works, it notices the steps they take themselves (a friend request, a like, a comment, a message,
 * and Confirm or Delete on a friend request they got: src/facebook/actions.ts) and tells the extension's background,
 * which notes them in HandsFreeOS; and it tells it who they open from a group. Only the person's own clicks and keys
 * count, never the page's, and never what they wrote. "Note my steps on Facebook" in HandsFreeOS turns this off. It
 * never changes the page, clicks, scrolls, or sends anything on Facebook, except for what the person asked of the
 * extension from HandsFreeOS: on Facebook's own download pages it presses the buttons that ask for their file and
 * download it, one step at a time (src/facebook/fetch.ts); in Messenger, for Read my chats, it opens their chats one
 * at a time from the list beside it and scrolls that list for more (src/facebook/browse.ts); it scrolls a group's
 * feed for more posts, a list of people for more people, and a list of groups for more groups (the same file); and on
 * the profiles of people they ticked, it presses Cancel request or Unfriend (src/facebook/tidy.ts). Once the person
 * lets the extension work on its own (src/auto/run.ts), it also presses Add friend, Confirm and Like on the profiles
 * of people on their list for today, and writes and sends the comment the AI drafted on a post on their list
 * (src/facebook/auto.ts), in the window the extension works in; and on a good group it presses Join group and
 * answers the group's questions with the AI's answers (src/facebook/join.ts, decision 48). It never sends a message.
 *
 * While noting is on, it also looks at the chats on the page as they change (Messenger's list, an open chat, a small
 * chat window) and tells the background of each whose last message is theirs, and whether the person was looking at
 * the tab (src/facebook/replies.ts), so their phone can hear who wrote back. Only who, never what they wrote.
 *
 * And in the tab in front of the person, as the page settles (src/facebook/looking.ts): Facebook's warnings, always;
 * and while noting is on, a chat they open when Read chats I open is on, or a group's posts as they scroll when Look
 * for posts as I scroll is on. The background notes the warnings and saves the rest (src/hfos/looked.ts).
 */
import {
  answerFromClick,
  seenFromClick,
  stepFromClick,
  stepFromEnter,
  type Answered,
  type Step,
} from './facebook/actions';
import { likeTheirPost, readTheirPosts, writeComment, writeMessage } from './facebook/auto';
import { answerJoin, pressJoin } from './facebook/join';
import { readComments, readReactions, writeGroupPost } from './facebook/compose';
import { openChat, scrollChats, scrollFeed, scrollList, scrollPage } from './facebook/browse';
import { doPath, doStep, fetchPage, type StepResult } from './facebook/fetch';
import { LOOK_EVERY_MS, lookFor } from './facebook/looking';
import { outlinePage } from './facebook/outline';
import { readOwnProfile, writeBio } from './facebook/own-profile';
import { requestsPage } from './facebook/friends';
import { tidyPage } from './facebook/tidy';
import { classifyUrl } from './facebook/urls';
import { readPage } from './facebook/page';
import { readReplies } from './facebook/replies';
import { readWarnings } from './facebook/warnings';
import {
  MARK_POSTS_KEY,
  NOTING_KEY,
  READ_CHATS_KEY,
  type Answer,
  type Ask,
  type AutoAnswer,
  type PostsAnswer,
  type AutoAsk,
  type BrowseAnswer,
  type BrowseAsk,
  type FetchAnswer,
  type FetchAsk,
  type GroupPostAnswer,
  type GroupPostAsk,
  type JoinAnswer,
  type JoinAsk,
  type OwnProfileAnswer,
  type OwnProfileAsk,
  type TabNote,
} from './messages';

/** How long after the page starts changing it's read again: Facebook draws a new post in several steps. */
const SETTLE_MS = 1500;
/** The same button pressed twice within this is one press: a key, and the click Facebook makes of it. */
const SAME_PRESS_MS = 1500;
/** How often a step that isn't on the page yet is looked for again, while Facebook draws the next screen. */
const LOOK_AGAIN_MS = 300;
/** The chats on the page are looked at no more often than this as it changes. */
const REPLIES_EVERY_MS = 10_000;
/** After the person sends a message, the page takes this long to show it last. */
const AFTER_SENDING_MS = 20_000;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One of the panel's steps on a download page, looked for until it shows or `waitMs` is up. */
async function fetchStep(ask: FetchAsk): Promise<FetchAnswer> {
  const allowed = ask.tidy
    ? tidyPage(location.href)
    : ask.lists
      ? requestsPage(location.href)
      : fetchPage(location.href);
  if (!allowed)
    return {
      ok: false,
      error: ask.tidy
        ? 'Facebook didn’t open their profile.'
        : ask.lists
          ? 'Facebook didn’t open your friend requests.'
          : 'This isn’t one of Facebook’s download pages.',
    };
  const until = Date.now() + ask.waitMs;
  for (;;) {
    let result: StepResult;
    let at: number | undefined;
    if (ask.type === 'hfos-fetch-step') result = doStep(document, ask.step);
    else {
      const went = doPath(document, ask.steps, ask.from);
      result = 'at' in went ? 'done' : went.result;
      at = 'at' in went ? went.at : undefined;
    }
    if (result === 'done' || result === 'already' || result === 'stop' || Date.now() >= until)
      return { ok: true, result, at };
    await pause(LOOK_AGAIN_MS);
  }
}

/** One of the runner's steps (src/facebook/auto.ts): a like on someone's profile, a comment on a post, or a message. */
async function autoStep(ask: AutoAsk): Promise<AutoAnswer | PostsAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-their-posts' || ask.type === 'hfos-like-post') {
    if (kind !== 'profile') return { ok: false, error: 'Facebook didn’t open their profile.' };
    if (ask.type === 'hfos-their-posts')
      return {
        ok: true,
        posts: await readTheirPosts(document, location.href, ask.profile, window, ask.most),
      };
    return { ok: true, ...(await likeTheirPost(document, location.href, ask.profile, ask)) };
  }
  if (ask.type === 'hfos-message') {
    if (kind !== 'chat' && kind !== 'profile')
      return { ok: false, error: 'Facebook didn’t open a chat with them.' };
    return { ok: true, result: await writeMessage(document, ask.text) };
  }
  if (kind !== 'post') return { ok: false, error: 'Facebook didn’t open the post.' };
  return { ok: true, result: await writeComment(document, ask.text) };
}

/** Asking to join the group the tab shows (src/facebook/join.ts): Join group, then the AI's answers to its questions. */
async function joinStep(ask: JoinAsk): Promise<JoinAnswer> {
  if (classifyUrl(location.href).kind !== 'group')
    return { ok: false, error: 'Facebook didn’t open the group.' };
  if (ask.type === 'hfos-join') return { ok: true, step: await pressJoin(document) };
  return { ok: true, result: await answerJoin(document, ask.answers) };
}

/** A helpful post (src/facebook/compose.ts): put it up on the group's page, or read who engaged on the person's own. */
async function groupPostStep(ask: GroupPostAsk): Promise<GroupPostAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-group-post') {
    if (kind !== 'group') return { ok: false, error: 'Facebook didn’t open the group.' };
    return { ok: true, result: await writeGroupPost(document, ask.text) };
  }
  if (kind !== 'post') return { ok: false, error: 'Facebook didn’t open the post.' };
  return {
    ok: true,
    comments: readComments(document, location.href),
    reactions: await readReactions(document, location.href),
  };
}

/** The person's own profile (src/facebook/own-profile.ts): read it for the AI's check, or put a bio in. */
async function ownProfileStep(ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  const address = classifyUrl(location.href);
  if (address.kind !== 'profile') return { ok: false, error: 'Facebook didn’t open your profile.' };
  if (ask.type === 'hfos-own-profile')
    return { ok: true, read: readOwnProfile(document, location.href, address) };
  return { ok: true, result: await writeBio(document, ask.bio) };
}

const here = globalThis as { hfosSocialListening?: boolean };

/** Whether a change adds or takes away writing or a link: not a spinner, a picture or a moving progress bar. */
function matters(records: readonly MutationRecord[]): boolean {
  return records.some((record) =>
    [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        ((node.textContent ?? '').trim() !== '' ||
          (node as Element).matches('a[href]') ||
          (node as Element).querySelector('a[href]') !== null),
    ),
  );
}

// The panel loads this again into tabs opened before the extension was installed; one listener is enough.
if (!here.hfosSocialListening) {
  here.hfosSocialListening = true;
  chrome.runtime.onMessage.addListener(
    (
      ask: Ask | FetchAsk | BrowseAsk | AutoAsk | JoinAsk | GroupPostAsk | OwnProfileAsk,
      sender,
      respond: (answer: Answer) => void,
    ) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (ask.type === 'hfos-join' || ask.type === 'hfos-join-answer') {
        void joinStep(ask).then(respond as (answer: JoinAnswer) => void);
        return true;
      }
      if (ask.type === 'hfos-own-profile' || ask.type === 'hfos-write-bio') {
        void ownProfileStep(ask).then(respond as (answer: OwnProfileAnswer) => void);
        return true;
      }
      if (ask.type === 'hfos-group-post' || ask.type === 'hfos-engaged') {
        void groupPostStep(ask).then(respond as (answer: GroupPostAnswer) => void);
        return true;
      }
      if (
        ask.type === 'hfos-their-posts' ||
        ask.type === 'hfos-like-post' ||
        ask.type === 'hfos-comment' ||
        ask.type === 'hfos-message'
      ) {
        void autoStep(ask).then(respond as (answer: AutoAnswer | PostsAnswer) => void);
        return true;
      }
      if (
        ask.type === 'hfos-open-chat' ||
        ask.type === 'hfos-scroll-chats' ||
        ask.type === 'hfos-scroll-feed' ||
        ask.type === 'hfos-scroll-list' ||
        ask.type === 'hfos-scroll-page'
      ) {
        const ok =
          ask.type === 'hfos-open-chat'
            ? openChat(document, location.href, ask.threadId)
            : ask.type === 'hfos-scroll-chats'
              ? scrollChats(document, location.href)
              : ask.type === 'hfos-scroll-list'
                ? scrollList(document, location.href)
                : ask.type === 'hfos-scroll-page'
                  ? scrollPage(document, location.href)
                  : scrollFeed(location.href);
        (respond as (answer: BrowseAnswer) => void)({ ok });
        return false;
      }
      if (ask.type === 'hfos-fetch-step' || ask.type === 'hfos-fetch-path') {
        void fetchStep(ask).then(respond as (answer: FetchAnswer) => void);
        return true;
      }
      if (ask.type !== 'hfos-read' && ask.type !== 'hfos-outline') return false;
      try {
        const result = readPage(document, location.href);
        const outline =
          ask.type === 'hfos-outline'
            ? outlinePage(document, location.href, {
                version: chrome.runtime.getManifest().version,
                found: result,
                window: { width: innerWidth, height: innerHeight },
              })
            : undefined;
        respond({ ok: true, result, outline });
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return false;
    },
  );

  // Noting: on unless the person turned it off in HandsFreeOS; reading chats and posts as they go, only when on.
  let noting = true;
  let readChats = false;
  let markPosts = false;
  chrome.storage.local
    .get([NOTING_KEY, READ_CHATS_KEY, MARK_POSTS_KEY])
    .then((found) => {
      noting = found[NOTING_KEY] !== false;
      readChats = found[READ_CHATS_KEY] === true;
      markPosts = found[MARK_POSTS_KEY] === true;
    })
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (NOTING_KEY in changes) noting = changes[NOTING_KEY]?.newValue !== false;
    if (READ_CHATS_KEY in changes) readChats = changes[READ_CHATS_KEY]?.newValue === true;
    if (MARK_POSTS_KEY in changes) markPosts = changes[MARK_POSTS_KEY]?.newValue === true;
  });

  let last: { readonly key: string; readonly at: number } | null = null;
  /** When the person last sent a message from this tab. */
  let sentAt = 0;
  const tell = (note: TabNote) => {
    try {
      chrome.runtime.sendMessage(note).catch(() => undefined);
    } catch {
      // The extension was updated or taken out under this page: there's nobody to tell.
    }
  };
  const noted = (step: Step | null) => {
    if (!step) return false;
    const now = Date.now();
    if (step.kind === 'message') sentAt = now;
    // Sending empties the box, so writing is never sent twice; a button can be pressed twice.
    const key =
      step.kind === 'friend_request' || step.kind === 'like'
        ? JSON.stringify([step.kind, step.to.profile, step.postUrl])
        : null;
    if (!key || last?.key !== key || now - last.at > SAME_PRESS_MS)
      tell({ type: 'hfos-noted', step, at: new Date(now).toISOString() });
    if (key) last = { key, at: now };
    return true;
  };
  const answered = (answer: Answered | null) => {
    if (!answer) return false;
    const now = Date.now();
    // Facebook takes the buttons away once pressed, but a quick second press can land first.
    const key = JSON.stringify([answer.answer, answer.to.profile]);
    if (last?.key !== key || now - last.at > SAME_PRESS_MS)
      tell({ type: 'hfos-answered', answered: answer, at: new Date(now).toISOString() });
    last = { key, at: now };
    return true;
  };
  const watching = (event: Event) =>
    noting && event.isTrusted && event.target instanceof Element ? event.target : null;

  // Caught on the way down, before Facebook's own handlers change the button ("Like" becomes "Remove Like") or
  // empty the box. A mistake in noticing never gets in the way of the page.
  document.addEventListener(
    'click',
    (event) => {
      const target = watching(event);
      if (!target) return;
      try {
        if (noted(stepFromClick(target, document, location.href))) return;
        if (answered(answerFromClick(target, document, location.href))) return;
        const seen = seenFromClick(target, document, location.href);
        if (seen) tell({ type: 'hfos-seen', seen });
      } catch (error) {
        console.debug('HandsFreeOS Social couldn’t tell what that click was', error);
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      const target = watching(event);
      if (!target || event.repeat || event.isComposing) return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      try {
        // Enter sends what's written; Enter or Space presses a button Facebook draws as a box. A real button makes a
        // click of it, heard above.
        if (event.key === 'Enter' && noted(stepFromEnter(target, document, location.href))) return;
        if ((event.key !== 'Enter' && event.key !== ' ') || target.tagName === 'BUTTON') return;
        if (!noted(stepFromClick(target, document, location.href)))
          answered(answerFromClick(target, document, location.href));
      } catch (error) {
        console.debug('HandsFreeOS Social couldn’t tell what that key was', error);
      }
    },
    true,
  );

  // Chats whose last message is theirs: looked at as the page changes, once it settles, and not just after the person
  // sent one, while the page catches up.
  let repliesTimer: ReturnType<typeof setTimeout> | undefined;
  const lookForReplies = () => {
    repliesTimer = undefined;
    if (!noting) return;
    const wait = sentAt + AFTER_SENDING_MS - Date.now();
    if (wait > 0) {
      repliesTimer = setTimeout(lookForReplies, wait);
      return;
    }
    try {
      const seen = readReplies(document, location.href);
      if (seen.length)
        tell({
          type: 'hfos-replies',
          seen,
          looking: document.visibilityState === 'visible' && document.hasFocus(),
        });
    } catch (error) {
      console.debug('HandsFreeOS Social couldn’t look at the chats on the page', error);
    }
  };
  new MutationObserver((records) => {
    if (repliesTimer !== undefined || !noting || !matters(records)) return;
    repliesTimer = setTimeout(lookForReplies, REPLIES_EVERY_MS);
  }).observe(document.body, { childList: true, subtree: true });

  // The page in front of the person, read as it settles and on a new address, at most every LOOK_EVERY_MS: its
  // warnings, and a chat or a group's posts when they asked for those (src/facebook/looking.ts).
  let lookTimer: ReturnType<typeof setTimeout> | undefined;
  let lookedAt = 0;
  let lookedUrl = '';
  const look = () => {
    lookTimer = undefined;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const wait = lookedAt + LOOK_EVERY_MS - Date.now();
    if (wait > 0 && location.href === lookedUrl) {
      lookTimer = setTimeout(look, wait);
      return;
    }
    lookedAt = Date.now();
    lookedUrl = location.href;
    try {
      const kind = classifyUrl(location.href).kind;
      const what = lookFor(kind, { noting, readChats, markPosts });
      const result = what === 'page' ? readPage(document, location.href) : null;
      const warnings = result ? result.warnings : readWarnings(document, location.href);
      if (warnings.length || result)
        tell({ type: 'hfos-looked', url: location.href, warnings, result });
    } catch (error) {
      console.debug('HandsFreeOS Social couldn’t read the page', error);
    }
  };
  const lookSoon = () => {
    if (lookTimer === undefined) lookTimer = setTimeout(look, SETTLE_MS);
  };
  new MutationObserver((records) => {
    if (matters(records)) lookSoon();
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('focus', lookSoon);
  document.addEventListener('visibilitychange', lookSoon);
  lookSoon();
}
