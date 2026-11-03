/**
 * Social Outreach's first message is one short question that makes them curious (docs/outreach.md, decision 137): the
 * owner's words, with their kind of business put in from what's known of them. Today's drafts, the one text to
 * someone's Requests on Instagram, and Your messages' first samples all ask for it, as one text, and a playbook's AI
 * style only words the question.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_MESSAGE_EXAMPLE,
  FIRST_MESSAGE_SHAPE,
  FIRST_MESSAGE_WORDS,
  messageRewritePrompt,
  messageSamplesPrompt,
  type SamplesFacts,
} from '../../src/addons/outreach/conversation';
import { PLAYBOOK_SUGGESTIONS, PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { REQUESTS_TASK, todayDraftPrompt } from '../../src/addons/outreach/today';
import { VOICE_DEFAULTS } from '../../src/addons/outreach/voice';

const crm = { name: 'CRM demos', ...PLAYBOOK_TEMPLATES.crm_demos.details };
const opener = (more: Partial<Parameters<typeof todayDraftPrompt>[0]> = {}) =>
  todayDraftPrompt({
    kind: 'opener',
    business: 'Bright Books',
    name: 'Dana Reyes',
    facts: ['Owner at Reyes Roofing', 'Roofing and gutters in Tulsa'],
    recent: [],
    playbook: crm,
    ...more,
  });

describe('a first message', () => {
  it('is the owner’s short, curious question, with their kind of business put in', () => {
    expect(FIRST_MESSAGE_EXAMPLE.split(/\s+/).length).toBeLessThan(FIRST_MESSAGE_WORDS);
    const prompt = opener();
    expect(prompt).toContain(FIRST_MESSAGE_SHAPE);
    expect(prompt).toContain(FIRST_MESSAGE_EXAMPLE);
    expect(prompt).toMatch(/name its kind from the facts or their pages/);
    expect(prompt).toMatch(/say “your business”/);
    expect(prompt).toMatch(/no greeting, no line about them, no promise of more info/);
    // Only what the offer really does: SEO brings customers, credit repair is for people, not a business.
    expect(prompt).toMatch(/say only what the offer really does/);
    expect(prompt).toMatch(/help raise your credit score/);
    expect(prompt).toMatch(/leave out “in your … business”/);
    expect(prompt).not.toMatch(/for your home/);
    // Decision 65's ask is gone.
    expect(prompt).not.toMatch(/will send more info|open to the offer’s outcome|just say hi/);
  });

  it('goes as one text, whatever the voice says about splitting', () => {
    expect(VOICE_DEFAULTS.split).toBe(true);
    expect(opener({ voice: VOICE_DEFAULTS })).toContain(
      'Write it as one message, with no blank lines.',
    );
    // A reply still goes as texts.
    const reply = todayDraftPrompt({
      kind: 'reply',
      business: 'Bright Books',
      name: 'Dana Reyes',
      facts: [],
      recent: [{ fromMe: false, text: 'What is it?', at: new Date().toISOString() }],
      playbook: crm,
      voice: VOICE_DEFAULTS,
    });
    expect(reply).toMatch(/blank line between texts/);
    expect(reply).not.toContain(FIRST_MESSAGE_SHAPE);
  });

  it('is the same question to someone’s Requests on Instagram, and once they follow back', () => {
    expect(REQUESTS_TASK).toContain(FIRST_MESSAGE_SHAPE);
    expect(opener({ platform: 'instagram', requests: true })).toContain(REQUESTS_TASK);
    const back = opener({ platform: 'instagram' });
    expect(back).toContain('They just followed the owner back.');
    expect(back).toContain(FIRST_MESSAGE_SHAPE);
    expect(opener({ platform: 'linkedin' })).toContain(FIRST_MESSAGE_SHAPE);
  });

  it('takes a playbook’s style only for how the question is worded', () => {
    const style = 'Say it could stop leads slipping through the cracks.';
    const prompt = opener({ opener: { kind: 'style', text: style } });
    expect(prompt).toContain(
      `Word the question in this style, as far as it fits one short question with nothing added: ${style}`,
    );
    expect(prompt).not.toMatch(/Write the line about them/);
  });

  it('is what the ready-made playbooks’ styles and the suggestions word', () => {
    const styles = [
      ...Object.values(PLAYBOOK_TEMPLATES).flatMap((t) => t.details.openerStyles),
      ...PLAYBOOK_SUGGESTIONS.openerStyles,
    ];
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s).toMatch(/^Say it could /);
  });
});

describe('Your messages’ first samples', () => {
  const facts: SamplesFacts = {
    business: 'Pine Roof Leads',
    playbook: {
      name: 'CRM demos',
      niche: 'Roofers with 2 to 3 crews',
      problem: null,
      tone: null,
      samples: [],
      avoid: [],
      disclaimer: null,
      usefulWhat: null,
      hasVideo: false,
    },
    offer: { line: null, outcome: 'more booked calls' },
    followUps: 6,
    voice: 'No emoji.',
  };

  it('are written, and written again, in the same shape for the niche’s kind of business', () => {
    const all = messageSamplesPrompt(facts);
    expect(all).toContain(`- first: 2 different first messages`);
    expect(all).toContain(FIRST_MESSAGE_SHAPE);
    expect(all).toMatch(/kind of business the playbook’s niche runs/);
    expect(all).not.toMatch(/will send more info/);
    const again = messageRewritePrompt({
      ...facts,
      slot: { part: 'first', index: 0 },
      before: 'Hi Sam! Open to more booked calls?',
      others: [],
    });
    expect(again).toContain(FIRST_MESSAGE_SHAPE);
  });
});
