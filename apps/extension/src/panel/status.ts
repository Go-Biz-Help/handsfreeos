/**
 * Next up, in the side panel (docs/outreach.md, decisions 26 to 33, 41, 43 and 59): how it's doing, in the top bar;
 * what the extension is doing or does next, and why it isn't working when it isn't (another computer works, noting is
 * off, Facebook warned you today); a warning when their own steps today go past a daily limit; today's steps against
 * the limits; **Start my day** and **Stop for today**; and what they asked of it from HandsFreeOS while it goes, with
 * **Carry on**, **Skip** and **Stop**. Under the list, Done today, the newest of the day's steps; at the foot, the
 * person's settings in one line (the hours and training wheels in it), with **Change in HandsFreeOS**. Everything else
 * is in HandsFreeOS. The background's runner does the work (src/auto/run.ts), and the asks (src/asks/run.ts).
 */
import {
  ASK_KINDS,
  askNeedsYou,
  askRepliesFor,
  type AskKind,
  type AskReply,
} from '@hfos/core/addons/outreach/asks';
import { settingsSummary } from '@hfos/core/addons/outreach/automation';
import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { REPORTED_STATES, standDownWords, stateTone } from '@hfos/core/addons/outreach/live';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { outreachPath, type OutreachTab } from '@hfos/core/addons/outreach/setup';
import { AUTO_STATE_KEY, isState } from '../auto/plan';
import { ASK_KEY, type KeptAsk } from '../hfos/asks';
import { SETTINGS_KEY } from '../hfos/follow';
import { LIVE_KEY, reportedStatus } from '../hfos/live';
import type { AutoStatus } from '../hfos/messages';
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
/** The ask under way here, as the background keeps it. */
let under: KeptAsk | null = null;

/** Asks the background for the person's choices and where the runner is. */
export async function refreshStatus(): Promise<void> {
  const answer = await ask({ type: 'hfos-auto' });
  if (answer.ok) [status, problem] = [answer.value, null];
  else problem = answer.problem.message;
  draw();
}

async function readAsk(): Promise<void> {
  try {
    const found: unknown = (await chrome.storage.local.get(ASK_KEY))[ASK_KEY];
    under = found && typeof found === 'object' ? (found as KeptAsk) : null;
  } catch {
    under = null;
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

async function answerAsk(reply: AskReply | 'stop'): Promise<void> {
  const answer = await ask(
    reply === 'stop' ? { type: 'hfos-ask-stop' } : { type: 'hfos-ask-reply', reply },
  );
  refused = answer.ok ? null : answer.problem.message;
  draw();
}

/** What the person asked from HandsFreeOS, while it goes. */
function askView(a: KeptAsk): Child {
  const kind = a.kind as AskKind;
  const stuck = askNeedsYou(a.state);
  const replies = a.state === 'stuck' ? askRepliesFor(kind) : [];
  return h(
    'div',
    { class: stuck ? 'warn-line asked' : 'run-line asked' },
    h(
      'p',
      {},
      h('strong', {}, 'Asked from HandsFreeOS: '),
      ASK_KINDS[kind] ?? 'Something you asked',
      a.about ? ` · ${a.about}` : '',
    ),
    a.line ? h('p', { role: 'status' }, a.line) : null,
    h(
      'div',
      { class: 'actions' },
      ...replies.map((r) =>
        button(r === 'carry_on' ? 'Carry on' : 'Skip', () => void answerAsk(r), {
          primary: r === 'carry_on',
        }),
      ),
      button('Stop', () => void answerAsk('stop')),
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
function stateView(now: AutoStatus): Child[] {
  const automation = now.automation;
  const state = now.state;
  if (!automation) return [];
  const settings = automation.settings;
  const off = settings.sending === 'off';
  const standing = now.live !== null && !now.live.working;
  const reported = reportedStatus(state, settings, standing).state;
  const next =
    !off && !standing && !state.stopped && !state.working && state.nextAt !== null
      ? state.nextAt
      : null;
  const going = state.started && !state.stopped;
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
    under ? askView(under) : null,
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
    // The ask's line changes every few seconds: drawn from what's kept, without asking the background.
    if (ASK_KEY in changes) void readAsk();
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
