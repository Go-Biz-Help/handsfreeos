/**
 * Next up, in the side panel (docs/outreach.md, decisions 26 to 33, 41, 43, 59 and 72): how it's doing, in the top
 * bar; what the extension is doing or does next, and why it isn't working when it isn't (another computer works,
 * noting is off, Facebook warned you today); a warning when their own steps today go past a daily limit; today's steps
 * against the limits; **Start my day** and **Stop for today**, or Get ready's items until the person is ready
 * (decision 63); and what they asked of it from HandsFreeOS while it goes, each network's ask under way on its own
 * line with **Stop**. A step an ask hands the person says what to do, and to press **Carry on** in HandsFreeOS's
 * Needs you, with a link there: the panel shows progress, and answers nothing waiting. Under the list, Done today,
 * the newest of the day's steps; at the foot, the person's settings in one line (the hours and training wheels in it),
 * with **Change in HandsFreeOS**. Everything else is in HandsFreeOS. The background's runner does the work
 * (src/auto/run.ts), and the asks (src/asks/run.ts).
 */
import {
  ASK_KINDS,
  askNameOn,
  askNeedsYou,
  askRepliesFor,
  type AskKind,
} from '@hfos/core/addons/outreach/asks';
import { settingsSummary } from '@hfos/core/addons/outreach/automation';
import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { PLATFORM_KEYS, PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { PRE_DAY_TITLE, preDayCount, preDaySteps } from '@hfos/core/addons/outreach/lists';
import {
  dayGoing,
  REPORTED_STATES,
  standDownWords,
  stateTone,
} from '@hfos/core/addons/outreach/live';
import {
  adviceLeft,
  blocksStart,
  holdingCount,
  READY_WORDS,
} from '@hfos/core/addons/outreach/readiness';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { outreachPath, type OutreachTab } from '@hfos/core/addons/outreach/setup';
import { AUTO_STATE_KEY, isState } from '../auto/plan';
import { askKeyOf, type KeptAsk } from '../hfos/asks';
import { SETTINGS_KEY } from '../hfos/follow';
import { LIVE_KEY, reportedStatus } from '../hfos/live';
import type { AutoStatus } from '../hfos/messages';
import { carryOnWords, NEEDS_YOU_LINK, needsYouUrl } from '../hfos/needs-you';
import { WARNED_KEY } from '../hfos/warned';
import { ask } from './ask';
import { ago, button, h, hfosLink, type Child } from './dom';

/** Training wheels, in the settings line: HandsFreeOS says the rest. */
const WHEELS_SHORT = 'Training wheels: each message waits for your OK';

let box: HTMLElement;
let doneBox: HTMLElement | null = null;
let chipBox: HTMLElement | null = null;
let settingsBox: HTMLElement | null = null;
let status: AutoStatus | null = null;
let problem: string | null = null;
/** Why HandsFreeOS refused Start my day or Stop for today, or a press about the ask, in its words. */
let refused: string | null = null;
/** Each network's ask under way here, as the background keeps them: Facebook's first. */
let unders: KeptAsk[] = [];
/** Where each network's ask under way is kept. */
const ASK_KEYS = PLATFORM_KEYS.map(askKeyOf);

/** Asks the background for the person's choices and where the runner is. */
export async function refreshStatus(): Promise<void> {
  const answer = await ask({ type: 'hfos-auto' });
  if (answer.ok) [status, problem] = [answer.value, null];
  else problem = answer.problem.message;
  draw();
}

async function readAsk(): Promise<void> {
  try {
    const found = await chrome.storage.local.get(ASK_KEYS);
    unders = ASK_KEYS.flatMap((key) => {
      const kept: unknown = found[key];
      return kept && typeof kept === 'object' ? [kept as KeptAsk] : [];
    });
  } catch {
    unders = [];
  }
  draw();
}

const clock = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
/** "2:04 PM", for the day's steps. */
const clockShort = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const hfosUrl = (now: AutoStatus, view: OutreachTab) =>
  now.businessId ? `${now.webUrl}${outreachPath(now.businessId, view)}` : null;

async function act(type: 'hfos-auto-start' | 'hfos-auto-stop'): Promise<void> {
  const answer = await ask({ type });
  if (answer.ok) [status, refused] = [answer.value, null];
  // Refused: the day is as it was; the panel says why beside the buttons.
  else refused = answer.problem.message;
  draw();
}

/** Stop, for an ask under way here. Carry on and Skip are pressed in HandsFreeOS, under Needs you (decision 72). */
async function stopAsk(askId: string): Promise<void> {
  const answer = await ask({ type: 'hfos-ask-stop', askId });
  refused = answer.ok ? null : answer.problem.message;
  draw();
}

/**
 * What the person asked from HandsFreeOS, while it goes: on a network but Facebook, named. A step handed to them says
 * what to do (its line), then to press Carry on in HandsFreeOS's Needs you, with a link there; a code from their email
 * says where to look (its line), with the same link, where they type it.
 */
function askView(a: KeptAsk): Child {
  const kind = a.kind as AskKind;
  const stuck = askNeedsYou(a.state);
  const carryOn = a.state === 'stuck' ? carryOnWords(askRepliesFor(kind)) : null;
  // A code from their email is typed in Needs you too: the link goes there.
  const needsYou =
    (carryOn || a.state === 'code') && status?.webUrl
      ? needsYouUrl(status.webUrl, a.businessId)
      : null;
  const on = a.platform && a.platform !== 'facebook' ? `, on ${PLATFORMS[a.platform]}` : '';
  return h(
    'div',
    { class: stuck ? 'warn-line asked' : 'run-line asked' },
    h(
      'p',
      {},
      h('strong', {}, `Asked from HandsFreeOS${on}: `),
      // The kind's name on its network: "Check LinkedIn", "Read your LinkedIn profile".
      ASK_KINDS[kind] ? askNameOn(kind, a.platform ?? 'facebook') : 'Something you asked',
      a.about ? ` · ${a.about}` : '',
    ),
    a.line ? h('p', { role: 'status' }, a.line) : null,
    carryOn ? h('p', {}, carryOn) : null,
    h(
      'div',
      { class: 'actions' },
      needsYou ? hfosLink(NEEDS_YOU_LINK, needsYou) : null,
      button('Stop', () => void stopAsk(a.askId)),
    ),
  );
}

/** Today's steps against the daily limits, from HandsFreeOS: only those it may take today. */
function metersView(now: AutoStatus): Child {
  const limits = now.today?.limits;
  if (!limits) return null;
  const steps = DAILY_STEPS.filter((step) => limits[step].most > 0);
  if (!steps.length) return null;
  return h(
    'ul',
    { class: 'meters', 'aria-label': W.todaySoFar },
    ...steps.map((step) => {
      const { done, most } = limits[step];
      const full = done >= most;
      return h(
        'li',
        { class: full ? 'meter full' : 'meter' },
        h(
          'div',
          {},
          h('span', { class: 'label' }, DAILY_WORDS[step].label),
          h('span', { class: 'count' }, `${done} / ${most}`),
        ),
        h(
          'div',
          { class: 'bar' },
          h('span', { style: `width: ${Math.min(100, Math.round((done / most) * 100))}%` }),
        ),
      );
    }),
  );
}

/** How it's doing, in the panel's top bar: the same words and colours as HandsFreeOS's. */
function stateChip(now: AutoStatus | null): void {
  if (!chipBox) return;
  const automation = now?.automation;
  if (!now || !automation) {
    chipBox.hidden = true;
    return;
  }
  const standing = now.live !== null && !now.live.working;
  const reported = reportedStatus(now.state, automation.settings, standing).state;
  chipBox.hidden = false;
  chipBox.className = `state ${stateTone(reported)}`;
  chipBox.textContent = REPORTED_STATES[reported];
}

/** Next up: what it's doing or does next, why it isn't working when it isn't, the day's steps, and the day's buttons. */
/**
 * The steps before the first day, as a live checklist: each ticked once done, the one under way with its progress
 * line ("Reading your friends… 1,240 friends so far."). Nothing once they're all done.
 */
export const PRE_DAY_TICKS = { done: '✓', now: '•', next: '○' } as const;
/** For screen readers, after each step's name. */
const PRE_DAY_STATE_WORDS = { done: ': done', now: ': under way', next: ': to come' } as const;

export function preDayView(state: AutoStatus['state']): Child {
  const steps = preDaySteps(state.lists, {
    doing: state.beforeNow ?? null,
    line: state.working && state.beforeNow ? state.line : null,
  });
  if (!steps.length) return null;
  return h(
    'div',
    { class: 'run-line' },
    h('p', {}, h('strong', {}, PRE_DAY_TITLE), ` · ${preDayCount(steps)}`),
    h(
      'ol',
      { class: 'pre-day', 'aria-label': PRE_DAY_TITLE },
      ...steps.map((step) =>
        h(
          'li',
          { class: step.state, 'aria-current': step.state === 'now' ? 'step' : undefined },
          h('span', { class: 'tick', 'aria-hidden': 'true' }, PRE_DAY_TICKS[step.state]),
          h(
            'span',
            {},
            step.label,
            h('span', { class: 'sr-only' }, PRE_DAY_STATE_WORDS[step.state]),
          ),
          step.progress ? h('span', { class: 'progress', role: 'status' }, step.progress) : null,
        ),
      ),
    ),
  );
}

/** What's under the profile while it's left: that the day doesn't wait on it (decision 90). */
const adviceNote = (holding: number): string =>
  holding ? READY_WORDS.profileNoHold : READY_WORDS.profileLater;

/**
 * Get ready (decisions 63 and 90): until the person is ready, Next up is what's left before the extension reaches
 * anyone, each item ticked as it's done, and where to finish it. Only what holds the day is counted; the profile is
 * advice, shown with what's left of it and that the day doesn't wait on it. What only reads still goes meanwhile.
 */
function readyView(now: AutoStatus): Child[] {
  const ready = now.ready;
  if (!ready || ready.ready) return [];
  const { done, of } = holdingCount(ready.items);
  const holding = of - done;
  const url = hfosUrl(now, 'today');
  return [
    h('p', { class: 'overline' }, W.rightNow),
    h('p', { class: 'next-title' }, READY_WORDS.title),
    h('p', { class: 'muted' }, READY_WORDS.cardHint(holding)),
    h(
      'ol',
      { class: 'pre-day', 'aria-label': READY_WORDS.title, 'data-testid': 'panel-ready' },
      ...ready.items.map((i) => {
        const finished = i.state === 'done';
        const advice = !finished && !blocksStart(i.item);
        return h(
          'li',
          {
            class: finished ? 'done' : advice ? 'next advice' : 'next',
            'data-testid': `panel-ready-${i.item}`,
          },
          h('span', { class: 'tick', 'aria-hidden': 'true' }, finished ? '✓' : '○'),
          h(
            'span',
            {},
            READY_WORDS.items[i.item].label,
            h('span', { class: 'sr-only' }, `: ${READY_WORDS.states[i.state]}`),
          ),
          i.left ? h('span', { class: 'progress' }, i.left) : null,
          advice ? h('span', { class: 'progress advice-note' }, adviceNote(holding)) : null,
        );
      }),
    ),
    url ? h('div', { class: 'actions' }, hfosLink(READY_WORDS.panelGo, url)) : null,
    h('p', { class: 'muted' }, READY_WORDS.panelStill),
  ];
}

/**
 * The profile left once Get ready no longer holds the day, or the day's started (decision 90): advice beside a Start
 * that works, with what's left of it, that it can be finished later, and where.
 */
function adviceView(now: AutoStatus): Child[] {
  const items = now.ready?.items ?? [];
  const left = adviceLeft(items);
  if (!left.length) return [];
  const { done, of } = holdingCount(items);
  const url = hfosUrl(now, 'today');
  return [
    h(
      'div',
      { class: 'advice', 'data-testid': 'panel-advice' },
      ...left.map((i) =>
        h(
          'p',
          {},
          h('strong', {}, READY_WORDS.items[i.item].label),
          i.left ? ` · ${i.left}` : null,
        ),
      ),
      h('p', { class: 'muted' }, adviceNote(of - done)),
      url ? h('p', {}, hfosLink(READY_WORDS.items[left[0]!.item].go, url)) : null,
    ),
  ];
}

function stateView(now: AutoStatus): Child[] {
  const automation = now.automation;
  const state = now.state;
  if (!automation) return [];
  // Until they're ready, nothing outreach-like starts: Get ready is what's next (decision 63).
  if (now.ready && !now.ready.ready && !(state.started && !state.stopped))
    return [...readyView(now), metersView(now)];
  const settings = automation.settings;
  const off = settings.sending === 'off';
  const standing = now.live !== null && !now.live.working;
  const reported = reportedStatus(state, settings, standing).state;
  const next =
    !off && !standing && !state.stopped && !state.working && state.nextAt !== null
      ? state.nextAt
      : null;
  // Going, started or on its own in the working hours (decision 95): Stop for today alone, as on the web and the phone.
  const going =
    !state.stopped &&
    (state.started ||
      dayGoing({
        day: { date: state.day ?? '', state: 'none', why: null, via: null, at: null },
        sending: settings.sending,
        hours: settings.hours,
        timezone: automation.timezone,
        now: Date.now(),
        platform: 'facebook',
      }));
  return [
    h('p', { class: 'overline' }, next ? `Next up · ${clock(next)}` : W.rightNow),
    h(
      'p',
      { class: 'next-title' },
      state.line && !standing && !off ? state.line : REPORTED_STATES[reported],
    ),
    state.line && state.lineAt && !state.working && !standing && !off
      ? h('p', { class: 'muted' }, ago(new Date(state.lineAt).toISOString()))
      : null,
    standing ? h('p', { class: 'muted' }, standDownWords(now.live!.workingName)) : null,
    standing || off ? null : preDayView(state),
    !now.noting && !off
      ? h(
          'p',
          { class: 'warn-line' },
          'Noting is off, so the extension doesn’t work on its own. Turn on “Note my steps on Facebook” in HandsFreeOS.',
        )
      : null,
    off ? h('p', { class: 'muted' }, W.sendingOffNote) : null,
    metersView(now),
    off
      ? null
      : h(
          'div',
          { class: 'actions' },
          going
            ? null
            : button(W.startDay, () => void act('hfos-auto-start'), {
                wide: true,
                disabled: state.working,
              }),
          state.stopped
            ? null
            : button(W.stopDay, () => void act('hfos-auto-stop'), {
                wide: going,
                ghost: !going,
              }),
        ),
    ...adviceView(now),
  ];
}

/** Done today: the newest of the day's steps, as HandsFreeOS keeps them, and the rest there. */
function doneView(now: AutoStatus): Child[] {
  const steps = now.today?.steps;
  if (!steps) return [];
  const all = hfosUrl(now, 'live');
  return [
    h(
      'h2',
      {},
      W.doneToday,
      all ? h('span', { class: 'see-all' }, hfosLink('See all', all)) : null,
    ),
    steps.length
      ? h(
          'ol',
          {},
          ...steps.map((step) =>
            h(
              'li',
              { class: step.kind === 'stopped' ? 'stopped' : undefined },
              h('time', { datetime: step.at }, clockShort(Date.parse(step.at))),
              h('span', {}, step.line),
            ),
          ),
        )
      : h('p', { class: 'muted' }, W.noSteps),
  ];
}

/** The person's settings in a line, at the foot, with where to change them. */
function settingsView(now: AutoStatus | null): void {
  if (!settingsBox) return;
  const automation = now?.automation;
  if (!now || !automation) {
    settingsBox.hidden = true;
    return settingsBox.replaceChildren();
  }
  const settings = automation.settings;
  const url = hfosUrl(now, 'settings');
  settingsBox.hidden = false;
  settingsBox.replaceChildren(
    settings.sending === 'off'
      ? 'It doesn’t work on its own for you: you do everything.'
      : `${[...settingsSummary(settings), ...(automation.wheels.on ? [WHEELS_SHORT] : [])].join(' · ')}.`,
    ...(url ? [' ', hfosLink('Change in HandsFreeOS', url)] : []),
  );
}

function draw(): void {
  if (!box) return;
  const shown = status?.businessId != null || problem !== null;
  box.hidden = !shown;
  stateChip(shown ? status : null);
  settingsView(shown ? status : null);
  if (doneBox) {
    const done = shown && status ? doneView(status) : [];
    doneBox.hidden = !done.length;
    doneBox.replaceChildren(...done.filter((part): part is Node | string => Boolean(part)));
  }
  if (!shown) return box.replaceChildren();
  const warned = status?.warned ?? null;
  const parts: Child[] = [
    problem || status?.trouble
      ? h('p', { class: 'muted' }, `Couldn’t get your settings. ${problem ?? status?.trouble}`)
      : null,
    warned
      ? h(
          'p',
          { class: 'warning-note', role: 'alert' },
          `Facebook warned you today (“${warned[0]}”). The extension stops until tomorrow, and your daily limits are halved for a week.`,
        )
      : null,
    status?.pastLimit ? h('p', { class: 'warn-line', role: 'alert' }, status.pastLimit) : null,
    ...unders.map(askView),
    ...(status ? stateView(status) : []),
    refused ? h('p', { class: 'warn-line', role: 'alert' }, refused) : null,
  ];
  box.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
}

/**
 * Draws Next up into `into`, Done today into `done`, how it's doing into the top bar's `chip`, and the settings line
 * into `settingsLine`, and again whenever what they show changes.
 */
export function startStatus(
  into: HTMLElement,
  parts: { done?: HTMLElement; chip?: HTMLElement; settingsLine?: HTMLElement } = {},
): void {
  box = into;
  doneBox = parts.done ?? null;
  chipBox = parts.chip ?? null;
  settingsBox = parts.settingsLine ?? null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // An ask's line changes every few seconds: drawn from what's kept, without asking the background.
    if (ASK_KEYS.some((key) => key in changes)) void readAsk();
    // Changed in HandsFreeOS, a new beat's answer, or a warning: the background has them already.
    if (SETTINGS_KEY in changes || LIVE_KEY in changes || WARNED_KEY in changes)
      return void refreshStatus();
    const next: unknown = changes[AUTO_STATE_KEY]?.newValue;
    if (!status || !isState(next)) return;
    status = { ...status, state: next };
    draw();
  });
  void readAsk();
  void refreshStatus();
}
