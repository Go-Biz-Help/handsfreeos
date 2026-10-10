/**
 * Right now, in the side panel (docs/outreach.md, decisions 26 to 33, 41 and 43): what the extension is doing, its next
 * step, and why it isn't working when it isn't (another computer works, noting is off, Facebook warned you today);
 * a warning when their own steps today go past a daily limit; the person's settings in one line (the hours and
 * training wheels in it), with **Change in HandsFreeOS**; **Start my day** and **Stop for today**; and what
 * they asked of it from HandsFreeOS while it goes, with **Carry on**, **Skip** and **Stop**. Everything else is in
 * HandsFreeOS. The background's runner does the work (src/auto/run.ts), and the asks (src/asks/run.ts).
 */
import {
  ASK_KINDS,
  askNeedsYou,
  askRepliesFor,
  type AskKind,
  type AskReply,
} from '@hfos/core/addons/outreach/asks';
import { settingsSummary } from '@hfos/core/addons/outreach/automation';
import { REPORTED_STATES, standDownWords } from '@hfos/core/addons/outreach/live';
import { AUTO_STATE_KEY, isState } from '../auto/plan';
import { ASK_KEY, type KeptAsk } from '../hfos/asks';
import { SETTINGS_KEY } from '../hfos/follow';
import { LIVE_KEY, reportedStatus } from '../hfos/live';
import type { AutoStatus } from '../hfos/messages';
import { WARNED_KEY } from '../hfos/warned';
import { ask } from './ask';
import { ago, button, chip, h, hfosLink, type Child } from './dom';

/** Training wheels, in the settings line: HandsFreeOS says the rest. */
const WHEELS_SHORT = 'Training wheels: each message waits for your OK';

let box: HTMLElement;
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

const hfosUrl = (now: AutoStatus, view: string) =>
  now.businessId ? `${now.webUrl}/app/w/${now.businessId}/a/outreach?view=${view}` : null;

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

function stateView(now: AutoStatus): Child[] {
  const automation = now.automation;
  const state = now.state;
  if (!automation) return [];
  const settings = automation.settings;
  const settingsUrl = hfosUrl(now, 'settings');
  const off = settings.sending === 'off';
  const standing = now.live !== null && !now.live.working;
  const reported = reportedStatus(state, settings, standing).state;
  const next =
    !off && !standing && !state.stopped && !state.working && state.nextAt !== null
      ? `Next step: ${clock(state.nextAt)}.`
      : null;
  return [
    h(
      'p',
      { class: 'now-line' },
      chip(REPORTED_STATES[reported], reported === 'working' ? 'saved' : 'plain'),
      ' ',
      state.line && !standing && !off ? state.line : '',
      state.line && state.lineAt && !state.working && !standing && !off
        ? h('span', { class: 'muted' }, ` · ${ago(new Date(state.lineAt).toISOString())}`)
        : null,
    ),
    next ? h('p', { class: 'muted' }, next) : null,
    standing ? h('p', { class: 'muted' }, standDownWords(now.live!.workingName)) : null,
    !now.noting && !off
      ? h(
          'p',
          { class: 'warn-line' },
          'Noting is off, so the extension doesn’t work on its own. Turn on “Note my steps on Facebook” in HandsFreeOS.',
        )
      : null,
    h(
      'p',
      { class: 'muted settings-line' },
      off
        ? 'It doesn’t work on its own for you: you do everything.'
        : `${[...settingsSummary(settings), ...(automation.wheels.on ? [WHEELS_SHORT] : [])].join(' · ')}.`,
      ' ',
      settingsUrl ? hfosLink('Change in HandsFreeOS', settingsUrl) : null,
    ),
    off
      ? null
      : h(
          'div',
          { class: 'actions' },
          button('Start my day', () => void act('hfos-auto-start'), {
            primary: true,
            disabled: state.working || (state.started && !state.stopped),
          }),
          button('Stop for today', () => void act('hfos-auto-stop'), {
            disabled: state.stopped !== null,
          }),
        ),
  ];
}

function draw(): void {
  if (!box) return;
  const shown = status?.businessId != null || problem !== null;
  box.hidden = !shown;
  if (!shown) return box.replaceChildren();
  const warned = status?.warned ?? null;
  const parts: Child[] = [
    h('h2', {}, 'Right now'),
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

export function startStatus(into: HTMLElement): void {
  box = into;
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
