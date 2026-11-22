/**
 * Social Outreach: the networking chat after an introduction (docs/outreach.md, decisions 173 and 176), without the
 * database. The playbook has the chat's words and switches, on to start; a reply there is short, reacts to what they
 * said with the business's story, asks a question only when the chat would stall and never right after the owner
 * asked one, offers a demo only when they ask about the business, sends people their way, and wraps up with the
 * networking call once they've written back twice, each only while its switch is on; the one nudge has its own words;
 * only a yes to a demo or a call is a yes, and it says which; a call's ask has its own words. How the chat goes
 * (decision 180) follows how keen they are, within the playbook's most replies, questions, story and demo choices.
 */
import { describe, expect, it } from 'vitest';
import {
  blankPlaybook,
  paceOf,
  PLAYBOOK_KEPT_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '../../src/addons/outreach/playbooks';
import {
  CHAT_START,
  chatOf,
  CHAT_PARTS,
  NETWORKING_KEYS,
  NETWORKING_ON,
  networkingOf,
  partShown,
  PLAYBOOK_CHAT,
  type PlaybookChat,
  playbookSays,
  SCRIPT_BLANKS,
  SCRIPT_GROUPS,
  SCRIPT_INFO,
  STARTING_CALL_OFFER,
  STARTING_DEMO_OFFER,
  STARTING_SEND_PEOPLE,
  startingScript,
} from '../../src/addons/outreach/script';
import {
  ANSWER_AFTER_INTRO_ASK,
  ANSWER_ASK,
  answerOf,
  NETWORKING_WRAP_AFTER,
  networkingStand,
  tookOf,
  todayDraftPrompt,
} from '../../src/addons/outreach/today';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const intro = { ...crm, opens: 'intro' as const };
const pace = paceOf(blankPlaybook().pace);
const theirs = (text: string) => ({ fromMe: false, text, at: new Date().toISOString() });

describe('the networking chat’s words and switches', () => {
  it('has starting words for the chat, shown only for a playbook that starts with an introduction', () => {
    const says = startingScript('demo');
    expect(says.demoOffer).toBe(STARTING_DEMO_OFFER);
    // The owner's words (decision 176).
    expect(STARTING_DEMO_OFFER).toBe(
      'I’d love to show you a demo if you have a bit of time in the next week or so.',
    );
    expect(says.callOffer).toBe(STARTING_CALL_OFFER);
    expect(says.sendPeople).toBe(STARTING_SEND_PEOPLE);
    expect(STARTING_SEND_PEOPLE).toContain('[their area]');
    expect(says.callYes).toContain('[booking link]');
    expect(SCRIPT_INFO.nudge.label).toBe('Nudge after the first message');
    expect(SCRIPT_GROUPS.find((g) => g.key === 'networking')?.parts).toEqual([
      'nudge',
      'demoOffer',
      'callOffer',
      'sendPeople',
      'callYes',
    ]);
    expect(SCRIPT_BLANKS.map((b) => b.blank)).toEqual(
      expect.arrayContaining(['[a question about them]', '[their area]', '[what they do]']),
    );
    for (const part of CHAT_PARTS) {
      expect(partShown(part, ['intro'])).toBe(true);
      expect(partShown(part, ['compliment'])).toBe(true);
      expect(partShown(part, ['pitch'])).toBe(false);
    }
    expect(partShown('intro', ['intro'])).toBe(true);
    expect(partShown('intro', ['compliment'])).toBe(false);
    expect(partShown('first', ['intro'])).toBe(true);
    expect(partShown('first', [])).toBe(true);
  });

  it('has every switch on to start, kept when a save leaves them out, and none for a playbook that pitches', () => {
    expect(NETWORKING_KEYS).toEqual(['demo', 'call', 'sendPeople']);
    expect(blankPlaybook().networking).toEqual(NETWORKING_ON);
    expect(PLAYBOOK_KEPT_KEYS).toContain('networking');
    // Saved before the switches: every one on.
    const { networking: _gone, ...before } = intro;
    const upgraded = PlaybookDetails.parse(upgradePlaybookDetails(before));
    expect(upgraded.networking).toEqual(NETWORKING_ON);
    expect(networkingOf(upgraded)).toEqual(NETWORKING_ON);
    // One turned off stays off.
    const noDemo = PlaybookDetails.parse({ ...intro, networking: { demo: false } });
    expect(networkingOf(noDemo)).toEqual({ demo: false, call: true, sendPeople: true });
    // A playbook that pitches offers none of them.
    expect(networkingOf(crm)).toEqual({ demo: false, call: false, sendPeople: false });
  });
});

describe('what the AI is told in the networking chat', () => {
  const base = {
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing, Boise'],
    playbook: intro,
  };
  const chat = [
    { fromMe: true, text: 'Hey Dana, thanks for connecting! How long have you been roofing?' },
    theirs('About 12 years now, started with my dad.'),
  ].map((m) => ({ at: new Date().toISOString(), ...m }));
  const inChat = { step: 'intro' as const, sent: pace.followUps, followUps: pace.followUps };

  it('keeps a reply short and about what they said, and offers what its switches allow, each once', () => {
    const prompt = todayDraftPrompt({
      kind: 'reply',
      ...base,
      recent: chat,
      conversation: inChat,
    });
    expect(prompt).toContain('this is a networking chat');
    expect(prompt).toContain('Keep the reply to a line or two.');
    // It reacts to what they said and shares the business's story where it connects (decision 176, the owner's 3).
    expect(prompt).toContain('React to what they actually said');
    expect(prompt).toContain('from the business’s story or what it believes under <content_lists>');
    // The intro asked them something, so this reply asks nothing (the owner's 1a).
    expect(prompt).toContain(
      'The owner’s last message asked them something, so this reply asks nothing.',
    );
    // A demo only when they ask about the business, after a quick answer (the owner's 2).
    expect(prompt).toContain(playbookSays(STARTING_DEMO_OFFER));
    expect(prompt).toContain('Never offer a demo when they haven’t asked');
    expect(prompt).toContain('once in the whole chat');
    // One reply in: nothing of the wrap-up yet, unless they're short with the owner or keen (decision 180).
    expect(prompt).toContain(
      'When they’re short with the owner (a word or two, or only signing off: thanks, you too, a thumbs up), wrap the chat up in one message that asks nothing:',
    );
    expect(prompt).toContain(
      'When they’re only answering, wrap the chat up once they’ve written back 2 times: nothing of the wrap-up before that.',
    );
    expect(prompt).toContain(ANSWER_AFTER_INTRO_ASK);
    expect(prompt).not.toContain(ANSWER_ASK);
    // A switch turned off: never offered.
    const off = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, networking: { demo: false, call: true, sendPeople: false } },
      recent: chat,
      conversation: inChat,
    });
    expect(off).toContain('Never offer a demo.');
    expect(off).not.toContain(playbookSays(STARTING_DEMO_OFFER));
    expect(off).not.toContain(playbookSays(STARTING_SEND_PEOPLE));
    // A pitch's reply is as before.
    const pitch = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: crm,
      recent: chat,
      conversation: { step: 'first', sent: 0, followUps: pace.followUps },
    });
    expect(pitch).not.toContain('this is a networking chat');
    expect(pitch).toContain(ANSWER_ASK);
  });

  it('asks a question only when the owner didn’t just ask one, and wraps up with the call after two replies (decision 176)', () => {
    const long = [
      ...chat,
      { fromMe: true, text: 'That’s a long run. I started mine after years in IT.' },
      theirs('Nice.'),
      theirs('Yeah it’s been good.'),
    ].map((m) => ({ at: new Date().toISOString(), ...m }));
    expect(networkingStand(chat)).toEqual({ wroteBack: 1, ownerAsked: true, theyAsked: 0 });
    // Two texts in a row are one time writing back; the owner's last asked nothing.
    expect(networkingStand(long)).toEqual({ wroteBack: 2, ownerAsked: false, theyAsked: 0 });
    expect(NETWORKING_WRAP_AFTER).toBe(2);
    const wrap = todayDraftPrompt({ kind: 'reply', ...base, recent: long, conversation: inChat });
    expect(wrap).toContain('Ask a question only when the chat would stall without one');
    expect(wrap).toContain(
      'When they’re only answering: they’ve written back 2 times, so unless they ask about the business',
    );
    // One message that asks nothing: the call with the person's own calendar, then the line about sending people
    // their way (the owner, 18 Nov 2026).
    expect(wrap).toContain('wrap the chat up in one message that asks nothing:');
    expect(wrap).toContain(playbookSays(STARTING_CALL_OFFER));
    expect(wrap).toContain(
      'wrap the chat up in one message that asks nothing: the call offer, then the line about sending people their way, as the sign-off.',
    );
    expect(wrap).toContain(playbookSays(STARTING_SEND_PEOPLE));
    expect(wrap).toContain('just a short, warm sign-off, with no offer and no link.');
    expect(wrap).not.toContain('nothing of the wrap-up before that');
    // No calendar of their own: the call goes with no link.
    expect(wrap).toContain('There’s no calendar link to give');
    const own = 'https://app.handsfreeos.com/book/acme/dana';
    const linked = todayDraftPrompt({
      kind: 'reply',
      ...base,
      recent: long,
      conversation: inChat,
      callLink: own,
    });
    expect(linked).toContain(
      `The owner’s own calendar link for [calendar link], exactly as written: ${own}.`,
    );
    expect(linked).not.toContain('There’s no calendar link to give');
    // With the call off it says the line and signs off; with both off it only signs off.
    const noCall = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, networking: { demo: true, call: false, sendPeople: true } },
      recent: long,
      conversation: inChat,
      callLink: own,
    });
    expect(noCall).not.toContain(playbookSays(STARTING_CALL_OFFER));
    expect(noCall).not.toContain(own);
    expect(noCall).toContain(
      'wrap the chat up in one message that asks nothing: the line about sending people their way',
    );
    const neither = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, networking: { demo: true, call: false, sendPeople: false } },
      recent: long,
      conversation: inChat,
    });
    expect(neither).toContain(
      'wrap the chat up in one message that asks nothing: a short, warm sign-off, with no offer and no link.',
    );
    // The words the owner gave (18 Nov 2026), with the person's own calendar's blank.
    expect(STARTING_CALL_OFFER).toContain('let’s jump on a call');
    expect(STARTING_CALL_OFFER).toContain('[calendar link]');
    expect(STARTING_SEND_PEOPLE).toBe(
      'If I see anyone online looking for [what they do] in [their area], I’ll be sure to mention you.',
    );
  });

  it('writes the one nudge from its own words, never a follow-up number', () => {
    const nudge = todayDraftPrompt({
      kind: 'follow_up',
      ...base,
      recent: chat.slice(0, 1),
      conversation: { step: 'intro', sent: pace.followUps - 1, followUps: pace.followUps },
    });
    expect(nudge).toContain('Write the owner’s one nudge.');
    expect(nudge).toContain(playbookSays(startingScript('demo').nudge));
    expect(nudge).not.toMatch(/This is follow-up \d/);
  });

  it('asks for a time for a networking call in the call’s own words', () => {
    const ask = todayDraftPrompt({
      kind: 'pitch',
      ...base,
      recent: chat,
      conversation: { step: 'intro', sent: 0, followUps: pace.followUps, call: true },
    });
    expect(ask).toContain('They said yes to a networking call');
    expect(ask).toContain(playbookSays(startingScript('demo').callYes));
    const demo = todayDraftPrompt({ kind: 'pitch', ...base, recent: chat });
    expect(demo).not.toContain('They said yes to a networking call');
    // A follow-up after the call's ask calls it a call.
    const after = todayDraftPrompt({
      kind: 'follow_up',
      ...base,
      recent: chat,
      conversation: { step: 'link', sent: 0, followUps: pace.followUps, call: true },
    });
    expect(after).toContain('not a demo: call it a quick call');
  });

  it('reads only a yes to a demo or a call as a yes there, and says which', () => {
    const recent = [theirs('Sure, a call sounds good')];
    expect(answerOf('reply', { answer: 'yes', took: 'none' }, recent, 'intro')).toBeNull();
    expect(answerOf('reply', { answer: 'yes', took: 'call' }, recent, 'intro')).toBe('yes');
    expect(tookOf({ answer: 'yes', took: 'call' }, 'intro')).toBe('call');
    expect(tookOf({ answer: 'yes', took: 'demo' }, 'intro')).toBe('demo');
    expect(tookOf({ answer: 'yes', took: 'call' }, 'first')).toBeNull();
    // Anywhere else a yes is a yes, as before.
    expect(answerOf('reply', { answer: 'yes', took: 'none' }, recent, 'first')).toBe('yes');
    expect(answerOf('reply', { answer: 'question', took: 'none' }, recent, 'intro')).toBe(
      'question',
    );
  });
});

