/**
 * Events near the person on Alignable (decision 112, 0.104.0): an event's own address from a link to it, the events a
 * town's page lists, and an event's page read for who's hosting and who's going. From Alignable's usual markup,
 * written here by hand with made-up businesses, till the owner's next Check Alignable outlines an events page.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { eventCards, eventOf, eventPage, readAlignable } from '../src/networks/alignable/read';

const AL = 'https://www.alignable.com';
const page = (url: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;
const at = (path: string) => eventOf(new URL(`${AL}${path}`));

describe('an event’s own address', () => {
  it('is the event’s, in a town, a group or the site’s own, whatever comes after it', () => {
    expect(at('/austin-tx/events/101-spring-mixer?ref=feed')).toBe(
      `${AL}/austin-tx/events/101-spring-mixer`,
    );
    expect(at('/austin-tx/events/101-spring-mixer/attendees')).toBe(
      `${AL}/austin-tx/events/101-spring-mixer`,
    );
    expect(at('/groups/home-pros-network/events/77')).toBe(
      `${AL}/groups/home-pros-network/events/77`,
    );
    expect(at('/events/88')).toBe(`${AL}/events/88`);
    expect(at('/biz/events/99')).toBe(`${AL}/biz/events/99`);
  });

  it('is never a page of events, a business, or another site’s', () => {
    expect(at('/austin-tx/events')).toBeNull();
    expect(at('/austin-tx/events/upcoming')).toBeNull();
    expect(at('/events/search')).toBeNull();
    expect(at('/austin-tx/acme-roofing')).toBeNull();
    expect(at('/austin-tx/acme-roofing/events/1')).toBeNull();
    expect(eventOf(new URL('https://example.com/events/1'))).toBeNull();
  });
});

describe('a town’s events', () => {
  it('lists each event once, by its heading, with the line under it, never the menu’s', () => {
    const doc = page(
      `${AL}/austin-tx/events`,
      `<nav><a href="/events/1">Featured event</a></nav><main><h1>Events in Austin, TX</h1>
        <div><h3><a href="/austin-tx/events/101-spring-mixer">Spring Business Mixer</a></h3>
          <span>Thu, Nov 6 · 5:30 PM</span><a href="/austin-tx/events/101-spring-mixer">RSVP</a></div>
        <div><a href="/austin-tx/events/102-coffee">View event</a><a href="/austin-tx/events/102-coffee">Coffee Connect</a>
          <span>Fri, Nov 7</span></div></main>`,
    );
    expect(eventCards(doc, doc.location.href)).toEqual([
      {
        url: `${AL}/austin-tx/events/101-spring-mixer`,
        name: 'Spring Business Mixer',
        detail: 'Thu, Nov 6 · 5:30 PM',
      },
      { url: `${AL}/austin-tx/events/102-coffee`, name: 'Coffee Connect', detail: 'Fri, Nov 7' },
    ]);
    expect(readAlignable(doc, doc.location.href).events).toHaveLength(2);
    // Anywhere else, no events are read.
    const town = page(`${AL}/austin-tx`, doc.body.innerHTML);
    expect(readAlignable(town, town.location.href)).not.toHaveProperty('events');
  });
});

describe('an event’s page', () => {
  it('reads who’s hosting and who’s going, and nobody beside it', () => {
    const doc = page(
      `${AL}/austin-tx/events/101-spring-mixer`,
      `<main><h1>Spring Business Mixer</h1><button>RSVP</button>
        <div><span>Host</span><a href="/austin-tx/cole-bakery/morgan-cole">Morgan Cole</a>
          <a href="/austin-tx/cole-bakery">Cole Bakery</a></div>
        <h2>Attendees (2)</h2>
        <div><a href="/austin-tx/pine-painting/jamie-pine">Jamie Pine</a><a href="/austin-tx/pine-painting">Pine Painting</a>
          <span>Painter</span><button>Connect</button></div>
        <div><a href="/biz/businesses/5150?user=3">Sam Vale</a><span>Vale Books</span></div>
        <h2>People you may know</h2>
        <div><a href="/austin-tx/hill-realty/hana-hill">Hana Hill</a></div></main>`,
    );
    const read = eventPage(doc, doc.location.href);
    expect(read).toMatchObject({
      url: `${AL}/austin-tx/events/101-spring-mixer`,
      name: 'Spring Business Mixer',
      hosts: [{ name: 'Morgan Cole', business: 'Cole Bakery', lines: [] }],
      guests: [
        { name: 'Jamie Pine', business: 'Pine Painting', lines: ['Painter'] },
        { name: 'Sam Vale', profile: { id: '5150' } },
      ],
    });
    expect(readAlignable(doc, doc.location.href).event?.guests).toHaveLength(2);
  });
});
