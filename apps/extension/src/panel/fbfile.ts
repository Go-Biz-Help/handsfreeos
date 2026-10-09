/**
 * Your Facebook file, in the side panel (docs/outreach.md, decision 16). The extension gets Facebook's download file
 * for the person: it asks Facebook for it, downloads it when it's ready, and gets the chat backup, pressing the buttons
 * on Facebook's own pages in a tab the person can see (src/facebook/fetch.ts). Facebook asks for their password and
 * their PIN, which they type themselves; a step it can't find on the page it hands to them, and carries on after.
 *
 * Then it finds the zips among Chrome's downloads, reads them in the panel, where they stay, and brings them in the
 * way the Friends tab's card does: names and moments, never what a message said (src/hfos/files.ts).
 */
import {
  DOWNLOAD_LIST_KEYS,
  DOWNLOAD_LISTS,
  DownloadError,
  downloadParts,
  readDownload,
  type DownloadRead,
} from '@hfos/core/addons/outreach/download-read';
import { FETCH_PLANS, type FetchJob, type FetchStep, type StepResult } from '../facebook/fetch';
import { fileNameOf, fileUrlOf, isFacebookZip } from '../hfos/files';
import type { FetchAnswer, FetchAsk } from '../messages';
import { ask } from './ask';
import { button, counted, h, hfosLink, type Child } from './dom';

const KEPT = 'hfos.facebookFile';
/** How long a step is looked for before it's handed to the person; a screen that may not come, less. */
const WAIT_MS = 12_000;
const WAIT_OPTIONAL_MS = 4_000;
/** Between steps, while Facebook draws what a press opened. */
const SETTLE_MS = 1_200;
/** How long it waits for the person to type their password or PIN before it stops. */
const TYPING_MS = 15 * 60_000;
/** The newest Facebook zips shown. */
const FILES_SHOWN = 8;

/** What the panel keeps between openings: when the file was asked for, and which zips were brought in. */
interface Kept {
  readonly requestedAt?: string;
  readonly broughtIn?: Readonly<Record<string, string>>;
}

interface FoundFile {
  readonly id: number;
  readonly path: string;
  readonly bytes: number;
  readonly at: string;
}

type Run =
  | { readonly job: FetchJob; readonly state: 'going'; readonly line: string }
  /** A step it couldn't find: the person does it, then carries on. */
  | { readonly job: FetchJob; readonly state: 'stuck'; readonly line: string }
  | { readonly job: FetchJob; readonly state: 'typing'; readonly line: string }
  | { readonly job: FetchJob; readonly state: 'done' | 'failed'; readonly line: string };

type Bring =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading'; readonly done: number; readonly all: number }
  | { readonly kind: 'read'; readonly read: DownloadRead; readonly ids: readonly number[] }
  | { readonly kind: 'sending'; readonly done: number; readonly all: number }
  | { readonly kind: 'sent'; readonly words: string; readonly friendsUrl: string | null }
  | {
      readonly kind: 'failed';
      readonly message: string;
      /** Set when it was sending: trying again carries on from the part that didn't go. */
      readonly again?: {
        readonly read: DownloadRead;
        readonly ids: readonly number[];
        readonly importId?: string;
        readonly from: number;
      };
    };

let box: HTMLElement;
let kept: Kept = {};
let files: FoundFile[] = [];
let fileAccess = false;
let run: Run | null = null;
let bring: Bring = { kind: 'idle' };
let tabId: number | null = null;
/** Set by Stop; the run looks at it before every step. */
let stopped = false;
/** Pressed Carry on: the run goes on from the step after the one handed to the person. */
let carryOn: (() => void) | null = null;
/** Whether the section is open: the person's choice once they've made one, else open until a file is in. */
let opened: boolean | null = null;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function keep(change: Partial<Kept>): Promise<void> {
  kept = { ...kept, ...change };
  await chrome.storage.local.set({ [KEPT]: kept }).catch(() => undefined);
}

// ---- Getting the file ----

