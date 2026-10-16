/**
 * LinkedIn's copy of the person's data (src/networks/linkedin/data.ts, src/jobs/linkedin/file.ts): on hand-written
 * pages of LinkedIn's Get a copy of your data (test/fixtures/linkedin-data*.html), as written and again with a bare box
 * around every element, it picks the data files, ticks Connections, Invitations and Messages, presses Request archive
 * and waits while the person types their password; it downloads one that's ready and waits for Chrome to start it;
 * and it brings the zip in from Chrome's downloads, as LinkedIn's lists and chats, with LinkedIn and HandsFreeOS stood
 * in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkedInExport } from '@hfos/core/addons/outreach/linkedin-export';
import { isFacebookZip, isLinkedInZip, linkedInFileParts } from '../src/hfos/files';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { OffscreenAsk } from '../src/messages';
import { doStep, stepOnPage, type StepAsk } from '../src/networks/facebook/fetch';
import { DATA_PAGE, dataPage, LINKEDIN_FILE_PLANS } from '../src/networks/linkedin/data';
import { boxEverything, load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { runAsk } = await import('../src/asks/run');
const { LINKEDIN_FILE, LINKEDIN_FILE_KEY, NO_NEW_LINKEDIN_FILES } =
  await import('../src/jobs/linkedin/file');

const LI = 'https://www.linkedin.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ZIP = '/Users/chris/Downloads/Basic_LinkedInDataExport_10-15-2026.zip';

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const PASSWORD_BOX =
  '<div role="dialog" aria-labelledby="pw-h"><h2 id="pw-h">Enter your password</h2>' +
  '<p>For your security, enter your password to continue.</p>' +
  '<label for="pw">Password</label><input type="password" id="pw" />' +
  '<button type="button">Done</button><button type="button">Cancel</button></div>';

/** The ids of the data files ticked. */
const ticked = (doc: Document) =>
  [...doc.querySelectorAll<HTMLInputElement>('#files input')]
    .filter((i) => i.checked)
    .map((i) => i.id);

/**
 * Get a copy of your data as LinkedIn behaves: picking the files you want turns their boxes on, and Request archive
 * asks for your password. Typing it and pressing Done (the test, for the person) has LinkedIn say it's preparing it.
 */
function askingPage(boxed: boolean) {
  const doc = load('linkedin-data.html', DATA_PAGE);
  if (boxed) boxEverything(doc);
  const requested: string[][] = [];
  doc.getElementById('arc-some')!.addEventListener('change', () => {
    for (const box of doc.querySelectorAll('#files input')) box.removeAttribute('disabled');
  });
  doc.getElementById('request')!.addEventListener('click', () => {
    requested.push(ticked(doc));
    doc.body.insertAdjacentHTML('beforeend', PASSWORD_BOX);
  });
  const typePassword = () => {
    doc.querySelector('[role="dialog"]')?.remove();
    doc
      .querySelector('main')!
      .insertAdjacentHTML(
        'afterbegin',
        '<p>Your archive is being prepared. We’ll email you when it’s ready.</p>',
      );
  };
  return { doc, requested, typePassword };
}

