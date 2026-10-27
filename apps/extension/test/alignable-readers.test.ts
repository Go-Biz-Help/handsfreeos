/**
 * Alignable's own readers (src/networks/alignable/read.ts; partners stage 6c, part 1): on pages drawn as the owner's
 * Check Alignable outlined them (0.66.0, 19 Oct 2026; an open conversation's messages from his Check of 21 Oct 2026),
 * with their test ids, links and words where Alignable put them. What a report of each says: how many of each, never
 * what they say.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ProblemFound } from '@hfos/core/problem-report';
import { commentOn } from '../src/networks/alignable/auto';
import {
  groupCards,
  groupFacts,
  groupLeaders,
  groupStanding,
  memberRows,
  readAlignable,
} from '../src/networks/alignable/read';
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

  it('reads a row’s Message in Alignable’s newer shape as its own (0.94.0)', () => {
    const doc = page(
      `${AL}/biz/my_network`,
      `<div data-testid="connection-row">
        <a aria-label="Robin Vale" data-testid="connection-row-profile-link" href="/biz/businesses/5150"></a>
        <div data-testid="connection-row-summary"><div><span>Robin Vale</span><span>Pine Street Bakery</span></div></div>
        <a data-testid="connection-row-cta" href="/biz/messages/new?recipient_ids=9001&to_user=9001">Message</a></div>`,
    );
    expect(readAlignable(doc, doc.location.href).businesses).toMatchObject([
      { name: 'Robin Vale', profile: { id: '5150' }, connect: false, message: true },
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
      connected: false,
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
      businessConnect: true,
      businessConnected: false,
      businessMessage: false,
    });
    expect(JSON.stringify(found)).not.toMatch(/Realtor|Acme|leaks/);
  });
});

/**
 * A business's page you're connected with, rebuilt from the outline in the owner's problem report of 26 Oct 2026
 * (0.91.0 handed it to him as "couldn't find Connect"), with made-up names where it hid them: a header with a link to
 * your network with them, a button, Alignable's newer Message (to the person by their own id, never their business's)
 * and their Recommend; their row of buttons twice (Refer, Introduce, Remove Connection and a menu), as a wide screen and
 * a phone draw it; and down the side, other businesses it suggests, each with its own Connect.
 */
const connectedPage = (o: { row?: string; side?: string; header?: string } = {}) =>
  page(
    `${AL}/denton-tx/pine-street-bakery`,
    `<main><section>
      <div><div><img alt="cover" />
        <div><div><h1 title="Robin Vale">Robin Vale</h1><h2 title="Pine Street Bakery">Pine Street Bakery</h2></div>
          <div><a href="/denton-tx">Denton, TX</a></div></div>
        <div>${
          o.header ??
          `<a href="/biz/my_network/5150/31?_fat=a&ov=b&pt=c">Shared connections</a>
          <div><div><button aria-expanded="false"><svg></svg><div>More ways to connect</div></button></div></div>
          <a href="/biz/messages/new?_faid=7&recipient_ids=9001&to_user=9001"><svg></svg>Message</a>
          <a href="/biz/recommendations/new?cyattr=x&cyfid=y&id=5150&request_source=profile"><svg></svg></a>`
        }</div></div>
      ${[1, 2]
        .map(
          () =>
            `<div>${
              o.row ??
              `<a href="/forward_referral_card/5150?cyattr=x&cyfid=y">Refer</a>
            <button data-testid="introduce-button">Introduce</button>
            <a href="/biz/connections/5150"><svg></svg>Remove Connection</a>
            <button><span><svg></svg></span></button>`
            }</div>`,
        )
        .join('')}
      <div><div><div>About Us</div></div><div><p>Sourdough baked fresh every morning.</p></div></div>
      </div>
      <aside><h3>Businesses near you</h3>${
        o.side ??
        [
          ['7501', 'denton-tx/moreno-movers', 'Kit Moreno'],
          ['8001', 'denton-tx/tran-tax', 'Lou Tran'],
          ['8501', 'denton-tx/bell-flowers', 'Ari Bell'],
        ]
          .map(
            ([id, at, name]) => `<div><a href="/${at}?user=2">${name}</a>
              <a href="/biz/connection_requests/make_connection?business_id=${id}&request_source=businesses-show&resource=r${id}"><div>Connect</div></a></div>`,
          )
          .join('')
      }</aside>
    </section></main>`,
  );