/** The tab the steps happen in: the one opened before when it's still there, else a new one at the plan's page. */
async function openTab(url: string): Promise<number> {
  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.update(tabId, { url, active: true });
      if (tab?.id !== undefined) return await loaded(tab.id);
    } catch {
      // Closed since.
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  tabId = tab.id ?? null;
  if (tabId === null) throw new Error('Chrome didn’t open the tab.');
  return loaded(tabId);
}

/** Waits for a tab to finish loading, and for Facebook to draw the page. */
async function loaded(id: number): Promise<number> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete') break;
    await pause(300);
  }
  await pause(2 * SETTLE_MS);
  return id;
}

async function askTab(message: FetchAsk): Promise<FetchAnswer> {
  if (tabId === null) return { ok: false, error: 'The Facebook tab was closed.' };
  const id = tabId;
  try {
    return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer;
  } catch {
    // A tab opened before the extension was loaded or updated doesn't have its script yet.
    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
      return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer;
    } catch {
      return {
        ok: false,
        error:
          'Facebook took the tab somewhere else. Check you’re signed in to Facebook in this browser, then try again.',
      };
    }
  }
}

function set(next: Run): void {
  run = next;
  draw();
}

/** Hands a step to the person, and waits for them to press Carry on (or Stop). */
function handOver(job: FetchJob, step: FetchStep): Promise<void> {
  set({
    job,
    state: 'stuck',
    line: `Couldn’t find that step on the page. ${step.says} Then press Carry on.`,
  });
  return new Promise((done) => (carryOn = done));
}

/** Waits while Facebook asks the person to type, asking again until the step shows. */
async function whileTyping(job: FetchJob, again: () => Promise<FetchAnswer>): Promise<FetchAnswer> {
  set({
    job,
    state: 'typing',
    line: 'Facebook is asking for your password or PIN. Type it in the Facebook tab, and this carries on after.',
  });
  const until = Date.now() + TYPING_MS;
  for (;;) {
    const answer = await again();
    if (stopped || !answer.ok || answer.result !== 'waiting' || Date.now() > until) return answer;
  }
}

const DONE: Record<FetchJob, string> = {
  request:
    'Facebook is making your file. It emails you when it’s ready, often within a few hours. Then press Download my file.',
  download:
    'Type your Facebook password if it asks. Once Chrome has downloaded the file, it shows below. If Facebook made more than one part, press Download on each.',
  backup: 'Type your PIN if Facebook asks. Once Chrome has downloaded the backup, it shows below.',
};

/** Does a job's steps in the tab, handing to the person what it can't find or mustn't type. */
async function go(job: FetchJob): Promise<void> {
  const plan = FETCH_PLANS[job];
  stopped = false;
  set({ job, state: 'going', line: 'Opening Facebook…' });
  try {
    const id = await openTab(plan.url);
    let nothingToDo: string | null = null;
    if (plan.mode === 'steps') nothingToDo = await bySteps(job, plan.steps);
    else await byPath(job, plan.steps);
    if (plan.then && !stopped && !nothingToDo) {
      // The path led to a page of its own: let it load, then do its choices in order.
      await loaded(id);
      nothingToDo = await bySteps(job, plan.then);
    }
    if (stopped) return;
    if (nothingToDo) {
      set({ job, state: 'done', line: nothingToDo });
      return;
    }
    if (job === 'request') await keep({ requestedAt: new Date().toISOString() });
    set({ job, state: 'done', line: DONE[job] });
  } catch (error) {
    if (!stopped)
      set({
        job,
        state: 'failed',
        line: error instanceof Error ? error.message : 'Something went wrong. Try again.',
      });
  }
}