describe('Get a copy of your data', () => {
  it('is the only page it gets the file on', () => {
    expect(dataPage(DATA_PAGE)).toBe(true);
    expect(dataPage(`${LI}/psettings/member-data`)).toBe(true);
    expect(dataPage(`${LI}/feed/`)).toBe(false);
    expect(dataPage('http://www.linkedin.com/mypreferences/d/download-my-data')).toBe(false);
    expect(dataPage('https://accountscenter.facebook.com/info_and_permissions/dyi/')).toBe(false);
  });

  it.each(asWrittenAndBoxed)(
    'picks the files, ticks Connections, Invitations and Messages, and waits for the password, %s',
    (_, boxed) => {
      const { doc, requested, typePassword } = askingPage(boxed);
      const steps = LINKEDIN_FILE_PLANS.request.steps;
      expect(steps.map((step) => doStep(doc, step))).toEqual([
        // Its own words about how long it takes don't say it's making one already.
        'missing',
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        // LinkedIn asks for the password, which the person types.
        'waiting',
      ]);
      expect((doc.getElementById('arc-some') as HTMLInputElement).checked).toBe(true);
      expect(requested).toEqual([['f-connections', 'f-messages', 'f-invitations', 'f-profile']]);
      typePassword();
      expect(doStep(doc, steps.at(-1)!)).toBe('done');
    },
  );

  it('stops when LinkedIn is making one already', () => {
    const { doc, typePassword } = askingPage(false);
    typePassword();
    expect(doStep(doc, LINKEDIN_FILE_PLANS.request.steps[0]!)).toBe('stop');
    expect(doStep(doc, LINKEDIN_FILE_PLANS.download.steps[0]!)).toBe('stop');
  });

  it.each(asWrittenAndBoxed)('presses Download archive on one that’s ready, %s', (_, boxed) => {
    const doc = load('linkedin-data-ready.html', DATA_PAGE);
    if (boxed) boxEverything(doc);
    let downloads = 0;
    let requests = 0;
    doc.getElementById('download')!.addEventListener('click', () => downloads++);
    doc.getElementById('request')!.addEventListener('click', () => requests++);
    expect(LINKEDIN_FILE_PLANS.download.steps.map((step) => doStep(doc, step))).toEqual([
      'missing',
      'done',
    ]);
    expect([downloads, requests]).toEqual([1, 0]);
  });
});

// ------------------------------------------------------------------------------------------------- the jobs

/** Chrome's downloads, kept here: what the finders search. */
let downloads: chrome.downloads.DownloadItem[] = [];
const store = new Map<string, unknown>();
/** What the offscreen page reads from the zips: core's reader, stood in for by what it would give. */
let inTheZip: LinkedInExport | null = null;
let readerParts: ReturnType<typeof linkedInFileParts>['parts'] = [];

function download(
  more: Partial<chrome.downloads.DownloadItem> & { filename: string },
): chrome.downloads.DownloadItem {
  return {
    id: downloads.length + 1,
    url: 'https://www.linkedin.com/ambry/?x-li-ambry-ep=made-up',
    finalUrl: 'https://www.linkedin.com/ambry/?x-li-ambry-ep=made-up',
    referrer: DATA_PAGE,
    mime: 'application/zip',
    startTime: new Date().toISOString(),
    state: 'complete',
    exists: true,
    ...more,
  } as chrome.downloads.DownloadItem;
}

beforeEach(() => {
  downloads = [];
  store.clear();
  inTheZip = null;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
      },
    },
    downloads: {
      search: async (query: chrome.downloads.DownloadQuery) =>
        downloads
          .filter(
            (d) =>
              (!query.state || d.state === query.state) &&
              (!query.startedAfter || d.startTime >= query.startedAfter),
          )
          .reverse(),
    },
    extension: { isAllowedFileSchemeAccess: async () => true },
    offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
    runtime: {
      sendMessage: async (ask: OffscreenAsk) => {
        if (ask.type === 'hfos-file-read') {
          if (ask.platform !== 'linkedin' || !inTheZip)
            return { ok: false, error: 'Not that one.' };
          const got = linkedInFileParts(inTheZip);
          readerParts = [...got.parts];
          return {
            ok: true,
            madeAt: inTheZip.madeAt,
            parts: got.parts.length,
            people: got.connections + got.invitations,
            chats: got.chats,
            connections: got.connections,
            invitations: got.invitations,
            noLink: got.noLink,
          };
        }
        return { ok: true, linkedin: readerParts[ask.i]! };
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * A tab on Get a copy of your data that answers the file's steps as the tab does (at once here, rather than looking
 * again for a while). `onPage` stands in for LinkedIn.
 */
function dataTab(doc: Document) {
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
      return 1;
    },
    async ask(message: StepAsk) {
      if (!dataPage(doc.location.href))
        return { ok: false, error: 'LinkedIn didn’t open its Get a copy of your data page.' };
      return { ok: true, ...(await stepOnPage(doc, { ...message, waitMs: 0 })) };
    },
  } as unknown as JobTab;
  return { tab, opened };
}

/** HandsFreeOS, answering as it would, and keeping what it was sent. */
function fakeHfos() {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    switch (ask.type) {
      case 'hfos-save-friends':
        return {
          ok: true,
          value: { saved: ask.input.people.length, added: 1, changed: 0 },
        };
      case 'hfos-save-download':
        return {
          ok: true,
          value: {
            importId: 'b1c2d3e4-0000-4000-8000-000000000001',
            counts: ask.input.last ? { linked: ask.input.chats?.length ?? 0 } : null,
            changed: 0,
          },
        };
      default:
        throw new Error(`Not expected: ${ask.type}`);
    }
  }) as unknown as Hfos;
  return { hfos, sent };
}

