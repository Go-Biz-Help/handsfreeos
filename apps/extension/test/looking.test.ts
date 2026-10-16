/**
 * What the content script reads as the person goes, in the Facebook tab in front of them (src/networks/facebook/looking.ts,
 * src/hfos/looked.ts; docs/outreach.md decision 43), now the side panel doesn't read beside them: warnings always,
 * and a chat or a group's posts only while noting and the person's switch for them are on.
 */
import { describe, expect, it } from 'vitest';
import { lookFor, type LookingSwitches } from '../src/networks/facebook/looking';
import { isLooked } from '../src/hfos/looked';

const on: LookingSwitches = { noting: true, readChats: true, markPosts: true };

describe('what it reads as the person goes', () => {
  it('reads a chat with Read chats I open on, and a group with Look for posts as I scroll on', () => {
    expect(lookFor('chat', on)).toBe('page');
    expect(lookFor('group', on)).toBe('page');
    expect(lookFor('chat', { ...on, readChats: false })).toBe('warnings');
    expect(lookFor('group', { ...on, markPosts: false })).toBe('warnings');
  });

  it('reads only warnings anywhere else, and with noting off', () => {
    expect(lookFor('profile', on)).toBe('warnings');
    expect(lookFor('feed', on)).toBe('warnings');
    expect(lookFor('chats', on)).toBe('warnings');
    expect(lookFor('chat', { ...on, noting: false })).toBe('warnings');
    expect(lookFor('group', { ...on, noting: false })).toBe('warnings');
  });

  it('takes only a note shaped as the content script sends it', () => {
    const note = {
      type: 'hfos-looked',
      url: 'https://www.facebook.com/',
      warnings: [],
      result: null,
    };
    expect(isLooked(note)).toBe(true);
    expect(isLooked({ ...note, warnings: ['You’re temporarily blocked'] })).toBe(true);
    expect(isLooked({ ...note, warnings: [3] })).toBe(false);
    expect(isLooked({ ...note, url: undefined })).toBe(false);
    expect(isLooked({ ...note, type: 'hfos-noted' })).toBe(false);
    expect(isLooked(null)).toBe(false);
  });
});