describe('a business’s page you’re connected with, as the owner’s report of 26 Oct 2026 outlined it', () => {
  for (const [shape, made] of [
    ['as its outline drew it', (doc: Document) => doc],
    ['with a bare box around every element', boxEverything],
  ] as const) {
    it(`reads you’re connected, and its newer Message as theirs, never a business it suggests, ${shape}`, () => {
      const doc = made(connectedPage());
      expect(readAlignable(doc, doc.location.href).business).toMatchObject({
        name: 'Robin Vale',
        profile: {
          id: '5150',
          username: 'denton-tx-pine-street-bakery',
          url: `${AL}/denton-tx/pine-street-bakery`,
        },
        // The Connects down the side are other businesses', by their ids: never taken for theirs.
        connect: false,
        connected: true,
        recommend: true,
        refer: true,
        message: true,
      });
    });
  }

  it('says so in a report, telling the truth of each, within what a report keeps', () => {
    const doc = connectedPage();
    const found = pageFound(readLooking(doc, doc.location.href, ALIGNABLE));
    expect(found).toMatchObject({
      business: true,
      businessProfile: true,
      businessConnect: false,
      businessConnected: true,
      businessMessage: true,
      businessRecommend: true,
      businessRefer: true,
    });
    expect(ProblemFound.safeParse({ ...found, sections: ['About Us'] }).success).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/Robin|Pine|Sourdough/);
  });

  it('tells Check Alignable you’re connected already, where no Connect shows', async () => {
    const doc = connectedPage({ side: '' });
    expect(await ALIGNABLE.looks.connect!.look(doc, doc.location.href)).toMatchObject({
      tried: false,
      missing: ['you’re connected already, or asked to be'],
    });
  });

  it('never takes another business’s Remove Connection, nor a link there that doesn’t say so, for theirs', () => {
    // A connection of yours down the side, with its own Remove Connection: their page still has their Connect.
    const side = connectedPage({
      row: `<a href="/forward_referral_card/5150">Refer</a>
        <a href="/biz/connection_requests/make_connection?business_id=5150&request_source=profile"><div>Connect</div></a>`,
      header: '<a href="/biz/recommendations/new?id=5150">Recommend</a>',
      side: `<div><a href="/denton-tx/moreno-movers?user=2">Kit Moreno</a>
        <a href="/biz/connections/7501">Remove Connection</a></div>`,
    });
    expect(readAlignable(side, side.location.href).business).toMatchObject({
      connect: true,
      connected: false,
      message: false,
    });
    // Their connections listed, by the same address: not the button that says you're connected.
    const listed = connectedPage({
      row: `<a href="/forward_referral_card/5150">Refer</a><a href="/biz/connections/5150">See all 212 connections</a>`,
    });
    expect(readAlignable(listed, listed.location.href).business).toMatchObject({
      connected: false,
    });
  });

  it('never takes a Message beside another business for theirs: one it suggests, or a post by another', () => {
    const doc = connectedPage({
      header: '<a href="/biz/recommendations/new?id=5150">Recommend</a>',
      row: `<a href="/forward_referral_card/5150">Refer</a>
        <a href="/biz/connection_requests/make_connection?business_id=5150&request_source=profile"><div>Connect</div></a>`,
      side: `<div><a href="/denton-tx/moreno-movers?user=2">Kit Moreno</a>
          <a href="/biz/messages/new?recipient_ids=9100&to_user=9100">Message</a>
          <a href="/biz/connection_requests/make_connection?business_id=7501&request_source=businesses-show"><div>Connect</div></a></div>
        <div><div><a href="/denton-tx/tran-tax?user=3"><span>Lou Tran</span><span>at</span><span>Tran Tax</span></a></div>
          <div><p>Tax season is coming.</p><a href="/biz/messages/new?recipient_ids=9200&to_user=9200">Message</a></div></div>`,
    });
    expect(readAlignable(doc, doc.location.href).business).toMatchObject({
      connect: true,
      connected: false,
      message: false,
    });
  });

  it('still reads its Message to their conversation by their business’s id, as before', () => {
    const doc = connectedPage({
      header: `<a href="/biz/recommendations/new?id=5150">Recommend</a>
        <a href="/biz/conversations?with_business_id=5150">Message</a>`,
      row: '<a href="/forward_referral_card/5150">Refer</a>',
    });
    expect(readAlignable(doc, doc.location.href).business).toMatchObject({
      connect: false,
      connected: false,
      message: true,
    });
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

// ------------------------------------------------------------------------------------------------ groups (decision 92)

/** A group's page of its people: its leaders under their own heading, then its members, one by Alignable's id. */
const membersPage = () =>
  page(
    `${AL}/groups/home-pros-network/members`,
    `<header><nav><a href="/salem-or/park-florist/lee-park">Lee Park</a></nav></header>
    <main><h1>Home Pros Network</h1><span>1,204 members</span>
      <h2>Group Leaders</h2>
      <div><a href="/denver-co/stone-gutters/riley-stone"><img alt="Riley Stone" /></a>
        <div><a href="/denver-co/stone-gutters/riley-stone">Riley Stone</a><a href="/denver-co/stone-gutters">Stone Gutters</a></div></div>
      <h2>Members (1,204)</h2>
      <div><a href="/boise-id/pine-painting/jamie-pine">Jamie Pine</a><a href="/boise-id/pine-painting">Pine Painting</a>
        <span>Painter in Boise</span><button>Connect</button></div>
      <div><a href="/biz/businesses/5150?user=3">Morgan Vale</a><span>Vale Bookkeeping</span><span>Boise, ID</span></div>
    </main>`,
  );

describe('groups, as Alignable lists them (decision 92)', () => {
  it('reads a search for groups: each by its address, its name, members, the line under it and where you stand', () => {
    const doc = page(
      `${AL}/groups/search?q=home%20services`,
      `<main><nav><a href="/groups/austin-tx">Austin Business Owners</a></nav><h1>Groups</h1>
        <div><div><a href="/groups/home-pros-network"><img alt="" /></a></div>
          <div><a href="/groups/home-pros-network">Home Pros Network</a><span>For people who fix and build homes</span>
            <span>1,204 members</span><button>Join</button></div></div>
        <div><a href="/groups/maple-valley-trades?ref=search">Maple Valley Trades</a><span>Maple Valley, WA</span>
          <span>1.2K Members</span><a href="/groups/maple-valley-trades">View</a><button>Requested</button></div>
        <div><a href="/groups/riverbend-roofers">Riverbend Roofers</a><span>86 members</span><button>Joined</button></div>
        <div><a href="/groups/search?q=home%20services&page=2">Next</a></div>
      </main>`,
    );
    expect(groupCards(doc, doc.location.href)).toEqual([
      {
        id: 'home-pros-network',
        url: `${AL}/groups/home-pros-network`,
        name: 'Home Pros Network',
        members: 1204,
        joined: false,
        asked: false,
        detail: 'For people who fix and build homes',
      },
      {
        id: 'maple-valley-trades',
        url: `${AL}/groups/maple-valley-trades`,
        name: 'Maple Valley Trades',
        members: 1200,
        joined: false,
        asked: true,
        detail: 'Maple Valley, WA',
      },
      {
        id: 'riverbend-roofers',
        url: `${AL}/groups/riverbend-roofers`,
        name: 'Riverbend Roofers',
        members: 86,
        joined: true,
        asked: false,
        detail: null,
      },
    ]);
    // A search's page is no group's own.
    expect(groupFacts(doc, doc.location.href)).toBeNull();
  });

  it('reads the person’s own groups, never a menu’s link or a group named in an answer', () => {
    const doc = page(
      `${AL}/biz/groups`,
      `<main><h1>My Groups</h1><nav><a href="/groups/maple-valley-trades">Maple Valley Trades</a></nav>
        <ul><li><a href="/groups/austin-tx"><h3>Austin Business Owners</h3></a><span>2,310 members</span>
            <a href="/groups/austin-tx/leave">Leave</a></li>
          <li><a href="/groups/riverbend-roofers">Riverbend Roofers</a><small>Roofers along the river</small>
            <button>Joined</button></li></ul>
        <div data-testid="discussion-comment"><a href="/groups/home-pros-network">Home Pros Network</a></div>
      </main>`,
    );
    const read = readAlignable(doc, doc.location.href);
    expect(read.groups.map((g) => [g.id, g.name, g.members, g.joined, g.detail])).toEqual([
      ['austin-tx', 'Austin Business Owners', 2310, true, null],
      ['riverbend-roofers', 'Riverbend Roofers', null, true, 'Roofers along the river'],
    ]);
    expect(read).not.toHaveProperty('group');
  });

  it('reads a group’s own page with its Join: its name, members and About, never a suggested group’s button', () => {
    const doc = page(
      `${AL}/groups/home-pros-network`,
      `<main><h1>Home Pros Network</h1><div><span>1,204 members</span><button>Join</button></div>
        <section><h2>About</h2><p>For people who fix and build homes.</p><p>Share leads and tips.</p></section>
        <aside><h3>Groups you may like</h3>
          <div><a href="/groups/riverbend-roofers">Riverbend Roofers</a><button>Joined</button></div></aside></main>`,
    );
    expect(groupFacts(doc, doc.location.href)).toEqual({
      id: 'home-pros-network',
      url: `${AL}/groups/home-pros-network`,
      name: 'Home Pros Network',
      members: 1204,
      joined: false,
      detail: null,
      asked: false,
      join: true,
      about: ['For people who fix and build homes.', 'Share leads and tips.'],
      leaders: false,
    });
    // The groups it suggests are only suggestions on a group's own page.
    expect(groupCards(doc, doc.location.href)).toEqual([]);
  });

  it('never takes a Connect asked in a post or a person’s row for the group’s own: it still has its Join', () => {
    // Its header with a leader's link, a post whose writer was asked to connect (and links to this group: "Posted in"),
    // and a member asked to connect with, on the side.
    const doc = page(
      `${AL}/groups/home-pros-network`,
      `<main><div><h1>Home Pros Network</h1><span>Led by <a href="/denver-co/stone-gutters/riley-stone">Riley Stone</a></span>
          <span>1,204 members</span><button>Join</button></div>
        <section><div>
          <div><a href="/boise-id/pine-painting/jamie-pine?user=5"><span>Jamie Pine</span><span>at</span><span>Pine Painting</span></a>
            <div><span>Posted in</span><a href="/groups/home-pros-network/fall-gutters"><span>4h</span></a></div>
            <button>Request Sent</button></div>
          <div><div title="Fall gutters">Who else is busy with gutters this fall?</div></div>
          <div><a href="/biz/discussions/93">Comment</a><a href="/biz/likes"><div>Like</div></a>
            <a href="/biz/connection_requests/quick?business_id=42&discussion_id=93&type=mgc"><div>Pending</div></a></div>
        </div></section>
        <aside><h3>Members</h3>
          <div><a href="/salem-or/vale-bookkeeping/morgan-vale">Morgan Vale</a><button>Requested</button></div></aside>
      </main>`,
    );
    expect(groupFacts(doc, doc.location.href)).toMatchObject({
      id: 'home-pros-network',
      name: 'Home Pros Network',
      joined: false,
      asked: false,
      join: true,
    });
    expect(groupStanding(doc, doc.location.href)?.join?.textContent).toBe('Join');
  });

  it('reads a group you’re in, and one you asked to join, on its About page', () => {
    const joined = page(
      `${AL}/groups/riverbend-roofers/about`,
      `<main><h1>Riverbend Roofers</h1><button>Joined</button>
        <div>About this group</div><div>Roofers along the river.</div></main>`,
    );
    expect(groupFacts(joined, joined.location.href)).toMatchObject({
      id: 'riverbend-roofers',
      joined: true,
      asked: false,
      join: false,
      about: ['Roofers along the river.'],
    });
    const asked = page(
      `${AL}/groups/maple-valley-trades/about`,
      `<main><h1>Maple Valley Trades</h1><button>Cancel Request</button><p>Trades in Maple Valley.</p></main>`,
    );
    expect(groupFacts(asked, asked.location.href)).toMatchObject({
      joined: false,
      asked: true,
      join: false,
      about: ['Trades in Maple Valley.'],
    });
  });

  it('reads a group’s members, each by their business, its leaders marked, never the menu', () => {
    const doc = membersPage();
    expect(memberRows(doc, doc.location.href)).toEqual([
      {
        name: 'Riley Stone',
        profile: {
          id: null,
          username: 'denver-co-stone-gutters',
          url: `${AL}/denver-co/stone-gutters`,
        },
        business: 'Stone Gutters',
        lines: [],
        leader: true,
      },
      {
        name: 'Jamie Pine',
        profile: {
          id: null,
          username: 'boise-id-pine-painting',
          url: `${AL}/boise-id/pine-painting`,
        },
        business: 'Pine Painting',
        lines: ['Painter in Boise'],
        leader: false,
      },
      {
        name: 'Morgan Vale',
        profile: { id: '5150', username: null, url: `${AL}/biz/businesses/5150` },
        business: null,
        lines: ['Vale Bookkeeping', 'Boise, ID'],
        leader: false,
      },
    ]);
    expect(groupLeaders(doc, doc.location.href)).toMatchObject({
      shown: true,
      leaders: [{ name: 'Riley Stone' }],
    });
    expect(groupFacts(doc, doc.location.href)).toMatchObject({ members: 1204, leaders: true });
  });

  it('marks a leader by the word beside them, and says when a page showed none', () => {
    const marked = page(
      `${AL}/groups/home-pros-network/members`,
      `<main><div><a href="/boise-id/pine-painting/jamie-pine">Jamie Pine</a><span>Organizer</span></div>
        <div><a href="/biz/businesses/5150">Morgan Vale</a></div></main>`,
    );
    expect(
      groupLeaders(marked, marked.location.href).leaders.map((m) => [m.name, m.lines]),
    ).toEqual([['Jamie Pine', []]]);
    const none = page(
      `${AL}/groups/home-pros-network/members`,
      `<main><div><a href="/biz/businesses/5150">Morgan Vale</a></div></main>`,
    );
    expect(groupLeaders(none, none.location.href)).toEqual({ shown: false, leaders: [] });
    // Only a page of a group's people has its members.
    const own = page(
      `${AL}/groups/home-pros-network`,
      '<main><a href="/biz/businesses/5150">Morgan Vale</a></main>',
    );
    expect(memberRows(own, own.location.href)).toEqual([]);
  });

  it('says how many of each it read in a report, never a name or a group’s words', () => {
    const doc = membersPage();
    const found = pageFound(readLooking(doc, doc.location.href, ALIGNABLE));
    expect(found).toMatchObject({ members: 3, groups: 0 });
    expect(JSON.stringify(found)).not.toMatch(/Riley|Stone|Jamie|Pine|Morgan|Vale|Home Pros/);
  });

  it('keeps where a search looked in an outline’s addresses, never what it looked for', () => {
    const doc = page(
      `${AL}/biz/search?q=roofing`,
      `<main><a href="/biz/search?q=roofing%20contractor&location=Austin&doc_type=group">Next</a></main>`,
    );
    const outline = outlineLooking(doc, doc.location.href, ALIGNABLE);
    expect(outline).toContain('location=Austin');
    expect(outline).toContain('doc_type=group');
    expect(outline).not.toMatch(/roofing|contractor/);
  });

  it('keeps a group page’s own words in an outline, never a name, a business or the group’s', () => {
    const doc = membersPage();
    const outline = outlineLooking(doc, doc.location.href, ALIGNABLE);
    expect(outline).toContain('Connect');
    expect(outline).not.toMatch(
      /Riley|Stone|Jamie|Pine|Painter|Boise|Morgan|Vale|Home Pros|home-pros|5150|denver|gutters/i,
    );
  });
});

/**
 * A discussion's own page: their post, its own reply form at the top, and an answer with a reply form of its own under
 * it. A Send empties the box it's in, as Alignable's does once a comment went.
 */
const discussion = (top = true) => {
  const doc = page(
    `${AL}/groups/home-pros-network/gutter-season`,
    `<main><section>
      <div><div><a href="/denver-co/stone-gutters?user=8"><span>Riley Stone</span><span>at</span><span>Stone Gutters</span></a>
          <span>2h</span></div>
        <p>Who else is busy with gutters this fall?</p>
        <div><a href="/biz/discussions/93">Comment</a><button>Like</button></div></div>
      ${top ? '<form data-testid="discussion-comment-reply-form" id="top"><textarea placeholder="Write a comment"></textarea><button>Send</button></form>' : ''}
      <div data-testid="discussion-comment"><a href="/boise-id/pine-painting?user=4">Jamie Pine</a><span>1h</span>
        <div data-testid="discussion-comment-body">Busy here too.</div><button>Reply</button>
        <form data-testid="discussion-comment-reply-form" id="under"><textarea placeholder="Write a reply"></textarea>
          <button>Send</button></form></div>
    </section></main>`,
  );
  const sent: string[] = [];
  for (const form of doc.querySelectorAll('form'))
    form.querySelector('button')!.addEventListener('click', () => {
      const box = form.querySelector('textarea')!;
      sent.push(`${form.id}: ${box.value}`);
      box.value = '';
    });
  return { doc, sent };
};

describe('a comment on a good post (decision 92)', () => {
  const RILEY = {
    id: null,
    username: 'denver-co-stone-gutters',
    url: `${AL}/denver-co/stone-gutters`,
  };
  const on = { profile: RILEY, postUrl: `${AL}/biz/discussions/93` };

  it('goes only in the post’s own reply form at the top, never the one under an answer', async () => {
    const { doc, sent } = discussion();
    expect(await commentOn(doc, doc.location.href, 'Same here, a busy season.', on)).toBe('done');
    expect(sent).toEqual(['top: Same here, a busy season.']);
    expect(doc.querySelector<HTMLTextAreaElement>('#under textarea')!.value).toBe('');
  });

  it('writes nothing with only a reply box under an answer, on another post, or on another business’s', async () => {
    const onlyUnder = discussion(false);
    expect(await commentOn(onlyUnder.doc, onlyUnder.doc.location.href, 'Hi', on)).toBe('none');
    const other = discussion();
    expect(
      await commentOn(other.doc, other.doc.location.href, 'Hi', {
        ...on,
        postUrl: `${AL}/biz/discussions/94`,
      }),
    ).toBe('none');
    expect(
      await commentOn(other.doc, other.doc.location.href, 'Hi', {
        ...on,
        profile: {
          id: null,
          username: 'boise-id-pine-painting',
          url: `${AL}/boise-id/pine-painting`,
        },
      }),
    ).toBe('none');
    for (const { doc, sent } of [onlyUnder, other]) {
      expect(sent).toEqual([]);
      for (const box of doc.querySelectorAll('textarea')) expect(box.value).toBe('');
    }
  });

  it('leaves what the person wrote in its box alone', async () => {
    const { doc, sent } = discussion();
    doc.querySelector<HTMLTextAreaElement>('#top textarea')!.value = 'My own words';
    expect(await commentOn(doc, doc.location.href, 'Hi', on)).toBe('not_sent');
    expect(sent).toEqual([]);
    expect(doc.querySelector<HTMLTextAreaElement>('#top textarea')!.value).toBe('My own words');
  });
});