function jobWith(tab: JobTab, hfos: Hfos, more: Partial<Job> = {}) {
  const lines: string[] = [];
  const typing: (string | null)[] = [];
  const job: Job = {
    tab,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: (line) => lines.push(line),
    warn: async () => undefined,
    typing: (line) => typing.push(line),
    ...more,
  };
  return { job, lines, typing };
}

describe('asking LinkedIn for the file', () => {
  it('does the steps in a tab, waits while the person types their password, and keeps when', async () => {
    const { doc, requested, typePassword } = askingPage(false);
    const { tab, opened } = dataTab(doc);
    const { job, typing } = jobWith(tab, fakeHfos().hfos, {
      // The person types their password once they're asked to.
      typing: (line) => {
        typing.push(line);
        if (line) typePassword();
      },
    });
    const end = await runAsk({ kind: 'file_request' }, job, 'linkedin');
    expect(opened).toEqual([DATA_PAGE]);
    expect(requested).toEqual([['f-connections', 'f-messages', 'f-invitations', 'f-profile']]);
    expect(typing).toEqual(['Waiting for you to type your password in the LinkedIn tab…', null]);
    expect(end).toEqual({ line: LINKEDIN_FILE.done.request, warned: false });
    expect(store.get(LINKEDIN_FILE_KEY)).toEqual({ requestedAt: expect.any(String) });
    // Facebook's is its own.
    expect(store.has('hfos.facebookFile')).toBe(false);
  });

  it('says so when LinkedIn is making one already, and presses nothing', async () => {
    const { doc, requested, typePassword } = askingPage(false);
    typePassword();
    const end = await runAsk(
      { kind: 'file_request' },
      jobWith(dataTab(doc).tab, fakeHfos().hfos).job,
      'linkedin',
    );
    expect(end.line).toBe(
      'LinkedIn is already making your copy. It emails you when it’s ready; then ask for Download my file.',
    );
    expect(requested).toEqual([]);
  });

  it('hands a step it can’t find to the person, and stops when they say Stop', async () => {
    const doc = load('linkedin-data.html', DATA_PAGE);
    const asked: string[] = [];
    const { job } = jobWith(dataTab(doc).tab, fakeHfos().hfos, {
      handOver: async (says) => (asked.push(says), 'stop'),
    });
    expect((await runAsk({ kind: 'file_request' }, job, 'linkedin')).line).toBe('Stopped.');
    // Picking the files turns nothing on here, so the first box is the one it asks for.
    expect(asked).toEqual([
      'Couldn’t find that step on the page. Tick “Connections”. Then press Carry on.',
    ]);
  });
});

describe('downloading LinkedIn’s file', () => {
  it('presses Download archive and waits for Chrome to start it', async () => {
    const doc = load('linkedin-data-ready.html', DATA_PAGE);
    doc
      .getElementById('download')!
      .addEventListener('click', () =>
        downloads.push(download({ filename: ZIP, state: 'in_progress' })),
      );
    const end = await runAsk(
      { kind: 'file_download' },
      jobWith(dataTab(doc).tab, fakeHfos().hfos).job,
      'linkedin',
    );
    expect(end).toEqual({
      line: 'Downloading Basic_LinkedInDataExport_10-15-2026.zip. Once Chrome has it, ask for Bring it in.',
      warned: false,
    });
  });

  it('waits while LinkedIn asks for the password first', async () => {
    const doc = load('linkedin-data-ready.html', DATA_PAGE);
    doc
      .getElementById('download')!
      .addEventListener('click', () => doc.body.insertAdjacentHTML('beforeend', PASSWORD_BOX));
    const { job, typing } = jobWith(dataTab(doc).tab, fakeHfos().hfos, {
      typing: (line) => {
        typing.push(line);
        if (!line) return;
        doc.querySelector('[role="dialog"]')!.remove();
        downloads.push(download({ filename: ZIP }));
      },
    });
    const end = await runAsk({ kind: 'file_download' }, job, 'linkedin');
    expect(typing).toEqual(['Waiting for you to type your password in the LinkedIn tab…', null]);
    expect(end.line).toContain('Downloading Basic_LinkedInDataExport_10-15-2026.zip.');
  });

  it('says so when LinkedIn is still making it', async () => {
    const { doc, typePassword } = askingPage(false);
    typePassword();
    const end = await runAsk(
      { kind: 'file_download' },
      jobWith(dataTab(doc).tab, fakeHfos().hfos).job,
      'linkedin',
    );
    expect(end.line).toBe(
      'LinkedIn is still making your copy. It emails you when it’s ready; then ask for Download my file again.',
    );
  });
});

