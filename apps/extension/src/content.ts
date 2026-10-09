/**
 * Runs in each Facebook tab. It reads the page when the side panel asks, and answers only the panel; the one other
 * reading, of the chats on the page, is below. While the panel reads as the page changes, it also tells the panel when the page has changed, so the panel can ask again.
 *
 * As the person works, it notices the steps they take themselves (a friend request, a like, a comment, a message,
 * and Confirm or Delete on a friend request they got: src/facebook/actions.ts) and tells the extension's background,
 * which notes them in HandsFreeOS; and it tells it who they open from a group. Only the person's own clicks and keys
 * count, never the page's, and never what they wrote. The switch in the panel turns this off. It never changes the
 * page, clicks, scrolls, or sends anything on Facebook, with five exceptions, each only once the person asks in the
 * panel: on Facebook's own download pages it presses the buttons that ask for their file and download it, one step at
 * a time (src/facebook/fetch.ts); in Messenger, for Read my chats, it opens their chats one at a time from the list
 * beside it and scrolls that list for more (src/facebook/browse.ts); for Find posts, it scrolls a group's feed for
 * more posts (the same file); and on the profiles of people they ticked in the panel, it presses Cancel request or
 * Unfriend (src/facebook/tidy.ts). Once the person lets the extension work on its own (src/auto/run.ts), it also
 * presses Add friend, Confirm and Like on the profiles of people on their list for today, and writes and sends the
 * comment the AI drafted on a post on their list (src/facebook/auto.ts), in the window the extension works in. It never
 * sends a message.
 *
 * While noting is on, it also looks at the chats on the page as they change (Messenger's list, an open chat, a small
 * chat window) and tells the background of each whose last message is theirs, and whether the person was looking at
 * the tab (src/facebook/replies.ts), so their phone can hear who wrote back. Only who, never what they wrote.
 */
import {
  answerFromClick,
  seenFromClick,
  stepFromClick,
  stepFromEnter,
  type Answered,
  type Step,
} from './facebook/actions';
import { likeLatest, writeComment } from './facebook/auto';
import { openChat, scrollChats, scrollFeed } from './facebook/browse';
import { doPath, doStep, fetchPage, type StepResult } from './facebook/fetch';
import { outlinePage } from './facebook/outline';
import { tidyPage } from './facebook/tidy';
import { classifyUrl } from './facebook/urls';
import { readPage } from './facebook/page';
import { readReplies } from './facebook/replies';
import {
  NOTING_KEY,
  WATCH,
  type Answer,
  type Ask,
  type AutoAnswer,
  type AutoAsk,
  type BrowseAnswer,
  type BrowseAsk,
  type FetchAnswer,
  type FetchAsk,
  type Note,
  type TabNote,
} from './messages';

/** How long after the page starts changing the panel hears of it: Facebook draws a new post in several steps. */
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
  if (ask.tidy ? !tidyPage(location.href) : !fetchPage(location.href))
    return {
      ok: false,
      error: ask.tidy
        ? 'Facebook didn’t open their profile.'
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

/** One of the runner's steps (src/facebook/auto.ts): a like on someone's profile, or a comment on a post. */
async function autoStep(ask: AutoAsk): Promise<AutoAnswer> {
  const kind = classifyUrl(location.href).kind;
  if (ask.type === 'hfos-like-latest') {
    if (kind !== 'profile') return { ok: false, error: 'Facebook didn’t open their profile.' };
    const liked = await likeLatest(document, location.href, ask.profile, window);
    return { ok: true, ...liked };
  }
  if (kind !== 'post') return { ok: false, error: 'Facebook didn’t open the post.' };
  return { ok: true, result: await writeComment(document, ask.text) };
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
    (ask: Ask | FetchAsk | BrowseAsk | AutoAsk, sender, respond: (answer: Answer) => void) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (ask.type === 'hfos-like-latest' || ask.type === 'hfos-comment') {
        void autoStep(ask).then(respond as (answer: AutoAnswer) => void);
        return true;
      }
      if (
        ask.type === 'hfos-open-chat' ||
        ask.type === 'hfos-scroll-chats' ||
        ask.type === 'hfos-scroll-feed'
      ) {
        const ok =
          ask.type === 'hfos-open-chat'
            ? openChat(document, location.href, ask.threadId)
            : ask.type === 'hfos-scroll-chats'
              ? scrollChats(document, location.href)
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

  // Noting: on unless the person turned it off in the panel.
  let noting = true;
  chrome.storage.local
    .get(NOTING_KEY)
    .then((found) => (noting = found[NOTING_KEY] !== false))
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && NOTING_KEY in changes) noting = changes[NOTING_KEY]?.newValue !== false;
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

  // Facebook adds to the page as you scroll and as messages come in, without a new address. While the panel is
  // watching, say so once things settle; the watching stops when the panel closes or looks at another tab.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== WATCH) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver((records) => {
      if (timer !== undefined || !matters(records)) return;
      timer = setTimeout(() => {
        timer = undefined;
        port.postMessage({ type: 'hfos-changed' } satisfies Note);
      }, SETTLE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    port.onDisconnect.addListener(() => {
      observer.disconnect();
      clearTimeout(timer);
    });
  });
}
