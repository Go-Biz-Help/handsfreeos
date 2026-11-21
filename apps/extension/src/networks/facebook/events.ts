/**
 * Facebook's events (docs/outreach.md decision 188): the events its event search lists (/search/events/?q=…), and an
 * event's own page (/events/<number>/). Nothing is pressed on either: no Going, Interested, Invite or Share, and no See
 * all on its guests.
 *
 * - **A search's events:** each event once, by its own page, with its name (a link to it) and what its card says of
 *   when and where: the day's line ("THU, DEC 4 AT 7:30 AM CST"), and the line after its name.
 * - **An event's page:** its name (its heading, else the page's title), when (its day's line), where (the line after its
 *   name), who hosts it (the links in its "Event by …" line, and those under Meet your hosts) and who's going (the
 *   faces under its Guests, as far as the page shows them).
 *
 * The readers are guesses till the owner's next Check Facebook outlines an event search and an event (../../jobs/
 * checkup.ts): the job that reads them (../../jobs/events.ts) notes a page that showed no events, or an event that
 * showed nobody, with its outline so they can be tuned.
 */
import { calmCase, isWhenLine, startsAtOf } from '../event-when';
import { clean, collectLinked, inTopBar, isHeading, namesOn, textLines } from './dom';
import { bestName } from './people';
import type { EventCard, EventGoer, EventPage } from './types';
import { eventFromUrl, facebookUrl, profileFromUrl, profileKey } from './urls';

/** The most events read from one search's page, and the most hosts and guests kept from one event's. */
const CARDS_MOST = 30;
const HOSTS_MOST = 10;
const GUESTS_MOST = 40;
const NAME_MOST = 200;
const PLACE_MOST = 200;

/** The words on an event's buttons and labels: never its name or its place. */
const CONTROLS =
  /^(interested|going|not going|maybe|can['’]t go|invite|share|more|see more|see all|save|join|details|about|discussion|guests|meet your hosts?|event by\b.*|hosted by\b.*|(public|private|friends)( · .*)?|only people who are invited|anyone on or off facebook|online event details|duration:.*|tickets?(:.*)?|find tickets|price:.*|edit|respond|reply|follow|message|(suggested|upcoming|related|more|popular) events|events|·)$/i;
/** How many are going, interested or responded: "32 interested · 5 going", "120 people responded". */
const COUNTS =
  /^\d[\d,.]*\s*[km]?\s+(people\s+)?(interested|going|responded|went|guests?|invited|maybe)\b/i;

const isControl = (line: string) => CONTROLS.test(line) || COUNTS.test(line);

const cut = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text;

/** The day's line among some lines, in everyday capitals, and when it starts. */
function whenIn(
  lines: readonly string[],
  now: Date,
): { when: string | null; startsAt: string | null } {
  const line = lines.find(isWhenLine) ?? null;
  return line
    ? { when: calmCase(line), startsAt: startsAtOf(line, now) }
    : { when: null, startsAt: null };
}

/** Where: the line after the event's name that isn't its day, a button or a count. */
function placeAfter(lines: readonly string[], name: string): string | null {
  const at = lines.findIndex((line) => line === name);
  if (at < 0) return null;
  for (const line of lines.slice(at + 1, at + 4)) {
    if (isWhenLine(line) || isControl(line) || line === name) continue;
    return line.length <= PLACE_MOST ? line : null;
  }
  return null;
}

/** An event's name among some words: not its day, a button or a count. */
const nameLike = (text: string) =>
  text.length > 0 &&
  text.length <= 300 &&
  !isWhenLine(text) &&
  !isControl(text) &&
  !/^facebook$/i.test(text);

/** The events an event search lists, each once by its own page, in the page's order. */
export function readEventCards(root: Element, base: string, now: Date = new Date()): EventCard[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const event = eventFromUrl(url);
      return event ? { key: event, value: event } : null;
    },
    { skip: inTopBar },
  );
  const cards: EventCard[] = [];
  for (const entry of linked) {
    const lines = textLines(entry.card, 20);
    const named =
      entry.anchors.map((a) => clean(a.textContent)).find(nameLike) ??
      entry.anchors.map((a) => clean(a.getAttribute('aria-label'))).find(nameLike) ??
      lines.find(nameLike);
    if (!named) continue;
    const name = cut(named, NAME_MOST);
    cards.push({ url: entry.value, name, ...whenIn(lines, now), place: placeAfter(lines, named) });
    if (cards.length >= CARDS_MOST) break;
  }
  return cards;
}