describe('LinkedIn’s zips among Chrome’s downloads', () => {
  const seen = (more: Partial<chrome.downloads.DownloadItem> & { filename: string }) => {
    const d = download(more);
    return {
      url: d.url,
      finalUrl: d.finalUrl,
      referrer: d.referrer,
      filename: d.filename,
      mime: d.mime,
    };
  };

  it('are the ones LinkedIn names so, or that came from Get a copy of your data', () => {
    expect(isLinkedInZip(seen({ filename: ZIP }))).toBe(true);
    expect(isLinkedInZip(seen({ filename: 'C:\\Users\\chris\\Downloads\\export (1).zip' }))).toBe(
      true,
    );
    // A zip someone sent them in LinkedIn messaging.
    expect(
      isLinkedInZip(
        seen({
          filename: '/Users/chris/Downloads/quote.zip',
          url: 'https://media.licdn.com/dms/document/made-up',
          referrer: `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`,
        }),
      ),
    ).toBe(false);
    const facebook = seen({
      filename: '/Users/chris/Downloads/facebook-chrisgee-2026-10-15.zip',
      url: 'https://bigzipfiles.facebook.com/p/dlf/made-up',
      finalUrl: 'https://bigzipfiles.facebook.com/p/dlf/made-up',
      referrer: 'https://accountscenter.facebook.com/info_and_permissions/dyi/',
    });
    expect(isLinkedInZip(facebook)).toBe(false);
    expect(isFacebookZip(seen({ filename: ZIP }))).toBe(false);
  });
});

/** What a made-up LinkedIn zip has in it, as core reads it. */
const madeUpExport = (more: Partial<LinkedInExport> = {}): LinkedInExport => ({
  madeAt: '2026-10-15T09:00:00.000Z',
  connections: [
    {
      name: 'Dana Reyes',
      url: `${LI}/in/dana-reyes-4b2a1c/`,
      at: '2024-03-02T00:00:00.000Z',
    },
    { name: 'Sam Lee', url: `${LI}/in/sam-lee-77/`, at: '2025-01-20T00:00:00.000Z' },
    { name: 'Hidden Person', url: null, at: null },
  ],
  invitations: [
    // Sam accepted it: they're a connection now.
    {
      name: 'Sam Lee',
      url: `${LI}/in/sam-lee-77/`,
      at: '2025-01-18T15:04:00.000Z',
      direction: 'sent',
    },
    {
      name: 'Morgan Ellis',
      url: `${LI}/in/morgan-ellis-3/`,
      at: '2026-08-01T10:00:00.000Z',
      direction: 'sent',
    },
    {
      name: 'Riley Park',
      url: `${LI}/in/riley-park-9/`,
      at: '2026-10-10T10:00:00.000Z',
      direction: 'received',
    },
  ],
  chats: [
    {
      name: 'Dana Reyes',
      url: `${LI}/in/dana-reyes-4b2a1c/`,
      firstAt: '2026-09-01T10:00:00.000Z',
      lastAt: '2026-10-01T10:00:00.000Z',
      messages: 4,
      lastFromMe: false,
      recent: [{ fromMe: false, text: 'Do you do water heaters?', at: '2026-10-01T10:00:00.000Z' }],
    },
  ],
  read: 4,
  unread: 0,
  ...more,
});

