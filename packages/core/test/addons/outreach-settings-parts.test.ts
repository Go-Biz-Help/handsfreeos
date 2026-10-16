/**
 * Social Outreach's Settings, a page for each part (./src/addons/outreach/settings-parts.ts): General first, then each
 * network, then Your computer and Start fresh; an address naming an old part or none opens General.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_KEYS } from '../../src/addons/outreach/networks';
import {
  isNetworkPart,
  NEXT_NETWORKS,
  SETTINGS_PART_KEYS,
  settingsPartOf,
} from '../../src/addons/outreach/settings-parts';

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
});
