import {
  AI_SETUP_WORDS,
  aiSetupStateOf,
  emptyTeammateConfig,
  startingAiSetupAnswers,
  type AiSetupStateOut,
} from '@hfos/core';
import type { DemoWorld } from '../world';
import { idsFor } from './ask-kit';
import type { DemoPlayer, DemoScene } from './types';

/**
 * Quick setup from the business's website (39): a new owner pastes their website, the AI teammate reads it and fills
 * in the screens, Save sets it up, and a test chat asks it what customers would. Played on the business's own
 * quick setup page, as though it had no teammate and nothing written about it yet. Nothing is saved, and the real
 * teammate (or none) is back on Exit.
 */

const s39 = idsFor(39);
const SOURCE = s39(0x01);
const SCAN = s39(0x02);
const TEAMMATE = s39(0x03);
const CHAT = s39(0x04);
/** The website chat's key, in the shape the database gives one (`wk_` and 20 letters or digits). */
const CHAT_KEY = 'wk_DemoPlayerChatKey039';
const iso = (ms: number) => new Date(ms).toISOString();

/** "brightpathhomeservices.com": the business's name as a website, as the email scenes name its mailbox. */
const siteOf = (w: DemoWorld) =>
  `${w.state.business.toLowerCase().replace(/[^a-z0-9]/g, '') || 'business'}.com`;

