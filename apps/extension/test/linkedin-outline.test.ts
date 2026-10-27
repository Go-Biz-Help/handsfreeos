/**
 * The page outline on LinkedIn (src/networks/linkedin/outline.ts), as ./outline.test.ts does Facebook's: it keeps the
 * page's shape, LinkedIn's own words and the words in its addresses, and never holds a name, a headline, a message, a
 * post or an id from any LinkedIn test page.
 */
import { describe, expect, it, vi } from 'vitest';
import { linkedin } from '../src/networks';
import { maskText } from '../src/networks/linkedin/outline';
import { load } from './load';

const LI = 'https://www.linkedin.com';
const PAGES = [
  ['linkedin-profile.html', `${LI}/in/dana-reyes-4b2a1c/`],
  ['linkedin-own-profile.html', `${LI}/in/me/`],
  ['linkedin-connections.html', `${LI}/mynetwork/invite-connect/connections/`],
  ['linkedin-invitations.html', `${LI}/mynetwork/invitation-manager/received/`],
  ['linkedin-invitations-sent.html', `${LI}/mynetwork/invitation-manager/sent/`],
  ['linkedin-search-people.html', `${LI}/search/results/people/?keywords=plumber`],
  ['linkedin-feed.html', `${LI}/feed/`],
  ['linkedin-post-commenting.html', `${LI}/feed/update/urn:li:activity:7380000000000000101/`],
  ['linkedin-chat.html', `${LI}/messaging/thread/2-MadeUpThreadDana0001==/`],
  ['linkedin-chat-window.html', `${LI}/feed/`],
  ['linkedin-notifications.html', `${LI}/notifications/`],
  ['linkedin-invite-box.html', `${LI}/in/dana-reyes-4b2a1c/`],
  ['linkedin-own-profile-full.html', `${LI}/in/chris-gee-12/`],
  ['linkedin-edit-intro.html', `${LI}/in/chris-gee-12/edit/intro/`],
  ['linkedin-withdraw-invitation.html', `${LI}/mynetwork/invitation-manager/sent/`],
  ['linkedin-company.html', `${LI}/company/acme-plumbing-atx/about/`],
  ['linkedin-activity.html', `${LI}/in/dana-reyes-4b2a1c/recent-activity/all/`],
  ['linkedin-own-post.html', `${LI}/feed/update/urn:li:activity:7380000000000000500/`],
  ['linkedin-share-box.html', `${LI}/feed/`],
  ['linkedin-reactions.html', `${LI}/feed/update/urn:li:activity:7380000000000000500/`],
  ['linkedin-data.html', `${LI}/mypreferences/d/download-my-data`],
  ['linkedin-data-ready.html', `${LI}/mypreferences/d/download-my-data`],
  ['linkedin-feed-2026-10.html', `${LI}/feed/`],
  ['linkedin-own-profile-2026-10.html', `${LI}/in/chris-gee-12/?isSelfProfile=true`],
  ['linkedin-post-2026-10.html', `${LI}/feed/update/urn:li:activity:7380000000000000777/`],
  ['linkedin-reactions-2026-10.html', `${LI}/feed/update/urn:li:activity:7380000000000000777/`],
] as const;

const outlines = Object.fromEntries(
  PAGES.map(([name, url]) => {
    const doc = load(name, url);
    return [
      name,
      linkedin.outline(doc, url, {
        version: '0.34.0',
        found: linkedin.readPage(doc, url),
        window: { width: 1440, height: 900 },
      }),
    ];
  }),
);

