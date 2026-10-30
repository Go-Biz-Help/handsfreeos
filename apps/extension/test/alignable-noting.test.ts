/**
 * The person's own steps on Alignable, noticed as they take them (src/networks/alignable/actions.ts; partners stage 6c,
 * part 2), on pages drawn as the owner's Check Alignable outlined them (0.66.0 to 0.68.0): Connect, a post's and an
 * answer's Like, Send in a box to answer in, and a message. And that each is a save HandsFreeOS takes.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { alignableNoticer, stepFromClick } from '../src/networks/alignable/actions';
import { alignable } from '../src/networks/alignable/kit';
import { touchSave } from '../src/hfos/saves';

const AL = 'https://www.alignable.com';
const page = (url: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;
const click = (doc: Document, selector: string) =>
  stepFromClick(doc.querySelector(selector)!, doc, doc.location.href);

/** A post on a group's page, its author Dana Reyes of Acme Plumbing (id 42), its discussion 91. */
const POST = `<div><div><div><a aria-label="Go to Dana’s profile" href="/austin-tx/acme-plumbing?user=5"></a></div>
    <div><a href="/austin-tx/acme-plumbing?user=5"><span>Dana Reyes</span><span>at</span><span>Acme Plumbing</span></a>
      <span>4h</span></div></div>
  <div><div title="Need a roofer">Can anyone recommend a roofer?</div></div>
  <div><div><a id="likes" href="/biz/likes?resource=9"><span>3</span><span>Like</span></a></div><hr>
    <div><a href="/biz/discussions/91">Comment</a><a id="like" href="/biz/likes"><svg></svg><div>Like</div></a>
      <a id="connect" href="/biz/connection_requests/make_connection?business_id=42&discussion_id=91&type=mgc"><div>Connect</div></a></div></div></div>`;

describe('noting Connect on Alignable', () => {
  it('notes a search result’s Connect, to its business by Alignable’s id', () => {
    const doc = page(
      `${AL}/biz/search?q=plumber`,
      `<div role="contentinfo"><ul><div><a href="/austin-tx/acme-plumbing?user=5&result_id=42"><img alt="Dana Reyes" /></a>
        <div><div><a title="Dana Reyes" href="/austin-tx/acme-plumbing?user=5&result_id=42">Dana Reyes</a></div>
          <a data-testid="react-connect-button" href="/biz/connection_requests/make_connection?business_id=42&result_id=42"><svg></svg>Connect</a></div></div></ul></div>`,
    );
    expect(click(doc, '[data-testid="react-connect-button"] svg')).toEqual({
      kind: 'friend_request',
      to: {
        name: 'Dana Reyes',
        profile: {
          id: '42',
          username: 'austin-tx-acme-plumbing',
          url: `${AL}/austin-tx/acme-plumbing`,
        },
      },
      group: null,
      postUrl: null,
      thread: null,
      replying: null,
    });
  });

  it('notes Connect on a business’s own page as to that business', () => {
    const doc = page(
      `${AL}/round-rock-tx/best-bakery`,
      `<section><a href="/forward_referral_card/43">Refer</a><h1 title="Sam Lee">Sam Lee</h1><h2 title="Best Bakery">Best Bakery</h2>
        <a id="connect" href="/biz/connection_requests/make_connection?business_id=43&request_source=profile"><div>Connect</div></a></section>`,
    );
    expect(click(doc, '#connect div')).toMatchObject({
      kind: 'friend_request',
      to: { name: 'Sam Lee', profile: { id: '43', url: `${AL}/round-rock-tx/best-bakery` } },
    });
  });

  it('notes a post’s Connect, and an answer’s, to whoever wrote each', () => {
    const doc = page(
      `${AL}/groups/austin-tx/need-a-roofer-91`,
      `<section>${POST}<div data-testid="discussion-comment"><a href="/round-rock-tx/best-bakery?user=6">Sam Lee</a><span>3h</span>
        <div data-testid="discussion-comment-body">We can help.</div><button>Reply</button><button id="answer-like">Like</button>
        <a id="answer-connect" href="/biz/connection_requests/make_connection?business_id=43&request_source=discussionpost_1">Connect</a></div></section>`,
    );
    expect(click(doc, '#connect div')).toMatchObject({
      to: { name: 'Dana Reyes', profile: { id: '42', username: 'austin-tx-acme-plumbing' } },
    });
    expect(click(doc, '#answer-connect')).toMatchObject({
      to: { name: 'Sam Lee', profile: { id: '43', username: 'round-rock-tx-best-bakery' } },
    });
  });

  it('notes nothing for a link that isn’t a Connect', () => {
    const doc = page(`${AL}/groups/austin-tx`, `<section>${POST}</section>`);
    expect(click(doc, 'a[href="/biz/discussions/91"]')).toBeNull();
  });
});

