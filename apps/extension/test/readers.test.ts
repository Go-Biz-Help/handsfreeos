/**
 * The readers against hand-written pages in test/fixtures. Those pages are our best guess at Facebook's markup, not
 * saved Facebook pages: these tests hold the readers' logic still, and the page outlines testers send back are what
 * tune them to the real thing.
 */
import { describe, expect, it } from 'vitest';
import { readChat } from '../src/facebook/chat';
import { readPage } from '../src/facebook/page';
import { runsGroup } from '../src/facebook/people';
import { classifyUrl } from '../src/facebook/urls';
import { readWarnings } from '../src/facebook/warnings';
import { load } from './load';

const NOW = new Date('2026-10-05T12:00:00Z');

function read(fixture: string, url: string) {
  return readPage(load(fixture, url), url, NOW);
}

describe('a group’s members', () => {
  const url = 'https://www.facebook.com/groups/austinsmallbiz/members';
  const result = read('group-members.html', url);

  it('reads the group', () => {
    expect(result.kind).toBe('group-members');
    expect(result.group).toEqual({
      name: 'Austin Small Business Owners',
      group: { id: 'austinsmallbiz', url: 'https://www.facebook.com/groups/austinsmallbiz/' },
      privacy: 'private',
      members: 12_300,
      joined: true,
    });
  });

  it('lists each member once, with the line under their name, and never you from the top bar', () => {
    expect(result.people?.map((person) => person.name)).toEqual([
      'Lisa Park',
      'Mike Torres',
      'Jane Doe',
      'Sam Carter',
      'Kim Lee',
    ]);
    const jane = result.people?.find((person) => person.name === 'Jane Doe');
    expect(jane?.profile?.id).toBe('100002222222222');
    expect(jane?.detail).toBe('Owner at Smith Plumbing');
  });

  it('tells the admins and moderators apart', () => {
    const running = result.people?.filter(runsGroup).map((person) => person.name);
    expect(running).toEqual(['Lisa Park', 'Mike Torres']);
    // A badge on someone ("Admin") doesn't start a part of the list.
    expect(result.people?.map((person) => person.section)).toEqual([
      'Admins and moderators',
      'Admins and moderators',
      'New to the group',
      'New to the group',
      'New to the group',
    ]);
    expect(result.people?.find((person) => person.name === 'Lisa Park')?.badges).toEqual(['Admin']);
    expect(result.people?.find((person) => person.name === 'Kim Lee')).toMatchObject({
      badges: ['Top contributor'],
      section: 'New to the group',
      detail: 'Lives in Austin, Texas',
    });
  });

  it('says the list grows as you scroll', () => {
    expect(result.notes.join(' ')).toContain('Facebook loads more as you scroll');
    expect(result.warnings).toEqual([]);
  });
});

describe('a profile', () => {
  const result = read('profile.html', 'https://www.facebook.com/jane.doe.5');

  it('reads who they are and where you stand', () => {
    expect(result.profile).toEqual({
      name: 'Jane Doe',
      profile: { id: null, username: 'jane.doe.5', url: 'https://www.facebook.com/jane.doe.5' },
      intro: [
        'Helping Austin homeowners since 2009',
        'Owner at Smith Plumbing',
        'Lives in Austin, Texas',
        'From Waco, Texas',
        'Joined March 2010',
      ],
      friendship: 'not_friends',
      mutualFriends: 45,
    });
  });

  it('reads their posts without the comments under them', () => {
    expect(result.posts).toEqual([
      {
        author: {
          name: 'Jane Doe',
          profile: { id: null, username: 'jane.doe.5', url: 'https://www.facebook.com/jane.doe.5' },
        },
        url: 'https://www.facebook.com/jane.doe.5/posts/pfbid0abcDEF',
        when: '3d',
        text: 'Anyone have a good way to keep track of follow-ups with customers? Sticky notes are not cutting it.',
        comments: 12,
        reactions: 34,
      },
      {
        author: {
          name: 'Jane Doe',
          profile: { id: null, username: 'jane.doe.5', url: 'https://www.facebook.com/jane.doe.5' },
        },
        url: 'https://www.facebook.com/permalink.php?story_fbid=pfbid02xyz&id=100002222222222',
        when: 'October 1 at 9:12 AM',
        text: 'Big week for the team. Thanks to everyone who came out!',
        comments: null,
        reactions: null,
      },
    ]);
  });
});

