/**
 * Alignable's own readers (src/networks/alignable/read.ts; partners stage 6c, part 1): on pages drawn as the owner's
 * Check Alignable outlined them (0.66.0, 19 Oct 2026; an open conversation's messages from his Check of 21 Oct 2026),
 * with their test ids, links and words where Alignable put them. What a report of each says: how many of each, never
 * what they say.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { readAlignable } from '../src/networks/alignable/read';
import { readReplies } from '../src/networks/alignable/replies';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { outlineLooking, readLooking } from '../src/networks/looking/read';
import { pageFound } from '../src/jobs/report';
import { boxEverything } from './load';

const AL = 'https://www.alignable.com';
const page = (url: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;

const kind = (path: string) => ALIGNABLE.kindOf(ALIGNABLE.url(`${AL}${path}`)!);

describe('Alignable’s addresses, as its pages lead', () => {
  it('tells apart a business by its id, Requests, a chat, a town’s group and a discussion', () => {
    expect(kind('/biz/businesses/42')).toBe('business');
    // Their own profile's address is where Check starts on it, still known by its own word.
    expect(kind('/biz/businesses/my_profile')).toBe('search');
    expect(kind('/biz/my_network/connection_requests?_fat=a')).toBe('requests');
    expect(kind('/biz/conversations?with_business_id=42')).toBe('chat');
    expect(kind('/biz/conversations')).toBe('inbox');
    expect(kind('/groups/austin-tx')).toBe('community');
    expect(kind('/groups/austin-tx/need-a-roofer-123')).toBe('discussion');
    expect(kind('/groups/austin-tx/members')).toBe('search');
    expect(kind('/groups/austin-tx/events/77')).toBe('events');
    expect(kind('/groups/search?q=roof')).toBe('search');
  });

  it('counts a group’s discussion as a post, never its members or events', () => {
    const post = (path: string) => ALIGNABLE.postOf(ALIGNABLE.url(`${AL}${path}`)!);
    expect(post('/groups/austin-tx/need-a-roofer-123?cyattr=x')).toBe(
      `${AL}/groups/austin-tx/need-a-roofer-123`,
    );
    expect(post('/groups/austin-tx/members')).toBeNull();
    expect(post('/groups/austin-tx/events/77')).toBeNull();
    expect(post('/groups/austin-tx')).toBeNull();
  });

  it('keeps the word a Connect link leads to in an outline, and hides the business it’s for', () => {
    const doc = page(
      `${AL}/biz/search?q=roof`,
      `<a href="/biz/connection_requests/quick_connect?business_id=4242&type=mgc">Connect</a>`,
    );
    const outline = outlineLooking(doc, doc.location.href, ALIGNABLE);
    expect(outline).toContain('/biz/connection_requests/quick_connect?business_id={');
    expect(outline).not.toContain('4242');
  });

  it('keeps its own words with a _ after /biz, and a like’s and a report’s, never a business’s name', () => {
    const doc = page(
      `${AL}/groups/austin-tx`,
      `<a href="/biz/thumbs_up?resource=9">Like</a><a href="/biz/flags/new?resource=9">Report</a>
        <a href="/biz/acme/contacts">Contacts</a><a href="/biz/acme-roofing">Acme</a>`,
    );
    const outline = outlineLooking(doc, doc.location.href, ALIGNABLE);
    expect(outline).toContain('/biz/thumbs_up?resource={');
    expect(outline).toContain('/biz/flags/new?resource={');
    expect(outline).not.toMatch(/acme/i);
  });
});

describe('a search for businesses', () => {
  const doc = page(
    `${AL}/biz/search?q=plumber`,
    `<div role="contentinfo"><ul>
      <div><a href="/austin-tx/acme-plumbing?user=5&page_num=1&result_id=42&request_source=biz/search-index">
          <div data-testid="avatar"><img data-testid="avatar-image" alt="Dana Reyes" title="Dana Reyes" /></div></a>
        <div><div><div><a title="Dana Reyes" href="/austin-tx/acme-plumbing?user=5&result_id=42">Dana Reyes</a>
            <div role="status"><svg></svg>47</div></div>
          <div><div><a title="Acme Plumbing Co" href="/austin-tx/acme-plumbing?user=5&result_id=42">Acme Plumbing Co</a>
            <span>Plumbing Contractor</span></div><div>Austin, TX</div></div></div>
        <a data-testid="react-connect-button" href="/biz/connection_requests/quick?business_id=42&result_id=42"><svg></svg>Connect</a></div></div>
      <div><a href="/round-rock-tx/best-bakery?user=6&result_id=43"><img alt="Sam Lee" /></a>
        <div><div><div><a title="Sam Lee" href="/round-rock-tx/best-bakery?user=6&result_id=43">Sam Lee</a></div>
          <div><div><a title="Best Bakery" href="/round-rock-tx/best-bakery?user=6&result_id=43">Best Bakery</a>
            <span>Bakery</span></div><div>Round Rock, TX</div></div></div></div></div>
    </ul></div>`,
  );

  it('reads each result’s owner, business, kind and town, its id, and whether it has Connect', () => {
    expect(readAlignable(doc, doc.location.href).businesses).toEqual([
      {
        name: 'Dana Reyes',
        profile: {
          id: '42',
          username: 'austin-tx-acme-plumbing',
          url: `${AL}/austin-tx/acme-plumbing`,
        },
        business: 'Acme Plumbing Co',
        details: ['Plumbing Contractor', 'Austin, TX'],
        connect: true,
        message: false,
      },
      {
        name: 'Sam Lee',
        profile: {
          id: '43',
          username: 'round-rock-tx-best-bakery',
          url: `${AL}/round-rock-tx/best-bakery`,
        },
        business: 'Best Bakery',
        details: ['Bakery', 'Round Rock, TX'],
        connect: false,
        message: false,
      },
    ]);
  });

  it('says how many it read, and of what, in a report: never a name', () => {
    const found = pageFound(readLooking(doc, doc.location.href, ALIGNABLE));
    expect(found).toMatchObject({
      businesses: 2,
      businessesName: 2,
      businessesBusiness: 2,
      businessesConnect: 1,
      threads: 0,
      answers: 0,
      business: false,
      chat: false,
      answerBox: false,
    });
    expect(JSON.stringify(found)).not.toMatch(/Dana|Acme|Austin/);
  });
});

describe('My Network', () => {
  it('reads each connection’s business by its id, its names and its Message', () => {
    const doc = page(
      `${AL}/biz/my_network`,
      `<div data-testid="connections-table"><div data-testid="allies-picks-list"><div>
        <div data-testid="connection-row">
          <a aria-label="Sam Lee" data-testid="connection-row-profile-link" href="/biz/businesses/43?cyattr=x">
            <div data-testid="avatar"><img alt="Sam Lee" /></div></a>
          <div data-testid="connection-row-summary"><div><span>Sam Lee</span><span>Best Bakery Co</span></div></div>
          <div><button data-testid="connection-row-menu-trigger"></button>
            <a data-testid="connection-row-cta" href="/biz/conversations?_fat=x&with_business_id=43">Message</a></div>
          <p data-testid="connection-row-action-summary">Say hi to Sam about the bakery fair.</p></div>
      </div></div></div>`,
    );
    expect(readAlignable(doc, doc.location.href).businesses).toEqual([
      {
        name: 'Sam Lee',
        profile: { id: '43', username: null, url: `${AL}/biz/businesses/43` },
        business: 'Best Bakery Co',
        details: [],
        connect: false,
        message: true,
      },
    ]);
  });
});

describe('posts, on a town’s group and a forum question', () => {
  it('reads each post on a group’s page: its author, words, likes, its discussion and its Connect', () => {
    const doc = page(
      `${AL}/groups/austin-tx`,
      `<section><h1 data-testid="group-header/header-text">Austin Business Owners</h1>
        <div><div><div><div href="/austin-tx/acme-plumbing?user=5">
            <a aria-label="Go to Dana Reyes’s profile" href="/austin-tx/acme-plumbing?cyattr=a&user=5"></a></div>
          <div><div><a href="/austin-tx/acme-plumbing?cyattr=a&user=5"><span>Dana Reyes</span><span>at</span>
            <span>Acme Plumbing</span></a></div>
            <div><span>Posted in</span><span>·</span><a href="/groups/austin-tx/need-a-roofer?cyattr=a"><span>4h</span></a></div></div></div>
          <div><div><img data-testid="postImage" alt="A roof" /><div><div title="Need a roofer">Can anyone<br>recommend a roofer?</div>
            <button>See More</button></div></div></div>
          <div><div><span>You and 2 others</span><a href="/biz/likes?resource=9"><span>3</span><span>Like</span><span>s</span></a>
            <span><span>0</span><span>Share</span></span></div><hr>
            <div><a href="/biz/discussions/91?cyattr=a"><svg></svg>Comment</a><a href="/biz/likes"><div>Like</div></a>
              <a href="/biz/connection_requests/quick?business_id=42&discussion_id=91&type=mgc"><div>Connect</div></a>
              <a href="/biz/reports/new?feed_item=1"><div>Report</div></a></div></div></div></div>
      </section>`,
    );
    const read = readAlignable(doc, doc.location.href);
    expect(read.threads).toEqual([
      {
        author: {
          name: 'Dana Reyes',
          profile: {
            id: null,
            username: 'austin-tx-acme-plumbing',
            url: `${AL}/austin-tx/acme-plumbing`,
          },
        },
        url: `${AL}/biz/discussions/91`,
        when: '4h',
        text: 'Can anyone recommend a roofer?',
        likes: 3,
        connect: true,
      },
    ]);
    expect(read.answers).toEqual([]);
    expect(read.business).toBeNull();
  });

  it('reads a forum question’s post, then its answers and their replies, and its box to answer in', () => {
    const doc = page(
      `${AL}/groups/austin-tx/need-a-plumber-12`,
      `<section><div><div><div><a aria-label="Sam’s profile" href="/austin-tx/best-bakery?user=6"></a>
          <div><div><a href="/austin-tx/best-bakery?user=6"><span>Sam Lee</span><span>at</span><span>Best Bakery</span></a></div>
            <div><span>4h</span></div></div></div>
          <p>Who does great plumbing in Austin?</p>
          <div><div><a href="/biz/likes?resource=7"><span>1</span><span>Like</span></a></div><hr>
            <div><a href="/biz/discussions/12">Comment</a><a href="/biz/likes"><div>Like</div></a>
              <a href="/biz/connection_requests/quick?business_id=43&discussion_id=12&type=mgc"><div>Connect</div></a></div></div></div>
        <div><div data-testid="discussion-comment"><div><a href="/austin-tx/acme-plumbing?user=5"><div data-testid="avatar"><img alt="Dana" /></div></a>
            <div><div><div><a href="/austin-tx/acme-plumbing?user=5">Dana Reyes</a><span>about 4 hours ago</span></div>
              <div data-testid="discussion-comment-body"><div>We can help.<br><br>Call any time.</div></div>
              <button>See More</button></div>
              <div><button>Reply</button><button>Like</button>
                <a href="/biz/connection_requests/quick?business_id=42&request_source=discussionpost_1&type=mgc">Connect</a></div></div></div>
          <div><button><span>1</span></button>
            <div data-testid="discussion-comment"><div><a href="/austin-tx/best-bakery?user=6"><img alt="Sam" /></a>
              <div><div><div><a href="/austin-tx/best-bakery?user=6">Sam Lee</a><span>3h</span></div>
                <div data-testid="discussion-comment-body"><p>Thanks!</p></div></div>
                <div><button>Reply</button><button>Like</button></div></div></div></div></div></div>
        <form data-testid="discussion-comment-reply-form"><div><div contenteditable="true" placeholder="Write a comment"><p><br></p></div>
          <textarea placeholder="Write a comment"></textarea></div><button>Send</button></form></div>
      </section>`,
    );
    const read = readAlignable(doc, doc.location.href);
    expect(read.threads).toEqual([
      {
        author: {
          name: 'Sam Lee',
          profile: {
            id: null,
            username: 'austin-tx-best-bakery',
            url: `${AL}/austin-tx/best-bakery`,
          },
        },
        url: `${AL}/biz/discussions/12`,
        when: '4h',
        text: 'Who does great plumbing in Austin?',
        likes: 1,
        connect: true,
      },
    ]);
    expect(read.answers).toEqual([
      {
        author: {
          name: 'Dana Reyes',
          profile: {
            id: null,
            username: 'austin-tx-acme-plumbing',
            url: `${AL}/austin-tx/acme-plumbing`,
          },
        },
        when: 'about 4 hours ago',
        text: 'We can help. Call any time.',
        connect: true,
        reply: false,
      },
      {
        author: {
          name: 'Sam Lee',
          profile: {
            id: null,
            username: 'austin-tx-best-bakery',
            url: `${AL}/austin-tx/best-bakery`,
          },
        },
        when: '3h',
        text: 'Thanks!',
        connect: false,
        reply: true,
      },
    ]);
    expect(read.answerBox).toBe(true);
  });
});

describe('a business’s page', () => {
  it('reads its names, town, pitch, About Us, ideal customer and partner, tags and buttons', () => {
    const doc = page(
      `${AL}/austin-tx/acme-plumbing`,
      `<section><div><div><div><img alt="Acme Plumbing cover" />
        <div><a href="/biz/recommendations/new?id=42&request_source=businesses-show">Recommend</a>
          <a href="/forward_referral_card/42">Refer</a></div>
        <div><div><h1 title="Dana Reyes">Dana Reyes</h1><h2 title="Acme Plumbing">Acme Plumbing</h2></div>
          <div><a href="/austin-tx">Austin, TX</a></div></div>
        <div><a href="/biz/search?q=plumbing&source=profile_featured_tags">Plumbing</a>
          <a href="/biz/search?q=drains&source=profile_featured_tags">Drains</a>
          <a href="/biz/search?q=plumbing&source=profile_featured_tags">Plumbing</a></div>
        <div><a href="/biz/connection_requests/quick?business_id=42&request_source=profile"><div>Connect</div></a></div></div>
        <div><div><svg></svg><div>Our Elevator Pitch</div></div>
          <div><span>We fix leaks fast. <a href="#">Read more</a></span>
            <span>We fix leaks fast, and we answer the phone at night.</span>
            <a href="/biz/businesses/77"><strong>Recommended by</strong> 3 local businesses</a></div></div>
        <div><div data-testid="ideal-customer-information"><h1>Our Ideal Customers</h1>
            <div data-testid="ideal-customer-description">Homeowners with older houses.</div>
            <div><div data-testid="ideal-customer-type">Consumers</div><div data-testid="ideal-customer-location">Austin and Round Rock</div></div>
            <div data-testid="ideal-customer-tags"><div><a href="/biz/search?q=homeowners"><span>Homeowners</span></a></div></div></div>
          <div data-testid="ideal-partner-information"><h1>Businesses we refer with</h1>
            <div data-testid="ideal-partner-description">Realtors and home inspectors.</div>
            <div data-testid="ideal-partner-tags"><div><a href="/biz/search?q=realtor"><span>Realtor</span></a>
              <a href="/biz/search?q=inspector"><span>Home Inspector</span></a></div></div></div></div>
        <div><div><div>About Us</div></div><div><p>Family plumbers since 1990.</p><p>Licensed and insured.</p></div></div>
      </div></div></section>`,
    );
    expect(readAlignable(doc, doc.location.href).business).toEqual({
      name: 'Dana Reyes',
      title: 'Acme Plumbing',
      profile: {
        id: '42',
        username: 'austin-tx-acme-plumbing',
        url: `${AL}/austin-tx/acme-plumbing`,
      },
      town: 'austin-tx',
      pitch: 'We fix leaks fast, and we answer the phone at night.',
      about: 'Family plumbers since 1990.',
      customer: {
        words: 'Homeowners with older houses.',
        type: 'Consumers',
        place: 'Austin and Round Rock',
        tags: ['Homeowners'],
      },
      partner: {
        words: 'Realtors and home inspectors.',
        type: null,
        place: null,
        tags: ['Realtor', 'Home Inspector'],
      },
      tags: ['Plumbing', 'Drains'],
      connect: true,
      recommend: true,
      refer: true,
      message: false,
    });
    const found = pageFound(readLooking(doc, doc.location.href, ALIGNABLE));
    expect(found).toMatchObject({
      business: true,
      businessName: true,
      businessPitch: true,
      businessPartner: true,
      businessTags: true,
      businessMessage: false,
    });
    expect(JSON.stringify(found)).not.toMatch(/Realtor|Acme|leaks/);
  });
});

describe('a forum question’s own post, written straight in a box of its own', () => {
  it('reads its words between its author and its counts (the owner’s Check, 0.67.0)', () => {
    const doc = page(
      `${AL}/groups/austin-tx/need-a-plumber-12`,
      `<section><a href="/groups/austin-tx"><span>Back to Austin Business Owners</span></a>
        <div><div><div><div href="/austin-tx/best-bakery?user=6"><a aria-label="Sam’s profile" href="/austin-tx/best-bakery?user=6"></a></div>
            <div><div><a href="/austin-tx/best-bakery?user=6"><span>Sam Lee</span><span>at</span><span>Best Bakery</span></a></div>
              <div><span>2d</span></div></div></div>
          <div>Who does great plumbing in Austin?<br>Old house, slow drains.</div>
          <div><div><span>You and 2 others</span><a href="/biz/likes?resource=7"><span>3</span><span>Like</span></a></div><hr>
            <div><a href="/biz/discussions/12">Comment</a>
              <a href="/biz/connection_requests/make_connection?business_id=43&discussion_id=12&type=mgc"><div>Connect</div></a></div></div></div></div>
      </section>`,
    );
    expect(readAlignable(doc, doc.location.href).threads).toMatchObject([
      {
        when: '2d',
        text: 'Who does great plumbing in Austin? Old house, slow drains.',
        likes: 3,
        connect: true,
      },
    ]);
  });
});

describe('My Network’s Requests', () => {
  it('reads nobody from its table when it says there are none', () => {
    const doc = page(
      `${AL}/biz/my_network/connection_requests`,
      `<div data-testid="requests-360-table"><div><span>Requests</span></div><table><thead><tr>
        <th><div data-testid="name-header">Business name</div></th><th><div data-testid="reason-header"><div>Why they want to connect</div></div></th><th></th></tr></thead>
        <tbody><tr><td><div data-testid="connection-requests-360-empty"><span>You have no new requests.</span>
          <span>Complete your profile to get more.</span><a href="/biz/acme">Go to your profile</a></div></td></tr></tbody></table></div>`,
    );
    expect(readAlignable(doc, doc.location.href).requests).toEqual([]);
  });

  it('reads each request’s business, why they’d connect, and its Accept', () => {
    const doc = page(
      `${AL}/biz/my_network/connection_requests`,
      `<div data-testid="requests-360-table"><table><tbody><tr>
        <td><a href="/austin-tx/best-bakery?user=6&business_id=43"><span>Sam Lee</span></a><div>Best Bakery</div></td>
        <td><p>We both serve homeowners in Austin.</p></td>
        <td><button>Accept</button><button>Ignore</button></td></tr></tbody></table></div>`,
    );
    expect(readAlignable(doc, doc.location.href).requests).toEqual([
      {
        name: 'Sam Lee',
        profile: {
          id: '43',
          username: 'austin-tx-best-bakery',
          url: `${AL}/austin-tx/best-bakery`,
        },
        business: 'Best Bakery',
        reason: 'We both serve homeowners in Austin.',
        accept: true,
      },
    ]);
  });
});

describe('Messages', () => {
  it('reads the conversations down the side, and the one open: who, its box and Send', () => {
    const doc = page(
      `${AL}/biz/conversations?_fat=x&with_business_id=42`,
      `<div data-testid="inbox"><div><div><header><h3>Messages</h3></header>
        <div data-testid="conversationInSidebar"><div><div><img alt="" /><div><div>Sam Lee</div><div>See you Tuesday</div></div></div>
          <span data-testid="conversationDate">Oct 12</span></div></div>
        <div data-testid="conversationInSidebar"><div><div><img alt="" /><div><div>Pat Kim</div></div></div>
          <span data-testid="conversationDate">Sep 3</span></div></div></div>
        <div><div data-testid="channel-header-loaded"><header><div><img alt="" />
          <a href="/biz/businesses/42?user=5"><div>Dana Reyes</div></a></div></header></div>
          <div data-testid="full-view-write-message"><div><div contenteditable="true" placeholder="Write a message"></div>
            <textarea placeholder="Write a message"></textarea></div>
            <button aria-label="Send" data-testid="messaging-send-external"><svg></svg></button></div></div></div>`,
    );
    const read = readAlignable(doc, doc.location.href);
    expect(read.chats).toEqual([
      { name: 'Sam Lee', preview: 'See you Tuesday', when: 'Oct 12' },
      { name: 'Pat Kim', preview: null, when: 'Sep 3' },
    ]);
    expect(read.chat).toEqual({
      name: 'Dana Reyes',
      profile: { id: '42', username: null, url: `${AL}/biz/businesses/42` },
      box: true,
      send: true,
      // A conversation with nothing written in it yet.
      messages: [],
      last: null,
    });
  });
});

/**
 * A conversation open on Messages, rebuilt element for element from the owner's Check of 21 Oct 2026 (0.83.0), with
 * made-up words where its outline hid them: its header's link to the business it's with, the business card and a day
 * above its messages, then each message's row. Theirs starts with their picture in a link to their business, then who
 * and when, then its card; the person's own has who and when, its card, then a picture alone.
 */