/** What it reads on the website: what the business does, its services, where it works, its hours and facts. */
const foundOf = (w: DemoWorld) => ({
  url: `https://${siteOf(w)}`,
  at: iso(w.state.startedAt),
  description: `${w.state.business} keeps homes comfortable all year. We repair and install heating and cooling systems, fix plumbing and water heaters, and clean ducts, with upfront prices and techs who show up on time.`,
  services: [
    {
      name: 'Furnace and AC repair',
      description: 'Diagnosis and repair for any make of heating or cooling system.',
    },
    {
      name: 'Seasonal tune-up',
      description: 'A full check of your system before summer or winter.',
    },
    { name: 'Water heater repair', description: 'Tank and tankless, repaired or replaced.' },
    { name: 'Drain cleaning', description: 'Slow sinks, tubs and main lines cleared.' },
    { name: 'Duct cleaning', description: 'Cleaner air and better airflow from every vent.' },
  ],
  area: 'Katy, Cypress, Spring, The Woodlands and northwest Houston',
  openHours: [
    ...[1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' })),
    { day: 6, start: '08:00', end: '12:00' },
  ],
  facts: {
    free_estimates: 'yes',
    financing: 'yes',
    emergency: 'yes',
    warranty: 'yes',
    licensed: 'yes',
    same_day: 'yes',
  } as Record<string, 'yes' | 'no'>,
  questions: [],
});

/** What the website scan found for Knowledge, for "What Ava learned". */
const FINDINGS = [
  {
    kind: 'fact',
    title: 'Comfort Club maintenance plan',
    body: 'Two tune-ups a year, priority booking and 15% off repairs, for $14.99 a month.',
  },
  {
    kind: 'fact',
    title: 'How to pay',
    body: 'We take cards, checks and cash. Payment is due when the job is done, and financing is available on new systems.',
  },
  {
    kind: 'fact',
    title: 'Repair warranty',
    body: 'Repairs come with a one-year parts and labor warranty.',
  },
  {
    kind: 'faq',
    title: 'What should I do before the tech arrives?',
    body: 'Clear a path to your indoor unit and water heater, and keep pets in another room.',
  },
  {
    kind: 'faq',
    title: 'Do you charge for a second opinion?',
    body: 'No. If another company quoted you for a new system, we’ll take a look for free.',
  },
] as const;

/** Where the screens stand, as `ai_setup.get` says: what the business has, with what the scene has done so far. */
function stateOf(w: DemoWorld, real: AiSetupStateOut): AiSetupStateOut {
  const s = w.setup!;
  return {
    ...real,
    website: s.site ? `https://${s.site}` : null,
    page: null,
    // A new business: nothing written about it yet, so what it reads fills the screens.
    profile: { ...real.profile, description: '', services: [], serviceArea: '' },
    services: [],
    openHours: null,
    facts: [],
    teammate: s.saved
      ? {
          id: TEAMMATE,
          name: w.state.teammate,
          status: 'off',
          revision: 1,
          config: emptyTeammateConfig() as unknown as Record<string, unknown>,
        }
      : null,
    chat: s.saved ? { id: CHAT, name: 'Website chat' } : null,
    scan: {
      state: s.read ? 'done' : s.reading ? 'running' : 'none',
      pending: s.read && !s.saved ? FINDINGS.length : 0,
    },
    found: s.read ? foundOf(w) : null,
    reading: s.reading,
  };
}

/** The test chat's answers, by what the question asks. Prices are off, so that one goes to a person. */
function replyTo(
  w: DemoWorld,
  question: string,
): { text: string; outcome: 'replied' | 'handed_off' } {
  const name = w.state.teammate;
  const q = question.toLowerCase();
  if (q.includes('serve'))
    return {
      text: 'Yes, we do! We cover Katy, Cypress, Spring, The Woodlands and northwest Houston. What can we help you with?',
      outcome: 'replied',
    };
  if (q.includes('estimate'))
    return {
      text: 'Yes, estimates are free. Would you like me to set one up?',
      outcome: 'replied',
    };
  if (q.includes('cost'))
    return {
      text: 'Good question! Prices depend on your system, so I’ve asked the team to send you one. Can I get your address?',
      outcome: 'handed_off',
    };
  if (q.includes('come out') || q.includes('next week'))
    return {
      text: 'Sure! We have openings next week. What day works best, and what’s going on with your system?',
      outcome: 'replied',
    };
  if (q.includes('saturday'))
    return { text: 'Yes, we’re open Saturday from 8 AM to noon.', outcome: 'replied' };
  if (q.includes('real person'))
    return {
      text: `I’m ${name}, the AI assistant for ${w.state.business.replace(/\.$/, '')}. I can answer questions and book visits, and someone on the team is always a text away.`,
      outcome: 'replied',
    };
  return {
    text: 'Happy to help! What’s going on at your home?',
    outcome: 'replied',
  };
}

/** The test chat's events, as the worker streams them: the reply a couple of words at a time, then done. */
function testStream(
  w: DemoWorld,
  body: Record<string, unknown>,
  signal: AbortSignal | null | undefined,
): Response {
  const messages = Array.isArray(body['messages'])
    ? (body['messages'] as { text?: unknown }[])
    : [];
  const { text, outcome } = replyTo(w, String(messages.at(-1)?.text ?? ''));
  const at = iso(Date.now());
  const events: { wait: number; event: Record<string, unknown> }[] = [
    { wait: 200, event: { type: 'started', runId: s39(0x50), at } },
  ];
  const words = text.split(/(?<= )/);
  for (let i = 0; i < words.length; i += 2)
    events.push({ wait: 60, event: { type: 'delta', text: words.slice(i, i + 2).join('') } });
  events.push({
    wait: 150,
    event: {
      type: 'done',
      outcome,
      reply: text,
      draft: false,
      ended: false,
      toolSteps: 0,
      ms: 1400,
      firstWordsMs: null,
      steps: null,
    },
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { wait, event } of events) {
        await new Promise((r) => setTimeout(r, wait));
        if (signal?.aborted) break;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The screen quick setup is on (`data-step`). */
const screenNow = () =>
  document.querySelector('[data-testid="ai-setup"]')?.getAttribute('data-step') ?? null;

/** Next, then waits for the screen after it. */
async function next(p: DemoPlayer) {
  const from = screenNow();
  await p.click('@ai-setup-next');
  const end = Date.now() + 8000;
  while (screenNow() === from && Date.now() < end) await p.wait(100);
  await p.wait(500);
}

const websiteSetup: DemoScene = {
  id: 'website-setup',
  number: 39,
  title: 'Set up in minutes from your website',
  kind: 'app',
  startsOn: 'ai-team/setup',
  answers: {
    'ai_setup.get': async (w, _body, real) => {
      const got = await real();
      if (!got) return undefined;
      const state = stateOf(w, got['state'] as AiSetupStateOut);
      const answers = startingAiSetupAnswers(aiSetupStateOf(state));
      const s = w.setup!;
      return {
        ...got,
        state,
        answers,
        starting: answers,
        reached: s.saved ? null : s.site ? 'business' : null,
        started: s.site ? { at: iso(w.state.startedAt), by: w.state.me.id } : null,
        finished: s.saved ? { at: iso(Date.now()), by: w.state.me.id } : null,
        runs: s.saved ? 1 : 0,
        templates: [],
        templateId: null,
        templatePicked: false,
        saveTo: null,
      };
    },
    // Each Next keeps the answers: nothing is kept here, and the next screen opens.
    'ai_setup.save': (w, body) => ({
      workspaceId: w.workspaceId,
      reached: body['step'],
      kind: 'home',
      kindChanged: false,
      scanStarted: body['step'] === 'business',
    }),
    'ai_setup.finish': () => ({
      teammateId: TEAMMATE,
      revision: 1,
      changes: [],
      chat: { widgetId: CHAT, publicKey: CHAT_KEY },
      calendarId: null,
      notes: [],
    }),
    'knowledge_scan.get': (w) => {
      const s = w.setup!;
      if (!s.site) return { source: null, scan: null };
      const at = iso(w.state.startedAt);
      return {
        source: { id: SOURCE, url: `https://${s.site}`, updatedAt: at },
        scan: {
          id: SCAN,
          status: s.read ? 'done' : 'running',
          pages: [],
          suggestionCount: s.read ? FINDINGS.length : 0,
          pendingSuggestions: s.read ? FINDINGS.length : 0,
          errors: [],
          startedBy: null,
          startedAt: at,
          finishedAt: s.read ? at : null,
          createdAt: at,
        },
      };
    },
    'knowledge_suggestion.list': (w) => ({
      // Newest first, as the list comes: the screen turns it around.
      items: w.setup!.read
        ? FINDINGS.map((f, i) => ({
            id: s39(0x30 + i),
            kind: f.kind,
            reason: 'scan',
            status: 'pending',
            proposed: { title: f.title, body: f.body, tags: [] },
            source: {},
            scanId: SCAN,
            itemId: null,
            similarCount: 0,
            decidedBy: null,
            decidedAt: null,
            createdAt: iso(w.state.startedAt),
          })).reverse()
        : [],
      nextCursor: null,
    }),
    // The presenter's own cell stays off the screen.
    'user_phone.get': () => ({ phone: null }),
    'ai_team.test': (w, body, _real, signal) => testStream(w, body, signal),
  },
  setup: (w) => {
    w.setup = { site: null, reading: false, read: false, saved: false };
  },
  steps: [
    {
      label: 'Paste your website',
      voiceover:
        'A new owner starts here. Paste your website, and your AI teammate reads it for you, so there’s almost nothing to type.',
      run: async (p) => {
        await p.waitFor('@ai-setup-website-input');
        await p.type('@ai-setup-website-input', siteOfPlayer(p));
        await p.point('@ai-setup-next');
      },
    },
    {
      label: 'It reads while you pick its jobs',
      voiceover:
        'It starts reading your pages straight away. Meanwhile you tick what you want help with: answering, booking, following up.',
      change: (w) => {
        w.setup!.site = siteOf(w);
        w.setup!.reading = true;
      },
      run: async (p) => {
        await next(p);
        // Booking ticked, so the test chat asks for a visit too.
        const book = document.querySelector('[data-testid="ai-setup-job-book"]');
        if (book?.getAttribute('aria-checked') === 'true') await p.point('@ai-setup-job-book');
        else await p.click('@ai-setup-job-book');
        await next(p);
        await p.waitFor('@ai-setup-reading');
        await p.point('@ai-setup-reading');
      },
    },
    {
      label: 'It fills in what you do',
      voiceover:
        'A few seconds later it’s written what you do, listed your services, and found where you work. You only check it.',
      change: (w) => {
        w.setup!.reading = false;
        w.setup!.read = true;
      },
      live: ['knowledge_source', 'knowledge_scan', 'knowledge_suggestion'],
      run: async (p) => {
        await p.waitFor('@ai-setup-service-0', 12_000);
        await p.point('@ai-setup-description');
        await p.point('@ai-setup-services');
        await p.point('@ai-setup-area');
      },
    },
    {
      label: 'Your hours and quick facts',
      voiceover:
        'Your hours came from the website too, and so did the quick facts: free estimates, financing, emergency calls.',
      run: async (p) => {
        await next(p);
        await p.point('@ai-setup-open-editor');
        await next(p);
        await p.point('@ai-setup-facts');
      },
    },
    {
      label: 'Name it and pick its voice',
      voiceover:
        'Give your teammate a name, and say how it tells people it’s AI. Then pick how it sounds.',
      run: async (p) => {
        await next(p);
        await p.point('@ai-setup-name');
        await p.point('@ai-setup-disclosure-first_message');
        await next(p);
        await p.point('@ai-setup-prices');
      },
    },
    {
      label: 'What it learned',
      voiceover:
        'It also found answers on your pages: your maintenance plan, how people pay, your warranty. Untick anything you don’t want it to use.',
      run: async (p) => {
        await next(p);
        await p.waitFor('@ai-setup-findings');
        await p.point('[data-testid^="ai-setup-finding-"]');
        await p.point('@ai-setup-findings');
      },
    },
    {
      label: 'Save',
      voiceover:
        'A couple more screens, then Save. It sets up your teammate, its booking, and a chat for your website.',
      change: (w) => {
        w.setup!.saved = true;
      },
      run: async (p) => {
        for (let i = 0; i < 4 && !lastScreen(); i++) await next(p);
        await p.point('@ai-setup-summary');
        await p.click('@ai-setup-next');
        await p.waitFor('@ai-setup-try', 15_000);
        await p.point('@ai-setup-chat-code');
      },
    },
    {
      label: 'Try it before it talks to anyone',
      voiceover:
        'Before it talks to a customer, it answers the questions they’d ask. Nothing is sent. Prices are off, so that one goes to you.',
      run: async (p) => {
        await p.click('@ai-setup-ask-all');
        await p.waitFor('@ai-setup-report', 30_000);
        await p.point('@ai-setup-test');
        await p.point('[data-testid^="ai-setup-test-"][data-testid$="-add"]');
      },
    },
    {
      label: 'Turn it on with training wheels',
      voiceover:
        'Happy with it? Turn it on with training wheels: it asks your OK before it sends anything, until it’s earned your trust. That’s the whole setup.',
      run: async (p) => {
        await p.point('@ai-setup-turn-on');
      },
    },
  ],
};

/** The website the first step types: the same as `siteOf`, from what the player knows. */
function siteOfPlayer(p: DemoPlayer): string {
  return `${p.business.toLowerCase().replace(/[^a-z0-9]/g, '') || 'business'}.com`;
}

/** The last screen's button says Save. */
const lastScreen = () =>
  document.querySelector('[data-testid="ai-setup-next"]')?.textContent?.trim() ===
  AI_SETUP_WORDS.save;

export const SETUP_SCENES: readonly DemoScene[] = [websiteSetup];
