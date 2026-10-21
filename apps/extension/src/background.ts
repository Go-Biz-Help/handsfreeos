/**
 * The extension's background worker. It opens the side panel when the toolbar button is pressed, and it holds the
 * sign-in to HandsFreeOS: the side panel asks it to sign in (src/hfos/session.ts). Its script in a tab of a network it
 * works on tells it the steps the person takes there, which it notes as that network's (src/hfos/noting.ts), and what
 * the tab in front of them shows (src/hfos/looked.ts); it knows the network by the tab's address (src/networks/), and
 * takes nothing from a network that's off. That script is never answered, and only the extension's own pages are. It
 * keeps each network's script on its site only while the person works that network and Chrome allows it
 * (src/networks/scripts.ts). Its alarm wakes the runner that works on Facebook on its own, once the person turns that
 * on (src/auto/run.ts), and LinkedIn's, Alignable's and Instagram's beside it (src/auto/linkedin.ts,
 * src/auto/alignable.ts, src/auto/instagram.ts). It does what the person asks of this computer from HandsFreeOS
 * (src/asks/run.ts). It follows the person's settings in HandsFreeOS from the
 * moment they sign in (src/hfos/follow.ts), and sends a first-timer to HandsFreeOS's setup (src/hfos/setup.ts). Every
 * minute while someone is signed in it tells HandsFreeOS how things stand on this computer, and hears from it about
 * the person's day (src/hfos/live.ts). It keeps the number of things waiting for the person on its icon, and Chrome's
 * pop-ups about them, which open Needs you in HandsFreeOS (src/hfos/waiting.ts).
 */
import { answerAsk, askSoon, askTabIds, heardAsk, recoverAsk, signInChanged } from './asks/run';
import { AUTO_ALARM, answerAuto, runnerTabId, tick, wake } from './auto/run';
import { LINKEDIN_ALARM, linkedInRunnerTabId, linkedInTick, wakeLinkedIn } from './auto/linkedin';
import {
  ALIGNABLE_ALARM,
  alignableRunnerTabId,
  alignableTick,
  wakeAlignable,
} from './auto/alignable';
import {
  INSTAGRAM_ALARM,
  instagramRunnerTabId,
  instagramTick,
  wakeInstagram,
} from './auto/instagram';
import { kitOf } from './networks';
import { isWorking, NETWORKS_KEY, statesNow } from './networks/on';
import { syncNetworks } from './networks/scripts';
import { follow, loadSettings, SETTINGS_KEY } from './hfos/follow';
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
import { PLACE_KEY } from './hfos/messages';
import { answer, savingTo } from './hfos/session';
import {
  answerWaiting,
  heardWaiting,
  openWaiting,
  refreshWaitingIfOld,
  waitingSoon,
} from './hfos/waiting';
import { firstRun } from './hfos/setup';
import { TAB_NOTES } from './messages';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error('Couldn’t set the side panel to open from the toolbar', error),
  );

/** After these, whose settings it follows may have changed. */
const SIGN_INS = new Set(['hfos-check-code', 'hfos-password', 'hfos-pick', 'hfos-sign-out']);

/** The person's own steps on a network: this computer is the one they use. */
const OWN_STEPS = new Set(['hfos-noted', 'hfos-answered']);

/**
 * Loads the settings when asked, and listens for changes to them and to the person's day; a wake from the live
 * channel has the runner look. Then tells HandsFreeOS it's signed in, and at a sign-in (`signedIn`) opens its setup
 * for a first-timer (src/hfos/setup.ts). The minute's beat goes while someone is signed in.
 */