describe('a group’s posts', () => {
  const result = read('group-feed.html', 'https://www.facebook.com/groups/texascontractors/');

  it('reads the group and that you haven’t joined it', () => {
    expect(result.group).toMatchObject({
      name: 'Texas Contractors Network',
      privacy: 'public',
      members: 5_400,
      joined: false,
    });
  });

  it('reads each post, whether its comments sit inside it or beside it', () => {
    expect(result.posts).toEqual([
      {
        author: {
          name: 'Rob Hayes',
          profile: {
            id: '100006666666666',
            username: null,
            url: 'https://www.facebook.com/profile.php?id=100006666666666',
          },
        },
        url: 'https://www.facebook.com/groups/texascontractors/posts/1122334455667788/',
        when: '2h',
        text: 'Looking for recommendations on scheduling software for a 5-person crew. What do you all use?',
        comments: 8,
        reactions: null,
      },
      {
        author: {
          name: 'Ellen Brooks',
          profile: {
            id: '100007777777777',
            username: null,
            url: 'https://www.facebook.com/profile.php?id=100007777777777',
          },
        },
        url: 'https://www.facebook.com/groups/texascontractors/posts/2233445566778899/',
        when: 'Yesterday at 4:05 PM',
        text: 'Reminder: our monthly meetup is Thursday at 6.',
        comments: null,
        reactions: 1_200,
      },
    ]);
  });
});

describe('a chat', () => {
  const url = 'https://www.facebook.com/messages/t/1234567890/';

  it('reads who it’s with and who said what, oldest first', () => {
    const result = read('chat.html', url);
    expect(result.chat?.name).toBe('Sam Carter');
    expect(result.chat?.profile?.username).toBe('sam.carter.77');
    expect(result.chat?.thread?.id).toBe('1234567890');
    expect(result.chat?.messages).toEqual([
      {
        from: 'me',
        sender: null,
        text: 'Hi Sam, saw your post in Austin Small Business Owners about follow-ups.',
        when: 'Oct 3, 2026, 3:15 PM',
      },
      {
        from: 'them',
        sender: 'Sam Carter',
        text: 'Hey! Thanks for reaching out.',
        when: 'Oct 3, 2026, 3:15 PM',
      },
      {
        from: 'them',
        sender: 'Sam Carter',
        text: 'We use HubSpot right now.',
        when: 'Oct 3, 2026, 3:15 PM',
      },
      { from: 'me', sender: null, text: 'How do you like it so far?', when: 'Today at 10:12 AM' },
      {
        from: 'them',
        sender: 'Sam Carter',
        text: "Honestly it's too expensive for us.",
        when: 'Today at 10:12 AM',
      },
    ]);
  });

  it('reads the chats beside it', () => {
    expect(read('chat.html', url).chats).toEqual([
      {
        name: 'Sam Carter',
        thread: {
          id: '1234567890',
          encrypted: false,
          url: 'https://www.facebook.com/messages/t/1234567890/',
        },
        preview: 'You: How do you like it so far?',
        when: '2h',
      },
      {
        name: 'Maria Lopez',
        thread: {
          id: '9876543210123',
          encrypted: true,
          url: 'https://www.facebook.com/messages/e2ee/t/9876543210123/',
        },
        preview: 'Are you free Tuesday?',
        when: '3d',
      },
      {
        name: 'Austin Biz Mastermind',
        thread: {
          id: '555666777',
          encrypted: false,
          url: 'https://www.facebook.com/messages/t/555666777/',
        },
        preview: 'Dan: See you all Thursday',
        when: '1w',
      },
    ]);
  });

  it('goes by which side a message is on when nothing labels it', () => {
    const doc = load('chat.html', url);
    for (const label of doc.querySelectorAll('[role="row"] h5')) label.remove();
    const chat = readChat(doc, classifyUrl(url), url, {
      sideOf: (element) =>
        /^(Hi Sam|How do you)/.test(element.textContent?.trim() ?? '') ? 'right' : 'left',
    });
    expect(chat.messages.map((message) => [message.from, message.sender])).toEqual([
      ['me', null],
      ['them', 'Sam Carter'],
      ['them', 'Sam Carter'],
      ['me', null],
      ['them', 'Sam Carter'],
    ]);
  });
});

