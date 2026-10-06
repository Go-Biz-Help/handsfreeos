/**
 * The readers against hand-written pages in test/fixtures. Those pages are our best guess at Facebook's markup, not
 * saved Facebook pages: these tests hold the readers' logic still, and the page outlines testers send back are what
 * tune them to the real thing.
 */
import { describe, expect, it } from 'vitest';
import { measuredSide, readChat } from '../src/facebook/chat';
import { friendListOf, mutualFriendsIn, yourProfile } from '../src/facebook/friends';
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
      // The exact count from the Members heading, not the rounded 12.3K at the top.
      members: 12_317,
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
    expect(jane?.details).toEqual(['Owner at Smith Plumbing', 'Joined about a week ago']);
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
      details: ['Lives in Austin, Texas'],
    });
  });

  it('says the list grows as you scroll', () => {
    expect(result.notes.join(' ')).toContain('Facebook loads more as you scroll');
    expect(result.warnings).toEqual([]);
  });
});

describe('a group’s members, as Facebook drew them in 2026', () => {
  const url = 'https://www.facebook.com/groups/4455667788/members';
  const result = read('group-members-2026.html', url);

  it('reads the exact count and that you’re in the group', () => {
    expect(result.group).toMatchObject({
      name: 'Westfield Makers Market',
      group: { id: '4455667788' },
      privacy: 'public',
      members: 34_718,
      joined: true,
    });
  });

  it('reads the lists below the tabs, not the row of faces above them', () => {
    // Rosa Delgado and Hal Becker are in the row of faces too: they count where the lists put them.
    expect(result.people?.map((person) => [person.name, person.section])).toEqual([
      ['Chris Gee', 'Members'],
      ['Rosa Delgado', 'Admins & moderators'],
      ['Kim Lowe', 'Admins & moderators'],
      ['Lena Fox', 'Top makers'],
      ['Hal Becker', 'Members with things in common'],
      ['Mia Park', 'New to the group'],
      ['Omar Haddad', 'New to the group'],
    ]);
  });

  it('tells the admins and moderators apart from the people under any other heading', () => {
    expect(result.people?.filter(runsGroup).map((person) => person.name)).toEqual([
      'Rosa Delgado',
      'Kim Lowe',
    ]);
    expect(result.people?.find((person) => person.name === 'Kim Lowe')?.badges).toEqual([
      'Moderator',
    ]);
  });

  it('keeps every line under a name, and not the title of the part they’re in', () => {
    expect(
      Object.fromEntries(result.people?.map((person) => [person.name, person.details]) ?? []),
    ).toEqual({
      'Chris Gee': ['Entrepreneur · 2,761 people follow this'],
      'Rosa Delgado': ['Entrepreneur · 2,177 people follow this'],
      'Kim Lowe': ['Westfield, Texas'],
      'Lena Fox': ['Marketing Agency · 870 people follow this'],
      'Hal Becker': [
        '37 mutual friends including Sam Carter and Jane Doe',
        'Digital creator · 5,159 people follow this',
      ],
      'Mia Park': ['Joined 7 minutes ago', 'Digital creator · 4,654 people follow this'],
      'Omar Haddad': ['Joined about an hour ago'],
    });
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

describe('a profile, as Facebook drew it in 2026', () => {
  const url = 'https://www.facebook.com/dana.reyes.12';
  const result = read('profile-2026.html', url);
  const dana = {
    name: 'Dana Reyes',
    profile: { id: null, username: 'dana.reyes.12', url: 'https://www.facebook.com/dana.reyes.12' },
  };

  it('reads the name, where you stand and the intro from the top, above the tabs', () => {
    expect(result.profile).toEqual({
      ...dana,
      intro: [
        'Crafts, candles and custom signs. If you need it handmade, ask me first.',
        'Westfield High School',
        'Texas State',
        'danasdesigns',
      ],
      friendship: 'friends',
      mutualFriends: 21,
    });
    expect(result.notes).toEqual([]);
  });

  it('finds the name on the links to the profile when the page’s title doesn’t have it', () => {
    const doc = load('profile-2026.html', url);
    doc.title = 'Facebook';
    expect(readPage(doc, url, NOW).profile?.name).toBe('Dana Reyes');
  });

  it('reads a post that isn’t an article, without the hidden words around it or the empty ones loading', () => {
    expect(result.posts).toEqual([
      {
        author: dana,
        url: null,
        when: null,
        text: 'Craft fair this Saturday!\nBooth 14 at the Westfield market.\nSigns, candles and wreaths. Come say hi.',
        comments: null,
        // The number on the Like button, which you've pressed here ("Remove Like").
        reactions: 4,
      },
    ]);
  });
});

describe('the News Feed, as Facebook drew it in 2026', () => {
  const result = read('feed-2026.html', 'https://www.facebook.com/');

  it('reads each post once, with its counts, and never its comments as posts', () => {
    expect(result.kind).toBe('feed');
    expect(result.posts).toEqual([
      {
        author: {
          name: 'Mark Ellis',
          profile: {
            id: '100004000000001',
            username: null,
            url: 'https://www.facebook.com/profile.php?id=100004000000001',
          },
        },
        // Its own time link is empty until you point at it: its comments' links give its address.
        url: 'https://www.facebook.com/permalink.php?story_fbid=pfbid0AbCdEf&id=100004000000001',
        when: null,
        text: 'Is the house you live in an asset or not? Curious what you all think.',
        comments: 6,
        reactions: 2,
      },
      {
        author: {
          name: 'Westfield Home Team',
          profile: {
            id: null,
            username: 'westfieldhometeam',
            url: 'https://www.facebook.com/westfieldhometeam',
          },
        },
        url: null,
        when: null,
        text: 'Thinking about selling this spring? Here are five things buyers look at first, and what you can fix in a weekend. …',
        comments: 24,
        reactions: 32,
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

describe('a chat, as Facebook drew it in 2026', () => {
  const url = 'https://www.facebook.com/messages/t/100009000000002/';
  const yours = /^(Hey! Yes|yeah that|We still)/;
  const where = (element: Element) =>
    yours.test(element.textContent?.trim() ?? '') ? 'right' : 'left';
  const readIt = (doc: Document, sideOf: (element: Element) => 'left' | 'right' | null = where) =>
    readChat(doc, classifyUrl(url), url, { sideOf });

  it('reads each message once, without the line that repeats it, with the time above it', () => {
    const result = read('chat-2026.html', url);
    expect(result.chat?.name).toBe('Dana Reyes');
    expect(result.chat?.profile?.id).toBe('100009000000002');
    const sep25 = 'Sep 25, 2026, 11:39 PM';
    expect(readIt(load('chat-2026.html', url)).messages).toEqual([
      {
        from: 'them',
        sender: 'Dana Reyes',
        text: "Hey Chris! I see you've been busy.",
        when: sep25,
      },
      {
        from: 'them',
        sender: 'Dana Reyes',
        text: 'Could we set up a demo of your CRM? I need something simpler 🙂',
        when: sep25,
      },
      {
        from: 'me',
        sender: null,
        text: "Hey! Yes, definitely. I've got a couple of appointments Monday, other than that I'm free.",
        when: sep25,
      },
      {
        from: 'them',
        sender: 'Dana Reyes',
        text: "I work Tuesdays and Thursdays, so let's do Wednesday. I'm on Pacific time. Maybe 10am?",
        when: sep25,
      },
      { from: 'me', sender: null, text: 'yeah that works', when: sep25 },
      { from: 'me', sender: null, text: 'We still on in an hour?', when: 'Wed 11:02 AM' },
    ]);
  });

  it('goes by the line that repeats each message, wherever the message seems to sit', () => {
    for (const side of ['left', 'right', null] as const)
      expect(
        readIt(load('chat-2026.html', url), () => side).messages.map((message) => message.from),
        String(side),
      ).toEqual(['them', 'them', 'me', 'them', 'me', 'me']);
  });

  it('goes by their picture beside a message before its side', () => {
    const doc = load('chat-2026.html', url);
    for (const repeat of doc.querySelectorAll('[role="log"] [role="button"][aria-label^="Enter"]'))
      repeat.remove();
    const messages = readIt(doc, () => 'right').messages;
    // The two with Dana's picture beside them, however wide they are.
    expect([messages[1], messages[3]].map((message) => [message?.from, message?.sender])).toEqual([
      ['them', 'Dana Reyes'],
      ['them', 'Dana Reyes'],
    ]);
  });

  it('goes by the side when nothing else says', () => {
    const doc = load('chat-2026.html', url);
    for (const said of doc.querySelectorAll(
      '[role="log"] [role="button"][aria-label^="Enter"], [role="log"] [aria-hidden="true"] img',
    ))
      said.remove();
    expect(readIt(doc).messages.map((message) => [message.from, message.sender])).toEqual([
      ['them', 'Dana Reyes'],
      ['them', 'Dana Reyes'],
      ['me', null],
      ['them', 'Dana Reyes'],
      ['me', null],
      ['me', null],
    ]);
  });

  it('reads the chats beside it, without Facebook’s words about them', () => {
    expect(
      read('chat-2026.html', url).chats?.map(({ name, preview, when }) => ({
        name,
        preview,
        when,
      })),
    ).toEqual([
      { name: 'Ben Ortiz', preview: 'Sup', when: '2d' },
      { name: 'Dana Reyes', preview: 'Dana sent a phone number.', when: '4d' },
    ]);
  });
});

describe('measuredSide', () => {
  // Boxes as a 1440-wide window draws them: the conversation, their messages after their picture, and yours.
  const box = (left: number, right: number) =>
    ({ getBoundingClientRect: () => ({ left, right, width: right - left }) }) as unknown as Element;
  const conversation = box(560, 1465);

  it('goes by the nearer edge, however wide the message', () => {
    expect(measuredSide(box(653, 1315), conversation)).toBe('left');
    expect(measuredSide(box(653, 700), conversation)).toBe('left');
    expect(measuredSide(box(710, 1433), conversation)).toBe('right');
    expect(measuredSide(box(1404, 1434), conversation)).toBe('right');
  });

  it('says neither for a line in the middle, or a box that isn’t drawn', () => {
    expect(measuredSide(box(900, 1125), conversation)).toBeNull();
    expect(measuredSide(box(0, 0), conversation)).toBeNull();
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
    expect(result.friendList).toBe('friends');
    expect(
      result.people?.map(({ name, profile, details }) => ({
        name,
        profile: profile?.id ?? profile?.username,
        details,
      })),
    ).toEqual([
      { name: 'Ben Ortiz', profile: '100005555555555', details: ['12 mutual friends'] },
      { name: 'Rob Hayes', profile: '100006666666666', details: [] },
      { name: 'Kate Nguyen', profile: 'kate.nguyen.9', details: ['3 mutual friends'] },
    ]);
  });
});

describe('your friend requests', () => {
  const url = 'https://www.facebook.com/friends/requests/?profile_id=100007000000001';

  it('reads the requests beside the page, not the friends of whoever’s picked', () => {
    const result = read('friend-requests.html', url);
    expect(result.kind).toBe('friends');
    expect(result.friendList).toBe('requests');
    expect(
      result.people?.map(({ name, profile, details }) => ({
        name,
        profile: profile?.id ?? profile?.username,
        details,
      })),
    ).toEqual([
      { name: 'Avery Lane', profile: '100007000000001', details: ['12 mutual friends'] },
      { name: 'Quinn Harper', profile: '100007000000002', details: ['1 mutual friend'] },
      { name: 'Rowan Blake', profile: 'rowan.blake.4', details: [] },
    ]);
  });

  it('knows your own lists, and that someone else’s friends aren’t yours', () => {
    const doc = load('friend-requests.html', url);
    const at = (path: string) => friendListOf(doc, `https://www.facebook.com${path}`);
    expect(yourProfile(doc, url)).toEqual({
      id: null,
      username: 'jordan.owner.1',
      url: 'https://www.facebook.com/jordan.owner.1',
    });
    expect(at('/friends/requests/')).toBe('requests');
    expect(at('/friends/list')).toBe('friends');
    expect(at('/jordan.owner.1/friends')).toBe('friends');
    expect(at('/sky.patel.8/friends')).toBeNull();
    // /friends itself has parts: the requests among them are found by their part's name.
    expect(at('/friends')).toBeNull();
    expect(at('/groups/4455667788/members')).toBeNull();
  });

  it('finds how many mutual friends a line says', () => {
    expect(mutualFriendsIn(['Owner at Lane Landscaping', '12 mutual friends'])).toBe(12);
    expect(mutualFriendsIn(['1.2K friends · 45 mutual'])).toBe(45);
    expect(mutualFriendsIn(['1 mutual friend'])).toBe(1);
    expect(mutualFriendsIn(['Lives in Round Rock'])).toBeNull();
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
