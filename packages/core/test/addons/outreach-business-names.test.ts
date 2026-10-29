/**
 * How messages talk about a business (docs/outreach.md, decision 124; the owner, 29 Oct 2026: a whole business name in
 * every message reads like a robot): what it does in plain words, a name at most once in a chat, never a handle. Every
 * draft on every network, and the samples and rewrites in Your messages, carry it.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_REWRITE_SYSTEM,
  MESSAGE_SAMPLES_SYSTEM,
} from '../../src/addons/outreach/conversation';
import { PLATFORMS, type Platform } from '../../src/addons/outreach/networks';
import { todayDraftSystem } from '../../src/addons/outreach/today';
import { BUSINESS_NAMES } from '../../src/addons/outreach/voice';

const EVERY = Object.keys(PLATFORMS) as Platform[];

describe('business names', () => {
  it('says plain words, a name at most once in a chat, and never a handle', () => {
    expect(BUSINESS_NAMES).toMatch(/not by its name/);
    expect(BUSINESS_NAMES).toMatch(/at most once in a whole chat/);
    expect(BUSINESS_NAMES).toMatch(/never copy a handle or a name run together/);
    expect(BUSINESS_NAMES).toMatch(/"I" or "we" for the owner’s own/);
  });

  it.each(EVERY)('is in every draft on %s', (platform) => {
    expect(todayDraftSystem(platform).split('\n')).toContain(BUSINESS_NAMES);
  });

  it('is in the sample messages and their rewrites', () => {
    for (const system of [MESSAGE_SAMPLES_SYSTEM, MESSAGE_REWRITE_SYSTEM])
      expect(system.split('\n')).toContain(BUSINESS_NAMES);
  });
});
