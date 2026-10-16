/**
 * Social Outreach's Settings, a page for each part (./src/addons/outreach/settings-parts.ts): General first, then each
 * network, then Your computer and Start fresh; an address naming an old part or none opens General. A network's page
 * shows the person's limits there as they stand, from the business's own and the network's kit.
 */
import { describe, expect, it } from 'vitest';
import { NO_RULES } from '../../src/addons/outreach/automation';
import { NETWORK_WORDS } from '../../src/addons/outreach/network-words';
import { PLATFORM_KEYS } from '../../src/addons/outreach/networks';
import {
  isNetworkPart,
  limitsShownOn,
  NEXT_NETWORKS,
  SETTINGS_PART_KEYS,
  settingsPartOf,
} from '../../src/addons/outreach/settings-parts';

/** A network's limits as its page shows them: each one's name and how many, with the line under it. */
const shown = (...args: Parameters<typeof limitsShownOn>) =>
  limitsShownOn(...args).map((l) => [l.label, l.most, l.note]);

describe('Settings, a page for each part', () => {
  it('lists General, then every network, then Your computer and Start fresh', () => {
    expect(SETTINGS_PART_KEYS).toEqual(['general', ...PLATFORM_KEYS, 'computer', 'fresh']);
    expect(SETTINGS_PART_KEYS.filter(isNetworkPart)).toEqual(PLATFORM_KEYS);
  });

  it('opens the part an address names, and General for an old part or none', () => {
    expect(settingsPartOf('linkedin')).toBe('linkedin');
    expect(settingsPartOf('computer')).toBe('computer');
    for (const old of ['mine', 'business', null, undefined, '', 'nope']) {
      expect(settingsPartOf(old)).toBe('general');
    }
  });

  it('never lists a network still to come as one of its own', () => {
    for (const name of NEXT_NETWORKS) {
      expect(SETTINGS_PART_KEYS).not.toContain(name.toLowerCase());
    }
  });

  it('shows LinkedIn’s limits a day with its cap in any 7 days, and the kit’s others', () => {
    expect(shown('linkedin', NO_RULES, false)).toEqual([
      ['Invitations to connect', 15, 'At most 80 in any 7 days'],
      ['First messages', 15, null],
      ['Follow-ups', 20, null],
      ['Comments', 10, null],
      ['Likes', 30, null],
      ['Profiles read', 40, null],
      ['Helpful post', 1, null],
      ['Invitations withdrawn', 20, null],
    ]);
  });

  it('takes the business’s own limits on that network, and halves them on training wheels', () => {
    const rules = { dailyLimits: { friend_request: 4 }, networkLimits: { linkedin: { like: 0 } } };
    expect(shown('linkedin', rules, true).slice(0, 5)).toEqual([
      ['Invitations to connect', 7, 'At most 80 in any 7 days'],
      ['First messages', 7, null],
      ['Follow-ups', 10, null],
      ['Comments', 5, null],
      // Set to none by the business, it stays none.
      ['Likes', 0, null],
    ]);
    expect(shown('facebook', rules, true)).toEqual([
      ['Friend requests', 2, null],
      ['First messages', 7, null],
      ['Follow-ups', 10, null],
      ['Comments', 7, null],
      ['Likes', 20, null],
      ['Profiles read', 40, null],
      ['Helpful post', 1, null],
      ['Requests cancelled', 15, null],
      ['Friends unfriended', 10, null],
    ]);
  });

  it('points someone a network isn’t allowed for to its own page', () => {
    expect(NETWORK_WORDS.notAllowed('LinkedIn', true)).toContain(
      'Turn on “Your team may use LinkedIn” below',
    );
    expect(NETWORK_WORDS.notAllowed('LinkedIn', false)).toContain(
      'Social Outreach → Settings → LinkedIn.',
    );
  });
});
