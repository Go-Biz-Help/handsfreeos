import { businessOf, fullName } from '../world';
import { idsFor } from './ask-kit';
import { conversationIn, openConversation, startConversation } from './kit';
import {
  APPROVED,
  approveDraft,
  changeWords,
  customerSays,
  draftReply,
  NEW_MESSAGE,
  newPerson,
  regular,
  teammateSays,
} from './teammate-kit';
import type { DemoScene } from './types';

/**
 * The AI teammate brings in work: a question about a quote answered from the quote (15), a neighbor turned into a
 * lead in one press (17), and a fix to its draft it remembers for the next customer (18).
 */

const DAY = 24 * 3600_000;

/** A day `days` from `at`, as `YYYY-MM-DD` where the business is. */
const localDay = (at: number, days: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at + days * DAY));

/** The card on Home for one made-up item. */
const homeCard = (id: string) => `[data-testid="attention-card"][data-item="${id}"]`;

// ------------------------------------------------------------------------------------ 15. a question about a quote

const s15 = idsFor(15);
const MEGAN = s15(1);
const ESTIMATE = s15(2);
const ANSWER = s15(31);
const QUOTE_LINK = 'https://app.handsfreeos.com/e/4tRw8nZq';

export const quoteQuestion: DemoScene = {
  id: 'quote-question',
  number: 15,
  title: 'A question about a quote',
  kind: 'teammate',
  startsOn: 'inbox',
  // Quoted two days ago and opened that evening.
  setup: (w, at) => {
    const sentAt = at - 2 * DAY;
    const megan = newPerson(s15(3), 'Megan', 'Cross', 1519, 'Spring', 'megan.cross@example.com');
    w.estimates.push({
      id: ESTIMATE,
      number: 'EST-1052',
      title: 'AC replacement',
      person: megan,
      email: megan.email!,
      lines: [
        {
          name: '3-ton 16 SEER2 AC condenser',
          description: '10-year parts warranty',
          quantity: 1,
          unitPriceCents: 390_000,
        },
        {
          name: 'Evaporator coil',
          description: 'Matched to the new condenser',
          quantity: 1,
          unitPriceCents: 110_000,
        },
        {
          name: 'Installation',
          description: 'New pad, line set flush, refrigerant charge and start-up test',
          quantity: 1,
          unitPriceCents: 145_000,
        },
        {
          name: 'Removal and disposal of the old unit',
          description: 'We recover the refrigerant and haul the old condenser and coil away',
          quantity: 1,
          unitPriceCents: 15_000,
        },
        { name: 'City permit', description: null, quantity: 1, unitPriceCents: 9_500 },
      ],
      createdAt: sentAt - 3600_000,
      sentAt,
      viewedAt: sentAt + 6 * 3600_000,
      expiresOn: localDay(sentAt, 30, w.state.timeZone),
    });
    w.conversations.unshift({
      id: MEGAN,
      person: megan,
      createdAt: sentAt,
      unread: 0,
      messages: [
        {
          id: s15(11),
          at: sentAt,
          direction: 'outbound',
          body: `${businessOf(w)}: Your estimate for an AC replacement is ready, $6,695.00. Approve it here: ${QUOTE_LINK}`,
        },
      ],
      drafts: [],
      visits: [],
    });
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Two days ago you quoted Megan for a new AC. She opened it that night, and she’s thinking it over.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Megan asks a question about the quote',
      voiceover:
        'Then she texts a question. This is the moment a job is won or lost: answer fast and clearly, or she goes with someone else.',
      change: (w, at) => {
        customerSays(w, MEGAN, {
          id: s15(12),
          at,
          body: 'Quick question on the quote. Does this include hauling the old unit away?',
        });
        conversationIn(w, MEGAN).unread = 1;
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, MEGAN),
    },
    {
      label: 'It answers from the estimate itself',
      voiceover:
        'Your AI teammate reads her actual estimate. Yes, the haul-away is on it, and it says which line. Then it sends her the link again, so approving is one tap away.',
      change: (w, at) => {
        conversationIn(w, MEGAN).unread = 0;
        draftReply(w, MEGAN, {
          id: ANSWER,
          at,
          inReplyTo: s15(12),
          body: `Hi Megan, yes! It’s on your estimate as “Removal and disposal of the old unit” ($150): we recover the refrigerant and haul the old condenser and coil away. The permit is included too. Whenever you’re ready, you can approve it here: ${QUOTE_LINK}`,
          action: {
            kind: 'share_link',
            estimateId: ESTIMATE,
            summary: 'Send the link to estimate EST-1052',
          },
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-text');
      },
    },
    {
      label: 'Approve: the answer goes to Megan',
      voiceover: 'You approve it from your phone in a second.',
      change: (w, at) => {
        approveDraft(w, MEGAN, ANSWER, s15(13), at);
      },
      live: APPROVED,
      run: (p) => p.click('@draft-approve'),
    },
    {
      label: 'Megan approves the estimate',
      voiceover: 'A few minutes later, Megan writes back. She just approved it.',
      change: (w, at) => {
        customerSays(w, MEGAN, {
          id: s15(14),
          at,
          body: 'Perfect, that’s what I needed. Just approved it!',
        });
        w.estimates.find((e) => e.id === ESTIMATE)!.accepted = { at, name: 'Megan Cross' };
      },
      live: [...NEW_MESSAGE, 'estimate'],
      run: (p) => p.point(`@message-${s15(14)}`),
    },
    {
      label: 'Open the estimate: approved',
      voiceover:
        'And there it is: approved, with her name and the time she signed. A question that could have stalled the job closed it instead.',
      run: async (p) => {
        await p.go(`money/estimates/${ESTIMATE}`);
        await p.point('@document-activity');
      },
    },
  ],
};

// ------------------------------------------------------------------------------------- 17. a neighbor gets referred

const s17 = idsFor(17);
const CARLA = s17(1);
const REFERRAL = s17(2);
const SUE_LEAD = s17(3);

export const neighborReferral: DemoScene = {
  id: 'neighbor-referral',
  number: 17,
  title: 'A neighbor gets referred',
  kind: 'teammate',
  startsOn: 'inbox',
  // Carla's AC was fixed yesterday.
  setup: (w, at) => {
    w.teammateAutomatic = true;
    const done = at - DAY;
    w.conversations.unshift({
      id: CARLA,
      person: regular(newPerson(s17(4), 'Carla', 'Benson', 1733, 'Houston'), at, 4),
      createdAt: done - DAY,
      unread: 0,
      messages: [
        {
          id: s17(11),
          at: done,
          direction: 'outbound',
          teammate: true,
          body: 'Hi Carla, your AC is all fixed! Thanks for choosing us. Let us know if anything comes up.',
        },
      ],
      drafts: [],
      visits: [],
    });
  },
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Yesterday you fixed Carla’s AC. Happy customers talk to their neighbors, and that’s the cheapest new business there is, if you catch it.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Carla says her neighbor needs help too',
      voiceover:
        'Carla texts to say thanks, and mentions her neighbor Sue needs her heater looked at.',
      change: (w, at) => {
        customerSays(w, CARLA, {
          id: s17(12),
          at,
          body: 'Thanks again for fixing our AC yesterday! My neighbor Sue Pruitt needs her heater looked at too. Can I give her your number?',
        });
        conversationIn(w, CARLA).unread = 1;
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, CARLA),
    },
    {
      label: 'It thanks her and asks for Sue’s number',
      voiceover: 'Your AI teammate thanks her, and asks for Sue’s number so you can reach out.',
      change: (w, at) => {
        conversationIn(w, CARLA).unread = 0;
        teammateSays(w, CARLA, {
          id: s17(13),
          at,
          body: 'So glad it’s cooling again, Carla, and thank you! We’d love to help Sue. Feel free to pass along this number, or send me hers and we’ll reach out.',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s17(13)}`),
    },
    {
      label: 'Carla sends it',
      voiceover: 'Carla sends it over.',
      change: (w, at) => {
        customerSays(w, CARLA, { id: s17(14), at, body: 'Sure! It’s 832-555-1787.' });
        w.referrals.push({
          id: REFERRAL,
          from: conversationIn(w, CARLA).person,
          conversationId: CARLA,
          name: 'Sue Pruitt',
          relation: 'neighbor',
          need: 'heater check',
          quote: 'My neighbor Sue Pruitt needs her heater looked at too.',
          at,
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${s17(14)}`),
    },
    {
      label: 'Home: Carla mentioned Sue',
      voiceover:
        'On your Home screen, HandsFreeOS caught it: Carla mentioned Sue, her neighbor, who needs a heater check.',
      run: async (p) => {
        await p.go('');
        await p.point(`${homeCard(REFERRAL)} [data-testid="attention-title"]`);
      },
    },
    {
      label: 'One press: Create lead',
      voiceover: 'One press, and Sue is a customer with a lead of her own.',
      change: (w, at) => {
        const r = w.referrals.find((x) => x.id === REFERRAL)!;
        w.leads.push({
          id: SUE_LEAD,
          title: 'Heater check',
          person: newPerson(s17(5), 'Sue', 'Pruitt', 1787, 'Houston'),
          stage: 'New',
          valueCents: 0,
          source: `Referred by ${fullName(r.from)}`,
          at,
        });
        r.leadId = SUE_LEAD;
      },
      run: async (p) => {
        await p.click(`${homeCard(REFERRAL)} [data-testid="attention-handle"]`);
        await p.waitFor('[data-sonner-toast] [data-button]');
      },
    },
    {
      label: 'Open the lead: it says who sent her',
      voiceover:
        'And the lead says who sent her: Carla. When you call Sue, you know exactly what to say, and you know who to thank.',
      run: async (p) => {
        // The toast's Open the lead is gone by the time a presenter has finished talking: open it as a link does.
        await p.go(`leads/${SUE_LEAD}`);
        await p.waitFor('@lead-source', 15_000);
        await p.wait(400);
        await p.point('@lead-source');
      },
    },
  ],
};