/** The part of an event's page a heading starts: its hosts, its guests, or another. */
function partOf(element: Element): string | null {
  if (!isHeading(element)) return null;
  const text = clean(element.textContent)
    .replace(/\s*see all$/i, '')
    .replace(/\s*[·•]\s*[\d,]+$/, '');
  if (/^meet (your|the) hosts?$/i.test(text)) return 'hosts';
  if (/^(guests|going|who['’]s going|people going|attendees|guest list)$/i.test(text))
    return 'guests';
  return 'other';
}

const HOSTED = /^(event by|hosted by)\b/i;
/** Text only, as Node.SHOW_TEXT. */
const SHOW_TEXT = 4;

/**
 * The event's hosts' lines: from each piece of text that starts "Event by" or "Hosted by", the smallest box around it
 * that links to someone, while its words still start so.
 */
function hostLines(root: Element): Element[] {
  const found = new Set<Element>();
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!HOSTED.test(clean(node.nodeValue))) continue;
    for (
      let box = node.parentElement, steps = 0;
      box && box !== root && steps < 6;
      box = box.parentElement, steps++
    ) {
      const text = clean(box.textContent);
      if (!HOSTED.test(text) || text.length > 300) break;
      if (!box.querySelector('a[href]')) continue;
      if (!inTopBar(box)) found.add(box);
      break;
    }
  }
  return [...found];
}

/** The people some links lead to, each once, with the name a link to them shows. */
function goersIn(anchors: readonly Element[], base: string): EventGoer[] {
  const found = new Map<string, EventGoer>();
  for (const anchor of anchors) {
    const url = facebookUrl(anchor.getAttribute('href') ?? '', base);
    const profile = url ? profileFromUrl(url) : null;
    if (!profile || found.has(profileKey(profile))) continue;
    const name = bestName(namesOn([anchor]));
    if (name) found.set(profileKey(profile), { name, profile });
  }
  return [...found.values()];
}

/** The event's name: its page's main heading, else the page's title ("Spring Mixer | Facebook"), else another heading. */
function nameOf(root: Element, title: string): string | null {
  const headings = [...root.querySelectorAll('h1, h2, h3, [role="heading"]')].filter(
    (h) => !inTopBar(h),
  );
  const tops = headings.filter((h) => h.tagName === 'H1').map((h) => clean(h.textContent));
  const titled = clean(title.replace(/^\(\d+\)\s*/, '').replace(/\s*[|·-]\s*Facebook$/i, ''));
  const others = headings.filter((h) => partOf(h) === 'other').map((h) => clean(h.textContent));
  return [...tops, titled, ...others].find(nameLike) ?? null;
}

/**
 * An event's own page: what it is, when and where, who hosts it and who's going as far as the page shows. Its address
 * says which event; nothing on the page is pressed.
 */
export function readEventPage(
  root: Element,
  base: string,
  title: string,
  now: Date = new Date(),
): EventPage | null {
  const here = facebookUrl(base);
  const url = here ? eventFromUrl(here) : null;
  if (!url) return null;
  const lines = textLines(root, 300);
  const named = nameOf(root, title);
  const people = collectLinked(
    root,
    base,
    (link) => {
      const profile = profileFromUrl(link);
      return profile ? { key: profileKey(profile), value: profile } : null;
    },
    { skip: inTopBar, sectionOf: partOf },
  );
  const hosts = new Map<string, EventGoer>();
  for (const line of hostLines(root))
    for (const goer of goersIn([...line.querySelectorAll('a[href]')], base))
      hosts.set(profileKey(goer.profile), goer);
  const guests = new Map<string, EventGoer>();
  for (const entry of people) {
    if (entry.section !== 'hosts' && entry.section !== 'guests') continue;
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    const key = profileKey(entry.value);
    if (entry.section === 'hosts') hosts.set(key, hosts.get(key) ?? { name, profile: entry.value });
    else if (!hosts.has(key)) guests.set(key, { name, profile: entry.value });
  }
  return {
    url,
    name: named ? cut(named, NAME_MOST) : '',
    ...whenIn(lines, now),
    place: named ? placeAfter(lines, named) : null,
    hosts: [...hosts.values()].slice(0, HOSTS_MOST),
    guests: [...guests.values()]
      .filter((g) => !hosts.has(profileKey(g.profile)))
      .slice(0, GUESTS_MOST),
  };
}
