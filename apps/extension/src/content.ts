/**
 * Runs in each Facebook tab. It reads the page only when the side panel asks, and answers only the panel. While the
 * panel reads as the page changes, it also tells the panel when the page has changed, so the panel can ask again. It
 * never changes the page, clicks, scrolls, or sends anything anywhere.
 */
import { outlinePage } from './facebook/outline';
import { readPage } from './facebook/page';
import { WATCH, type Answer, type Ask, type Note } from './messages';

/** How long after the page starts changing the panel hears of it: Facebook draws a new post in several steps. */
const SETTLE_MS = 1500;

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
