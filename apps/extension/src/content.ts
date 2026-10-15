/**
 * Runs in each tab of a network the extension works on, by that network's kit (src/networks/): Facebook's tabs from
 * install, and LinkedIn's only while HandsFreeOS says LinkedIn is on for the person and Chrome allows it
 * (src/networks/scripts.ts). A network that's off runs nothing here: a tab whose network was turned off since it
 * loaded reads nothing, notes nothing and answers nothing but to say so. It answers only the extension.
 *
 * It reads the page when the background asks (the runner that works on its own, what the person asks of the
 * extension from HandsFreeOS, and the panel's page outline). The runner's and the asks' other steps are Facebook's
 * for now (src/networks/facebook/work.ts): on Facebook's own download pages, the buttons that ask for the person's
 * file; in Messenger, opening their chats one at a time and scrolling the list; scrolling a group's feed, a list of
 * people or of groups; on the profiles of people they ticked, Cancel request or Unfriend; once they let the extension
 * work on its own (src/auto/run.ts), Add friend, Confirm and Like on the profiles of people on their list for today,
 * the comment the AI drafted, and the messages they OK'd; Join group and its questions (decision 48); a helpful post;
 * and their own profile's bio. No other network's tab does any of these.
 *
 * As the person works, it notices the steps they take themselves (a friend request or an invitation to connect, a
 * like, a comment, a message, and their answer to a request they got: src/networks/facebook/actions.ts,
 * src/networks/linkedin/actions.ts) and tells the extension's background, which notes them in HandsFreeOS; and on
 * Facebook, who they open from a group. Only the person's own clicks and keys count, never the page's, and never what
 * they wrote. "Note my steps" in HandsFreeOS turns this off. It never changes the page, clicks, scrolls, or sends
 * anything but for the steps above.
 *
 * While noting is on, it also looks at the chats on the page as they change and tells the background of each whose
 * last message is theirs, and whether the person was looking at the tab, so their phone can hear who wrote back. Only
 * who, never what they wrote.
 *
 * And in the tab in front of the person, as the page settles: the network's warnings, always; and on Facebook, while
 * noting is on, a chat they open when Read chats I open is on, or a group's posts as they scroll when Look for posts
 * as I scroll is on (src/networks/facebook/looking.ts). The background notes the warnings and saves the rest
 * (src/hfos/looked.ts).
 */
import { kitHere, type Noticed, type Step, type Answered } from './networks';
import { LOOK_EVERY_MS } from './networks/facebook/looking';
import { isStates, isWorking, NETWORKS_KEY } from './networks/on';
import { MARK_POSTS_KEY, NOTING_KEY, READ_CHATS_KEY, type TabNote } from './messages';

/** How long after the page starts changing it's read again: a post is drawn in several steps. */
const SETTLE_MS = 1500;
/** The same button pressed twice within this is one press: a key, and the click the page makes of it. */
const SAME_PRESS_MS = 1500;
/** The chats on the page are looked at no more often than this as it changes. */
const REPLIES_EVERY_MS = 10_000;
/** After the person sends a message, the page takes this long to show it last. */
const AFTER_SENDING_MS = 20_000;

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

const kit = kitHere(location.href);

