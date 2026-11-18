/**
 * Social Outreach: the networking chat after an introduction (docs/outreach.md, decisions 173 and 176), without the
 * database. The playbook has the chat's words and switches, on to start; a reply there is short, reacts to what they
 * said with the business's story, asks a question only when the chat would stall and never right after the owner
 * asked one, offers a demo only when they ask about the business, sends people their way, and wraps up with the
 * networking call once they've written back twice, each only while its switch is on; the one nudge has its own words;
 * only a yes to a demo or a call is a yes, and it says which; a call's ask has its own words.
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
  INTRO_PARTS,
  NETWORKING_KEYS,
  NETWORKING_ON,
  networkingOf,
  partShown,
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
    expect(SCRIPT_INFO.nudge.label).toBe('Nudge after the introduction');
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
    for (const part of INTRO_PARTS) {
      expect(partShown(part, true)).toBe(true);
      expect(partShown(part, false)).toBe(false);
    }
    expect(partShown('first', false)).toBe(true);
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
    expect(prompt).toContain(playbookSays(STARTING_SEND_PEOPLE));
    expect(prompt).toContain('once in the whole chat');
    // One reply in: no call yet.
    expect(prompt).not.toContain(playbookSays(STARTING_CALL_OFFER));
    expect(prompt).toContain('Don’t offer a call yet.');
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
    expect(networkingStand(chat)).toEqual({ wroteBack: 1, ownerAsked: true });
    // Two texts in a row are one time writing back; the owner's last asked nothing.
    expect(networkingStand(long)).toEqual({ wroteBack: 2, ownerAsked: false });
    expect(NETWORKING_WRAP_AFTER).toBe(2);
    const wrap = todayDraftPrompt({ kind: 'reply', ...base, recent: long, conversation: inChat });
    expect(wrap).toContain('Ask a question only when the chat would stall without one');
    expect(wrap).toContain('They’ve written back 2 times, so unless they ask about the business');
    expect(wrap).toContain(playbookSays(STARTING_CALL_OFFER));
    expect(wrap).toContain('a short, warm sign-off.');
    expect(wrap).not.toContain('Don’t offer a call yet.');
    // With the call off it only signs off.
    const noCall = todayDraftPrompt({
      kind: 'reply',
      ...base,
      playbook: { ...intro, networking: { demo: true, call: false, sendPeople: true } },
      recent: long,
      conversation: inChat,
    });
    expect(noCall).not.toContain(playbookSays(STARTING_CALL_OFFER));
    expect(noCall).toContain('wrap the chat up now and ask nothing more: a short, warm sign-off.');
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
