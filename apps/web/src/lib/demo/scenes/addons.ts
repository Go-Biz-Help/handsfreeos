import type { Ok } from '../../api/types';
import type { DemoOutreachSend, DemoWorld } from '../world';
import { idsFor } from './ask-kit';
import { conversationIn, myFirstName, openConversation, startConversation } from './kit';
import { APPROVED, approveDraft, draftReply, newPerson, regular } from './teammate-kit';
import type { DemoScene } from './types';

/**
 * Add-ons on the business's own screens, shown as on though the business hasn't them: the AI teammate working for a
 * real estate agent (48), and Social Outreach's first messages on Facebook (49).
 */

// ------------------------------------------------------------------------------ 48. a buyer texts about a home

const s48 = idsFor(48);
const JOANNA = newPerson(
  s48(1),
  'Joanna',
  'Whitlock',
  4801,
  'Spring',
  'joanna.whitlock@example.com',
);
const CHAT = s48(0x11);
const DEAL = s48(0x21);
const ASK = s48(0x31);
const HOME = '2218 Laurel Glen Dr';

const buyerTexts: DemoScene = {
  id: 'buyer-texts',
  number: 48,
  title: 'A home buyer texts about a house',
  kind: 'teammate',
  startsOn: 'inbox',
  addons: ['realestate'],
  steps: [
    {
      label: 'A buyer texts about a house',
      voiceover:
        'With the Real Estate Agent add-on, your AI teammate works for agents too. Joanna, a buyer you’re helping, texts about a house she drove past.',
      change: (w, at) => {
        startConversation(w, at, {
          id: CHAT,
          person: regular(JOANNA, at, 0),
          firstId: s48(0x12),
          body: `Hi! We drove past ${HOME} today and loved it. Can we see it Saturday? And is it a good area for families?`,
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, CHAT);
        await p.point(`@message-${s48(0x12)}`);
      },
    },
    {
      label: 'It asks you before adding the house',
      voiceover:
        'Your teammate doesn’t add a house to her search on its own: it asks you first. Its replies also go through fair housing checks, so it sends her to the school district’s own site instead of saying who an area suits.',
      change: (w, at) => {
        conversationIn(w, CHAT).unread = 0;
        draftReply(w, CHAT, {
          id: ASK,
          at,
          inReplyTo: s48(0x12),
          body: `Great find, Joanna! I’ve asked ${myFirstName(w)} to add ${HOME} to your homes for a Saturday showing. For schools, the district’s school finder shows which ones serve it.`,
          ask: {
            addonId: 'realestate',
            operation: 'realestate.home.add',
            tool: 'realestate_ask_add_home',
            input: { address: `${HOME}, Spring, TX 77386` },
            recordId: DEAL,
            recordName: 'Joanna Whitlock · Buying',
            summary: `Add ${HOME} to Joanna’s homes`,
          },
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-ask');
      },
    },
    {
      label: 'Approve: the house is on her list',
      voiceover:
        'One tap adds it to her buyer deal, as you, and Joanna gets the text. You set up the showing from there.',
      change: (w, at) => {
        approveDraft(w, CHAT, ASK, s48(0x13), at);
      },
      live: [...APPROVED, 'activity'],
      run: async (p) => {
        await p.click('@draft-approve');
        await p.waitFor(`@message-${s48(0x13)}`);
        await p.point(`@message-${s48(0x13)}`);
      },
    },
  ],
};

// ------------------------------------------------------------------------------ 49. Social Outreach starts conversations

const s49 = idsFor(49);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** Local realtors it found in the presenter's Facebook groups, and the first message it drafted for each. */
const OPENERS = [
  {
    n: 1,
    name: 'Shonda Merritt',
    text: 'Hi Shonda! Saw your post in Katy Area Realtors about a buyer’s AC failing inspection. We do quick AC checks before closing, so if a buyer ever needs one, I’m happy to help.',
  },
  {
    n: 2,
    name: 'Phil Kaminski',
    text: 'Hey Phil, we’re both in Cypress Home Pros. I run a local heating and cooling company. If your sellers ever need an HVAC report before listing, I’d be glad to be your go-to.',
  },
  {
    n: 3,
    name: 'Lorena Estrada',
    text: 'Hi Lorena! Loved your tips on getting a home ready to list. If a seller ever needs their AC serviced before photos, we can usually get out the same week.',
  },
] as const;

const REPLY = s49(0x40);

function outreachSend(w: DemoWorld, s: DemoOutreachSend) {
  return {
    sendId: s.id,
    kind: s.kind,
    profileId: s.profileId,
    name: s.name,
    profileUrl: null,
    chatId: null,
    threadKey: null,
    text: s.text,
    state: s.state,
    why: null,
    opener: null,
    handedOver: s.kind === 'reply',
    needsYou: s.needsYou,
    createdAt: iso(s.at),
    recent: s.recent.map((m) => ({ fromMe: m.fromMe, text: m.text, at: iso(m.at) })),
    postId: null,
    postUrl: null,
    post: null,
    postWhole: null,
  };
}

/** Training wheels on: every message waits for an OK, as on a new account's first week. */
const wheelsOf = (w: DemoWorld) => ({
  on: true,
  from: iso(w.state.startedAt - 3 * DAY),
  ok: 14 + w.outreach.filter((s) => s.state === 'approved').length,
  daysLeft: 4,
  edits: 1,
});

function waitingOf(w: DemoWorld): Ok<'/v1/queries/outreach.waiting'> {
  const open = w.outreach.filter((s) => s.state === 'waiting');
  const of = (kind: 'opener' | 'reply') => {
    const these = open.filter((s) => s.kind === kind);
    const newest = these.reduce<number | null>((m, s) => (m === null || s.at > m ? s.at : m), null);
    return { count: these.length, newestAt: newest === null ? null : iso(newest) };
  };
  const none = { count: 0, newestAt: null };
  return {
    count: open.length,
    kinds: { ask: none, reply: of('reply'), message: of('opener'), need: none, request: none },
    items: open.map((s) =>
      s.kind === 'reply'
        ? { kind: 'reply' as const, at: iso(s.at), send: outreachSend(w, s) }
        : { kind: 'message' as const, at: iso(s.at), send: outreachSend(w, s) },
    ),
    wheels: wheelsOf(w),
    commentHolds: [],
    pushes: 'bundled',
    hours: { start: 8, end: 18, days: [1, 2, 3, 4, 5] },
    timezone: w.state.timeZone,
  };
}

const approveIn = (w: DemoWorld, ids: readonly string[]) => {
  for (const s of w.outreach) if (ids.includes(s.id)) s.state = 'approved';
};

const outreachStarts: DemoScene = {
  id: 'outreach-starts',
  number: 49,
  title: 'Social Outreach starts conversations',
  kind: 'app',
  startsOn: 'a/outreach/needs-you',
  addons: ['outreach'],
  answers: {
    'outreach.waiting': (w) => waitingOf(w),
    // The step that presses OK has already OK'd them: the answer names those.
    'outreach.send.approve': (w, body) => {
      const asked = Array.isArray(body['sends'])
        ? (body['sends'] as { sendId?: unknown }[]).map((x) => String(x.sendId))
        : null;
      const okd = w.outreach.filter((s) => s.state === 'approved' && s.kind === 'opener');
      return {
        approved: asked ?? okd.map((s) => s.id),
        wheels: wheelsOf(w),
      };
    },
    'outreach.send.skip': (_w, body) => ({ sendId: body['sendId'] }),
    // Nobody it couldn't place by country.
    'outreach.countries.skipped': () => ({ people: [], total: 0, page: 1, pages: 1 }),
    // The live ticker: no computer working right now, so it stays out of the way.
    'outreach.ticker': (w) => ({
      timezone: w.state.timeZone,
      now: iso(Date.now()),
      computer: null,
      status: null,
      steps: [],
    }),
    'outreach.live.watch': () => ({ until: iso(Date.now() + 60_000) }),
  },
  setup: (w, at) => {
    for (const o of OPENERS)
      w.outreach.push({
        id: s49(0x10 + o.n),
        profileId: s49(0x20 + o.n),
        name: o.name,
        kind: 'opener',
        text: o.text,
        state: 'waiting',
        needsYou: null,
        recent: [],
        at: at - (4 - o.n) * 40 * 60_000,
      });
  },
  steps: [
    {
      label: 'It found people in your groups',
      voiceover:
        'Social Outreach works with a browser extension on your computer. It found three local realtors in the Facebook groups you’re in, and wrote each a friendly first message.',
      change: () => {},
      run: async (p) => {
        await p.waitFor('@waiting-message');
        await p.point('@waiting-message-title');
        await p.point('@today-send-texts');
      },
    },
    {
      label: 'You OK the first one',
      voiceover:
        'While its training wheels are on, nothing goes until you OK it. You read it, and it sends from your own Facebook, at a person’s pace.',
      change: (w) => approveIn(w, [s49(0x11)]),
      run: async (p) => {
        await p.click('@today-send-ok');
        await p.wait(1500);
      },
    },
    {
      label: 'Approve all',
      voiceover: 'Happy with the others? Approve all sends the rest the same way.',
      change: (w) => approveIn(w, [s49(0x12), s49(0x13)]),
      run: async (p) => {
        await p.click('@waiting-approve-all');
        await p.wait(1500);
      },
    },
    {
      label: 'Shonda writes back',
      voiceover:
        'Shonda writes back about a job. The AI drafts your answer, and because she asked for you, it hands it to you first.',
      change: (w, at) => {
        const first = OPENERS[0];
        w.outreach.push({
          id: REPLY,
          profileId: s49(0x21),
          name: first.name,
          kind: 'reply',
          text: 'Thanks, Shonda! Happy to help. We can check the AC this week, before the closing. What’s the address, and does Thursday or Friday work better?',
          state: 'waiting',
          needsYou: 'they asked for you',
          recent: [
            { fromMe: true, text: first.text, at: at - 2 * HOUR },
            {
              fromMe: false,
              text: 'Yes! I have buyers closing in Katy next week and the AC looks old. Can I talk to you about it?',
              at,
            },
          ],
          at,
        });
      },
      live: ['outreach_profile'],
      run: async (p) => {
        await p.waitFor('@waiting-reply');
        await p.point('@waiting-reply-title');
        await p.point('@today-send-alone');
      },
    },
  ],
};

export const ADDON_SCENES: readonly DemoScene[] = [buyerTexts, outreachStarts];
