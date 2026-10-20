/**
 * Alignable's About Us put in (src/networks/alignable/own-profile.ts, src/jobs/looking.ts; docs/outreach.md decision
 * 82): its Edit asks for a code Alignable emailed, HandsFreeOS asks the person for it, the extension puts it in where
 * Alignable asks and presses Continue, then writes About Us and presses Save. On a profile drawn as the owner's Check
 * Alignable found his (0.62.0 to 0.69.0), its code's box as he described it.
 */
import { JSDOM } from 'jsdom';
import { askCodeRanOutWords, askCodeWords } from '@hfos/core/addons/outreach/asks';
import { describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { KITS } from '../src/networks';
import { putCode, writeAboutUs } from '../src/networks/alignable/own-profile';
import type { HandOverReply, Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';

// A person's pace between pages, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const AL = 'https://www.alignable.com';
const MINE = `${AL}/biz/businesses/my_profile`;
const CODE = '482913';
const ABOUT =
  'We help Columbus homeowners keep the rain out, with free inspections after every storm. Book a call on our page.';

const PROFILE = `<!doctype html><html><head><title>Casey Owner</title></head><body><main>
  <div><h1 title="Casey Owner">Casey Owner</h1><h2 title="Owner, Summit Roofing">Owner, Summit Roofing</h2></div>
  <div><div><div>About Us</div>
    <div><button data-testid="elevator-pitch-cta-button"><p>Add Your Elevator Pitch</p></button>
      <a id="edit" href="/biz/profile/about_us?source=about_us_section"><div>Edit</div></a></div></div>
    <p id="about">Summit Roofing has fixed roofs across Columbus for twelve years.</p></div>
</main></body></html>`;

/**
 * Alignable as the owner found it: About Us's Edit asks for the code it emailed, in a box over the page with Cancel and
 * Continue; the right code opens About Us's editor in its place, whose Save puts what's written on the profile.
 */
function alignableDoes(doc: Document, sent = CODE) {
  let verified = false;
  const editor = () => {
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    box.innerHTML = `<h2>About Us</h2><textarea aria-label="About Us"></textarea>
      <button type="button">Cancel</button><button type="button">Save</button>`;
    const field = box.querySelector('textarea')!;
    field.value = doc.querySelector('#about')!.textContent ?? '';
    box.querySelectorAll('button')[1]!.addEventListener('click', () => {
      doc.querySelector('#about')!.textContent = field.value;
      box.remove();
    });
    doc.body.append(box);
  };
  doc.querySelector('#edit')!.addEventListener('click', (event) => {
    event.preventDefault();
    if (verified) return editor();
    const ask = doc.createElement('div');
    ask.setAttribute('role', 'dialog');
    ask.innerHTML = `<button aria-label="Close"></button>
      <p>To keep your account safe, we sent a verification code to your email. Enter it to keep editing.</p>
      <input type="text" /><button type="button">Cancel</button><button type="button">Continue</button>`;
    ask.querySelectorAll('button')[2]!.addEventListener('click', () => {
      if (ask.querySelector('input')!.value !== sent) {
        ask.querySelector('p')!.textContent =
          'That code isn’t right. Check the verification code we sent.';
        return;
      }
      verified = true;
      ask.remove();
      editor();
    });
    doc.body.append(ask);
  });
  return doc;
}

const profile = (sent = CODE) =>
  alignableDoes(
    new JSDOM(PROFILE, { url: `${AL}/columbus-oh/summit-roofing?user=77` }).window.document,
    sent,
  );

describe('putting About Us in, in the page', () => {
  it('says Alignable asks for its code, puts the code in, then writes About Us and saves it', async () => {
    const doc = profile();
    expect(await writeAboutUs(doc, ABOUT)).toBe('code');
    expect(await putCode(doc, CODE)).toBe('ok');
    // The code taken, its editor's open: About Us is written there and saved.
    expect(await writeAboutUs(doc, ABOUT)).toBe('done');
    expect(doc.querySelector('#about')!.textContent).toBe(ABOUT);
    expect(doc.querySelector('[role="dialog"]')).toBeNull();
    // In already: nothing pressed.
    expect(await writeAboutUs(doc, ABOUT)).toBe('done');
  }, 20_000);

  it('says a code didn’t take while Alignable still asks for it, and that there’s no box to put one in', async () => {
    vi.useFakeTimers();
    try {
      const doc = profile();
      const asked = writeAboutUs(doc, ABOUT);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await asked).toBe('code');
      const put = putCode(doc, '111111');
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await put).toBe('wrong');
    } finally {
      vi.useRealTimers();
    }
    expect(await putCode(profile(), CODE)).toBe('none');
  });
});

