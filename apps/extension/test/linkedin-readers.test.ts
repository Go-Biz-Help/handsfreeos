/**
 * The LinkedIn readers against hand-written pages in test/fixtures (linkedin-*.html). Those pages are our best guess
 * at LinkedIn's markup, not saved LinkedIn pages: these tests hold the readers' logic still, and the page outlines
 * from the owner's own account are what tune them to the real thing.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { readChat } from '../src/networks/linkedin/chat';
import { shownLines } from '../src/networks/linkedin/dom';
import { readPage } from '../src/networks/linkedin/page';
import type { ProfileRef, ReadResult } from '../src/networks/linkedin/types';
import { classifyUrl } from '../src/networks/linkedin/urls';
import {
  degreeOnly,
  isSentWhen,
  mutualCount,
  nameFrom,
  postTimeOf,
} from '../src/networks/linkedin/vocabulary';
import { readWarnings } from '../src/networks/linkedin/warnings';
import { load } from './load';

const NOW = new Date('2026-10-15T12:00:00Z');

function read(fixture: string, url: string, doc: Document = load(fixture, url)): ReadResult {
  return readPage(doc, url, NOW, { sideOf: () => null });
}

const dana: ProfileRef = {
  id: null,
  username: 'dana-reyes-4b2a1c',
  url: 'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
};
const danaWithId: ProfileRef = { ...dana, id: 'ACoAAFakeDanaReyes123' };

/** Puts a button in place of another, as LinkedIn does when where you stand changes. */
function swapButton(doc: Document, label: string, html: string) {
  const button = doc.querySelector(`[aria-label="${label}"]`)!;
  button.insertAdjacentHTML('beforebegin', html);
  button.remove();
}

