/**
 * LinkedIn's newer list of conversations, whose rows link to none of them (the owner's Check LinkedIn of 29 Oct
 * 2026), pressed open by the name each shows (docs/outreach.md, decision 150, answer 4a): the press itself
 * (src/networks/linkedin/chats.ts, browse.ts), scrolling the list from its last row, and Read my chats going through
 * the rows (src/jobs/chats.ts), each sent for the AI by the id of the conversation it opened.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '../src/networks/facebook/types';
import type { HfosAsk } from '../src/hfos/messages';
import type { ChatMemory } from '../src/jobs/chats';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { openChat, scrollChats } from '../src/networks/linkedin/browse';
import { lastRow, pressRow } from '../src/networks/linkedin/chats';
import { readPage } from '../src/networks/linkedin/page';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { readChats, LINKEDIN_MESSAGING } = await import('../src/jobs/chats');

const LI = 'https://www.linkedin.com';
const MESSAGING = `${LI}/messaging/`;
const THREAD = `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`;

/** A row as the owner's Check outlined one; `wrap` puts its middle in what takes the keyboard. */
const row = (name: string, said: string, wrap = false) => {
  const middle = `<div><div><h3><span>${name}</span></h3><time>2:21 PM</time></div><div><p>${said}</p></div></div>`;
  return `<li data-name="${name}"><div><div><img alt="${name}">
    ${wrap ? `<div tabindex="0" data-pressed="${name}">${middle}</div>` : middle}
    <div><button type="button"><span>Open the options list in your conversation with ${name}</span></button></div></div></div></li>`;
};
const list = (rows: string) =>
  `<!doctype html><html><body><main><div><div id="box">
    <div><a href="#"><div>Jump to active conversation</div></a><h2>Conversation List</h2></div>
    <ul aria-label="Conversation List"><li></li>${rows}</ul></div></div></main></body></html>`;

describe('a row of LinkedIn’s newer list, pressed open', () => {
  const doc = () =>
    new JSDOM(
      list(row('Dana Reyes', 'Dana: Tuesday works for me', true) + row('Sam Lee', 'You: Thanks')),
      { url: MESSAGING },
    ).window.document;
  const pressed = (d: Document) => {
    const got: string[] = [];
    d.addEventListener('click', (e) => {
      const t = e.target as Element;
      got.push(t.getAttribute('data-pressed') ?? t.textContent ?? '');
    });
    return got;
  };

  it('presses the part around its name that takes a press, else its name', () => {
    const d = doc();
    const got = pressed(d);
    expect(pressRow(d.body, 'dana  reyes')).toBe(true);
    expect(pressRow(d.body, 'Sam Lee')).toBe(true);
    expect(got).toEqual(['Dana Reyes', 'Sam Lee']);
    // Never a row it doesn't show, nor the row’s options button.
    expect(pressRow(d.body, 'Kim Baker')).toBe(false);
    expect(got).toHaveLength(2);
  });

  it('opens by the conversation’s link when there is one, else by the name its row shows', () => {
    const d = doc();
    const got = pressed(d);
    expect(openChat(d, MESSAGING, '', 'Dana Reyes')).toBe(true);
    expect(openChat(d, MESSAGING, '', null)).toBe(false);
    expect(openChat(d, `${LI}/feed/`, '', 'Dana Reyes')).toBe(false);
    expect(got).toEqual(['Dana Reyes']);
  });

  it('scrolls the list from its last row, for more', () => {
    const d = doc();
    vi.stubGlobal('getComputedStyle', d.defaultView!.getComputedStyle.bind(d.defaultView));
    expect(lastRow(d.body)?.getAttribute('data-name')).toBe('Sam Lee');
    const box = d.getElementById('box')!;
    box.style.overflowY = 'auto';
    let top = 0;
    Object.defineProperty(box, 'clientHeight', { get: () => 400 });
    Object.defineProperty(box, 'scrollHeight', { get: () => 900 });
    Object.defineProperty(box, 'scrollTop', {
      get: () => top,
      set: (v: number) => (top = Math.min(v, 500)),
    });
    expect(scrollChats(d, MESSAGING)).toBe(true);
    expect(top).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe('Read my chats on LinkedIn, by the newer list’s rows', () => {
  function linkedinTab() {
    let at = MESSAGING;
    const asked: { type: string; name?: string }[] = [];
    const rows =
      row('Dana Reyes', 'Dana: Tuesday works for me') +
      row('Sam Lee', 'Sam: Thanks, talk soon') +
      row('Kim Baker', 'Kim: Sounds good');
    const page = () => {
      if (at !== THREAD) return new JSDOM(list(rows), { url: MESSAGING }).window.document;
      // Her conversation open beside the same list, which still links to none.
      const doc = load('linkedin-chat.html', THREAD);
      doc.querySelector('ul[aria-label="Conversation List"]')!.innerHTML = rows;
      return doc;
    };
    const tab = {
      async open(url: string) {
        at = url;
      },
      async ask(message: { readonly type: string; readonly name?: string }) {
        asked.push({ type: message.type, ...(message.name ? { name: message.name } : {}) });
        if (message.type === 'hfos-read')
          return { ok: true, result: readPage(page(), at, new Date(), { sideOf: () => null }) };
        if (message.type === 'hfos-open-chat') {
          // Dana's row opens her conversation; Kim's doesn't open.
          if (message.name === 'Dana Reyes') at = THREAD;
          return { ok: message.name === 'Dana Reyes' };
        }
        return { ok: false };
      },
    } as unknown as JobTab;
    return { tab, asked };
  }

  it('presses each row not read lately and sends the conversation it opened, by its id', async () => {
    const { tab, asked } = linkedinTab();
    const sent: HfosAsk[] = [];
    const hfos = (async (ask: HfosAsk) => {
      sent.push(ask);
      return { ok: true, value: { saved: 1, waiting: 1 } };
    }) as unknown as Hfos;
    const job: Job = {
      tab,
      hfos,
      businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
    };
    const remembered: string[] = [];
    // Sam's row was read lately; the conversations the open page links to too.
    const memory: ChatMemory = {
      lately: async (chat: ChatSummary) =>
        chat.thread.id === 'linkedin:name:sam lee' || !chat.thread.id.startsWith('linkedin:name:'),
      remember: async (id) => void remembered.push(id),
    };
    const said: string[] = [];
    const end = await readChats(job, {
      most: 60,
      memory,
      said: (line) => said.push(line),
      again: '',
      home: LINKEDIN_MESSAGING,
    });
    expect(asked.filter((a) => a.type === 'hfos-open-chat')).toEqual([
      { type: 'hfos-open-chat', name: 'Dana Reyes' },
      { type: 'hfos-open-chat', name: 'Kim Baker' },
    ]);
    const collected = sent.filter((a) => a.type === 'hfos-collect-chats') as Extract<
      HfosAsk,
      { type: 'hfos-collect-chats' }
    >[];
    expect(collected).toHaveLength(1);
    expect(collected[0]!.input.platform).toBe('linkedin');
    expect(collected[0]!.input.chats[0]!.thread.id).toBe('2-MadeUpThreadDana0001==');
    // Dana's row is remembered with her conversation, and Kim's that didn't open, so neither is pressed again today.
    expect(remembered).toEqual(
      expect.arrayContaining([
        '2-MadeUpThreadDana0001==',
        'linkedin:name:dana reyes',
        'linkedin:name:kim baker',
      ]),
    );
    expect(said).toEqual(['Sent the chat with Dana Reyes for the AI to read.']);
    expect(end.line).toMatch(/^Done: 1 chat sent for the AI to read\./);
  });
});
