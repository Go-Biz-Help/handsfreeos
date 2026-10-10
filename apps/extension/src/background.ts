/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in, look people up and save (src/hfos/session.ts), and for
 * the day on Facebook (src/hfos/noting.ts). Its script in a Facebook tab tells it the steps the person takes there,
 * which it notes; that script is never answered, and only the extension's own pages are. Its alarm wakes the runner
 * that works on Facebook on its own, once the person turns that on (src/auto/run.ts). It follows the person's settings
 * in HandsFreeOS from the moment they sign in (src/hfos/follow.ts).
 */
import { AUTO_ALARM, answerAuto, tick, wake } from './auto/run';
import { facebookUrl } from './facebook/urls';
import { follow, loadSettings } from './hfos/follow';
import { AUTO_ASKS, HFOS_ASKS, type HfosAnswer, type HfosAsk } from './hfos/messages';
import { answerNoting, isTabNote, takeNote } from './hfos/noting';
import { answer } from './hfos/session';
import { TAB_NOTES } from './messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

/** After these, whose settings it follows may have changed. */
const SIGN_INS = new Set(['hfos-check-code', 'hfos-password', 'hfos-pick', 'hfos-sign-out']);

/** Loads the settings when asked, and listens for changes to them; a wake from the live channel has the runner look. */
async function followNow(load = false): Promise<void> {
  try {
    if (load) await loadSettings();
    await follow(() => void tick());
  } catch {
    // Signed out, or offline: the runner's next step looks again.
  }
}

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
      ask.type === 'hfos-today'
        ? answerNoting(ask)
        : AUTO_ASKS.has(ask.type)
          ? answerAuto(ask as Parameters<typeof answerAuto>[0])
          : answer(ask as Parameters<typeof answer>[0])
    ).then((answered) => {
      respond(answered);
      if (SIGN_INS.has(ask.type)) void followNow(true);
    });
    return true;
  },
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) void tick();
  void followNow();
});
// The background woke: it listens again, and the channel keeps it awake while Chrome is open.
void followNow();
// Chrome started, or the extension was updated: the alarm may be gone.
chrome.runtime.onStartup.addListener(() => void wake());
chrome.runtime.onInstalled.addListener(() => void wake());