/** Does steps in order. When the page says there's nothing to do, what to tell the person; else null. */
async function bySteps(job: FetchJob, steps: readonly FetchStep[]): Promise<string | null> {
  let before: StepResult = 'done';
  for (const [i, step] of steps.entries()) {
    if (stopped) return null;
    if (step.afterPrevious && before !== 'done' && before !== 'already') {
      before = 'missing';
      continue;
    }
    set({
      job,
      state: 'going',
      line:
        step.action === 'stopIf'
          ? 'Checking whether Facebook is making your file already…'
          : `Step ${i + 1} of ${steps.length}: ${step.says}`,
    });
    const once = () =>
      askTab({
        type: 'hfos-fetch-step',
        step,
        waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, once);
    if (stopped) return null;
    if (!answer.ok) throw new Error(answer.error);
    if (answer.result === 'stop') return step.says;
    before = answer.result;
    if (answer.result === 'missing' || answer.result === 'waiting') {
      if (step.optional) continue;
      await handOver(job, step);
      before = 'done';
      continue;
    }
    await pause(SETTLE_MS);
  }
  return null;
}

async function byPath(job: FetchJob, steps: readonly FetchStep[]): Promise<void> {
  let from = 0;
  while (from < steps.length && !stopped) {
    set({ job, state: 'going', line: `Looking for: ${steps[from]!.says}` });
    const once = () => askTab({ type: 'hfos-fetch-path', steps, from, waitMs: WAIT_MS });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, once);
    if (stopped) return;
    if (!answer.ok) throw new Error(answer.error);
    if (answer.at !== undefined) {
      from = answer.at + 1;
      await pause(SETTLE_MS);
      continue;
    }
    // The person presses it, or a step past it; the path carries on from wherever the page is then.
    await handOver(job, steps[from]!);
  }
}

// ---- The files ----

/** Facebook's zips among Chrome's downloads, the newest first. */
async function findFiles(): Promise<void> {
  try {
    const items = await chrome.downloads.search({
      state: 'complete',
      exists: true,
      orderBy: ['-startTime'],
      limit: 200,
    });
    files = items
      .filter((item) =>
        isFacebookZip({
          url: item.url,
          finalUrl: item.finalUrl,
          referrer: item.referrer,
          filename: item.filename,
          mime: item.mime,
        }),
      )
      .slice(0, FILES_SHOWN)
      .map((item) => ({
        id: item.id,
        path: item.filename,
        bytes: item.fileSize > 0 ? item.fileSize : item.totalBytes,
        at: item.endTime ?? item.startTime,
      }));
  } catch {
    files = [];
  }
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
  draw();
}

/** A downloaded file, opened where Chrome saved it. */
function open(file: FoundFile): Promise<Blob> {
  return new Promise((done, failed) => {
    const request = new XMLHttpRequest();
    request.open('GET', fileUrlOf(file.path));
    request.responseType = 'blob';
    request.onload = () =>
      request.response instanceof Blob && request.response.size > 0
        ? done(request.response)
        : failed(new Error('empty'));
    request.onerror = () => failed(new Error('unreadable'));
    request.send();
  });
}

const notBroughtIn = () => files.filter((f) => !kept.broughtIn?.[String(f.id)]);

async function readFiles(): Promise<void> {
  const picked = notBroughtIn();
  if (!picked.length) return;
  bring = { kind: 'reading', done: 0, all: 0 };
  draw();
  try {
    const blobs = await Promise.all(picked.map(open));
    const read = await readDownload(blobs, (done, all) => {
      bring = { kind: 'reading', done, all };
      draw();
    });
    bring = { kind: 'read', read, ids: picked.map((f) => f.id) };
  } catch (error) {
    bring = {
      kind: 'failed',
      message:
        error instanceof DownloadError
          ? error.message
          : 'Those files couldn’t be opened. Check they’re still in your downloads folder, then try again.',
    };
  }
  draw();
}