// The panel loads this again into tabs opened before the extension was installed; one listener is enough. A page of
// no network it knows gets nothing.
if (kit && !here.hfosSocialListening) {
  here.hfosSocialListening = true;
  const name = kit.network.name;

  // The network on for the person and allowed by Chrome; noting on unless they turned it off in HandsFreeOS; reading
  // chats and posts as they go, only when on.
  let working = isWorking(kit, null);
  let noting = true;
  let readChats = false;
  let markPosts = false;
  chrome.storage.local
    .get([NETWORKS_KEY, NOTING_KEY, READ_CHATS_KEY, MARK_POSTS_KEY])
    .then((found) => {
      const states: unknown = found[NETWORKS_KEY];
      working = isWorking(kit, isStates(states) ? states : null);
      noting = found[NOTING_KEY] !== false;
      readChats = found[READ_CHATS_KEY] === true;
      markPosts = found[MARK_POSTS_KEY] === true;
    })
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (NETWORKS_KEY in changes) {
      const states: unknown = changes[NETWORKS_KEY]?.newValue;
      working = isWorking(kit, isStates(states) ? states : null);
    }
    if (NOTING_KEY in changes) noting = changes[NOTING_KEY]?.newValue !== false;
    if (READ_CHATS_KEY in changes) readChats = changes[READ_CHATS_KEY]?.newValue === true;
    if (MARK_POSTS_KEY in changes) markPosts = changes[MARK_POSTS_KEY]?.newValue === true;
  });

  chrome.runtime.onMessage.addListener(
    (ask: { readonly type?: unknown }, sender, respond: (answer: unknown) => void) => {
      if (sender.id !== chrome.runtime.id || typeof ask?.type !== 'string') return false;
      if (!working) {
        const allow = kit.optional ? `, then press Allow on ${name} in the extension’s panel` : '';
        respond({
          ok: false,
          error: `${name} is off for you, so the extension does nothing on it. Turn it on under Social Outreach → Settings in HandsFreeOS${allow}.`,
        });
        return false;
      }
      if (ask.type === 'hfos-read' || ask.type === 'hfos-outline') {
        try {
          const result = kit.readPage(document, location.href);
          const outline =
            ask.type === 'hfos-outline'
              ? kit.outline(document, location.href, {
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
      }
      if (!kit.work) {
        respond({
          ok: false,
          error: `The extension doesn’t work on ${name} pages on its own yet.`,
        });
        return false;
      }
      const going = kit.work(ask as { readonly type: string });
      if (!going) return false;
      void going.then(respond);
      return true;
    },
  );

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
  const noted = (step: Step) => {
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
  };
  const answered = (answer: Answered) => {
    const now = Date.now();
    // The page takes the buttons away once pressed, but a quick second press can land first.
    const key = JSON.stringify([answer.answer, answer.to.profile]);
    if (last?.key !== key || now - last.at > SAME_PRESS_MS)
      tell({ type: 'hfos-answered', answered: answer, at: new Date(now).toISOString() });
    last = { key, at: now };
  };
  /** Tells the background what a click or a key was, now or once the page shows it went. True when it was something. */
  const handle = (noticed: Noticed | null): boolean => {
    if (!noticed) return false;
    if (noticed.kind === 'step') noted(noticed.step);
    else if (noticed.kind === 'answer') answered(noticed.answered);
    else if (noticed.kind === 'seen') tell({ type: 'hfos-seen', seen: noticed.seen });
    else
      setTimeout(() => {
        try {
          if (working && noting && noticed.went()) noted(noticed.step);
        } catch (error) {
          console.debug('HandsFreeOS Social couldn’t tell whether that went', error);
        }
      }, noticed.afterMs);
    return true;
  };
  const noticer = kit.noticer();
  const watching = (event: Event) =>
    working && noting && event.isTrusted && event.target instanceof Element ? event.target : null;

  // Caught on the way down, before the page's own handlers change the button ("Like" becomes "Remove Like") or
  // empty the box. A mistake in noticing never gets in the way of the page.
  document.addEventListener(
    'click',
    (event) => {
      const target = watching(event);
      if (!target) return;
      try {
        handle(noticer.click(target, document, location.href));
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
        // Enter sends what's written; Enter or Space presses a button drawn as a box. A real button makes a click
        // of it, heard above.
        if (event.key === 'Enter' && handle(noticer.enter(target, document, location.href))) return;
        if ((event.key !== 'Enter' && event.key !== ' ') || target.tagName === 'BUTTON') return;
        handle(noticer.click(target, document, location.href, true));
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
    if (!noting || !working) return;
    const wait = sentAt + AFTER_SENDING_MS - Date.now();
    if (wait > 0) {
      repliesTimer = setTimeout(lookForReplies, wait);
      return;
    }
    try {
      const seen = kit.readReplies(document, location.href);
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
    if (repliesTimer !== undefined || !noting || !working || !matters(records)) return;
    repliesTimer = setTimeout(lookForReplies, REPLIES_EVERY_MS);
  }).observe(document.body, { childList: true, subtree: true });

  // The page in front of the person, read as it settles and on a new address, at most every LOOK_EVERY_MS: its
  // warnings, and a chat or a group's posts when they asked for those (the kit's `lookFor`).
  let lookTimer: ReturnType<typeof setTimeout> | undefined;
  let lookedAt = 0;
  let lookedUrl = '';
  const look = () => {
    lookTimer = undefined;
    if (!working || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const wait = lookedAt + LOOK_EVERY_MS - Date.now();
    if (wait > 0 && location.href === lookedUrl) {
      lookTimer = setTimeout(look, wait);
      return;
    }
    lookedAt = Date.now();
    lookedUrl = location.href;
    try {
      const what = kit.lookFor(kit.kindOf(location.href), { noting, readChats, markPosts });
      const result = what === 'page' ? kit.readPage(document, location.href) : null;
      const warnings = result ? [...result.warnings] : kit.readWarnings(document, location.href);
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