describe('the outline of a LinkedIn page', () => {
  it('says which page it was and what the readers found', () => {
    expect(outlines['linkedin-chat.html']!.split('\n').slice(0, 5)).toEqual([
      'HandsFreeOS Social 0.34.0 · page outline',
      'Page: chat /messaging/thread/{1}/',
      'Title: (1) Messaging | LinkedIn',
      'Found: 3 chats, 6 messages',
      'Window: 1440×900',
    ]);
    expect(outlines['linkedin-profile.html']).toContain('Title: (2) [2 words] | LinkedIn');
  });

  it('keeps LinkedIn’s words, and its phrases around a name as shapes', () => {
    expect(maskText('Invite Dana Reyes to connect')).toBe('Invite [2 words] to connect');
    expect(maskText('Accept Jordan Blake’s invitation')).toBe('Accept [2 words]’s invitation');
    expect(maskText('React Like to Sam Lee’s comment')).toBe('React Like to [2 words]’s comment');
    expect(maskText('Dana Reyes sent the following messages at 2:15 PM')).toBe(
      '[2 words] sent the following messages at [2 words]',
    );
    expect(maskText('Sam Lee and 11 other mutual connections')).toBe(
      '[2 words] and 11 other mutual connections',
    );
    expect(maskText('You: Thanks Sam, talk soon')).toBe('You: [4 words]');
    expect(maskText('Send without a note')).toBe('Send without a note');
    expect(maskText('500+ connections')).toBe('500+ connections');
    const post = outlines['linkedin-post-commenting.html']!;
    expect(post).toContain('aria-label="React Like" aria-pressed="false"');
    expect(post).toContain('aria-placeholder="Add a comment…"');
    expect(post).toContain('Page: post /feed/update/urn:li:activity:{');
    expect(post).toContain('data-urn="urn:li:activity:{');
    expect(post).toContain('span aria-hidden="true" "3h •"');
    expect(outlines['linkedin-invite-box.html']).toContain('"Add a note to your invitation?"');
    // Someone else's post in the newer layout (decision 92): its "Load more comments" kept as words, and the box of
    // who reacted with its Dismiss.
    expect(outlines['linkedin-post-2026-10.html']).toContain('p "Load more comments"');
    expect(outlines['linkedin-reactions-2026-10.html']).toContain('aria-label="Dismiss"');
  });

  it('keeps LinkedIn’s words on Get a copy of your data, so a step it couldn’t find can be named', () => {
    const data = outlines['linkedin-data.html']!;
    for (const words of ['Request archive', 'Connections', 'Invitations', 'Messages'])
      expect(data).toContain(words);
    expect(data).toContain('Page: other /mypreferences/d/download-my-data');
    expect(outlines['linkedin-data-ready.html']).toContain('Download archive');
  });

  it('shows what LinkedIn draws in its interop box and frame, kept closed or not, as hidden as the rest', () => {
    // The owner's Check LinkedIn of 17 Oct 2026: Message opened nothing the outline could show.
    const url = `${LI}/in/dana-reyes-4b2a1c/`;
    const doc = load('linkedin-profile.html', url);
    const host = doc.createElement('div');
    host.setAttribute('data-testid', 'interop-shadowdom');
    const frame = doc.createElement('iframe');
    frame.setAttribute('data-testid', 'interop-iframe');
    doc.body.append(host, frame);
    const inside = host.attachShadow({ mode: 'closed' });
    inside.innerHTML =
      '<aside aria-label="Messaging"><h2><a href="/in/dana-reyes-4b2a1c/">Dana Reyes</a></h2>' +
      '<form><div role="textbox" contenteditable="true"></div><button type="submit">Send</button></form></aside>';
    frame.contentDocument!.body.innerHTML = '<div role="dialog"><p>Dana Reyes wrote</p></div>';
    vi.stubGlobal('chrome', {
      dom: { openOrClosedShadowRoot: (element: Element) => (element === host ? inside : null) },
    });
    try {
      const outline = linkedin.outline(doc, url);
      expect(outline).toMatch(
        /div data-testid="interop-shadowdom"\n\s+#shadow-root\n\s+aside aria-label="Messaging"/,
      );
      expect(outline).toMatch(/div role="textbox" contenteditable="true"\n\s+button type="submit"/);
      expect(outline).toMatch(
        /iframe data-testid="interop-iframe"\n\s+#document\n\s+div role="dialog"/,
      );
      expect(outline).not.toMatch(/Dana|Reyes|dana-reyes/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves out the top bar, which is about the person', () => {
    expect(outlines['linkedin-feed.html']).toContain("(LinkedIn's top bar, left out)");
  });

  it('leaves out every name, headline, message, post and id', () => {
    for (const [name, outline] of Object.entries(outlines))
      for (const secret of [
        'Dana',
        'Reyes',
        'Sam Lee',
        'Avery',
        'Jordan',
        'Taylor',
        'Quinn',
        'Morgan',
        'Chris Gee',
        'Gee Consulting',
        'roofer',
        'Hill Country',
        'geeconsulting',
        'acmeplumbing',
        'Family-run',
        'father',
        'new van',
        'Acme',
        'Plumbing',
        'Austin',
        'water heater',
        'Tuesday',
        'commercial',
        'Landscap',
        'ACoAA',
        'MadeUpThread',
        'dana-reyes',
        'sam-lee',
        '7380000000000000101',
        'plumber',
        'Riley',
        'shut-off',
        'Lee Heating',
        'chris-gee',
        '7380000000000000500',
        // Decision 92's: someone else's post in the newer layout, and who reacted to it.
        'Priya',
        'Dalton',
        'Hector',
        'Jade Moreno',
        'Bianca',
        'Marcus Webb',
        'Holt Family',
        'Riverbend',
        'San Marcos',
        'cleaning crew',
        'Hopkins',
        'priya-dalton',
        '7380000000000000777',
      ])
        expect(outline, `${name}: ${secret}`).not.toContain(secret);
  });
});
