/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in, look people up and save (src/hfos/session.ts), and for
 * the day on Facebook (src/hfos/noting.ts). Its script in a Facebook tab tells it the steps the person takes there,
 * which it notes; that script is never answered, and only the extension's own pages are.
 */
import { facebookUrl } from './facebook/urls';
import { HFOS_ASKS, type HfosAnswer, type HfosAsk } from './hfos/messages';
import { answerNoting, isTabNote, takeNote } from './hfos/noting';
import { answer } from './hfos/session';
import { TAB_NOTES } from './messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, respond: (answer: HfosAnswer<unknown>) => void) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (sender.id !== chrome.runtime.id || typeof type !== 'string') return false;
    if (TAB_NOTES.has(type)) {
      const fromFacebook = sender.tab !== undefined && sender.url && facebookUrl(sender.url);
      if (fromFacebook && isTabNote(message)) takeNote(message);
      return false;
    }
    const ours = sender.url?.startsWith(chrome.runtime.getURL(''));
    if (!ours || !HFOS_ASKS.has(type)) return false;
    const ask = message as HfosAsk;
    void (
      ask.type === 'hfos-today' || ask.type === 'hfos-noting' ? answerNoting(ask) : answer(ask)
    ).then(respond);
    return true;
  },
);
