/**
 * Runs in each Facebook tab. It reads the page only when the side panel asks, and answers only the panel. It never
 * changes the page, clicks, scrolls, or sends anything anywhere.
 */
import { outlinePage } from './facebook/outline';
import { readPage } from './facebook/page';
import type { Answer, Ask } from './messages';

const here = globalThis as { hfosSocialListening?: boolean };

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
}
