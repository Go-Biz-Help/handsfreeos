import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  companyFromUrl,
  groupFromUrl,
  linkedinUrl,
  memberIdFrom,
  postOf,
  profileRefOf,
  threadOf,
  workUrl,
} from '../src/networks/linkedin/urls';

const parsed = <T>(read: (url: URL) => T, href: string): T | null => {
  const url = linkedinUrl(href);
  return url ? read(url) : null;
};

/** Core's LinkedIn kit (`NETWORKS.linkedin` in packages/core/src/addons/outreach/networks.ts): what saves take. */
const KIT = {
  link: /^https:\/\/www\.linkedin\.com\//,
  profileId: /^[A-Za-z0-9_-]{1,64}$/,
  username: /^[A-Za-z0-9%_-]{1,100}$/,
  threadKey: /^[A-Za-z0-9._=+-]{1,128}$/,
};

describe('classifyUrl', () => {
  it.each([
    ['https://www.linkedin.com/', 'feed'],
    ['https://www.linkedin.com/feed/', 'feed'],
    ['https://www.linkedin.com/feed/?trk=nav_logo', 'feed'],
    ['https://www.linkedin.com/in/dana-reyes-4b2a1c/', 'profile'],
    ['https://www.linkedin.com/in/dana-reyes-4b2a1c', 'profile'],
    ['https://www.linkedin.com/in/dana-reyes-4b2a1c/details/experience/', 'profile'],
    ['https://www.linkedin.com/in/dana-reyes-4b2a1c/overlay/contact-info/', 'profile'],
    ['https://www.linkedin.com/in/dana-reyes-4b2a1c/recent-activity/all/', 'activity'],
    ['https://www.linkedin.com/in/me/', 'own-profile'],
    ['https://www.linkedin.com/mynetwork/invite-connect/connections/', 'connections'],
    ['https://www.linkedin.com/mynetwork/invitation-manager/', 'invitations'],
    ['https://www.linkedin.com/mynetwork/invitation-manager/received/', 'invitations'],
    [
      'https://www.linkedin.com/mynetwork/invitation-manager/sent/?invitationType=CONNECTION',
      'invitations',
    ],
    ['https://www.linkedin.com/mynetwork/', 'other'],
    ['https://www.linkedin.com/search/results/people/?keywords=plumber', 'search-people'],
    [
      'https://www.linkedin.com/search/results/content/?keywords=plumber&sortBy=%22date_posted%22',
      'search-posts',
    ],
    ['https://www.linkedin.com/search/results/all/?keywords=plumber', 'search'],
    ['https://www.linkedin.com/search/results/companies/?keywords=plumber', 'other'],
    ['https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/', 'post'],
    ['https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7380000000000000101/', 'post'],
    [
      'https://www.linkedin.com/posts/dana-reyes-4b2a1c_water-heaters-activity-7380000000000000101-Ab3x',
      'post',
    ],
    ['https://www.linkedin.com/feed/hashtag/?keywords=plumbing', 'other'],
    ['https://www.linkedin.com/messaging/', 'messaging'],
    ['https://www.linkedin.com/messaging/thread/new/', 'messaging'],
    ['https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/', 'chat'],
    ['https://www.linkedin.com/notifications/?filter=all', 'notifications'],
    ['https://www.linkedin.com/groups/9876543/', 'group'],
    ['https://www.linkedin.com/groups/9876543/members/', 'other'],
    ['https://www.linkedin.com/groups/', 'other'],
    ['https://www.linkedin.com/company/acme-plumbing-atx/', 'company'],
    ['https://www.linkedin.com/company/acme-plumbing-atx/about/', 'company'],
    ['https://www.linkedin.com/company/', 'other'],
    ['https://www.linkedin.com/checkpoint/challenge/AgMadeUp', 'other'],
    ['https://www.linkedin.com.example.com/in/dana-reyes-4b2a1c/', 'other'],
    ['https://example.com/in/dana-reyes-4b2a1c/', 'other'],
    ['not a link', 'other'],
  ])('%s is %s', (url, kind) => {
    expect(classifyUrl(url).kind).toBe(kind);
  });

  it('says whose page it is, which chat, which post, and which invitations', () => {
    expect(
      classifyUrl('https://www.linkedin.com/in/Dana-Reyes-4b2a1c/details/experience/').profile,
    ).toEqual({
      id: null,
      username: 'Dana-Reyes-4b2a1c',
      url: 'https://www.linkedin.com/in/Dana-Reyes-4b2a1c/',
    });
    expect(classifyUrl('https://www.linkedin.com/in/me/').profile).toBeNull();
    expect(
      classifyUrl('https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/').thread,
    ).toEqual({
      id: '2-MadeUpThreadDana0001==',
      encrypted: false,
      url: 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/',
    });
    expect(
      classifyUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:7380000000000000999/?trk=x')
        .post,
    ).toBe('https://www.linkedin.com/feed/update/urn:li:ugcPost:7380000000000000999/');
    expect(
      classifyUrl('https://www.linkedin.com/mynetwork/invitation-manager/sent/').invitations,
    ).toBe('sent');
    expect(classifyUrl('https://www.linkedin.com/mynetwork/invitation-manager/').invitations).toBe(
      'received',
    );
    expect(classifyUrl('https://www.linkedin.com/groups/9876543/').group).toEqual({
      id: '9876543',
      url: 'https://www.linkedin.com/groups/9876543/',
    });
  });
});

