/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in (src/hfos/session.ts). Its script in a Facebook tab tells
 * it the steps the person takes there, which it notes (src/hfos/noting.ts), and what the tab in front of them shows
 * (src/hfos/looked.ts); that script is never answered, and only the extension's own pages are. Its alarm wakes the
 * runner that works on Facebook on its own, once the person turns that on (src/auto/run.ts). It does what the person
 * asks of this computer from HandsFreeOS (src/asks/run.ts). It follows the person's settings in HandsFreeOS from the
 * moment they sign in (src/hfos/follow.ts). Every minute while someone is signed in it tells HandsFreeOS how things
 * stand on this computer, and hears from it about the person's day (src/hfos/live.ts). It keeps the number of things
 * waiting for the person on its icon, and Chrome's pop-ups about them (src/hfos/waiting.ts).
 */
import { answerAsk, askSoon, askTabId, heardAsk, recoverAsk, signInChanged } from './asks/run';
import { AUTO_ALARM, answerAuto, runnerTabId, tick, wake } from './auto/run';
import { facebookUrl } from './facebook/urls';
import { follow, loadSettings } from './hfos/follow';
import { BEAT_ALARM, beat, heard, keepBeating, markActive, signOff } from './hfos/live';
import { isLooked, looked } from './hfos/looked';
import {
  ASK_ASKS,
  AUTO_ASKS,
  HFOS_ASKS,
  WAITING_ASKS,
  type HfosAnswer,
  type HfosAsk,
} from './hfos/messages';
import { isTabNote, sendWaitingSteps, takeNote } from './hfos/noting';
import { answer, savingTo } from './hfos/session';
import {
  answerWaiting,
  heardWaiting,
  openWaiting,
  refreshWaitingIfOld,
  trackWindows,
  waitingSoon,
} from './hfos/waiting';
import { TAB_NOTES } from './messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

/** After these, whose settings it follows may have changed. */
const SIGN_INS = new Set(['hfos-check-code', 'hfos-password', 'hfos-pick', 'hfos-sign-out']);

/** After these, what waits for the person has changed. */
const WAITING_MOVED = new Set(['hfos-send-ok', 'hfos-send-skip']);

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
      (payload) => void heardWaiting(payload),
      (payload) => void heardAsk(payload),
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
      // What the person's front tab showed; never the extension's own work, in the runner's or an ask's tab.
      if (type === 'hfos-looked') {
        const tabId = sender.tab?.id ?? null;
        const ours = tabId !== null && (tabId === askTabId() || tabId === runnerTabId());
        if (fromFacebook && !ours && isLooked(message)) void looked(message);
        return false;
      }
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
        : ASK_ASKS.has(ask.type)
          ? answerAsk(ask as Parameters<typeof answerAsk>[0])
          : WAITING_ASKS.has(ask.type)
            ? answerWaiting(ask as Parameters<typeof answerWaiting>[0])
            : AUTO_ASKS.has(ask.type)
              ? answerAuto(ask as Parameters<typeof answerAuto>[0])
              : ask.type === 'hfos-sign-out'
                ? // The last beat says so while the sign-in still works, so the app doesn't call it offline.
                  signOff().then(() => answer(ask))
                : answer(ask as Parameters<typeof answer>[0])
    ).then((answered) => {
      respond(answered);
      if (WAITING_MOVED.has(ask.type)) waitingSoon();
      if (!SIGN_INS.has(ask.type)) return;
      // An ask under way for whoever was signed in here before stops.
      void signInChanged();
      void followNow(true);
      // Signed in, out or to another business: the icon's number and the pop-ups are theirs now.
      waitingSoon();
      // Signing in here makes this the computer that works, and asks waiting for it start.
      if (ask.type !== 'hfos-sign-out' && answered.ok) {
        void markActive();
        askSoon();
      }
    });
    return true;
  },
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) void tick();
  if (alarm.name === BEAT_ALARM) {
    void beat(true);
    // Steps noted while HandsFreeOS couldn't be reached go now.
    void sendWaitingSteps();
    // Nothing heard on the live channel for a while: it asks what waits again.
    void refreshWaitingIfOld();
  }
  void followNow();
});
// A pop-up about what waits, clicked: registered here at the top, so a click wakes the background to answer it.
chrome.notifications.onClicked.addListener((id) => openWaiting(id));
chrome.notifications.onButtonClicked.addListener((id, button) => openWaiting(id, button));
trackWindows();
// The icon's number, from the last look or a new one.
void refreshWaitingIfOld();
// The background woke: it listens again, and the channel keeps it awake while Chrome is open.
void followNow();
// An ask left under way when Chrome or the extension stopped is ended as lost; any waiting start.
void recoverAsk().then(() => askSoon());
// Chrome started, or the extension was updated: the alarm may be gone.
chrome.runtime.onStartup.addListener(() => void wake());
chrome.runtime.onInstalled.addListener(() => {
  void wake();
  // What the old side panel kept, which nothing reads now.
  void chrome.storage.local.remove(['autoRead', 'hfos.recent']).catch(() => undefined);
  void chrome.storage.session.remove('hfos.recent').catch(() => undefined);
});