/** A tab on Alignable, at their own profile, reading and writing as its tab does. */
function alignableTab(doc: Document) {
  const kit = KITS.alignable;
  const opened: string[] = [];
  const asked: string[] = [];
  const tab = {
    async open(url: string) {
      if (url !== MINE) throw new Error(`Not expected: ${url}`);
      opened.push(url);
      // Opened afresh: whatever was open over the page is gone.
      for (const box of doc.querySelectorAll('[role="dialog"]')) box.remove();
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      return work();
    },
    async ask(message: { readonly type: string }) {
      asked.push(message.type);
      const at = doc.location.href;
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, at) };
      if (message.type === 'hfos-outline')
        return {
          ok: true,
          result: kit.readPage(doc, at),
          outline: kit.outline(doc, at),
          shown: true,
        };
      vi.stubGlobal('location', new URL(at));
      vi.stubGlobal('document', doc);
      try {
        return (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` };
      } finally {
        vi.unstubAllGlobals();
      }
    },
  } as unknown as JobTab;
  return { tab, opened, asked };
}

function alignableJob(tab: JobTab, codes: (string | null)[], replies: HandOverReply[] = []) {
  const checked: unknown[] = [];
  const notes: ReportNote[] = [];
  const lines: string[] = [];
  const handed: string[] = [];
  const job: Job = {
    tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      if (ask.type === 'hfos-profile-check') checked.push(ask.input);
      return { ok: true, value: {} };
    }) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
    report: async (note = {}) => void notes.push(note),
    code: async (line) => {
      lines.push(line);
      return codes.shift() ?? null;
    },
    ...(replies.length
      ? {
          handOver: async (says: string) => {
            handed.push(says);
            return replies.shift() ?? 'stop';
          },
        }
      : {}),
  };
  return { job, checked, notes, lines, handed };
}

describe('Read my profile and Put this one in, on Alignable', () => {
  it('reads their profile and sends it for the AI’s check', async () => {
    const { tab, opened } = alignableTab(profile());
    const { job, checked } = alignableJob(tab, []);
    const end = await runAsk({ kind: 'profile_read' }, job, 'alignable');
    expect(opened).toEqual([MINE]);
    expect(checked).toEqual([
      expect.objectContaining({
        platform: 'alignable',
        name: 'Casey Owner',
        about: 'Summit Roofing has fixed roofs across Columbus for twelve years.',
      }),
    ]);
    expect(end).toEqual({ line: 'Read your profile. The AI’s checked it.', warned: false });
  });

  it('asks HandsFreeOS for the code Alignable emailed, and asks again for the newest when one didn’t work', async () => {
    const doc = profile();
    const { tab, asked } = alignableTab(doc);
    const { job, checked, lines } = alignableJob(tab, ['999999', CODE]);
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const going = runAsk({ kind: 'profile_edit', bio: null, about: ABOUT }, job, 'alignable');
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect(await going).toEqual({ line: 'Your About Us is in.', warned: false });
    } finally {
      vi.useRealTimers();
    }
    expect(lines).toEqual([askCodeWords('alignable'), askCodeWords('alignable', true)]);
    expect(asked.filter((t) => t === 'hfos-put-code')).toHaveLength(2);
    expect(doc.querySelector('#about')!.textContent).toBe(ABOUT);
    // Read again for a new check.
    expect(checked).toHaveLength(1);
  }, 30_000);

  it('asks them to try again when no code came in time, and Alignable emails a new one when they do', async () => {
    const doc = profile();
    const { tab, opened, asked } = alignableTab(doc);
    const { job, lines, handed } = alignableJob(tab, [null, CODE], ['carry_on']);
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const going = runAsk({ kind: 'profile_edit', bio: null, about: ABOUT }, job, 'alignable');
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1_000);
      expect(await going).toEqual({ line: 'Your About Us is in.', warned: false });
    } finally {
      vi.useRealTimers();
    }
    expect(handed).toEqual([askCodeRanOutWords('alignable')]);
    // Their profile opened afresh, and its Edit pressed again for the new code.
    expect(opened.slice(0, 2)).toEqual([MINE, MINE]);
    expect(lines).toEqual([askCodeWords('alignable'), askCodeWords('alignable')]);
    expect(asked.filter((t) => t === 'hfos-put-code')).toHaveLength(1);
    expect(doc.querySelector('#about')!.textContent).toBe(ABOUT);
  }, 30_000);

  it('ends saying so when no code comes, with About Us as it was', async () => {
    const doc = profile();
    const { tab } = alignableTab(doc);
    const { job } = alignableJob(tab, [null]);
    const end = await runAsk({ kind: 'profile_edit', bio: null, about: ABOUT }, job, 'alignable');
    expect(end).toMatchObject({ failed: true, line: expect.stringContaining('No code came') });
    expect(doc.querySelector('#about')!.textContent).not.toBe(ABOUT);
  }, 20_000);
});