describe('noting a Like on Alignable', () => {
  it('notes a post’s Like to its author with its discussion, never its count', () => {
    const doc = page(`${AL}/groups/austin-tx`, `<section>${POST}</section>`);
    expect(click(doc, '#like div')).toMatchObject({
      kind: 'like',
      to: { name: 'Dana Reyes', profile: { username: 'austin-tx-acme-plumbing' } },
      postUrl: `${AL}/biz/discussions/91`,
    });
    // "3 Likes" opens who liked it.
    expect(click(doc, '#likes span')).toBeNull();
  });

  it('notes an answer’s Like to whoever wrote the answer', () => {
    const doc = page(
      `${AL}/groups/austin-tx/need-a-roofer-91`,
      `<section>${POST}<div data-testid="discussion-comment"><a href="/round-rock-tx/best-bakery?user=6">Sam Lee</a>
        <div data-testid="discussion-comment-body">We can help.</div><button id="answer-like">Like</button></div></section>`,
    );
    expect(click(doc, '#answer-like')).toMatchObject({
      kind: 'like',
      to: { name: 'Sam Lee', profile: { username: 'round-rock-tx-best-bakery' } },
    });
  });
});

describe('noting a forum answer on Alignable', () => {
  const discussion = (writing: string) =>
    page(
      `${AL}/groups/austin-tx/need-a-roofer-91`,
      `<section>${POST}
        <div data-testid="discussion-comment"><a href="/round-rock-tx/best-bakery?user=6">Sam Lee</a>
          <div data-testid="discussion-comment-body">We can help.</div>
          <form data-testid="discussion-comment-reply-form" id="reply"><textarea>${writing}</textarea><button>Send</button></form></div>
        <form data-testid="discussion-comment-reply-form" id="answer"><div contenteditable="true">${writing}</div>
          <button>Send</button></form></section>`,
    );

  it('notes Send in the question’s box as a comment to whoever asked, with its discussion', () => {
    expect(click(discussion('Call us any time.'), '#answer button')).toMatchObject({
      kind: 'comment',
      to: { name: 'Dana Reyes', profile: { username: 'austin-tx-acme-plumbing' } },
      postUrl: `${AL}/biz/discussions/91`,
    });
  });

  it('notes Send in a reply’s box as a comment to whoever wrote the answer', () => {
    expect(click(discussion('Thanks, Sam.'), '#reply button')).toMatchObject({
      kind: 'comment',
      to: { name: 'Sam Lee', profile: { username: 'round-rock-tx-best-bakery' } },
    });
  });

  it('notes nothing when nothing’s written', () => {
    expect(click(discussion(''), '#answer button')).toBeNull();
  });
});

describe('noting a message on Alignable', () => {
  const chat = (writing: string) =>
    page(
      `${AL}/biz/conversations?_fat=x&with_business_id=42`,
      `<div data-testid="inbox"><div data-testid="channel-header-loaded"><a href="/biz/businesses/42?user=5"><div>Dana Reyes</div></a></div>
        <div data-testid="full-view-write-message"><div contenteditable="true">${writing}</div>
          <button aria-label="Send" data-testid="messaging-send-external"><svg></svg></button></div></div>`,
    );

  it('notes Send in Messages to who the conversation is with, by their business’s id', () => {
    expect(
      click(
        chat('Hi Dana, want to refer each other?'),
        '[data-testid="messaging-send-external"] svg',
      ),
    ).toEqual({
      kind: 'message',
      to: {
        name: 'Dana Reyes',
        profile: { id: '42', username: null, url: `${AL}/biz/businesses/42` },
      },
      group: null,
      postUrl: null,
      thread: { id: '42', encrypted: false, url: `${AL}/biz/conversations?with_business_id=42` },
      replying: null,
    });
    expect(click(chat(''), '[data-testid="messaging-send-external"]')).toBeNull();
  });

  it('notes Send as Alignable draws it since 30 Oct 2026, in a conversation whose header has no test id', () => {
    const doc = page(
      `${AL}/biz/conversations?with_business_id=42`,
      `<div data-testid="inbox"><div><div><header><h3>Messages</h3></header></div>
        <div><header><div><img alt="" /><a href="/biz/businesses/42?user=5&cyfid=6"><div>Dana Reyes</div></a></div></header>
          <div><div></div><div data-testid="full-view-write-message"><div contenteditable="true">Hi Dana</div>
            <button data-testid="messaging-send-desktop" title="Send"><svg></svg></button></div></div></div></div></div>`,
    );
    expect(click(doc, '[data-testid="messaging-send-desktop"] svg')).toMatchObject({
      kind: 'message',
      to: { name: 'Dana Reyes', profile: { id: '42' } },
      thread: { id: '42', encrypted: false, url: `${AL}/biz/conversations?with_business_id=42` },
    });
  });

  it('notes Enter in its box only once the box empties', () => {
    const doc = chat('Hi Dana');
    const box = doc.querySelector('[contenteditable="true"]')!;
    const noticed = alignableNoticer().enter(box, doc, doc.location.href);
    expect(noticed).toMatchObject({ kind: 'maybe', step: { kind: 'message' } });
    if (noticed?.kind !== 'maybe') throw new Error('expected a maybe');
    expect(noticed.went()).toBe(false);
    box.textContent = '';
    expect(noticed.went()).toBe(true);
  });
});

