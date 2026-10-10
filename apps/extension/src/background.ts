/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in, look people up and save (src/hfos/session.ts), and for
 * the day on Facebook (src/hfos/noting.ts). Its script in a Facebook tab tells it the steps the person takes there,
 * which it notes; that script is never answered, and only the extension's own pages are. Its alarm wakes the runner
 * that works on Facebook on its own, once the person turns that on (src/auto/run.ts). It follows the person's settings
 * in HandsFreeOS from the moment they sign in (src/hfos/follow.ts). Every minute while someone is signed in it tells
 * HandsFreeOS how things stand on this computer, and hears from it about the person's day (src/hfos/live.ts).
 */
import { AUTO_ALARM, answerAuto, tick, wake } from './auto/run';
import { facebookUrl } from './facebook/urls';
import { follow, loadSettings } from './hfos/follow';
import { BEAT_ALARM, beat, heard, keepBeating, markActive, signOff } from './hfos/live';
import { AUTO_ASKS, HFOS_ASKS, type HfosAnswer, type HfosAsk } from './hfos/messages';
import { answerNoting, isTabNote, takeNote } from './hfos/noting';
import { answer, savingTo } from './hfos/session';
import { TAB_NOTES } from './messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

/** After these, whose settings it follows may have changed. */
const SIGN_INS = new Set(['hfos-check-code', 'hfos-password', 'hfos-pick', 'hfos-sign-out']);

/** The person's own steps on Facebook: this computer is the one they use. */
const OWN_STEPS = new Set(['hfos-noted', 'hfos-answered']);

/**
 * Loads the settings when asked, and listens for changes to them and to the person's day; a wake from the live
 * channel has the runner look. The minute's beat goes while someone is signed in.
 */
async function followNow(load = false): Promise<void> {
  try {
    if (load) await loadSettings();
    await follow(
      () => void tick(),
      (payload) => void heard(payload),
    );
  } catch {
    // Signed out, or offline: the runner's next step looks again.
  }
  await keepBeating(!!(await savingTo().catch(() => null)));
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, respond: (answer: HfosAnswer<unknown>) => void) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (sender.id !== chrome.runtime.id || typeof type !== 'string') return false;
    if (TAB_NOTES.has(type)) {
      const fromFacebook = sender.tab !== undefined && sender.url && facebookUrl(sender.url);
      if (fromFacebook && isTabNote(message)) {
        takeNote(message);
        if (OWN_STEPS.has(type)) void markActive();
      }
      return false;
    }
    const ours = sender.url?.startsWith(chrome.runtime.getURL(''));
    if (!ours || !HFOS_ASKS.has(type)) return false;
    const ask = message as HfosAsk;
    void (
      ask.type === 'hfos-here'
        ? markActive().then(() => ({ ok: true as const, value: null }))
        : ask.type === 'hfos-today'
          ? answerNoting(ask)
          : AUTO_ASKS.has(ask.type)
            ? answerAuto(ask as Parameters<typeof answerAuto>[0])
            : ask.type === 'hfos-sign-out'
              ? // The last beat says so while the sign-in still works, so the app doesn't call it offline.
                signOff().then(() => answer(ask))
              : answer(ask as Parameters<typeof answer>[0])
    ).then((answered) => {
      respond(answered);
      if (!SIGN_INS.has(ask.type)) return;
      void followNow(true);
      // Signing in here makes this the computer that works.
      if (ask.type !== 'hfos-sign-out' && answered.ok) void markActive();
    });
    return true;
  },
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) void tick();
  if (alarm.name === BEAT_ALARM) void beat(true);
  void followNow();
});
// The background woke: it listens again, and the channel keeps it awake while Chrome is open.
void followNow();
// Chrome started, or the extension was updated: the alarm may be gone.
chrome.runtime.onStartup.addListener(() => void wake());
chrome.runtime.onInstalled.addListener(() => void wake());