async function followNow(load = false, signedIn = false): Promise<void> {
  try {
    const found = load ? await loadSettings() : null;
    await follow(
      () => void tick(),
      (payload) => void heard(payload),
      (payload) => void heardWaiting(payload),
      (payload) => void heardAsk(payload),
    );
    await firstRun(found, signedIn);
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
      // A tab of a network it knows, by its address: never what the tab says it is.
      const kit = sender.tab !== undefined && sender.url ? kitOf(sender.url) : null;
      if (!kit) return false;
      const tabId = sender.tab?.id ?? null;
      void statesNow().then((states) => {
        // A network that's off takes nothing, though a tab of it opened while it was on still tells.
        if (!isWorking(kit, states)) return;
        // What the person's front tab showed; never the extension's own work, in the runner's or an ask's tab.
        if (type === 'hfos-looked') {
          const ours =
            tabId !== null &&
            (askTabIds().includes(tabId) ||
              tabId === runnerTabId() ||
              tabId === linkedInRunnerTabId() ||
              tabId === alignableRunnerTabId() ||
              tabId === instagramRunnerTabId());
          if (!ours && isLooked(message)) void looked(message, kit.platform);
          return;
        }
        if (isTabNote(message)) {
          void takeNote(message, kit.platform);
          if (OWN_STEPS.has(type)) void markActive();
        }
      });
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
      // A prompt answered on the phone or the web signs in like a code does; every other look at it changes nothing.
      const promptSignedIn =
        ask.type === 'hfos-prompt-check' &&
        answered.ok &&
        (answered.value as { status?: unknown } | null)?.status === 'signed-in';
      if (!SIGN_INS.has(ask.type) && !promptSignedIn) return;
      // An ask under way for whoever was signed in here before stops.
      void signInChanged();
      void followNow(true, ask.type !== 'hfos-sign-out');
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
  if (alarm.name === LINKEDIN_ALARM) void linkedInTick();
  if (alarm.name === ALIGNABLE_ALARM) void alignableTick();
  if (alarm.name === INSTAGRAM_ALARM) void instagramTick();
  if (alarm.name === BEAT_ALARM) {
    void beat(true);
    // Steps noted while HandsFreeOS couldn't be reached go now.
    void sendWaitingSteps();
    // Nothing heard on the live channel for a while: it asks what waits again.
    void refreshWaitingIfOld();
  }
  void followNow();
});
// A pop-up about what waits, clicked, or its button: Needs you opens in HandsFreeOS. Registered here at the top, so a
// click wakes the background to answer it.
chrome.notifications.onClicked.addListener((id) => openWaiting(id));
chrome.notifications.onButtonClicked.addListener((id) => openWaiting(id));
// The icon's number, from the last look or a new one.
void refreshWaitingIfOld();
// The background woke: it listens again, and the channel keeps it awake while Chrome is open.
void followNow();
// An ask left under way when Chrome or the extension stopped is ended as lost; any waiting start.
void recoverAsk().then(() => askSoon());
// Which networks it works on: when it wakes, when the settings or who's signed in change, and when the person allows
// or takes back a network's site in Chrome. A network's script runs on its site only while both say so.
void syncNetworks();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (SETTINGS_KEY in changes || PLACE_KEY in changes) void syncNetworks();
  // A network just turned on and allowed: the asks waiting on its line start.
  if (NETWORKS_KEY in changes) {
    askSoon();
    void linkedInTick();
    void alignableTick();
    void instagramTick();
  }
});
chrome.permissions.onAdded.addListener(() => void syncNetworks());
chrome.permissions.onRemoved.addListener(() => void syncNetworks());
// Chrome started, or the extension was updated: the alarm may be gone.
chrome.runtime.onStartup.addListener(() => {
  void wake();
  void wakeLinkedIn();
  void wakeAlignable();
  void wakeInstagram();
});
chrome.runtime.onInstalled.addListener(() => {
  void wake();
  void wakeLinkedIn();
  void wakeAlignable();
  void wakeInstagram();
  void syncNetworks();
  // What the old side panel kept, which nothing reads now.
  void chrome.storage.local.remove(['autoRead', 'hfos.recent']).catch(() => undefined);
  void chrome.storage.session.remove('hfos.recent').catch(() => undefined);
});
