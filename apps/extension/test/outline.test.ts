import { describe, expect, it } from 'vitest';
import { maskText, Outliner, outlinePage } from '../src/facebook/outline';
import { readPage } from '../src/facebook/page';
import { load } from './load';

describe('maskText', () => {
  it('keeps Facebook’s words and hides what people wrote', () => {
    expect(maskText('Add friend')).toBe('Add friend');
    expect(maskText('12 mutual friends')).toBe('12 mutual friends');
    expect(maskText('Today at 10:12 AM')).toBe('Today at 10:12 AM');
    expect(maskText('Admins and moderators · 3')).toBe('Admins and moderators · 3');
    expect(maskText('Jane Doe')).toBe('[2 words]');
    expect(maskText('We use HubSpot right now.')).toBe('[5 words]');
    expect(maskText('34')).toBe('34');
    expect(maskText('1.2K')).toBe('1.2K');
    expect(maskText('5125550123')).toBe('[1 word]');
  });

  it('keeps the shape of Facebook’s phrases around a name', () => {
    expect(maskText('Messages in conversation with Sam Carter')).toBe(
      'Messages in conversation with [2 words]',
    );
    expect(maskText('Sam Carter replied to you')).toBe('[2 words] replied to you');
    expect(maskText('You: How do you like it so far?')).toBe('You: [7 words]');
    expect(maskText('Maria Lopez accepted your friend request.')).toBe(
      '[2 words] accepted your friend request[1 word]',
    );
    expect(maskText('Profile picture of Jane Doe')).toBe('Profile picture of [2 words]');
  });
});

describe('Outliner.maskLink', () => {
  it('keeps Facebook’s words in a link and numbers everything else, the same one the same way', () => {
    const outliner = new Outliner();
    const base = 'https://www.facebook.com/';
    expect(
      outliner.maskLink('/groups/123456789012345/user/100002222222222/?__cft__[0]=AZ', base),
    ).toBe('/groups/{1}/user/{2}/');
    expect(outliner.maskLink('/jane.doe.5/friends', base)).toBe('/{3}/friends');
    expect(outliner.maskLink('/profile.php?id=100002222222222&sk=about', base)).toBe(
      '/profile.php?id={2}&sk=about',
    );
    expect(outliner.maskLink('/Jane.Doe.5', base)).toBe('/{3}');
    expect(
      outliner.maskLink('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com', base),
    ).toBe('(another site)');
    expect(outliner.maskLink('#', base)).toBe('#');
  });
});

describe('outlinePage', () => {
  const url = 'https://www.facebook.com/messages/t/1234567890/';
  const doc = load('chat.html', url);
  const outline = outlinePage(doc, url, {
    version: '0.1.0',
    found: readPage(doc, url),
    window: { width: 1440, height: 900 },
  });

  it('says which page it was and what the readers found', () => {
    expect(outline.split('\n').slice(0, 4)).toEqual([
      'HandsFreeOS Social 0.1.0 · page outline',
      'Page: chat /messages/t/{1}/',
      'Found: 3 chats, 5 messages',
      'Window: 1440×900',
    ]);
  });

  it('keeps the page’s structure and Facebook’s labels', () => {
    expect(outline).toContain('role="grid" aria-label="Messages in conversation with [2 words]"');
    expect(outline).toContain('span "You sent"');
    expect(outline).toContain('span "[2 words] replied to you"');
    expect(outline).toContain('span "Today at 10:12 AM"');
    expect(outline).toContain('a role="link" href="/messages/e2ee/t/{2}/"');
    expect(outline).toContain('div role="button" aria-label="Start a voice call"');
  });

  it('leaves out every name, message and id', () => {
    for (const secret of [
      'Sam',
      'Carter',
      'Maria',
      'HubSpot',
      'expensive',
      'Tuesday',
      'sam.carter',
      '1234567890',
      '9876543210123',
      'scontent',
    ])
      expect(outline, secret).not.toContain(secret);
  });
});

describe('outlinePage, on the 2026 layouts', () => {
  const pages = [
    ['profile-2026.html', 'https://www.facebook.com/dana.reyes.12'],
    ['group-members-2026.html', 'https://www.facebook.com/groups/4455667788/members'],
    ['chat-2026.html', 'https://www.facebook.com/messages/t/100009000000002/'],
  ] as const;
  const outlines = Object.fromEntries(
    pages.map(([name, url]) => {
      const doc = load(name, url);
      return [name, outlinePage(doc, url, { version: '0.1.1', found: readPage(doc, url) })];
    }),
  );

  it('leaves out every name, bio, birthday, message and id', () => {
    for (const [name, outline] of Object.entries(outlines))
      for (const secret of [
        'Dana',
        'Reyes',
        'Westfield',
        'danasdesigns',
        'Craft fair',
        'June 14',
        'Rosa',
        'Chris Gee',
        'Sam Carter',
        'Pacific',
        'yeah that works',
        'dana.reyes',
        '4455667788',
        '100009000000002',
      ])
        expect(outline, `${name}: ${secret}`).not.toContain(secret);
  });

  it('keeps the page’s title, dates and Facebook’s words around them as shapes', () => {
    const profile = outlines['profile-2026.html']!;
    expect(profile).toContain('Title: (3) [2 words] | Facebook');
    expect(profile).toContain('span "(a date)"');
    expect(profile).toContain('"mutual"');
    const group = outlines['group-members-2026.html']!;
    expect(group).toContain('div role="button" aria-label="Follow [2 words]"');
    expect(group).toContain('div "Joined 7 minutes ago"');
    expect(group).toContain('"2,761 people follow this"');
    expect(outlines['chat-2026.html']).toContain('"[1 word]" "[7 words]" "You" "[4 words]"');
  });
});