const theirRow = (id: string, words: string, when: string) => `
  <div><a href="/biz/businesses/${id}?user=5&cyfid=6&cyattr=7"><img alt="" /></a>
    <div><div><span>Dana Reyes</span><span>${when}</span></div>
      <div data-testid="rel-card-message"><div>${words}</div><svg role="img"></svg></div></div></div>`;
const myRow = (words: string, when: string, picture = '<img alt="" />') => `
  <div><div><div><span>You</span><span>${when}</span></div>
      <div data-testid="rel-card-message"><div>${words}</div><svg role="img"></svg></div></div>
    ${picture}</div>`;
const conversation = (url: string, rows: string) =>
  page(
    url,
    `<div data-testid="inbox"><div><div><header><h3>Messages</h3></header>
      <div data-testid="conversationInSidebar"><div><div><img alt="" /><div><div>Dana Reyes</div><div>Glad to, Dana.</div></div></div>
        <span data-testid="conversationDate">Oct 20</span></div></div></div></div>
    <div><div data-testid="channel-header-loaded"><header><div><div><img alt="" />
        <a href="/biz/businesses/42?user=5&cyfid=6&cyattr=7"><div>Dana Reyes</div></a></div>
        <div data-testid="inbox-notes-tags"><button aria-expanded="false"><svg role="img"></svg>Tags</button></div></div>
        <div><div data-testid="ellipses"><div></div></div></div></header></div>
      <div><div><div><div>
        <p>You and Dana Reyes are connected on Alignable</p>
        <div>October 14, 2026</div>
        <div><a href="/austin-tx/acme-plumbing?user=5"><span><img alt="Dana Reyes Acme Plumbing Co" /><svg role="img"></svg></span></a>
          <div><div><a href="/austin-tx/acme-plumbing?user=5"><div>Dana Reyes</div><div>Owner at Acme Plumbing Co</div></a>
            <a href="/austin-tx">Austin, TX</a></div>
            <div><div><svg role="img" aria-hidden="true"></svg><div>12 mutual connections</div></div>
              <div><img alt="Local business badge" /><div>On Alignable since 2019</div></div></div></div></div>
        <div><div>October 20, 2026</div></div>
        ${rows}
      </div>
      <div data-testid="wfm-see-why"><div><svg role="img" data-testid="small-orb"></svg>
        <button aria-expanded="false" data-testid="see-why-toggle"><span>Why you might want to talk</span></button></div></div></div>
      <div data-testid="full-view-write-message"><div><div dir="ltr">
        <div role="presentation" dir="ltr" contenteditable="true" placeholder="Write a message"></div>
        <textarea placeholder="Write a message"></textarea></div></div>
        <button aria-label="Send" data-testid="messaging-send-external"><svg role="img"></svg></button></div></div></div></div>`,
  );