describe('LinkedIn’s file in parts', () => {
  it('saves connections, then the invitations still waiting, then the chats, each by its link', () => {
    const got = linkedInFileParts(madeUpExport());
    expect(got).toMatchObject({ connections: 2, invitations: 2, chats: 1, noLink: 1 });
    expect(got.parts).toEqual([
      {
        list: 'friends',
        people: [
          {
            name: 'Dana Reyes',
            profile: {
              id: null,
              username: 'dana-reyes-4b2a1c',
              url: `${LI}/in/dana-reyes-4b2a1c/`,
            },
            mutualConnections: null,
            since: '2024-03-02T00:00:00.000Z',
          },
          expect.objectContaining({ name: 'Sam Lee', since: '2025-01-20T00:00:00.000Z' }),
        ],
      },
      { list: 'requests', people: [expect.objectContaining({ name: 'Riley Park' })] },
      {
        list: 'sent',
        people: [
          expect.objectContaining({ name: 'Morgan Ellis', since: '2026-08-01T10:00:00.000Z' }),
        ],
      },
      // The chat without the other person's link: core matches it by name.
      { chats: [expect.not.objectContaining({ url: expect.anything() })] },
    ]);
  });

  it('sends a long list in parts each save takes', () => {
    const many = Array.from({ length: 1_201 }, (_, i) => ({
      name: `Member ${i}`,
      url: `${LI}/in/member-${i}/`,
      at: null,
    }));
    const got = linkedInFileParts(madeUpExport({ connections: many, invitations: [], chats: [] }));
    expect(got.parts.map((p) => ('list' in p ? p.people.length : -1))).toEqual([500, 500, 201]);
  });
});

describe('bringing LinkedIn’s file in', () => {
  it('saves its lists as LinkedIn’s, since when the file says, then its chats, once', async () => {
    downloads.push(download({ filename: ZIP }));
    downloads.push(
      download({
        filename: '/Users/chris/Downloads/facebook-chrisgee-2026-10-15.zip',
        url: 'https://bigzipfiles.facebook.com/p/dlf/made-up',
        finalUrl: 'https://bigzipfiles.facebook.com/p/dlf/made-up',
        referrer: 'https://accountscenter.facebook.com/info_and_permissions/dyi/',
      }),
    );
    inTheZip = madeUpExport();
    const { hfos, sent } = fakeHfos();
    const { job } = jobWith(dataTab(load('linkedin-data.html', DATA_PAGE)).tab, hfos);
    const end = await runAsk({ kind: 'file_in' }, job, 'linkedin');
    expect(
      sent.map((a) =>
        a.type === 'hfos-save-friends'
          ? `${a.input.platform} ${a.input.list}: ${a.input.people.map((p) => `${p.name} ${p.since ?? '-'}`).join(', ')}`
          : a.type === 'hfos-save-download'
            ? `${a.type} ${a.input.platform}: ${a.input.chats?.map((c) => c.name).join(', ')}; people ${a.input.people?.length}; last ${a.input.last}`
            : a.type,
      ),
    ).toEqual([
      'linkedin friends: Dana Reyes 2024-03-02T00:00:00.000Z, Sam Lee 2025-01-20T00:00:00.000Z',
      'linkedin requests: Riley Park 2026-10-10T10:00:00.000Z',
      'linkedin sent: Morgan Ellis 2026-08-01T10:00:00.000Z',
      'hfos-save-download linkedin: Dana Reyes; people 0; last true',
    ]);
    expect(end).toEqual({
      line: 'Your LinkedIn file is in: 2 connections, 1 invitation you’ve got, 1 invitation you’ve sent and 1 conversation (3 new to HandsFreeOS). 1 conversation matches people saved in HandsFreeOS. 1 person had no profile link in the file, so they weren’t saved.',
      warned: false,
    });
    // Kept apart from Facebook's, and not brought in twice.
    expect(Object.keys((store.get(LINKEDIN_FILE_KEY) as { broughtIn: object }).broughtIn)).toEqual([
      '1',
    ]);
    expect((await runAsk({ kind: 'file_in' }, job, 'linkedin')).line).toBe(NO_NEW_LINKEDIN_FILES);
  });

  it('says what to do when there’s no LinkedIn file in the downloads', async () => {
    const { job } = jobWith(dataTab(load('linkedin-data.html', DATA_PAGE)).tab, fakeHfos().hfos);
    expect(await runAsk({ kind: 'file_in' }, job, 'linkedin')).toEqual({
      line: NO_NEW_LINKEDIN_FILES,
      warned: false,
    });
  });
});