describe('profileRefOf', () => {
  it('reads a member by the name in their address, without LinkedIn’s tracking', () => {
    expect(profileRefOf('/in/dana-reyes-4b2a1c/?lipi=urn%3Ali%3Apage%3Ad_flagship3&trk=x')).toEqual(
      {
        id: null,
        username: 'dana-reyes-4b2a1c',
        url: 'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
      },
    );
  });

  it('keeps the member id a search result’s link carries', () => {
    expect(
      profileRefOf(
        'https://www.linkedin.com/in/dana-reyes-4b2a1c?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAFakeDanaReyes123',
      ),
    ).toEqual({
      id: 'ACoAAFakeDanaReyes123',
      username: 'dana-reyes-4b2a1c',
      url: 'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
    });
  });

  it('reads a member linked by id alone, as messaging links them', () => {
    expect(profileRefOf('https://www.linkedin.com/in/ACoAAFakeDanaReyes123')).toEqual({
      id: 'ACoAAFakeDanaReyes123',
      username: null,
      url: 'https://www.linkedin.com/in/ACoAAFakeDanaReyes123/',
    });
  });

  it('keeps a name’s percent-escapes, written one way, as the kit takes them', () => {
    expect(profileRefOf('/in/ren%c3%a9e-park/')?.username).toBe('ren%C3%A9e-park');
    expect(profileRefOf('/in/renée-park/')?.username).toBe('ren%C3%A9e-park');
  });

  it('leaves out parts of profiles, your own /in/me/, other places and look-alike sites', () => {
    for (const href of [
      '/in/dana-reyes-4b2a1c/overlay/contact-info/',
      '/in/dana-reyes-4b2a1c/recent-activity/all/',
      '/in/me/',
      '/in/',
      '/company/acme-plumbing-atx/',
      '/search/results/people/?connectionOf=%5B%22ACoAAFakeDanaReyes123%22%5D',
      'https://www.linkedin.com.example.com/in/dana-reyes-4b2a1c/',
      'https://linkedin.example.com/in/dana-reyes-4b2a1c/',
      'https://example.com/in/dana-reyes-4b2a1c/',
      'https://lnkd.in/dana',
      'javascript:alert(1)',
    ])
      expect(profileRefOf(href), href).toBeNull();
  });

  it('gives what core’s LinkedIn kit takes', () => {
    for (const href of [
      '/in/dana-reyes-4b2a1c/',
      '/in/ren%C3%A9e-park/',
      '/in/ACoAAFakeDanaReyes123',
      '/in/sam-lee-77?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAFakeSamLee456',
    ]) {
      const profile = profileRefOf(href)!;
      expect(profile.url, href).toMatch(KIT.link);
      if (profile.id) expect(profile.id, href).toMatch(KIT.profileId);
      if (profile.username) expect(profile.username, href).toMatch(KIT.username);
    }
  });
});