describe('noting a recommendation on Alignable', () => {
  /** The page Recommend opens, for Pine Street Bakery (id 77), with something written or not. */
  const recommending = (written: string, heading = 'Recommend Pine Street Bakery') => {
    const doc = page(
      `${AL}/biz/recommendations/new?id=77`,
      `<main><h1>${heading}</h1><a href="/round-rock-tx/pine-street-bakery?user=9">Pine Street Bakery</a>
        <form><textarea aria-label="Your recommendation"></textarea>
          <button type="button" id="cancel">Cancel</button><button type="submit" id="send">Submit</button></form></main>`,
    );
    doc.querySelector('textarea')!.value = written;
    return doc;
  };

  it('notes Submit with something written as a recommendation of the business, by Alignable’s id', () => {
    const step = click(recommending('They fixed our oven the same day.'), '#send');
    expect(step).toEqual({
      kind: 'recommend',
      to: {
        name: 'Pine Street Bakery',
        profile: { id: '77', username: null, url: `${AL}/biz/businesses/77` },
      },
      group: null,
      postUrl: null,
      thread: null,
      replying: null,
    });
    expect(
      touchSave(step!, '00000000-0000-4000-8000-000000000001', null, 'alignable'),
    ).toMatchObject({ ok: true, input: { kind: 'recommend', platform: 'alignable' } });
  });

  it('names the business from its link when the heading doesn’t', () => {
    expect(click(recommending('Great work.', 'Write a review'), '#send')).toMatchObject({
      to: { name: 'Pine Street Bakery', profile: { id: '77' } },
    });
  });

  it('notes nothing with nothing written, for Cancel, or for Recommend’s link itself', () => {
    expect(click(recommending(''), '#send')).toBeNull();
    expect(click(recommending('Great work.'), '#cancel')).toBeNull();
    const profile = page(
      `${AL}/round-rock-tx/pine-street-bakery`,
      `<section><h1 title="Pine Street Bakery">Pine Street Bakery</h1>
        <a id="recommend" href="/biz/recommendations/new?id=77">Recommend</a></section>`,
    );
    expect(click(profile, '#recommend')).toBeNull();
  });
});

describe('what’s noted on Alignable, as HandsFreeOS takes it', () => {
  it('is a save on Alignable, by its business’s id and address', () => {
    const doc = page(`${AL}/groups/austin-tx`, `<section>${POST}</section>`);
    const step = click(doc, '#connect div')!;
    const built = touchSave(step, '00000000-0000-4000-8000-000000000001', null, 'alignable');
    expect(built).toMatchObject({
      ok: true,
      input: {
        platform: 'alignable',
        kind: 'friend_request',
        profile: {
          id: '42',
          username: 'austin-tx-acme-plumbing',
          url: `${AL}/austin-tx/acme-plumbing`,
        },
        name: 'Dana Reyes',
      },
    });
    // Alignable's kit notes them now.
    expect(
      alignable.noticer().click(doc.querySelector('#connect div')!, doc, doc.location.href),
    ).toMatchObject({
      kind: 'step',
    });
  });
});
