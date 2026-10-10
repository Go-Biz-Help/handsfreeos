/**
 * Working on its own, in the side panel (docs/outreach.md, decisions 26 to 33): what the person lets the extension do
 * for them on Facebook without pressing anything, and when, the once-a-day jobs among it; then what it's doing and what
 * those jobs found, with **Start my day** and **Stop for today**. The choices are kept in HandsFreeOS, each person's own (packages/core/src/addons/outreach/automation.ts);
 * the background's runner does the work (src/auto/run.ts), and this watches where it is.
 */
import {
  hourWords,
  hoursWords,
  SENDING_MODES,
  SENDING_MODE_KEYS,
  WEEKDAY_WORDS,
  type AutomationSettings,
  type SendingMode,
} from '@hfos/core/addons/outreach/automation';
import { DAILY_NAMES } from '../auto/daily';
import { AUTO_STATE_KEY, DAILY_JOBS, isState, type AutoKind, type AutoState } from '../auto/plan';
import type { AutoStatus } from '../hfos/messages';
import { ask } from './ask';
import { ago, button, chip, counted, h, type Child } from './dom';
import { onWarning } from './warnings';

let box: HTMLElement;
let status: AutoStatus | null = null;
let problem: string | null = null;
/** The choices as the person is changing them, before they're saved. */
let draft: AutomationSettings | null = null;
let saving = false;
let saved: string | null = null;

const DONE_WORDS: Record<AutoKind, readonly [string, string]> = {
  confirm: ['request confirmed', 'requests confirmed'],
  warm_up: ['post liked', 'posts liked'],
  friend_request: ['friend request', 'friend requests'],
  comment: ['comment', 'comments'],
};

/** Asks the background for the person's choices and where the runner is. */
export async function refreshAuto(): Promise<void> {
  const answer = await ask({ type: 'hfos-auto' });
  take(answer);
}

function take(answer: Awaited<ReturnType<typeof ask<{ type: 'hfos-auto' }>>>): void {
  if (answer.ok) {
    [status, problem] = [answer.value, null];
    draft = answer.value.automation ? structuredClone(answer.value.automation.settings) : null;
  } else problem = answer.problem.message;
  draw();
}

async function save(): Promise<void> {
  if (!status?.businessId || !draft) return;
  saving = true;
  saved = null;
  draw();
  const answer = await ask({
    type: 'hfos-auto-save',
    input: { workspaceId: status.businessId, settings: draft },
  });
  saving = false;
  if (!answer.ok) {
    saved = answer.problem.message;
    return draw();
  }
  saved = 'Saved.';
  take(answer);
}

// ---- Drawing ----

const clock = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function choicesView(settings: AutomationSettings, timezone: string): Child[] {
  const modes = SENDING_MODE_KEYS.map((mode: SendingMode) => {
    const pick = h('input', { type: 'radio', name: 'auto-sending' });
    pick.checked = settings.sending === mode;
    pick.addEventListener('change', () => {
      if (pick.checked) draft = { ...settings, sending: mode };
      draw();
    });
    return h('label', { class: 'auto' }, pick, ` ${SENDING_MODES[mode]}`);
  });
  const tick = (label: string, on: boolean, change: (on: boolean) => AutomationSettings) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', () => {
      draft = change(box.checked);
    });
    return h('label', { class: 'auto' }, box, ` ${label}`);
  };
  const hourPick = (value: number, from: number, to: number, change: (hour: number) => void) => {
    const select = h('select', {});
    for (let hour = from; hour <= to; hour++) {
      const option = h('option', { value: String(hour) }, hourWords(hour));
      option.selected = hour === value;
      select.append(option);
    }
    select.addEventListener('change', () => change(Number(select.value)));
    return select;
  };
  const days = WEEKDAY_WORDS.map((word, day) => {
    const on = h('input', { type: 'checkbox' });
    on.checked = settings.hours.days.includes(day);
    on.addEventListener('change', () => {
      const now = draft ?? settings;
      const picked = on.checked
        ? [...now.hours.days, day]
        : now.hours.days.filter((d) => d !== day);
      draft = { ...now, hours: { ...now.hours, days: picked.sort((a, b) => a - b) } };
    });
    return h('label', { class: 'day' }, on, ` ${word}`);
  });
  return [
    h('h3', {}, 'What it does on its own'),
    ...modes,
    tick('Like one of their posts a day before each friend request', settings.warmUp, (warmUp) => ({
      ...(draft ?? settings),
      warmUp,
    })),
    tick(
      'Confirm friend requests from people who fit a playbook',
      settings.confirmRequests,
      (confirmRequests) => ({ ...(draft ?? settings), confirmRequests }),
    ),
    tick(
      'Once a day, first: check friend requests, save group members, find posts and read my chats',
      settings.collect,
      (collect) => ({ ...(draft ?? settings), collect }),
    ),
    h('h3', {}, 'When'),
    h(
      'p',
      { class: 'hours' },
      'From ',
      hourPick(settings.hours.start, 0, 23, (start) => {
        const now = draft ?? settings;
        draft = { ...now, hours: { ...now.hours, start } };
      }),
      ' to ',
      hourPick(settings.hours.end, 1, 24, (end) => {
        const now = draft ?? settings;
        draft = { ...now, hours: { ...now.hours, end } };
      }),
    ),
    h('p', { class: 'days' }, ...days),
    h(
      'p',
      { class: 'muted' },
      `On your business’s clock (${timezone}), at random times spread over the hours.`,
    ),
    h(
      'div',
      { class: 'actions' },
      button(saving ? 'Saving…' : 'Save', () => void save(), {
        primary: true,
        disabled: saving,
      }),
    ),
    saved ? h('p', { class: 'muted', role: 'status' }, saved) : null,
  ];
}

function stateView(now: AutoStatus, settings: AutomationSettings, state: AutoState): Child[] {
  if (settings.sending === 'off') return [];
  const counts = (Object.keys(DONE_WORDS) as AutoKind[])
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
          'Noting is off, so the extension doesn’t work on its own. Turn on “Note what I do on Facebook” above.',
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
    h(
      'p',
      { class: 'muted' },
      'It works in a window of its own beside yours, while Chrome is open. Leave that window be; it closes when it’s done.',
    ),
  ];
}

async function act(type: 'hfos-auto-start' | 'hfos-auto-stop'): Promise<void> {
  take(await ask({ type }));
}

function draw(): void {
  if (!box) return;
  const automation = status?.automation ?? null;
  const shown = automation !== null || problem !== null || status?.trouble;
  box.hidden = !shown;
  if (!shown) return box.replaceChildren();
  const settings = draft ?? automation?.settings ?? null;
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
      'Let the extension do some of your list for today by itself. It keeps your daily limits, goes at a person’s pace, and stops for the day on any warning from Facebook. Messages always wait for you.',
    ),
    ...(settings && automation ? choicesView(settings, automation.timezone) : []),
    ...(status && automation ? stateView(status, automation.settings, status.state) : []),
  ];
  details.append(...parts.filter((part): part is Node | string => Boolean(part)));
  box.replaceChildren(details);
}

export function startAuto(into: HTMLElement): void {
  box = into;
  onWarning(() => void refreshAuto());
  chrome.storage.onChanged.addListener((changes, area) => {
    const next: unknown = changes[AUTO_STATE_KEY]?.newValue;
    if (area !== 'local' || !status || !isState(next)) return;
    status = { ...status, state: next };
    draw();
  });
  void refreshAuto();
}
