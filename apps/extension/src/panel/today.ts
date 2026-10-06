/**
 * Today on Facebook, in the side panel: the person's steps so far today against the daily limits, the people they
 * reached and who wrote back, and the last few steps noted; with the switch that turns noting on and off, and a link
 * to the activity panel in HandsFreeOS (docs/outreach.md, decisions 7 and 8). The background notes the steps and
 * answers for the day (src/hfos/noting.ts); this asks it, and asks again whenever it notes one.
 */
import {
  DAILY_LIMITS,
  DAILY_STEPS,
  DAILY_WORDS,
  TOUCH_KINDS,
} from '@hfos/core/addons/outreach/limits';
import type { Activity, Noted, Problem, Today, Touched } from '../hfos/messages';
import { ask } from './ask';
import { ago, chip, counted, h, hfosLink, type Child } from './dom';

/** How often the panel asks again while it's open: the day ends, and a step may wait to be sent. */
const AGAIN_MS = 2 * 60_000;
/** How long after a step is noted it asks: steps come in runs. */
const SOON_MS = 800;

let box: HTMLElement;
let today: Today | null = null;
let problem: Problem | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let switching = false;

/** Asks the background for the day and draws it. */
export async function refreshToday(): Promise<void> {
  clearTimeout(timer);
  const answer = await ask({ type: 'hfos-today' });
  if (answer.ok) [today, problem] = [answer.value, null];
  else problem = answer.problem;
  draw();
}

function soon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshToday(), SOON_MS);
}

async function turn(on: boolean): Promise<void> {
  switching = true;
  draw();
  const answer = await ask({ type: 'hfos-noting', on });
  switching = false;
  if (answer.ok) [today, problem] = [answer.value, null];
  else problem = answer.problem;
  draw();
}

/** What a step was, in a few words: "Message · Dana Reyes · chat started". */
function stepWords(noted: Noted): string {
  const place =
    noted.step === 'first_message'
      ? 'chat started'
      : noted.step === 'follow_up'
        ? 'follow-up'
        : null;
  return [TOUCH_KINDS[noted.kind], noted.name, place].filter(Boolean).join(' · ');
}

/** "6 people reached · 1 wrote back". */
function reachedWords(people: number, replies: number): string {
  const reached = `${people.toLocaleString()} ${people === 1 ? 'person' : 'people'} reached`;
  return replies ? `${reached} · ${replies.toLocaleString()} wrote back` : reached;
}

function recentView(recent: readonly Noted[]): Child {
  if (!recent.length) return null;
  return h(
    'div',
    {},
    h('h3', {}, 'Last noted'),
    h(
      'ul',
      { class: 'recent' },
      ...recent.map((noted) =>
        h(
          'li',
          {},
          h('span', {}, stepWords(noted)),
          h('span', { class: 'muted' }, ` · ${ago(noted.at)}`),
          noted.state === 'waiting' ? chip('Waiting to send') : null,
          noted.state === 'not_saved' ? chip('Not saved', 'warn') : null,
          noted.repeated ? h('span', { class: 'muted' }, ' · noted already') : null,
          noted.why ? h('div', { class: 'error' }, noted.why) : null,
        ),
      ),
    ),
  );
}

function limitsView(activity: Activity): Child[] {
  const done = activity.today;
  const past = DAILY_STEPS.filter((step) => done[step] > DAILY_LIMITS[step]);
  return [
    h(
      'ul',
      { class: 'limits' },
      ...DAILY_STEPS.map((step) => {
        const count = done[step];
        const limit = DAILY_LIMITS[step];
        const fill = h('span', { class: 'fill' });
        fill.style.width = `${Math.min(100, Math.round((count / limit) * 100))}%`;
        return h(
          'li',
          { class: count >= limit ? 'full' : undefined },
          h('span', { class: 'label' }, DAILY_WORDS[step].label),
          h('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
          h('span', { class: 'of' }, `${count} of ${limit}`),
        );
      }),
    ),
    past.length
      ? h(
          'p',
          { class: 'warn-line' },
          `Past today’s limit for ${past.map((step) => DAILY_WORDS[step].many).join(' and ')}. Slow down, so Facebook doesn’t block you.`,
        )
      : null,
    h('p', { class: 'muted' }, reachedWords(activity.numbers.people, activity.numbers.replies)),
  ];
}

function draw(): void {
  if (!box) return;
  const activity = today?.activity ?? null;
  // Why there are no numbers: HandsFreeOS's words, or the background's when it couldn't answer at all.
  const trouble = activity ? null : (today?.trouble ?? problem?.message ?? null);
  box.hidden = !activity && !trouble;
  if (box.hidden) return box.replaceChildren();
  const parts: Child[] = [
    h(
      'h2',
      {},
      'Today on Facebook',
      activity && today?.businessId
        ? h(
            'span',
            { class: 'see-all' },
            hfosLink('See all', `${today.webUrl}/app/w/${today.businessId}/a/outreach`),
          )
        : null,
    ),
    trouble ? h('p', { class: 'muted' }, `Couldn’t get today’s numbers. ${trouble}`) : null,
    today && !today.noting
      ? h(
          'p',
          { class: 'muted' },
          'Noting is off, so the steps you take on Facebook aren’t counted here.',
        )
      : null,
    ...(activity ? limitsView(activity) : []),
    today?.waiting
      ? h(
          'p',
          { class: 'muted' },
          `${counted(today.waiting, 'step')} waiting to be sent to HandsFreeOS.`,
        )
      : null,
    recentView(today?.recent ?? []),
    today ? switchView(today) : null,
  ];
  box.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
}

/** The switch that turns noting on and off. */
function switchView(now: Today): Child {
  const toggle = h('input', { type: 'checkbox' });
  toggle.checked = now.noting;
  toggle.disabled = switching;
  toggle.addEventListener('change', () => void turn(toggle.checked));
  return h('label', { class: 'auto' }, toggle, ' Note what I do on Facebook');
}

/** Draws the day into `into`, and asks again when a step is noted, and every few minutes while the panel shows. */
export function startToday(into: HTMLElement): void {
  box = into;
  chrome.runtime.onMessage.addListener((note: Touched | undefined) => {
    if (note?.type === 'hfos-touched') soon();
    return false;
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshToday();
  }, AGAIN_MS);
  void refreshToday();
}