/** Sends the parts in order, from `from`, as the Friends tab's card does. */
async function send(read: DownloadRead, ids: readonly number[], importId?: string, from = 0) {
  const account = await ask({ type: 'hfos-account' });
  if (!account.ok || !account.value.signedIn || !account.value.businessId) {
    bring = {
      kind: 'failed',
      message: account.ok
        ? 'Sign in above, and pick a business with Social Outreach, to bring the file in.'
        : account.problem.message,
      again: { read, ids, importId, from },
    };
    draw();
    return;
  }
  const { businessId, webUrl } = account.value;
  const parts = downloadParts(read);
  let id = importId;
  for (let i = from; i < parts.length; i++) {
    bring = { kind: 'sending', done: i, all: parts.length };
    draw();
    const sent = await ask({
      type: 'hfos-save-download',
      input: {
        workspaceId: businessId,
        madeAt: read.madeAt,
        ...(id ? { importId: id } : {}),
        people: parts[i]!.people,
        chats: parts[i]!.chats,
        last: i === parts.length - 1,
      },
    });
    if (!sent.ok) {
      bring = {
        kind: 'failed',
        message: sent.problem.message,
        again: { read, ids, importId: id, from: i },
      };
      draw();
      return;
    }
    id = sent.value.importId;
    if (sent.value.counts) {
      const { linked } = sent.value.counts;
      const now = new Date().toISOString();
      await keep({
        broughtIn: { ...kept.broughtIn, ...Object.fromEntries(ids.map((f) => [String(f), now])) },
      });
      bring = {
        kind: 'sent',
        words: `Your Facebook file is in. ${linked.toLocaleString()} ${linked === 1 ? 'name matches' : 'names match'} people saved in HandsFreeOS.`,
        friendsUrl: `${webUrl}/app/w/${businessId}/a/outreach?view=friends`,
      };
    }
  }
  draw();
}

// ---- Drawing ----

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function counts(read: DownloadRead): HTMLElement {
  const by = new Map<string, number>();
  for (const p of read.people) by.set(p.list, (by.get(p.list) ?? 0) + 1);
  const rows = [
    ...DOWNLOAD_LIST_KEYS.map((k) => [DOWNLOAD_LISTS[k], by.get(k) ?? 0] as const),
    ['Chats', read.chats.length] as const,
  ].filter(([, n]) => n > 0);
  return h(
    'ul',
    { class: 'lines' },
    ...rows.map(([label, n]) => h('li', {}, `${label}: ${n.toLocaleString()}`)),
  );
}

function runView(): Child {
  if (!run) return null;
  const going = run.state === 'going' || run.state === 'stuck' || run.state === 'typing';
  return h(
    'div',
    { class: run.state === 'failed' || run.state === 'stuck' ? 'warn-line' : 'run-line' },
    h('p', { role: 'status' }, run.line),
    going
      ? h(
          'div',
          { class: 'actions' },
          run.state === 'stuck'
            ? button(
                'Carry on',
                () => {
                  const next = carryOn;
                  carryOn = null;
                  next?.();
                },
                { primary: true },
              )
            : null,
          button('Stop', () => {
            stopped = true;
            const next = carryOn;
            carryOn = null;
            next?.();
            set({ job: run!.job, state: 'failed', line: 'Stopped. Nothing more is pressed.' });
          }),
        )
      : null,
  );
}

function stepView(n: number, text: string, note: Child, label: string, job: FetchJob): HTMLElement {
  const busy =
    run !== null && (run.state === 'going' || run.state === 'stuck' || run.state === 'typing');
  return h(
    'li',
    {},
    h('span', {}, `${n}. ${text}`),
    note ? h('span', { class: 'muted' }, ' ', note) : null,
    h(
      'div',
      {},
      button(label, () => void go(job), { disabled: busy }),
    ),
  );
}

