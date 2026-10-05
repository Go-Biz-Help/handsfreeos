/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in, look people up and save (src/hfos/session.ts). It
 * answers only the extension's own pages, never its script in a Facebook tab.
 */
import { HFOS_ASKS, type HfosAnswer, type HfosAsk } from './hfos/messages';
import { answer } from './hfos/session';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

chrome.runtime.onMessage.addListener(
  (ask: HfosAsk, sender, respond: (answer: HfosAnswer<unknown>) => void) => {
    const ours =
      sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
    if (!ours || typeof ask?.type !== 'string' || !HFOS_ASKS.has(ask.type)) return false;
    void answer(ask).then(respond);
    return true;
  },
);
