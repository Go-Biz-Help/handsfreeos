/**
 * Runs in each Facebook tab. It reads the page only when the side panel asks, and answers only the panel. While the
 * panel reads as the page changes, it also tells the panel when the page has changed, so the panel can ask again.
 *
 * As the person works, it notices the steps they take themselves (a friend request, a like, a comment, a message:
 * src/facebook/actions.ts) and tells the extension's background, which notes them in HandsFreeOS; and it tells it who
 * they open from a group. Only the person's own clicks and keys count, never the page's, and never what they wrote.
 * The switch in the panel turns this off. It never changes the page, clicks, scrolls, or sends anything on Facebook.
 */
import { seenFromClick, stepFromClick, stepFromEnter, type Step } from './facebook/actions';
import { outlinePage } from './facebook/outline';
import { readPage } from './facebook/page';
import { NOTING_KEY, WATCH, type Answer, type Ask, type Note, type TabNote } from './messages';

/** How long after the page starts changing the panel hears of it: Facebook draws a new post in several steps. */
const SETTLE_MS = 1500;
/** The same button pressed twice within this is one press: a key, and the click Facebook makes of it. */
const SAME_PRESS_MS = 1500;

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
  chrome.runtime.onMessage.addListener((ask: Ask, _sender, respond: (answer: Answer) => void) => {
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
  });

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
        if ((event.key === 'Enter' || event.key === ' ') && target.tagName !== 'BUTTON')
          noted(stepFromClick(target, document, location.href));
      } catch (error) {
        console.debug('HandsFreeOS Social couldn’t tell what that key was', error);
      }
    },
    true,
  );

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
