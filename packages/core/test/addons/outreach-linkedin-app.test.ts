/**
 * Working LinkedIn end to end from the app (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Networks in the
 * app"): Get ready's LinkedIn profile in LinkedIn's words, with headlines up to 220 characters to put in; the helpful
 * post on the person's own LinkedIn feed; Today's comments on posts with no group said to be on LinkedIn; and the
 * Friends tab's tidy-up on LinkedIn, which only withdraws old invitations and counts them against LinkedIn's limit
 * alone. Facebook's words and counts stay as they were.
 *
 * LinkedIn's profiles, posts and withdrawals are written here as the database would keep them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_KINDS,
  askNameOn,
  bioTooLongWords,
  TIDY_PACE_WORDS,
} from '../../src/addons/outreach/asks';
import {
  AUTOMATION_DEFAULTS,
  NETWORK_CHOICES_DEFAULTS,
  NETWORKS_DEFAULTS,
} from '../../src/addons/outreach/automation';
import {
  HELPFUL_WORDS,
  helpfulOpenUrl,
  helpfulWhere,
  helpfulWordsOn,
  howWords,
} from '../../src/addons/outreach/helpful';
import { helpfulOn, postingAboutOn, tidyWordsOn } from '../../src/addons/outreach/network-words';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import {
  PROFILE_CHECK_WORDS,
  PROFILE_ITEMS,
  PROFILE_ITEMS_ON,
} from '../../src/addons/outreach/profile-check';
import { profileWordsOn, READY_WORDS } from '../../src/addons/outreach/readiness';
import type { TidyOutput } from '../../src/addons/outreach/tidy';
import { OUTREACH_WORDS as W } from '../../src/addons/outreach/words';
import { outreachBusiness, refused, runAs, runWith } from './outreach-fixture';

const admin = () => testDbs().admin.db;

describe('LinkedIn’s words in the app', () => {
  it('says Get ready’s LinkedIn profile in its own words, and Facebook’s as it was', () => {
    const facebook = profileWordsOn('facebook');
    expect(facebook.title).toBe(READY_WORDS.profile.title);
    expect(facebook.items.map((i) => i.item)).toEqual([...PROFILE_ITEMS]);
    expect(facebook.items[2]).toEqual({ item: 'bio', ...READY_WORDS.profile.items.bio });
    expect(facebook.bios).toBe(PROFILE_CHECK_WORDS.bios);
    expect(facebook.biosHint).toBe(PROFILE_CHECK_WORDS.biosHint);
    expect(facebook.about).toBeNull();

    const linkedIn = profileWordsOn('linkedin');
    expect(linkedIn.title).toBe('Check your LinkedIn profile');
    expect(linkedIn.items.map((i) => i.item)).toEqual([...PROFILE_ITEMS_ON.linkedin]);
    expect(linkedIn.items.find((i) => i.item === 'bio')!.label).toBe(
      'A headline that says who you help and the result',
    );
    expect(linkedIn.bios).toBe('Headlines to pick from');
    expect(linkedIn.biosHint).toContain('up to 220 characters');
    expect(linkedIn.coverLine).toBe('A line for your banner');
    expect(linkedIn.about).toBe('An About to start from');
    expect(linkedIn.aboutCopied).toContain('About');
    expect(linkedIn.notRead).toContain('LinkedIn profile');
    expect(linkedIn.read).toBe(PROFILE_CHECK_WORDS.read);
    expect(linkedIn.editDone('Helping roofers')).toBe('Your headline now says “Helping roofers”.');
    for (const text of [
      linkedIn.title,
      linkedIn.hint,
      linkedIn.readHint,
      linkedIn.notRead,
      linkedIn.bios,
      linkedIn.biosHint,
      linkedIn.coverLine,
      linkedIn.coverHint,
      linkedIn.coverCopied,
      ...linkedIn.items.flatMap((i) => [i.label, i.tip]),
    ])
      expect(text).not.toMatch(/Facebook|\bbio\b|\bcover\b/);
  });

  it('keeps a bio to the network’s own length', () => {
    expect(bioTooLongWords('linkedin', 'h'.repeat(220))).toBeNull();
    expect(bioTooLongWords('facebook', 'b'.repeat(101))).toBeNull();
    expect(bioTooLongWords('facebook', 'b'.repeat(150))).toBe(
      'Facebook’s bio takes up to 101 characters, and this one has 150. Pick a shorter one, or cut it to fit.',
    );
    expect(bioTooLongWords('linkedin', 'h'.repeat(221))).toMatch(
      /^LinkedIn’s headline takes up to 220/,
    );
  });

  it('puts the helpful post on the person’s own LinkedIn feed, and Facebook’s in a group as it was', () => {
    expect(helpfulOn('linkedin')).toBe(true);
    const facebook = helpfulWordsOn('facebook');
    expect(facebook.open).toBe(HELPFUL_WORDS.openGroup);
    expect(facebook.copied).toBe(HELPFUL_WORDS.copied);
    expect(facebook.limit).toBe(HELPFUL_WORDS.limit);
    expect(facebook.feed).toBeNull();
    expect(facebook.how('copy')).toBe(howWords('copy'));

    const linkedIn = helpfulWordsOn('linkedin');
    expect(linkedIn.open).toBe('Open LinkedIn');
    expect(linkedIn.feed).toEqual({
      name: 'Your LinkedIn feed',
      url: 'https://www.linkedin.com/feed/',
    });
    expect(linkedIn.limit).toBe('One helpful post a day, on your own feed.');
    for (const text of [
      linkedIn.copied,
      linkedIn.limit,
      linkedIn.how('copy'),
      linkedIn.how('after_ok'),
    ])
      expect(text).not.toMatch(/group/i);

    const onFeed = { groupName: null, groupUrl: null, platform: 'linkedin' as const };
    expect(helpfulWhere(onFeed)).toBe('Your LinkedIn feed');
    expect(helpfulOpenUrl(onFeed)).toBe('https://www.linkedin.com/feed/');
    const inGroup = {
      groupName: 'Austin Owners',
      groupUrl: 'https://www.facebook.com/groups/1/',
      platform: 'facebook' as const,
    };
    expect(helpfulWhere(inGroup)).toBe('For Austin Owners');
    expect(helpfulOpenUrl(inGroup)).toBe('https://www.facebook.com/groups/1/');
    expect(postingAboutOn('facebook')).toBe(W.abouts.posting);
    expect(postingAboutOn('linkedin')).not.toMatch(/group/i);
  });

  it('tidies LinkedIn by withdrawing old invitations, never removing a connection', () => {
    const facebook = tidyWordsOn('facebook');
    expect(facebook.kinds).toEqual(['cancel', 'unfriend']);
    expect(facebook.about).toBe(`Tick the ones to go. ${TIDY_PACE_WORDS}`);
    expect(facebook.cancel.title).toBe('Old friend requests');
    expect(facebook.cancel.about(3)).toBe(
      'Sent more than 3 weeks ago and not answered. Facebook pauses your requests when too many wait.',
    );
    expect(facebook.unfriend.title).toBe('Friends to unfriend');

    const linkedIn = tidyWordsOn('linkedin');
    expect(linkedIn.kinds).toEqual(['cancel']);
    expect(linkedIn.cancel).toMatchObject({
      title: 'Old invitations',
      button: 'Withdraw the ticked invitations',
      done: 'invitations withdrawn',
    });
    expect(linkedIn.cancel.about(1)).toMatch(
      /^Sent more than a week ago and not answered\. LinkedIn/,
    );
    expect(linkedIn.about).toContain('in a LinkedIn tab');
    expect(linkedIn.about).not.toMatch(/Facebook/);
    expect(askNameOn('cancel', 'linkedin')).toBe('Withdraw old invitations');
    expect(askNameOn('profile_edit', 'linkedin')).toBe('Put your new headline in');
    expect(askNameOn('profile_read', 'linkedin')).toBe('Read your LinkedIn profile');
    expect(askNameOn('cancel')).toBe(ASK_KINDS.cancel);
  });
});

describe('LinkedIn from the app', () => {
  let owner: TestUser;
  let ws: string;
  const linkedInOn = {
    ...AUTOMATION_DEFAULTS,
    networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORK_CHOICES_DEFAULTS, on: true } },
  };

  beforeAll(async () => {
    owner = await createTestUser('outla-owner', { fullName: 'Morgan Owner' });
    ws = await outreachBusiness(owner, 'Outreach LinkedIn App Co');
    // A playbook with a niche: one of the things a person needs before their day starts (decision 63).
    await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: PLAYBOOK_TEMPLATES.crm_demos.details,
    });
  }, 60_000);

  afterAll(closeTestDbs);

  async function teammate(name: string): Promise<TestUser> {
    const u = await createTestUser(`outla-${name.toLowerCase().replace(/\s+/g, '-')}`, {
      fullName: name,
    });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: u.id, role: 'member' });
    return u;
  }

  async function profile(platform: 'facebook' | 'linkedin', name: string): Promise<string> {
    const slug = `${name.toLowerCase().replace(/\s+/g, '')}${randomUUID().slice(0, 6)}`;
    const url =
      platform === 'linkedin'
        ? `https://www.linkedin.com/in/${slug}/`
        : `https://www.facebook.com/${slug}`;
    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
          values (${ws}, ${platform}, ${slug}, ${url}, ${name}) returning id`,
    );
    return made!.id;
  }

  it('counts each network’s tidying, friends and file on its own', async () => {
    const dana = await teammate('Dana Reyes');
    // Three old invitations withdrawn on LinkedIn today, and one request cancelled on Facebook.
    for (const name of ['Avery Lane', 'Blake Moss', 'Cory Hale']) {
      const id = await profile('linkedin', name);
      await rows(
        admin(),
        sql`insert into addon_outreach.friend_ends (workspace_id, user_id, profile_id, kind, at)
            values (${ws}, ${dana.id}, ${id}, 'cancel_request', now())`,
      );
    }
    const onFacebook = await profile('facebook', 'Drew Park');
    await rows(
      admin(),
      sql`insert into addon_outreach.friend_ends (workspace_id, user_id, profile_id, kind, at)
          values (${ws}, ${dana.id}, ${onFacebook}, 'cancel_request', now())`,
    );
    // Two connections on LinkedIn, one friend on Facebook.
    for (const [platform, name] of [
      ['linkedin', 'Emery Stone'],
      ['linkedin', 'Finley Gray'],
      ['facebook', 'Gale Fox'],
    ] as const)
      await rows(
        admin(),
        sql`insert into addon_outreach.friends (workspace_id, user_id, profile_id, state, since, seen_at)
            values (${ws}, ${dana.id}, ${await profile(platform, name)}, 'friends', now(), now())`,
      );
    // Facebook's file is in; LinkedIn has none.
    await rows(
      admin(),
      sql`insert into addon_outreach.imports (workspace_id, user_id, platform, made_at, counts, finished_at)
          values (${ws}, ${dana.id}, 'facebook', now(), '{}'::jsonb, now())`,
    );

    const facebook: TidyOutput = await runAs(dana, ws, 'outreach.friends.tidy', {});
    const linkedIn: TidyOutput = await runAs(dana, ws, 'outreach.friends.tidy', {
      platform: 'linkedin',
    });
    expect(facebook.limits.cancel_request.done).toBe(1);
    expect(linkedIn.limits.cancel_request).toEqual({ done: 3, most: 20 });
    // LinkedIn never removes a connection.
    expect(linkedIn.limits.unfriend.most).toBe(0);
    expect(facebook.friends).toBe(1);
    expect(linkedIn.friends).toBe(2);
    expect(linkedIn.cap).toBe(30_000);
    expect(facebook.needsFile).toBe(false);
    expect(linkedIn.needsFile).toBe(true);
  });

  it('says a LinkedIn post with no group is on LinkedIn, on Today’s list', async () => {
    const sam = await teammate('Sam Lee');
    await runAs(sam, ws, 'outreach.automation.save', { settings: linkedInOn });
    const writer = await profile('linkedin', 'Harper Quinn');
    await rows(
      admin(),
      sql`insert into addon_outreach.posts
            (workspace_id, user_id, group_id, profile_id, url, body, found, check_state, check_why, seen_at)
          values (${ws}, ${sam.id}, null, ${writer},
            'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
            'Can anyone recommend a CRM for a small crew?', 'search', 'good', 'Asks for a CRM', now())`,
    );
    const today = await runAs(sam, ws, 'outreach.today', { platform: 'linkedin' });
    const comment = (
      today.items as { kind: string; name: string; why: string[]; postUrl: string | null }[]
    ).find((i) => i.kind === 'comment');
    expect(comment).toMatchObject({
      name: 'Harper Quinn',
      why: ['Asks for a CRM', 'On LinkedIn'],
      postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
    });
  });

  it('puts a LinkedIn headline in, up to LinkedIn’s 220 characters, and keeps Facebook’s bio to 101', async () => {
    const ash = await teammate('Ash Kim');
    await runAs(ash, ws, 'outreach.automation.save', { settings: linkedInOn });
    await runWith(
      ash,
      ws,
      'outreach.live.beat',
      {
        computer: { id: randomUUID(), name: 'Chrome on Mac', version: '0.40.0' },
        active: true,
        status: { state: 'idle', line: null, lineAt: null, nextAt: null },
      },
      { channel: 'extension', commandId: randomUUID(), occurredAt: new Date(), sentAt: new Date() },
    );
    const headline =
      `I help owners of small crews book more calls. ${'Plain follow-ups, '.repeat(8)}`.trim();
    expect(headline.length).toBeGreaterThan(101);
    expect(headline.length).toBeLessThanOrEqual(220);
    const ask = (platform: 'facebook' | 'linkedin') =>
      runWith(
        ash,
        ws,
        'outreach.ask.make',
        { platform, ask: { kind: 'profile_edit', bio: headline } },
        { channel: 'web' },
      );
    expect(await ask('linkedin')).toMatchObject({
      fresh: true,
      ask: { platform: 'linkedin', kind: 'profile_edit' },
    });
    expect(await refused(ask('facebook'))).toBe('outreach_bio_too_long');
  });
});