describe('memberIdFrom', () => {
  it('finds the member id LinkedIn’s links carry', () => {
    const id = (href: string) => parsed(memberIdFrom, href);
    expect(
      id('/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAFakeDanaReyes123'),
    ).toBe('ACoAAFakeDanaReyes123');
    expect(id('/messaging/compose/?recipient=ACoAAFakeDanaReyes123')).toBe('ACoAAFakeDanaReyes123');
    expect(
      id(
        '/search/results/people/?connectionOf=%5B%22ACoAAFakeDanaReyes123%22%5D&network=%5B%22F%22%5D',
      ),
    ).toBe('ACoAAFakeDanaReyes123');
    expect(id('/search/results/people/?keywords=plumber')).toBeNull();
    expect(id('/messaging/compose/?recipient=dana')).toBeNull();
  });
});

describe('threadOf', () => {
  it('reads a conversation by its id, which the kit takes', () => {
    const thread = threadOf('/messaging/thread/2-MadeUpThreadDana0001==/?trk=x');
    expect(thread).toEqual({
      id: '2-MadeUpThreadDana0001==',
      encrypted: false,
      url: 'https://www.linkedin.com/messaging/thread/2-MadeUpThreadDana0001==/',
    });
    expect(thread?.id).toMatch(KIT.threadKey);
    expect(threadOf('/messaging/thread/2-MadeUpThreadDana0001%3D%3D/')?.id).toBe(
      '2-MadeUpThreadDana0001==',
    );
  });

  it('leaves out a new message, the list, and ids the kit wouldn’t take', () => {
    expect(threadOf('/messaging/thread/new/')).toBeNull();
    expect(threadOf('/messaging/')).toBeNull();
    expect(threadOf('/messaging/thread/a%2Fb/')).toBeNull();
  });
});

describe('postOf', () => {
  it('writes every link to a post one way, without the tracking', () => {
    const one = 'https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000101/';
    expect(postOf('/feed/update/urn:li:activity:7380000000000000101/?utm_source=share')).toBe(one);
    expect(postOf('/feed/update/urn%3Ali%3Aactivity%3A7380000000000000101')).toBe(one);
    expect(
      postOf(
        '/posts/dana-reyes-4b2a1c_water-heaters-activity-7380000000000000101-Ab3x?utm_source=share&utm_medium=member_desktop',
      ),
    ).toBe(one);
    expect(
      postOf(
        '/feed/update/urn:li:activity:7380000000000000101?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7380000000000000101%2C1%29',
      ),
    ).toBe(one);
    expect(postOf('/feed/update/urn:li:share:7380000000000000999/')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:share:7380000000000000999/',
    );
  });

  it('leaves out what isn’t a post', () => {
    for (const href of [
      '/feed/',
      '/feed/hashtag/?keywords=plumbing',
      '/feed/update/urn:li:comment:123/',
      '/posts/dana-reyes-4b2a1c',
      '/in/dana-reyes-4b2a1c/recent-activity/all/',
      'https://example.com/feed/update/urn:li:activity:7380000000000000101/',
    ])
      expect(postOf(href), href).toBeNull();
  });
});

describe('groups and companies', () => {
  it('reads a group by its number, and a company by its name', () => {
    expect(parsed(groupFromUrl, '/groups/9876543/?highlightedUpdateUrn=x')?.url).toBe(
      'https://www.linkedin.com/groups/9876543/',
    );
    expect(parsed(groupFromUrl, '/groups/austin-pros/')).toBeNull();
    expect(parsed(companyFromUrl, '/company/acme-plumbing-atx/posts/?feedView=all')).toEqual({
      id: 'acme-plumbing-atx',
      url: 'https://www.linkedin.com/company/acme-plumbing-atx/',
    });
  });
});

describe('workUrl', () => {
  it('lets the extension’s own tab open only LinkedIn’s pages, over https', () => {
    expect(workUrl('https://www.linkedin.com/in/dana-reyes-4b2a1c/')).toBe(
      'https://www.linkedin.com/in/dana-reyes-4b2a1c/',
    );
    for (const href of [
      'http://www.linkedin.com/in/dana-reyes-4b2a1c/',
      'https://linkedin.com/in/dana-reyes-4b2a1c/',
      'https://www.linkedin.com.example.com/',
      'https://www.linkedin.com@example.com/',
      'https://user:pass@www.linkedin.com/',
      'https://www.linkedin.com:8443/',
      'https://www.facebook.com/',
      '/in/dana-reyes-4b2a1c/',
    ])
      expect(workUrl(href), href).toBeNull();
  });
});