describe('how the chat goes (decision 180)', () => {
  const base = {
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing, Boise'],
  };
  const inChat = { step: 'intro' as const, sent: pace.followUps, followUps: pace.followUps };
  const at = () => new Date().toISOString();
  const one = [
    {
      fromMe: true,
      text: 'Hey Dana, thanks for connecting! How long have you been roofing?',
      at: at(),
    },
    theirs('About 12 years now, started with my dad.'),
  ];
  const two = [
    ...one,
    { fromMe: true, text: 'That’s a long run. I started mine after years in IT.', at: at() },
    theirs('Nice, IT to software makes sense.'),
  ];
  const reply = (chat: Partial<PlaybookChat> | undefined, recent = one, more = {}) =>
    todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, ...(chat ? { chat } : {}) },
      recent,
      conversation: inChat,
      ...more,
    });

  it('starts as the chat went with decision 176, kept when a save leaves it out', () => {
    expect(CHAT_START).toEqual({
      wrapAfter: 2,
      questions: 'rarely',
      story: 'fits',
      demoWhen: 'asked',
    });
    expect(NETWORKING_WRAP_AFTER).toBe(CHAT_START.wrapAfter);
    expect(blankPlaybook().chat).toEqual(CHAT_START);
    expect(PLAYBOOK_KEPT_KEYS).toContain('chat');
    // Saved before it: the starting way. One choice saved: only that one differs.
    const { chat: _gone, ...before } = intro as typeof intro & { chat?: unknown };
    expect(chatOf(PlaybookDetails.parse(upgradePlaybookDetails(before)))).toEqual(CHAT_START);
    expect(chatOf(PlaybookDetails.parse({ ...intro, chat: { questions: 'often' } }))).toEqual({
      ...CHAT_START,
      questions: 'often',
    });
    // Only their 1st, 2nd or 3rd reply, said so.
    const four = PlaybookDetails.safeParse({ ...intro, chat: { wrapAfter: 4 } });
    expect(four.success).toBe(false);
    expect(four.error?.issues[0]?.message).toBe('Offer the call by their 1st, 2nd or 3rd reply.');
    expect(PlaybookDetails.safeParse({ ...intro, chat: { story: 'always' } }).success).toBe(false);
    // Its words, on the editors.
    expect(PLAYBOOK_CHAT.wrapAfter.option(1)).toBe('1st reply');
    expect(PLAYBOOK_CHAT.wrapAfter.option(3)).toBe('3rd reply');
  });

  it('counts the times they asked the owner something back, a few texts in a row once', () => {
    expect(networkingStand(one).theyAsked).toBe(0);
    const asking = [
      ...one,
      { fromMe: true, text: 'Nice, a family business.', at: at() },
      theirs('Thanks! What do you do?'),
      theirs('Is it software?'),
    ];
    expect(networkingStand(asking)).toEqual({ wroteBack: 2, ownerAsked: false, theyAsked: 1 });
  });

  it('wraps up a chat where they only answer, and leads one where they chat back to the call (the owner, 19 Nov)', () => {
    const prompt = reply(undefined);
    expect(prompt).toContain(
      'Follow how keen they are, and never drag the chat out. They’re chatting back when they ask the owner things or bring up things of their own; they’re only answering when they just reply to what the owner asked.',
    );
    // Short with the owner: it wraps up at once.
    expect(prompt).toContain(
      'When they’re short with the owner (a word or two, or only signing off: thanks, you too, a thumbs up), wrap the chat up in one message that asks nothing:',
    );
    // Only answering: it wraps up by the playbook's reply, nothing of it before.
    expect(prompt).toContain(
      'When they’re only answering, wrap the chat up once they’ve written back 2 times: nothing of the wrap-up before that.',
    );
    // Chatting back: never a wrap-up, but a meeting by then, sooner when they say they'd like to talk.
    expect(prompt).toContain(
      'When they’re chatting back, don’t wrap up: keep it going toward a meeting. When they say they’d like to talk, lead to a meeting in this reply: react to what they said, then the call offer.',
    );
    expect(prompt).toContain(
      'Don’t sign off, and no line about sending people their way yet: that waits until the chat winds down. Otherwise, it comes by the time they’ve written back 2 times.',
    );
    expect(prompt).toContain(
      'When the chat shows the owner already offered the call, never offer it again: keep the reply short and warm, and when the chat winds down, wrap the chat up',
    );
    // By then: only answering wraps up, chatting back gets the call and keeps going.
    const asked = [
      ...one,
      { fromMe: true, text: 'Nice, a family business.', at: at() },
      theirs('It is! How about you, how did you get started?'),
    ];
    const by = reply(undefined, asked);
    expect(by).toContain('They’ve asked the owner something 1 time so far.');
    expect(by).toContain(
      'When they’re only answering: they’ve written back 2 times, so unless they ask about the business (what it is, what it does, what it offers, how it works, the price), wrap the chat up',
    );
    expect(by).toContain(
      'When they’re chatting back, don’t wrap up: unless they ask about the business (what it is, what it does, what it offers, how it works, the price), lead to a meeting in this reply:',
    );
    expect(by).toContain(playbookSays(STARTING_CALL_OFFER));
    // Near the owner (decision 177): wanting to meet counts too, and the call is a call or coffee.
    const local = reply(undefined, one, { local: true });
    expect(local).toContain('When they say they’d like to talk or meet, lead to a meeting');
    expect(local).toContain('offer a call or to grab coffee');
    // With the call off, chatting back just keeps going: there's no meeting to lead to.
    const noCall = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, networking: { demo: true, call: false, sendPeople: true } },
      recent: asked,
      conversation: inChat,
    });
    expect(noCall).not.toContain('lead to a meeting');
    expect(noCall).toContain(
      'When they’re chatting back, keep it going, a line or two, and wrap up only when it winds down.',
    );
    expect(noCall).toContain('When they’re only answering: they’ve written back 2 times');
  });

  it('offers the call by the reply the playbook says', () => {
    // By their 1st: the first reply wraps up a quiet chat, and leads a lively one to the call.
    const first = reply({ wrapAfter: 1 });
    expect(first).toContain('When they’re only answering: they’ve written back 1 time, so unless');
    expect(first).toContain('When they’re chatting back, don’t wrap up: unless');
    // By their 3rd: two replies in, still nothing of the wrap-up for a quiet chat.
    const third = reply({ wrapAfter: 3 }, two);
    expect(third).toContain('wrap the chat up once they’ve written back 3 times');
    expect(third).toContain('Otherwise, it comes by the time they’ve written back 3 times.');
    const done = reply({ wrapAfter: 3 }, [
      ...two,
      { fromMe: true, text: 'Totally.', at: at() },
      theirs('Ha, yep.'),
    ]);
    expect(done).toContain('When they’re only answering: they’ve written back 3 times, so unless');
  });

  it('asks as often as the playbook says, never when it wraps up', () => {
    // Rarely (to start): only when it would stall, never right after the owner asked.
    expect(reply(undefined)).toContain(
      'The owner’s last message asked them something, so this reply asks nothing.',
    );
    expect(reply(undefined, two)).toContain('Ask a question only when the chat would stall');
    // Sometimes: every other reply at most.
    expect(reply({ questions: 'sometimes' })).toContain(
      'The owner’s last message asked them something, so this reply asks nothing.',
    );
    expect(reply({ questions: 'sometimes' }, two)).toContain(
      'The owner’s last message asked nothing, so this reply may end with one easy question about them, on what they just said, when it fits and doesn’t wrap the chat up.',
    );
    // Often: most replies, even right after the owner asked, but never in the wrap-up.
    const often = reply({ questions: 'often' });
    expect(often).toContain(
      'End the reply with one easy question about them, on what they just said, unless it wraps the chat up: most replies ask one.',
    );
    expect(often).not.toContain('so this reply asks nothing');
  });

  it('shares the owner’s story as often as the playbook says', () => {
    expect(reply(undefined)).toContain(
      'Then, when something of the owner’s own connects to it, share it in a sentence, from the business’s story',
    );
    expect(reply({ story: 'often' })).toContain(
      'Then, in most replies, find something of the owner’s own that connects to it and share it in a sentence, from the business’s story',
    );
    const never = reply({ story: 'never' });
    expect(never).toContain(
      'Keep the reply about them: never share the owner’s own story or what the business believes.',
    );
    expect(never).not.toContain('from the business’s story or what it believes under');
    // Every way reacts to what they said first.
    expect(never).toContain('React to what they actually said');
  });

  it('offers the demo when they ask, or also on a problem the business fixes', () => {
    const asked = reply(undefined);
    expect(asked).toContain('Never offer a demo when they haven’t asked');
    const problem = reply({ demoWhen: 'problem' });
    expect(problem).toContain(
      'When they ask about the business (what it is, what it does, what it offers, how it works, the price), or they name a problem the business fixes: answer in a sentence or two',
    );
    expect(problem).toContain(playbookSays(STARTING_DEMO_OFFER));
    expect(problem).not.toContain('Never offer a demo when they haven’t asked');
    // A problem puts the demo ahead of the wrap-up too.
    expect(reply({ demoWhen: 'problem' }, two)).toContain(
      'so unless they ask about the business (what it is, what it does, what it offers, how it works, the price), or they name a problem the business fixes, wrap the chat up',
    );
    // With the demo off, a problem changes nothing.
    const off = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: {
        ...intro,
        networking: { demo: false, call: true, sendPeople: true },
        chat: { demoWhen: 'problem' },
      },
      recent: one,
      conversation: inChat,
    });
    expect(off).toContain('Never offer a demo.');
    expect(off).not.toContain('they name a problem the business fixes');
  });
});
