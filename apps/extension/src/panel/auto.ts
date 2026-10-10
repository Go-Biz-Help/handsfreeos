/**
 * Working on its own, in the side panel (docs/outreach.md, decisions 26 to 33): what the person lets the extension do
 * for them on Facebook without pressing anything, and when, the once-a-day jobs among it; then what it's doing and what
 * those jobs found, with **Start my day** and **Stop for today**. The choices are set in HandsFreeOS, each person's own
 * (decision 37, packages/core/src/addons/outreach/automation.ts): this shows them read-only with **Change in
 * HandsFreeOS**. The background's runner does the work (src/auto/run.ts) and follows them live (src/hfos/follow.ts).
 */
import {
  hoursWords,
  settingsSummary,
  wheelsWords,
  type AutomationSettings,
} from '@hfos/core/addons/outreach/automation';
import { DAILY_NAMES } from '../auto/daily';
import { AUTO_STATE_KEY, DAILY_JOBS, isState, type AutoState, type DoneKind } from '../auto/plan';
import { SETTINGS_KEY } from '../hfos/follow';
import type { AutoStatus } from '../hfos/messages';
import { ask } from './ask';
import { ago, button, chip, counted, h, hfosLink, type Child } from './dom';
import { onWarning } from './warnings';

let box: HTMLElement;
let status: AutoStatus | null = null;
let problem: string | null = null;
/** Why HandsFreeOS refused Start my day or Stop for today, in its words. */
let refused: string | null = null;

const DONE_WORDS: Record<DoneKind, readonly [string, string]> = {
  confirm: ['request confirmed', 'requests confirmed'],
  warm_up: ['post liked', 'posts liked'],
  friend_request: ['friend request', 'friend requests'],
  comment: ['comment', 'comments'],
  drafted: ['message written', 'messages written'],
  sent: ['message sent', 'messages sent'],
};

/** Asks the background for the person's choices and where the runner is. */
export async function refreshAuto(): Promise<void> {
  const answer = await ask({ type: 'hfos-auto' });
  take(answer);
}

function take(answer: Awaited<ReturnType<typeof ask<{ type: 'hfos-auto' }>>>): void {
  if (answer.ok) [status, problem] = [answer.value, null];
  else problem = answer.problem.message;
  draw();
}

// ---- Drawing ----

const clock = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Where the person's choices are changed: HandsFreeOS, never here (decision 39). */
const settingsUrl = (now: AutoStatus) =>
  now.businessId ? `${now.webUrl}/app/w/${now.businessId}/a/outreach?view=settings` : null;

function summaryView(now: AutoStatus, settings: AutomationSettings): Child[] {
  const url = settingsUrl(now);
  return [
    h('ul', { class: 'list' }, ...settingsSummary(settings).map((line) => h('li', {}, line))),
    url ? h('div', { class: 'actions' }, hfosLink('Change in HandsFreeOS', url)) : null,
  ];
}

function stateView(now: AutoStatus, settings: AutomationSettings, state: AutoState): Child[] {
  if (settings.sending === 'off') return [];
  const counts = (Object.keys(DONE_WORDS) as DoneKind[])
    .filter((kind) => (state.done[kind] ?? 0) > 0)
    .map((kind) => counted(state.done[kind]!, DONE_WORDS[kind][0], DONE_WORDS[kind][1]));
  const next =
    state.stopped || state.working || state.nextAt === null
      ? null
      : `Next step: ${clock(state.nextAt)}.`;
  const daily = DAILY_JOBS.filter((job) => state.daily?.[job] !== undefined);
  return [
    h('h3', {}, 'Today'),
    !now.noting
      ? h(
          'p',
          { class: 'warn-line' },
          'Noting is off, so the extension doesn’t work on its own. Turn on “Note my steps on Facebook” in HandsFreeOS.',
        )
      : null,
    state.line
      ? h(
          'p',
          { class: 'status', role: 'status' },
          state.line,
          state.lineAt && !state.working
            ? h('span', { class: 'muted' }, ` · ${ago(new Date(state.lineAt).toISOString())}`)
            : null,
        )
      : h('p', { class: 'muted' }, `It works ${hoursWords(settings.hours)}.`),
    counts.length ? h('p', {}, `Done today: ${counts.join(', ')}.`) : null,
    daily.length
      ? h(
          'ul',
          { class: 'list' },
          ...daily.map((job) =>
            h('li', {}, h('strong', {}, DAILY_NAMES[job]), ' ', state.daily![job]!),
          ),
        )
      : null,
    next ? h('p', { class: 'muted' }, next) : null,
    h(
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
    refused ? h('p', { class: 'warn-line', role: 'alert' }, refused) : null,
    h(
      'p',
      { class: 'muted' },
      'It works in a window of its own beside yours, while Chrome is open. Leave that window be; it closes when it’s done.',
    ),
  ];
}

async function act(type: 'hfos-auto-start' | 'hfos-auto-stop'): Promise<void> {
  const answer = await ask({ type });
  if (answer.ok) return ((refused = null), take(answer));
  // Refused: the choices are as they were; the panel says why beside the buttons.
  refused = answer.problem.message;
  draw();
}

function draw(): void {
  if (!box) return;
  const automation = status?.automation ?? null;
  const shown = automation !== null || problem !== null || status?.trouble;
  box.hidden = !shown;
  if (!shown) return box.replaceChildren();
  const live = automation?.settings.sending ?? 'off';
  const details = h('details', {});
  details.open = (box.querySelector('details') as HTMLDetailsElement | null)?.open === true;
  const parts: Child[] = [
    h(
      'summary',
      {},
      h(
        'h2',
        {},
        'On its own ',
        chip(live === 'off' ? 'Off' : 'On', live === 'off' ? 'plain' : 'saved'),
      ),
    ),
    problem || status?.trouble
      ? h('p', { class: 'muted' }, `Couldn’t get your choices. ${problem ?? status?.trouble}`)
      : null,
    h(
      'p',
      { class: 'muted' },
      'The extension does some of your list for today by itself, as you choose in HandsFreeOS. It keeps your daily limits, goes at a person’s pace, and stops for the day on any warning from Facebook. Changes you make there reach it within seconds.',
    ),
    automation?.wheels.on ? h('p', { class: 'warn-line' }, wheelsWords(automation.wheels)) : null,
    ...(status && automation ? summaryView(status, automation.settings) : []),
    ...(status && automation ? stateView(status, automation.settings, status.state) : []),
  ];
  details.append(...parts.filter((part): part is Node | string => Boolean(part)));
  box.replaceChildren(details);
}

export function startAuto(into: HTMLElement): void {
  box = into;
  onWarning(() => void refreshAuto());
  chrome.storage.onChanged.addListener((changes, area) => {
    // Changed in HandsFreeOS: the background has them already.
    if (area === 'local' && changes[SETTINGS_KEY]) return void refreshAuto();
    const next: unknown = changes[AUTO_STATE_KEY]?.newValue;
    if (area !== 'local' || !status || !isState(next)) return;
    status = { ...status, state: next };
    draw();
  });
  void refreshAuto();
}