/** Messages as it opened, with their message and then the person's (the outline of /biz/conversations?_fan=…). */
const INBOX_OPEN = () =>
  conversation(
    `${AL}/biz/conversations?_fan=1`,
    `${theirRow('42', 'Hi Casey,<br><br>Thanks for connecting. We do a lot of water heaters in Austin.<br><br>Talk soon', '9:12 AM')}
    ${myRow('Glad to, Dana. Want to swap referrals?', '9:40 AM')}`,
  );

describe('the conversation open on Messages, as the owner’s Check of 21 Oct 2026 drew it', () => {
  for (const [shape, made] of [
    ['as its outline drew it', (doc: Document) => doc],
    ['with a bare box around every element', boxEverything],
  ] as const) {
    it(`reads each message as theirs or the person’s, what it says and when, and who wrote last, ${shape}`, () => {
      const doc = made(INBOX_OPEN());
      expect(readAlignable(doc, doc.location.href).chat).toEqual({
        name: 'Dana Reyes',
        profile: { id: '42', username: null, url: `${AL}/biz/businesses/42` },
        box: true,
        send: true,
        messages: [
          {
            from: 'them',
            text: 'Hi Casey,\nThanks for connecting. We do a lot of water heaters in Austin.\nTalk soon',
            when: '9:12 AM',
          },
          { from: 'me', text: 'Glad to, Dana. Want to swap referrals?', when: '9:40 AM' },
        ],
        last: 'me',
      });
    });
  }

  it('reads a conversation’s only message as the person’s, never the business card above it as theirs', () => {
    // The chat page's outline (/biz/conversations?with_business_id=…): one message, the person's.
    const doc = conversation(
      `${AL}/biz/conversations?_fat=1&with_business_id=42`,
      myRow('Hi Dana, nice to meet you here.', '2:05 PM'),
    );
    expect(readAlignable(doc, doc.location.href).chat).toMatchObject({
      messages: [{ from: 'me', text: 'Hi Dana, nice to meet you here.', when: '2:05 PM' }],
      last: 'me',
    });
    // Their message alone: theirs by the picture in the link to their business.
    const theirs = boxEverything(
      conversation(
        `${AL}/biz/conversations?_fat=1&with_business_id=42`,
        theirRow('42', 'Do you work in Round Rock too?', '3:10 PM'),
      ),
    );
    expect(readAlignable(theirs, theirs.location.href).chat).toMatchObject({
      messages: [{ from: 'them', text: 'Do you work in Round Rock too?', when: '3:10 PM' }],
      last: 'them',
    });
  });

  it('never takes the person’s own picture for theirs when it links to their own business', () => {
    const doc = conversation(
      `${AL}/biz/conversations?_fan=1`,
      `${theirRow('42', 'Thanks!', '9:12 AM')}
      ${myRow('Any time.', '9:40 AM', '<a href="/biz/businesses/77"><img alt="" /></a>')}`,
    );
    expect(readAlignable(doc, doc.location.href).chat?.messages.map((m) => m.from)).toEqual([
      'them',
      'me',
    ]);
  });

  it('tells who wrote back when the last message is theirs, by Alignable’s id for their business', () => {
    const mine = INBOX_OPEN();
    expect(readReplies(mine, mine.location.href)).toEqual([]);
    const doc = conversation(
      `${AL}/biz/conversations?_fan=1`,
      `${myRow('Want to swap referrals?', '9:40 AM')}${theirRow('42', 'Yes, let’s talk Tuesday.', '11:02 AM')}`,
    );
    expect(readReplies(doc, doc.location.href)).toEqual([
      {
        name: 'Dana Reyes',
        threadKey: '42',
        profile: { id: '42', username: null, url: `${AL}/biz/businesses/42` },
        when: null,
      },
    ]);
  });

  it('counts its messages in a report, never what they say or who', () => {
    const doc = INBOX_OPEN();
    const found = pageFound(readLooking(doc, doc.location.href, ALIGNABLE));
    expect(found).toMatchObject({ chat: true, chatMessages: true, chatLast: true, chats: 1 });
    expect(JSON.stringify(found)).not.toMatch(/water heaters|referrals|Dana/);
  });
});

describe('the box Alignable asks for an emailed code in', () => {
  const dialog = (words: string, boxes: string) =>
    page(
      `${AL}/austin-tx/acme-roofing?user=7`,
      `<main><h1 title="Dana Reyes">Dana Reyes</h1></main>
        <div role="dialog"><button aria-label="Close"></button><p>${words}</p>${boxes}
          <button>Cancel</button><button>Continue</button></div>`,
    );

  it('finds it over their profile, as About Us’s Edit opened it (0.69.0)', () => {
    const doc = dialog(
      'We sent a verification code to your email. Enter it to keep editing.',
      '<input type="text" />',
    );
    expect(readAlignable(doc, doc.location.href).codeBox).toBe(true);
  });

  it('never takes another box over the page for it', () => {
    const editor = dialog('Tell people about your business.', '<input type="text" />');
    expect(readAlignable(editor, editor.location.href).codeBox).toBe(false);
    const two = dialog('Enter the code we emailed you.', '<input /><input />');
    expect(readAlignable(two, two.location.href).codeBox).toBe(false);
  });
});