describe('notifications', () => {
  const result = read('notifications.html', 'https://www.facebook.com/notifications');

  it('reads who did what, and leaves Facebook’s own lines out', () => {
    expect(result.notices?.map(({ kind, names, when }) => ({ kind, names, when }))).toEqual([
      { kind: 'friend_accepted', names: ['Maria Lopez'], when: '2h' },
      { kind: 'reaction', names: ['Dan Wu'], when: '5h' },
      { kind: 'comment', names: ['Priya Shah'], when: '1d' },
      { kind: 'friend_request', names: ['Tom Reed'], when: '2d' },
      { kind: 'other', names: ['Austin Small Business Owners'], when: '3d' },
    ]);
  });

  it('links an accepted request to the person, and a reaction to the post', () => {
    expect(result.notices?.[0]).toMatchObject({
      text: 'Maria Lopez accepted your friend request.',
      profile: { username: 'maria.lopez.33' },
      url: 'https://www.facebook.com/maria.lopez.33',
    });
    expect(result.notices?.[1]?.url).toBe(
      'https://www.facebook.com/groups/123456789012345/posts/987654321098765/',
    );
  });
});

describe('your friends list', () => {
  it('reads the list Facebook puts beside the page', () => {
    const result = read('friends-list.html', 'https://www.facebook.com/friends/list');
    expect(
      result.people?.map(({ name, profile, detail }) => ({
        name,
        profile: profile?.id ?? profile?.username,
        detail,
      })),
    ).toEqual([
      { name: 'Ben Ortiz', profile: '100005555555555', detail: '12 mutual friends' },
      { name: 'Rob Hayes', profile: '100006666666666', detail: null },
      { name: 'Kate Nguyen', profile: 'kate.nguyen.9', detail: '3 mutual friends' },
    ]);
  });
});

describe('your groups', () => {
  it('reads each group once, from whichever list has more', () => {
    const result = read('groups-joined.html', 'https://www.facebook.com/groups/joins/');
    expect(result.groups).toEqual([
      {
        name: 'Austin Small Business Owners',
        group: { id: 'austinsmallbiz', url: 'https://www.facebook.com/groups/austinsmallbiz/' },
        detail: 'You last visited 2 days ago',
      },
      {
        name: 'Texas Contractors Network',
        group: {
          id: 'texascontractors',
          url: 'https://www.facebook.com/groups/texascontractors/',
        },
        detail: 'You last visited 5 hours ago',
      },
      {
        name: 'Round Rock Moms',
        group: { id: '1029384756', url: 'https://www.facebook.com/groups/1029384756/' },
        detail: 'You last visited 3 weeks ago',
      },
    ]);
  });
});

describe('Facebook’s warnings', () => {
  it('finds a block in a dialog, and not in somebody’s post about one', () => {
    const url = 'https://www.facebook.com/groups/texascontractors/';
    expect(read('warning.html', url).warnings).toEqual([
      'You’re Temporarily Blocked',
      'It looks like you were misusing this feature by going too fast. You’ve been temporarily blocked from using it.',
    ]);
  });

  it('counts a checkpoint page as a warning', () => {
    const doc = load('profile.html', 'https://www.facebook.com/checkpoint/1501092823525282/');
    expect(readWarnings(doc, 'https://www.facebook.com/checkpoint/1501092823525282/')).toEqual([
      'Facebook is asking you to check your account before you go on.',
    ]);
  });
});

describe('pages it doesn’t read', () => {
  it('says so, and finds nothing', () => {
    const result = read('profile.html', 'https://www.facebook.com/marketplace/');
    expect(result.kind).toBe('other');
    expect(result.notes).toEqual(['The extension doesn’t read this kind of page yet.']);
    expect(result.readAt).toBe('2026-10-05T12:00:00.000Z');
  });
});