describe('a member’s profile', () => {
  const url = 'https://www.linkedin.com/in/dana-reyes-4b2a1c/';

  it('reads who they are, their role and company, and where you stand', () => {
    const result = read('linkedin-profile.html', url);
    expect(result.kind).toBe('profile');
    expect(result.profile).toEqual({
      name: 'Dana Reyes',
      // The id is in the links of her mutual connections and her Message.
      profile: danaWithId,
      headline: 'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
      location: 'Austin, Texas, United States',
      about:
        'Third-generation plumber serving Austin since 2009.\nWe fix leaks, replace water heaters and take emergency calls 24/7.',
      role: {
        title: 'Owner',
        company: 'Acme Plumbing',
        dates: 'Jan 2015 - Present · 10 yrs 10 mos',
      },
      company: {
        name: 'Acme Plumbing',
        company: {
          id: 'acme-plumbing-atx',
          url: 'https://www.linkedin.com/company/acme-plumbing-atx/',
        },
      },
      degree: '2nd',
      connection: 'not_connected',
      // Connect is the main button; Follow is only under More.
      followFirst: false,
      mutualConnections: 12,
    });
    expect(result.notes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('knows an invitation you sent is waiting', () => {
    const doc = load('linkedin-profile.html', url);
    swapButton(
      doc,
      'Invite Dana Reyes to connect',
      '<button aria-label="Pending, click to withdraw invitation sent to Dana Reyes"><span>Pending</span></button>',
    );
    expect(read('linkedin-profile.html', url, doc).profile?.connection).toBe('pending');
  });

  it('knows she invited you', () => {
    const doc = load('linkedin-profile.html', url);
    swapButton(
      doc,
      'Invite Dana Reyes to connect',
      '<button aria-label="Accept Dana Reyes’s invitation"><span>Accept</span></button>' +
        '<button aria-label="Ignore an invitation to connect from Dana Reyes"><span>Ignore</span></button>',
    );
    expect(read('linkedin-profile.html', url, doc).profile?.connection).toBe('received');
  });

  it('knows you’re connected, by how far she is', () => {
    const doc = load('linkedin-profile.html', url);
    doc.querySelector('[aria-label="Invite Dana Reyes to connect"]')!.remove();
    for (const degree of doc.querySelectorAll('main span[aria-hidden="true"]'))
      if (degree.textContent === '· 2nd') {
        degree.textContent = '· 1st';
        degree.nextElementSibling!.textContent = '1st degree connection';
      }
    expect(read('linkedin-profile.html', url, doc).profile).toMatchObject({
      degree: '1st',
      connection: 'connected',
    });
  });

  it('finds the name in the page’s title when the top has no heading', () => {
    const doc = load('linkedin-profile.html', url);
    doc.querySelector('h1')!.remove();
    expect(read('linkedin-profile.html', url, doc).profile?.name).toBe('Dana Reyes');
  });

  it('says so when it can’t find the name', () => {
    const doc = load('linkedin-profile.html', url);
    doc.querySelector('h1')!.remove();
    doc.title = 'LinkedIn';
    expect(read('linkedin-profile.html', url, doc).notes).toEqual([
      'Couldn’t find the name on this profile.',
    ]);
  });
});

describe('a profile whose main button is Follow', () => {
  const result = read('linkedin-profile-follow.html', 'https://www.linkedin.com/in/sam-lee-77/');

  it('says Follow comes first, and that you aren’t connected (Connect is under More)', () => {
    expect(result.profile).toMatchObject({
      name: 'Sam Lee',
      headline: 'Founder at Lane & Lee Roofing · I post about running a trade business',
      location: 'Dallas, Texas, United States',
      about: null,
      degree: '3rd',
      connection: 'not_connected',
      followFirst: true,
      mutualConnections: null,
    });
  });

  it('reads a company with its roles under it: the company, and the first role', () => {
    expect(result.profile?.role).toEqual({
      title: 'Founder',
      company: 'Lane & Lee Roofing',
      dates: 'Mar 2021 - Present · 4 yrs 8 mos',
    });
    expect(result.profile?.company).toEqual({
      name: 'Lane & Lee Roofing',
      company: {
        id: 'lane-lee-roofing',
        url: 'https://www.linkedin.com/company/lane-lee-roofing/',
      },
    });
  });
});

describe('your own profile', () => {
  it('knows it’s you, and whose it is from its Contact info though the address is /in/me/', () => {
    const result = read('linkedin-own-profile.html', 'https://www.linkedin.com/in/me/');
    expect(result.kind).toBe('own-profile');
    expect(result.profile).toMatchObject({
      name: 'Chris Gee',
      profile: {
        id: null,
        username: 'chris-gee-12',
        url: 'https://www.linkedin.com/in/chris-gee-12/',
      },
      headline: 'Helping home service businesses answer every lead | Founder, Gee Consulting',
      location: 'Austin, Texas, United States',
      about:
        'I help plumbers, roofers and cleaners answer every call and follow up on every quote.',
      role: { title: 'Founder', company: 'Gee Consulting', dates: '2019 - Present · 6 yrs' },
      connection: 'self',
      followFirst: false,
    });
  });
});

describe('your connections', () => {
  const result = read(
    'linkedin-connections.html',
    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  );

  it('reads each connection once, with what they do and when you connected', () => {
    expect(result.people).toEqual([
      {
        name: 'Dana Reyes',
        profile: dana,
        headline: 'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
        location: null,
        degree: '1st',
        mutualConnections: null,
        details: [
          'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
          'Connected on October 3, 2026',
        ],
        connection: 'connected',
      },
      {
        name: 'Sam Lee',
        profile: {
          id: null,
          username: 'sam-lee-77',
          url: 'https://www.linkedin.com/in/sam-lee-77/',
        },
        headline: 'Founder at Lane & Lee Roofing · I post about running a trade business',
        location: null,
        degree: '1st',
        mutualConnections: null,
        details: [
          'Founder at Lane & Lee Roofing · I post about running a trade business',
          'Connected on September 28, 2026',
        ],
        connection: 'connected',
      },
      {
        name: 'Renée Park',
        // Her two links write her name's escapes two ways: one person.
        profile: {
          id: null,
          username: 'ren%C3%A9e-park',
          url: 'https://www.linkedin.com/in/ren%C3%A9e-park/',
        },
        headline: 'Realtor® · Park Homes Group',
        location: null,
        degree: '1st',
        mutualConnections: null,
        details: ['Realtor® · Park Homes Group', 'Connected on August 2, 2026'],
        connection: 'connected',
      },
    ]);
  });

  it('never takes you, from the column beside the list', () => {
    expect(result.people?.map((person) => person.name)).not.toContain('Chris Gee');
    expect(result.notes).toEqual(['LinkedIn loads more as you scroll. Scroll down to get more.']);
  });
});

describe('your invitations', () => {
  const received = 'https://www.linkedin.com/mynetwork/invitation-manager/received/';
  const sent = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
  const brief = (result: ReadResult) =>
    result.invitations?.map(
      ({ name, profile, mutualConnections, direction, when, connection }) => ({
        name,
        username: profile.username,
        mutualConnections,
        direction,
        when,
        connection,
      }),
    );

  it('reads the ones you’ve got, not the mutual connection’s face, nor an invitation to follow a page', () => {
    const result = read('linkedin-invitations.html', received);
    expect(brief(result)).toEqual([
      {
        name: 'Jordan Blake',
        username: 'jordan-blake-09',
        mutualConnections: 4,
        direction: 'received',
        when: 'Yesterday',
        connection: 'received',
      },
      {
        name: 'Taylor Reed',
        username: 'taylor-reed-5',
        mutualConnections: 1,
        direction: 'received',
        when: '3 days ago',
        connection: 'received',
      },
    ]);
    expect(result.invitations?.[0]).toMatchObject({
      headline: 'Property Manager at Blake Rentals',
      details: [
        'Property Manager at Blake Rentals',
        'Sam Lee and 3 other mutual connections',
        'Yesterday',
      ],
    });
  });

  it('reads the ones you’ve sent, with when, and not one that links to nobody', () => {
    expect(brief(read('linkedin-invitations-sent.html', sent))).toEqual([
      {
        name: 'Morgan Ellis',
        username: 'morgan-ellis-3',
        mutualConnections: null,
        direction: 'sent',
        when: 'Sent 3 weeks ago',
        connection: 'pending',
      },
      {
        name: 'Quinn Harper',
        username: 'quinnharper',
        mutualConnections: null,
        direction: 'sent',
        when: 'Sent today',
        connection: 'pending',
      },
    ]);
  });

  it('leaves out an invitation whose row can’t be told from the rest', () => {
    const doc = load('linkedin-invitations.html', received);
    for (const anchor of doc.querySelectorAll('a[href*="jordan-blake-09"]')) anchor.remove();
    expect(
      brief(read('linkedin-invitations.html', received, doc))?.map(({ name }) => name),
    ).toEqual(['Taylor Reed']);
  });
});

describe('people search', () => {
  const url = 'https://www.linkedin.com/search/results/people/?keywords=plumber';
  const result = read('linkedin-search-people.html', url);

  it('reads each person, how far they are and where you stand, and not one LinkedIn hides', () => {
    expect(
      result.people?.map(({ name, profile, location, degree, mutualConnections, connection }) => ({
        name,
        id: profile.id,
        location,
        degree,
        mutualConnections,
        connection,
      })),
    ).toEqual([
      {
        name: 'Dana Reyes',
        id: 'ACoAAFakeDanaReyes123',
        location: 'Austin, Texas Metropolitan Area',
        degree: '2nd',
        mutualConnections: 12,
        connection: 'not_connected',
      },
      {
        name: 'Sam Lee',
        id: 'ACoAAFakeSamLee456',
        location: 'Dallas-Fort Worth Metroplex',
        degree: '1st',
        mutualConnections: null,
        connection: 'connected',
      },
      {
        name: 'Avery Lane',
        id: null,
        location: 'Round Rock, Texas',
        degree: '3rd',
        mutualConnections: null,
        connection: 'not_connected',
      },
      {
        name: 'Morgan Ellis',
        id: null,
        location: 'Austin, Texas',
        degree: '2nd',
        mutualConnections: 1,
        connection: 'pending',
      },
    ]);
  });

  it('reads what LinkedIn shows, not its copies for screen readers', () => {
    expect(result.people?.[0]).toMatchObject({
      name: 'Dana Reyes',
      profile: danaWithId,
      headline: 'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
      details: [
        'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
        'Austin, Texas Metropolitan Area',
        'Current: Owner at Acme Plumbing',
        'Sam Lee and 11 other mutual connections',
      ],
    });
  });

  it('says results come a page at a time', () => {
    expect(result.notes).toEqual([
      'LinkedIn shows 10 people a page. Go to the next page to get more.',
    ]);
  });
});

describe('the feed', () => {
  const url = 'https://www.linkedin.com/feed/';
  const posts = [
    {
      author: { name: 'Dana Reyes', profile: danaWithId },
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/',
      when: '3h',
      text: 'Spring is the time to check your water heater. Ours ran 14 years before it went.\nThanks Sam Lee for the reminder! #plumbing',
      comments: 8,
      reactions: 42,
      company: null,
      headline: 'Owner at Acme Plumbing | Helping Austin homeowners since 2009',
    },
    {
      // Sam Lee likes it; Avery Lane wrote it.
      author: {
        name: 'Avery Lane',
        profile: { id: null, username: 'averylane', url: 'https://www.linkedin.com/in/averylane/' },
      },
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000202/',
      when: '1w',
      text: 'Planting season is close. Here are five plants that handle a Texas summer without much water.',
      comments: 3,
      // "Dana Reyes and 11 others".
      reactions: 12,
      company: null,
      headline: 'Landscape designer · I post about outdoor living',
    },
    {
      author: { name: 'Acme Plumbing', profile: null },
      url: null,
      when: '2mo',
      text: 'We’re hiring a licensed plumber in Austin. Apply through the link below.',
      comments: null,
      reactions: 18,
      company: {
        id: 'acme-plumbing-atx',
        url: 'https://www.linkedin.com/company/acme-plumbing-atx/',
      },
      // Its followers, under its name, are LinkedIn's count: not a headline.
      headline: null,
    },
  ];

  it('reads each post once, however LinkedIn draws it, and never a comment or a link’s preview as one', () => {
    const result = read('linkedin-feed.html', url);
    expect(result.posts).toEqual(posts);
    expect(result.notes).toEqual(['LinkedIn loads more as you scroll. Scroll down to get more.']);
  });

  it('finds every post by the menu at its top when none is an article or named', () => {
    const doc = load('linkedin-feed.html', url);
    for (const element of doc.querySelectorAll('[role="article"], [data-urn], [data-id]')) {
      if (element.matches('article')) continue;
      element.removeAttribute('role');
      element.removeAttribute('data-urn');
      element.removeAttribute('data-id');
    }
    expect(read('linkedin-feed.html', url, doc).posts).toEqual(
      // Without their ids, nothing in them says their address.
      posts.map((post) => ({ ...post, url: null })),
    );
  });
});

describe('post search', () => {
  it('reads each post with its address from its link, without LinkedIn’s tracking', () => {
    const url =
      'https://www.linkedin.com/search/results/content/?keywords=recommend%20a%20plumber&sortBy=%22date_posted%22';
    const result = read('linkedin-search-posts.html', url);
    expect(result.kind).toBe('search-posts');
    expect(
      result.posts?.map(({ author, url: link, when, text, comments, reactions }) => ({
        author: author?.profile?.username,
        link,
        when,
        text,
        comments,
        reactions,
      })),
    ).toEqual([
      {
        author: 'jordan-blake-09',
        link: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000404/',
        when: '5h',
        text: 'Can anyone recommend a plumber in Austin? Our water heater is leaking and the first company can’t come until next week.',
        comments: 4,
        reactions: 6,
      },
      {
        author: 'ren%C3%A9e-park',
        link: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000505/',
        when: '1d',
        text: 'Looking for a reliable handyman in Round Rock for a few small jobs before we list a house. DM me!',
        comments: null,
        reactions: null,
      },
    ]);
  });
});

describe('post search, never the person’s own', () => {
  it('leaves out their own post, by the name on the top bar’s Me (decision 92)', () => {
    const url =
      'https://www.linkedin.com/search/results/content/?keywords=recommend%20a%20plumber&sortBy=%22date_posted%22';
    const doc = load('linkedin-search-posts.html', url);
    // The person here is Jordan Blake: their own post under the search is nobody's to find or comment on.
    doc.querySelector('nav img')!.setAttribute('alt', 'Jordan Blake');
    expect(read('linkedin-search-posts.html', url, doc).posts?.map((p) => p.author?.name)).toEqual([
      'Renée Park',
    ]);
  });
});

describe('a post’s own page', () => {
  it('reads the post, its address from the page’s, and none of its comments or replies as posts', () => {
    const url = 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/';
    const result = read('linkedin-post.html', url);
    expect(result.posts).toEqual([
      {
        author: { name: 'Dana Reyes', profile: dana },
        url,
        when: '3h',
        text: 'Spring is the time to check your water heater. Ours ran 14 years before it went.',
        comments: 2,
        reactions: 42,
        company: null,
        headline: null,
      },
    ]);
    expect(result.notes).toEqual([]);
  });
});

describe('a group', () => {
  it('reads its name and its posts', () => {
    const result = read('linkedin-group.html', 'https://www.linkedin.com/groups/9876543/');
    expect(result.group).toEqual({
      name: 'Austin Home Services Pros',
      group: { id: '9876543', url: 'https://www.linkedin.com/groups/9876543/' },
    });
    expect(
      result.posts?.map(({ author, when, text, comments }) => [author?.name, when, text, comments]),
    ).toEqual([
      ['Sam Lee', '4h', 'Who here does gutter cleaning in Pflugerville? Need a referral.', 1],
    ]);
  });
});

describe('a conversation', () => {
  const url = 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/';
  const messages = [
    {
      from: 'me',
      sender: null,
      text: 'Hi Dana, thanks for connecting. I saw your post about water heaters.',
      when: 'Oct 3 at 4:05 PM',
    },
    {
      from: 'me',
      sender: null,
      text: 'Do you handle commercial jobs too?',
      when: 'Oct 3 at 4:05 PM',
    },
    {
      from: 'them',
      sender: 'Dana Reyes',
      text: 'Hi Chris! Yes, we do a few office buildings.',
      when: 'Today at 2:15 PM',
    },
    {
      from: 'them',
      sender: 'Dana Reyes',
      text: 'Happy to talk. Is Tuesday good?',
      when: 'Today at 2:15 PM',
    },
    { from: 'me', sender: null, text: 'Tuesday at 10 works for me.', when: 'Today at 2:20 PM' },
    {
      from: 'them',
      sender: 'Dana Reyes',
      text: 'Tuesday works. Talk then!',
      when: 'Today at 2:21 PM',
    },
  ];

  it('reads who it’s with and who said what, oldest first, and not the card about them at the start', () => {
    const result = read('linkedin-chat.html', url);
    expect(result.chat).toEqual({
      name: 'Dana Reyes',
      thread: {
        id: '2-MadeUpThreadDana0001==',
        encrypted: false,
        url: 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/',
      },
      // Messaging links people by id alone.
      profile: {
        id: 'ACoAAFakeDanaReyes123',
        username: null,
        url: 'https://www.linkedin.com/in/ACoAAFakeDanaReyes123/',
      },
      messages,
    });
  });

  it('tells yours from theirs without your name, in a chat with one person', () => {
    const doc = load('linkedin-chat.html', url);
    doc.querySelector('header')!.remove();
    expect(readChat(doc, classifyUrl(url), url).messages).toEqual(messages);
  });

  it('reads the conversation LinkedIn labels as one, the same', () => {
    const doc = load('linkedin-chat.html', url);
    doc.querySelectorAll('main ul')[1]!.setAttribute('aria-label', 'Conversation with Dana Reyes');
    expect(readChat(doc, classifyUrl(url), url).messages).toEqual(messages);
  });

  it('goes by the side a message sits on when nothing names its run, and the run carries on', () => {
    const doc = load('linkedin-chat.html', url);
    const rows = doc.querySelectorAll('main ul')[1]!.querySelectorAll(':scope > li');
    // The first run of each day loses its picture, name, time and the line for screen readers.
    for (const row of [rows[2]!, rows[4]!])
      for (const meta of row.querySelectorAll('li > div > a, li > div > span, li > div > div'))
        meta.remove();
    const mine = /^(Hi Dana|Do you)/;
    const chat = readChat(doc, classifyUrl(url), url, {
      sideOf: (element) => (mine.test(element.textContent?.trim() ?? '') ? 'right' : 'left'),
    });
    expect(chat.messages.map(({ from, sender, when }) => [from, sender, when])).toEqual([
      ['me', null, 'Oct 3'],
      ['me', null, 'Oct 3'],
      ['them', 'Dana Reyes', 'Today'],
      ['them', 'Dana Reyes', 'Today'],
      ['me', null, 'Today at 2:20 PM'],
      ['them', 'Dana Reyes', 'Today at 2:21 PM'],
    ]);
  });

  it('reads the conversations beside it, without LinkedIn’s words about them', () => {
    const chats = read('linkedin-chat.html', url).chats;
    expect(
      chats?.map(({ name, thread, preview, when }) => ({ name, id: thread.id, preview, when })),
    ).toEqual([
      {
        name: 'Dana Reyes',
        id: '2-MadeUpThreadDana0001==',
        preview: 'Dana: Tuesday works. Talk then!',
        when: '2:21 PM',
      },
      {
        name: 'Sam Lee',
        id: '2-MadeUpThreadSam0002==',
        preview: 'You: Thanks Sam, talk soon',
        when: 'Oct 3',
      },
      {
        name: 'Dana Reyes, Sam Lee and Avery Lane',
        id: '2-MadeUpThreadGroup0003==',
        preview: 'Avery: See everyone Thursday',
        when: 'Sep 29',
      },
    ]);
  });

  it('reads only the list on messaging itself', () => {
    const result = read('linkedin-chat.html', 'https://www.linkedin.com/messaging/');
    expect(result.kind).toBe('messaging');
    expect(result.chat).toBeUndefined();
    expect(result.chats).toHaveLength(3);
  });
});

describe('notifications', () => {
  const result = read('linkedin-notifications.html', 'https://www.linkedin.com/notifications/');

  it('reads who did what, and when', () => {
    expect(result.notices?.map(({ kind, names, when }) => ({ kind, names, when }))).toEqual([
      { kind: 'accepted', names: ['Morgan Ellis'], when: '2h' },
      { kind: 'reaction', names: ['Sam Lee'], when: '5h' },
      { kind: 'comment', names: ['Avery Lane'], when: '1d' },
      { kind: 'mention', names: ['Renée Park'], when: '2d' },
      // "14 people" and "Your profile" aren't anyone.
      { kind: 'viewed', names: [], when: '3d' },
      { kind: 'viewed', names: ['Dana Reyes'], when: '4d' },
      { kind: 'other', names: ['Acme Plumbing'], when: '1w' },
    ]);
  });

  it('links an accepted invitation to the person, and a reaction or a comment to the post', () => {
    expect(result.notices?.[0]).toMatchObject({
      text: 'Morgan Ellis accepted your invitation. Say hello.',
      profile: { username: 'morgan-ellis-3' },
      url: 'https://www.linkedin.com/in/morgan-ellis-3/',
    });
    expect(result.notices?.[1]).toMatchObject({
      profile: { username: 'sam-lee-77' },
      url: 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/',
    });
    expect(result.notices?.[2]?.url).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000202/',
    );
    expect(result.notices?.[4]).toMatchObject({ profile: null, url: null });
  });
});

describe('LinkedIn’s warnings', () => {
  it('finds the weekly invitation limit in a dialog, and not in somebody’s post about it', () => {
    const result = read('linkedin-warning.html', 'https://www.linkedin.com/feed/');
    expect(result.warnings).toEqual(['You’ve reached the weekly invitation limit']);
    // The post is still read; the note about scrolling for more isn't the point today.
    expect(result.posts).toHaveLength(1);
    expect(result.notes).toEqual([]);
  });

  it('finds a security check, and counts a checkpoint page as one', () => {
    const url = 'https://www.linkedin.com/checkpoint/challenge/AgMadeUp?ut=x';
    expect(readWarnings(load('linkedin-checkpoint.html', url), url)).toEqual([
      'LinkedIn is asking you to check your account before you go on.',
      'Let’s do a quick security check',
    ]);
  });

  it('finds a restricted account, and doesn’t ask for the outline for the posts it hides', () => {
    const result = read('linkedin-restricted.html', 'https://www.linkedin.com/feed/');
    expect(result.warnings).toEqual([
      'Your account has been temporarily restricted',
      'We’ve noticed some unusual activity. To get back in, confirm a few details.',
    ]);
    expect(result.notes).toEqual([]);
  });

  it('finds the search limit for free accounts', () => {
    const result = read(
      'linkedin-search-limit.html',
      'https://www.linkedin.com/search/results/people/?keywords=plumber',
    );
    expect(result.warnings).toEqual(['You’ve reached the monthly limit for profile searches']);
    expect(result.people).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('finds none on a page without any', () => {
    const url = 'https://www.linkedin.com/feed/';
    expect(readWarnings(load('linkedin-feed.html', url), url)).toEqual([]);
  });
});

describe('a reader that finds nothing', () => {
  it('says so, and asks for the outline, while LinkedIn still loads its results', () => {
    const result = read(
      'linkedin-loading.html',
      'https://www.linkedin.com/search/results/people/?keywords=roofing',
    );
    expect(result.people).toEqual([]);
    expect(result.notes).toEqual([
      'Found no people here. If the page shows some, save the page outline and send it to us so we can fix the reader.',
      'LinkedIn shows 10 people a page. Go to the next page to get more.',
    ]);
  });

  it('doesn’t, where LinkedIn says there are none', () => {
    const url = 'https://www.linkedin.com/search/results/people/?keywords=roofing';
    const doc = load('linkedin-loading.html', url);
    doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<h2>No results found</h2>');
    expect(read('linkedin-loading.html', url, doc).notes).toEqual([
      'LinkedIn shows 10 people a page. Go to the next page to get more.',
    ]);
  });

  it('says it doesn’t read a kind of page it doesn’t know', () => {
    const result = read('linkedin-feed.html', 'https://www.linkedin.com/jobs/');
    expect(result).toMatchObject({
      platform: 'linkedin',
      kind: 'other',
      readAt: '2026-10-15T12:00:00.000Z',
    });
    expect(result.posts).toBeUndefined();
    expect(result.notes).toEqual(['The extension doesn’t read this kind of page yet.']);
  });
});

describe('what the readers give HandsFreeOS', () => {
  /** Core's LinkedIn kit (`NETWORKS.linkedin` in packages/core/src/addons/outreach/networks.ts). */
  const KIT = {
    link: /^https:\/\/www\.linkedin\.com\//,
    profileId: /^[A-Za-z0-9_-]{1,64}$/,
    username: /^[A-Za-z0-9%_-]{1,100}$/,
    threadKey: /^[A-Za-z0-9._=+-]{1,128}$/,
  };
  const pages: readonly (readonly [string, string])[] = [
    ['linkedin-profile.html', 'https://www.linkedin.com/in/dana-reyes-4b2a1c/'],
    ['linkedin-own-profile.html', 'https://www.linkedin.com/in/me/'],
    ['linkedin-connections.html', 'https://www.linkedin.com/mynetwork/invite-connect/connections/'],
    [
      'linkedin-invitations.html',
      'https://www.linkedin.com/mynetwork/invitation-manager/received/',
    ],
    [
      'linkedin-search-people.html',
      'https://www.linkedin.com/search/results/people/?keywords=plumber',
    ],
    ['linkedin-feed.html', 'https://www.linkedin.com/feed/'],
    ['linkedin-search-posts.html', 'https://www.linkedin.com/search/results/content/?keywords=x'],
    ['linkedin-chat.html', 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/'],
    ['linkedin-notifications.html', 'https://www.linkedin.com/notifications/'],
  ];

  it('fits core’s LinkedIn kit: every profile’s id, name and link, every chat’s id, every post’s link', () => {
    const profiles: ProfileRef[] = [];
    const threads: string[] = [];
    const links: string[] = [];
    for (const [fixture, url] of pages) {
      const result = read(fixture, url);
      if (result.profile?.profile) profiles.push(result.profile.profile);
      for (const person of [...(result.people ?? []), ...(result.invitations ?? [])])
        profiles.push(person.profile);
      for (const post of result.posts ?? []) {
        if (post.author?.profile) profiles.push(post.author.profile);
        if (post.url) links.push(post.url);
      }
      for (const notice of result.notices ?? []) {
        if (notice.profile) profiles.push(notice.profile);
        if (notice.url) links.push(notice.url);
      }
      if (result.chat?.profile) profiles.push(result.chat.profile);
      for (const chat of result.chats ?? []) threads.push(chat.thread.id);
    }
    expect(profiles.length).toBeGreaterThan(15);
    for (const profile of profiles) {
      expect(profile.url).toMatch(KIT.link);
      if (profile.id !== null) expect(profile.id).toMatch(KIT.profileId);
      if (profile.username !== null) expect(profile.username).toMatch(KIT.username);
      expect(profile.id ?? profile.username).not.toBeNull();
    }
    expect(threads).toHaveLength(3);
    for (const thread of threads) expect(thread).toMatch(KIT.threadKey);
    for (const link of links) expect(link).toMatch(KIT.link);
  });
});

describe('what LinkedIn shows', () => {
  const lines = (html: string) =>
    shownLines(new JSDOM(`<body><div>${html}</div></body>`).window.document.body);

  it('leaves out the copy for screen readers after what’s shown, and ends the line there', () => {
    expect(
      lines(
        '<a><span aria-hidden="true">Dana Reyes</span><span>View Dana Reyes’ profile</span></a>' +
          '<span><span aria-hidden="true">• 2nd</span><span>2nd degree connection</span></span>',
      ),
    ).toEqual(['Dana Reyes', '• 2nd']);
    expect(
      lines('<span aria-hidden="true">3h • </span><span>3 hours ago • Visible to anyone</span>'),
    ).toEqual(['3h •']);
  });

  it('keeps what follows a hidden piece that isn’t copied: a separator, a badge’s number', () => {
    expect(lines('Austin, Texas <span aria-hidden="true">·</span> <a>Contact info</a>')).toEqual([
      'Austin, Texas · Contact info',
    ]);
    expect(lines('<span aria-hidden="true">1</span><span>You: see you then</span>')).toEqual([
      '1 You: see you then',
    ]);
  });

  it('keeps line breaks in what’s shown, and none of the copy’s', () => {
    expect(lines('<span aria-hidden="true">One.<br>Two.</span><span>One.<br>Two.</span>')).toEqual([
      'One.',
      'Two.',
    ]);
  });
});

describe('LinkedIn’s words', () => {
  it('counts mutual connections however a line says them', () => {
    expect(mutualCount('12 mutual connections')).toBe(12);
    expect(mutualCount('Sam Lee and 11 other mutual connections')).toBe(12);
    expect(mutualCount('Sam Lee, Avery Lane, and 10 other mutual connections')).toBe(12);
    expect(mutualCount('Sam Lee and Avery Lane are mutual connections')).toBe(2);
    expect(mutualCount('Sam Lee is a mutual connection')).toBe(1);
    expect(mutualCount('Owner at Acme Plumbing')).toBeNull();
  });

  it('knows a line that only says how far someone is', () => {
    expect(degreeOnly('• 2nd')).toBe('2nd');
    expect(degreeOnly('3rd+ degree connection')).toBe('3rd');
    expect(degreeOnly('2nd degree connection 2nd')).toBe('2nd');
    expect(degreeOnly('2nd generation plumber')).toBeNull();
  });

  it('takes a name out of LinkedIn’s words around it', () => {
    expect(nameFrom('View Dana Reyes’ profile')).toBe('Dana Reyes');
    expect(nameFrom('View: Dana Reyes • 2nd Owner at Acme Plumbing')).toBe('Dana Reyes');
    expect(nameFrom('Dana Reyes’s profile picture')).toBe('Dana Reyes');
    expect(nameFrom('Photo of Dana Reyes')).toBe('Dana Reyes');
    expect(nameFrom('Sam O’Neil')).toBe('Sam O’Neil');
  });

  it('reads times as LinkedIn prints them', () => {
    expect(postTimeOf('3h • Edited •')).toBe('3h');
    expect(postTimeOf('2mo •')).toBe('2mo');
    expect(postTimeOf('3 hours ago • Visible to anyone on or off LinkedIn')).toBe('3 hours ago');
    expect(postTimeOf('• 2nd')).toBeNull();
    expect(postTimeOf('2:15 PM')).toBeNull();
    expect(isSentWhen('Sent 3 weeks ago')).toBe(true);
    expect(isSentWhen('Sent today')).toBe(true);
    expect(isSentWhen('Sent from my phone')).toBe(false);
  });
});