function filesView(): Child[] {
  if (!files.length)
    return [h('p', { class: 'muted' }, 'No Facebook files in your downloads yet.')];
  const waiting = notBroughtIn();
  const list = h(
    'ul',
    { class: 'lines' },
    ...files.map((f) =>
      h(
        'li',
        {},
        `${fileNameOf(f.path)} · ${size(f.bytes)} · ${day(f.at)}`,
        kept.broughtIn?.[String(f.id)] ? h('span', { class: 'chip saved' }, 'Brought in') : null,
      ),
    ),
  );
  const out: Child[] = [list];
  if (!waiting.length) return out;
  if (!fileAccess) {
    out.push(
      h(
        'p',
        { class: 'warn-line' },
        'To open these files, Chrome needs your OK once: press the button, then turn on “Allow access to file URLs”, and come back here.',
      ),
      h(
        'div',
        { class: 'actions' },
        button('Open the extension’s settings', () => {
          void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
        }),
        button('Check again', () => void findFiles()),
      ),
    );
    return out;
  }
  switch (bring.kind) {
    case 'idle':
      out.push(
        h(
          'div',
          { class: 'actions' },
          button(`Read ${counted(waiting.length, 'file')}`, () => void readFiles(), {
            primary: true,
          }),
        ),
      );
      break;
    case 'reading':
      out.push(
        h(
          'p',
          { role: 'status' },
          bring.all
            ? `Reading your files: ${bring.done.toLocaleString()} of ${bring.all.toLocaleString()} parts`
            : 'Opening your files…',
        ),
      );
      break;
    case 'read': {
      const { read, ids } = bring;
      out.push(
        h('p', {}, `In your files, made ${day(read.madeAt)}:`),
        counts(read),
        h(
          'div',
          { class: 'actions' },
          button('Bring them in', () => void send(read, ids), { primary: true }),
        ),
      );
      break;
    }
    case 'sending':
      out.push(
        h(
          'p',
          { role: 'status' },
          bring.all > 1
            ? `Bringing it in: part ${(bring.done + 1).toLocaleString()} of ${bring.all.toLocaleString()}`
            : 'Bringing it in…',
        ),
      );
      break;
    case 'sent':
      break;
    case 'failed': {
      const again = bring.again;
      out.push(
        h('p', { class: 'warn-line' }, bring.message),
        h(
          'div',
          { class: 'actions' },
          again
            ? button(
                'Try again',
                () => void send(again.read, again.ids, again.importId, again.from),
                {
                  primary: true,
                },
              )
            : button('Try again', () => void readFiles(), { primary: true }),
        ),
      );
      break;
    }
  }
  return out;
}

function draw(): void {
  if (!box) return;
  const sent =
    bring.kind === 'sent'
      ? h(
          'p',
          {},
          bring.words,
          ' ',
          bring.friendsUrl ? hfosLink('See your friends', bring.friendsUrl) : null,
        )
      : null;
  const details = h('details', {}, h('summary', {}, h('h2', {}, 'Your Facebook file')));
  const busy = run !== null && run.state !== 'done' && run.state !== 'failed';
  details.open =
    busy || bring.kind !== 'idle' || (opened ?? !Object.keys(kept.broughtIn ?? {}).length);
  details.addEventListener('toggle', () => (opened = details.open));
  const inside: Child[] = [
    h(
      'p',
      { class: 'muted' },
      'Facebook’s own copy of your friends, requests and chats, for the Friends tab. The extension presses the buttons on Facebook; you type your password or PIN when it asks.',
    ),
    h(
      'ol',
      { class: 'fetch-steps' },
      stepView(
        1,
        'Ask Facebook for your file',
        kept.requestedAt ? `Asked ${day(kept.requestedAt)}.` : null,
        'Ask Facebook',
        'request',
      ),
      stepView(2, 'Download it once Facebook emails you', null, 'Download my file', 'download'),
      stepView(3, 'Get your chat backup, for newer chats', null, 'Get my chat backup', 'backup'),
    ),
    runView(),
    h('h3', {}, 'Files in your downloads'),
    ...filesView(),
    sent,
  ];
  for (const child of inside) if (child) details.append(child);
  box.replaceChildren(details);
}

export async function startFacebookFile(into: HTMLElement): Promise<void> {
  box = into;
  try {
    const found: unknown = (await chrome.storage.local.get(KEPT))[KEPT];
    if (found && typeof found === 'object') kept = found as Kept;
  } catch {
    kept = {};
  }
  chrome.downloads.onChanged.addListener((change) => {
    if (change.state?.current === 'complete') void findFiles();
  });
  chrome.downloads.onErased.addListener(() => void findFiles());
  await findFiles();
}

/** Looks for new files again: the panel was opened, or the person pressed Read this page. */
export function refreshFacebookFile(): void {
  void findFiles();
}
