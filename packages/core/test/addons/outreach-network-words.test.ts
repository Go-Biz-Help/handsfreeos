/**
 * The AI hears each network's own words (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Words and the AI"): a
 * LinkedIn draft, chat read, check, like or post check never says Facebook, Messenger or friend request, and
 * Facebook's prompts are exactly as they were.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_READ_SYSTEM,
  chatReadPrompt,
  chatReadSystem,
} from '../../src/addons/outreach/chat-read';
import { CHECK_SYSTEM, checkPrompt, checkSystem } from '../../src/addons/outreach/checks';
import { LIKE_PICK_SYSTEM, likePickSystem } from '../../src/addons/outreach/like-pick';
import { HELPFUL_SYSTEM, helpfulPrompt, helpfulSystem } from '../../src/addons/outreach/helpful';
import { inNetworkWords } from '../../src/addons/outreach/networks';
import { POST_CHECK_SYSTEM, postCheckSystem } from '../../src/addons/outreach/posts';
import {
  checkedProfileCheck,
  PROFILE_CHECK_SYSTEM,
  PROFILE_ITEMS_ON,
  profileCheckPrompt,
  profileCheckSystem,
  ProfileRead,
} from '../../src/addons/outreach/profile-check';
import {
  CUSTOMER_DRAFT_KINDS,
  TODAY_DRAFT_SYSTEM,
  todayDraftPrompt,
  todayDraftSystem,
} from '../../src/addons/outreach/today';
import { todayKindsOn } from '../../src/addons/outreach/network-words';

const FACEBOOK_WORDS = /Facebook|Messenger|friend request|\bfriends?\b/i;

const draft = (kind: (typeof CUSTOMER_DRAFT_KINDS)[number], platform?: 'facebook' | 'linkedin') =>
  todayDraftPrompt({
    kind,
    business: 'Bright Books',
    name: 'Sam Lee',
    facts: [],
    recent: [],
    playbook: null,
    post:
      kind === 'comment' || kind === 'warm_lead' ? { text: 'Who do you use?', group: null } : null,
    ...(platform ? { platform } : {}),
  });

describe('each network’s words for the AI', () => {
  it('puts Facebook’s words in LinkedIn’s, and leaves Facebook’s as they are', () => {
    expect(inNetworkWords('Send them a friend request on Facebook.', 'facebook')).toBe(
      'Send them a friend request on Facebook.',
    );
    expect(
      inNetworkWords(
        'A friend request on Facebook, then a Facebook Messenger chat with friends. Be friendly.',
        'linkedin',
      ),
    ).toBe(
      'An invitation to connect on LinkedIn, then a LinkedIn messaging chat with connections. Be friendly.',
    );
  });

  it('keeps Facebook’s prompts word for word', () => {
    expect(todayDraftSystem()).toBe(TODAY_DRAFT_SYSTEM);
    expect(todayDraftSystem('facebook')).toBe(TODAY_DRAFT_SYSTEM);
    expect(chatReadSystem('facebook')).toBe(CHAT_READ_SYSTEM);
    expect(checkSystem('facebook')).toBe(CHECK_SYSTEM);
    expect(likePickSystem('facebook')).toBe(LIKE_PICK_SYSTEM);
    expect(postCheckSystem('facebook')).toBe(POST_CHECK_SYSTEM);
    for (const kind of CUSTOMER_DRAFT_KINDS) expect(draft(kind, 'facebook')).toBe(draft(kind));
    expect(TODAY_DRAFT_SYSTEM).toContain('short Facebook messages');
    expect(draft('opener')).toContain('accepted the owner’s friend request');
    expect(draft('comment')).toContain('posted this in a Facebook group');
  });

  it('tells LinkedIn’s AI LinkedIn’s words, and never Facebook’s', () => {
    for (const text of [
      todayDraftSystem('linkedin'),
      chatReadSystem('linkedin'),
      checkSystem('linkedin'),
      likePickSystem('linkedin'),
      postCheckSystem('linkedin'),
      chatReadPrompt([], [], [], 'linkedin'),
      checkPrompt({
        business: 'Bright Books',
        name: 'Sam Lee',
        facts: [],
        lines: [],
        chat: null,
        playbooks: [],
        platform: 'linkedin',
      }),
      ...CUSTOMER_DRAFT_KINDS.map((kind) => draft(kind, 'linkedin')),
    ])
      expect(text).not.toMatch(FACEBOOK_WORDS);
    expect(todayDraftSystem('linkedin')).toContain('short LinkedIn messages');
    expect(draft('opener', 'linkedin')).toContain('accepted the owner’s invitation to connect');
    expect(draft('reconnect', 'linkedin')).toContain('the owner’s connection');
    // A post off a group, from LinkedIn's post search or the person's own feed, is on LinkedIn.
    expect(draft('comment', 'linkedin')).toContain('They posted this on LinkedIn.');
    expect(draft('warm_lead', 'linkedin')).toContain('own helpful post on LinkedIn');
    expect(postCheckSystem('linkedin')).toContain('find posts on LinkedIn');
    expect(likePickSystem('linkedin')).toContain('before sending them an invitation to connect');
    expect(todayKindsOn('facebook').friend_request).toBe('Send a friend request');
    expect(todayKindsOn('linkedin').friend_request).toBe('Send an invitation to connect');
  });

  it('checks a LinkedIn profile by its own list, with headlines and an About to start from', () => {
    expect(profileCheckSystem()).toBe(PROFILE_CHECK_SYSTEM);
    expect(profileCheckSystem('linkedin')).not.toMatch(FACEBOOK_WORDS);
    const read = ProfileRead.parse({
      platform: 'linkedin',
      name: 'Sam Lee',
      picture: 'Sam Lee',
      bio: 'Accountant',
      intro: ['Owner at Bright Books'],
    });
    expect(profileCheckPrompt(read, null)).toContain('Score this LinkedIn profile.');
    expect(profileCheckPrompt(read, null)).toContain('bio (the headline): Accountant');
    const check = checkedProfileCheck(
      {
        items: Object.fromEntries(
          PROFILE_ITEMS_ON.linkedin.map((i) => [i, { ok: true, why: 'Looks right.', fix: 'x' }]),
        ) as never,
        bios: ['h'.repeat(200), 'g'.repeat(221)],
        aboutDraft: 'I help small firms — and their owners — book more calls.',
        coverLine: 'More booked calls',
        feature: [],
      },
      read,
      '2026-10-15T10:00:00.000Z',
      1,
    );
    expect(Object.keys(check.items)).toEqual([...PROFILE_ITEMS_ON.linkedin]);
    // Nothing read for the banner or About: never right, whatever the AI says.
    expect(check.items.cover?.ok).toBe(false);
    expect(check.items.about?.ok).toBe(false);
    expect(check.items.bio?.ok).toBe(true);
    // Headlines up to LinkedIn's 220 characters, and an About with no long dashes.
    expect(check.bios).toEqual(['h'.repeat(200)]);
    expect(check.aboutDraft).not.toContain('—');
  });

  it('writes LinkedIn’s helpful post for the person’s own feed, with no group or rules', () => {
    expect(helpfulSystem()).toBe(HELPFUL_SYSTEM);
    expect(helpfulSystem('linkedin')).toContain('their own LinkedIn feed');
    expect(helpfulSystem('linkedin')).not.toMatch(FACEBOOK_WORDS);
    const prompt = helpfulPrompt({
      business: 'Bright Books',
      playbook: null,
      group: null,
      platform: 'linkedin',
      asked: ['Can anyone recommend a bookkeeper?'],
    });
    expect(prompt).not.toContain('<group>');
    expect(prompt).not.toContain('<rules>');
    expect(prompt).toContain('Write one helpful post for their own LinkedIn feed.');
  });
});
