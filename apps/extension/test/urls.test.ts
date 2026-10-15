import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  facebookUrl,
  postUrlFrom,
  profileFromUrl,
  threadFromUrl,
} from '../src/networks/facebook/urls';

const parsed = <T>(read: (url: URL) => T, href: string): T | null => {
  const url = facebookUrl(href);
  return url ? read(url) : null;
};

describe('classifyUrl', () => {
  it.each([
    ['https://www.facebook.com/', 'feed'],
    ['https://www.facebook.com/jane.doe.5', 'profile'],
    ['https://www.facebook.com/jane.doe.5/about', 'profile'],
    ['https://www.facebook.com/jane.doe.5/friends', 'friends'],
    ['https://www.facebook.com/jane.doe.5/followers', 'followers'],
    ['https://www.facebook.com/profile.php?id=100002222222222&sk=friends_mutual', 'friends'],
    ['https://www.facebook.com/profile.php?id=100002222222222&sk=about', 'profile'],
    ['https://www.facebook.com/friends/list', 'friends'],
    ['https://www.facebook.com/me/friends', 'friends'],
    ['https://www.facebook.com/messages/t/1234567890/', 'chat'],
    ['https://www.facebook.com/messages/e2ee/t/9876543210123', 'chat'],
    ['https://www.facebook.com/messages/', 'chats'],
    ['https://www.facebook.com/groups/feed/', 'groups'],
    ['https://www.facebook.com/groups/joins/?nav_source=tab', 'groups'],
    ['https://www.facebook.com/groups/search/groups/?q=plumbers', 'search'],
    ['https://www.facebook.com/groups/austinsmallbiz/', 'group'],
    ['https://www.facebook.com/groups/austinsmallbiz/members', 'group-members'],
    ['https://www.facebook.com/groups/123456789012345/user/100002222222222/', 'profile'],
    ['https://www.facebook.com/groups/austinsmallbiz/posts/987654321098765/', 'post'],
    ['https://www.facebook.com/groups/austinsmallbiz/permalink/987654321098765/', 'post'],
    ['https://www.facebook.com/jane.doe.5/posts/pfbid0abcDEF', 'post'],
    ['https://www.facebook.com/permalink.php?story_fbid=pfbid02xyz&id=100002222222222', 'post'],
    ['https://www.facebook.com/search/people/?q=plumber', 'search'],
    ['https://www.facebook.com/notifications', 'notifications'],
    ['https://www.facebook.com/marketplace/', 'other'],
    ['https://www.facebook.com/watch/?v=1', 'other'],
    ['https://example.com/jane.doe.5', 'other'],
  ])('%s is %s', (url, kind) => {
    expect(classifyUrl(url).kind).toBe(kind);
  });

  it('says whose page it is', () => {
    expect(classifyUrl('https://www.facebook.com/Jane.Doe.5/friends').profile).toEqual({
      id: null,
      username: 'Jane.Doe.5',
      url: 'https://www.facebook.com/Jane.Doe.5',
    });
    expect(classifyUrl('https://www.facebook.com/groups/austinsmallbiz/members').group?.id).toBe(
      'austinsmallbiz',
    );
    expect(classifyUrl('https://www.facebook.com/messages/e2ee/t/9876543210123').thread).toEqual({
      id: '9876543210123',
      encrypted: true,
      url: 'https://www.facebook.com/messages/e2ee/t/9876543210123/',
    });
  });
});

describe('profileFromUrl', () => {
  it('reads every way Facebook links to a person', () => {
    const id = (href: string) => parsed(profileFromUrl, href)?.id;
    expect(id('/profile.php?id=100002222222222&__tn__=R')).toBe('100002222222222');
    expect(id('/people/Jane-Doe/100002222222222/')).toBe('100002222222222');
    expect(id('/groups/123/user/100002222222222/?__cft__[0]=x')).toBe('100002222222222');
    expect(id('/friends/list/?profile_id=100005555555555')).toBe('100005555555555');
    expect(id('/100002222222222')).toBe('100002222222222');
    expect(
      parsed(profileFromUrl, 'https://m.facebook.com/jane.doe.5?ref=bookmarks')?.username,
    ).toBe('jane.doe.5');
  });

  it('leaves out parts of profiles, Facebook’s own pages and other sites', () => {
    for (const href of [
      '/jane.doe.5/photos',
      '/groups/123/',
      '/marketplace',
      '/watch',
      '/messages/t/1',
      '/friends/requests/',
      'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com',
      'https://example.com/jane',
    ])
      expect(parsed(profileFromUrl, href), href).toBeNull();
  });
});

describe('postUrlFrom', () => {
  it('takes the tracking off a post’s link', () => {
    const post = (href: string) => parsed(postUrlFrom, href);
    expect(post('/groups/austinsmallbiz/permalink/987/?__cft__[0]=AZ&__tn__=%2CO')).toBe(
      'https://www.facebook.com/groups/austinsmallbiz/posts/987/',
    );
    expect(post('/permalink.php?story_fbid=pfbid02xyz&id=100002222222222&__cft__[0]=AZ')).toBe(
      'https://www.facebook.com/permalink.php?story_fbid=pfbid02xyz&id=100002222222222',
    );
    expect(post('/jane.doe.5/posts/pfbid0abc?__cft__[0]=AZ')).toBe(
      'https://www.facebook.com/jane.doe.5/posts/pfbid0abc',
    );
    expect(post('/jane.doe.5/photos')).toBeNull();
    expect(post('/groups/austinsmallbiz/')).toBeNull();
  });
});

describe('threadFromUrl', () => {
  it('reads plain and end-to-end encrypted chats', () => {
    expect(parsed(threadFromUrl, '/messages/t/1234567890/')).toEqual({
      id: '1234567890',
      encrypted: false,
      url: 'https://www.facebook.com/messages/t/1234567890/',
    });
    expect(parsed(threadFromUrl, '/messages/e2ee/t/42')?.encrypted).toBe(true);
    expect(parsed(threadFromUrl, '/messages/')).toBeNull();
  });
});