// ------------------------------------------------------------------------------------- 18. it learns from your fix

const s18 = idsFor(18);
const JEFF = s18(1);
const ALICIA = s18(2);
const LESSON = s18(3);
const SUNDAY = s18(31);
const RIGHT = s18(32);
const LESSON_LINE = 'We don’t work Sundays. Offer the next weekday instead.';
const SUNDAY_ASK = 'We can come out Sunday morning. What time works best for you?';
const MONDAY_OFFER =
  'We don’t work Sundays, but we can come Monday at 8:00 AM, first thing. Does that work?';

export const learnsFromFix: DemoScene = {
  id: 'learns-from-fix',
  number: 18,
  title: 'It learns from your fix',
  kind: 'teammate',
  startsOn: 'inbox',
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Your AI teammate learns your business the way a new hire does: when you correct it, it remembers.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Jeff asks for Sunday morning',
      voiceover:
        'Jeff texts. His furnace is rattling, and he’d like someone out on Sunday morning.',
      change: (w, at) => {
        startConversation(w, at, {
          id: JEFF,
          person: newPerson(s18(4), 'Jeff', 'Moreau', 1841, 'Pasadena'),
          firstId: s18(11),
          body: 'Any chance someone could come out Sunday morning? My furnace is making a rattling noise.',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => openConversation(p, JEFF),
    },
    {
      label: 'It offers Sunday, which you don’t do',
      voiceover:
        'Your teammate is still in training, so it writes a reply and waits for you. It offered Sunday. But you don’t work Sundays.',
      change: (w, at) => {
        conversationIn(w, JEFF).unread = 0;
        draftReply(w, JEFF, {
          id: SUNDAY,
          at,
          inReplyTo: s18(11),
          body: `Hi Jeff, this is ${w.state.teammate} with ${businessOf(w)}. Sorry about the rattle! ${SUNDAY_ASK}`,
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-text');
      },
    },
    {
      label: 'Change it: “We don’t work Sundays”',
      voiceover:
        'So you fix it, the way you’d fix a new hire’s text: we don’t work Sundays, but Monday first thing works. Then send your version.',
      change: (w, at) => {
        const d = conversationIn(w, JEFF).drafts.find((x) => x.id === SUNDAY)!;
        d.edited = d.body.replace(SUNDAY_ASK, MONDAY_OFFER);
        approveDraft(w, JEFF, SUNDAY, s18(12), at);
        w.lessons.push({
          id: LESSON,
          line: LESSON_LINE,
          why: 'You changed a Sunday visit to Monday in Jeff Moreau’s reply. Add it to its instructions so it doesn’t offer Sundays again.',
          at,
        });
      },
      // Nothing refreshes while the new words are typed: the card would close under the typing.
      run: async (p) => {
        await p.click('@draft-edit');
        await changeWords(p, '@draft-input', SUNDAY_ASK, MONDAY_OFFER);
        await p.click('@draft-send-edit');
        await p.wait(500);
        p.refresh([...APPROVED]);
        await p.waitFor(`@message-${s18(12)}`);
      },
    },
    {
      label: 'Home: it saved that as a lesson',
      voiceover:
        'On your Home screen, your teammate noticed the change and turned it into a lesson: we don’t work Sundays.',
      run: async (p) => {
        await p.go('');
        await p.point(`${homeCard(LESSON)} [data-testid="attention-title"]`);
      },
    },
    {
      label: 'Add it to its instructions',
      voiceover: 'One press adds it to its instructions, for good.',
      change: (w) => {
        w.lessons.find((l) => l.id === LESSON)!.applied = true;
      },
      run: async (p) => {
        await p.click(`${homeCard(LESSON)} [data-testid="attention-handle"]`);
        await p.waitFor('[data-sonner-toast]');
      },
    },
    {
      label: 'The next customer asks about Sunday',
      voiceover: 'Later that week, Alicia asks the same thing: can you come Sunday?',
      change: (w, at) => {
        startConversation(w, at, {
          id: ALICIA,
          person: newPerson(s18(5), 'Alicia', 'Grant', 1852, 'Pearland'),
          firstId: s18(13),
          body: 'Hi, can you guys come this Sunday to check my AC? It’s been running nonstop.',
        });
      },
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, ALICIA);
      },
    },
    {
      label: 'It gets it right',
      voiceover:
        'This time it gets it right on its own: no Sundays, here’s Monday. You taught it once, and it stuck.',
      change: (w, at) => {
        conversationIn(w, ALICIA).unread = 0;
        draftReply(w, ALICIA, {
          id: RIGHT,
          at,
          inReplyTo: s18(13),
          body: `Hi Alicia, this is ${w.state.teammate} with ${businessOf(w)}. We don’t work Sundays, but we can come Monday at 8:00 AM or 1:00 PM. Which works better?`,
        });
      },
      live: ['ai_teammate_draft', 'conversation'],
      run: async (p) => {
        await p.waitFor('@draft-card');
        await p.point('@draft-text');
      },
    },
  ],
};

export const TEAMMATE_SALES_SCENES: readonly DemoScene[] = [
  quoteQuestion,
  neighborReferral,
  learnsFromFix,
];
