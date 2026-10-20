/**
 * The kinds and their gates (search/kinds.ts), with no database: each searcher has exactly one entry in
 * `SEARCH_KINDS`, which holds its gate, and every kind the server searches has a searcher.
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROLES, hasWorkspacePermission } from '../../src/permissions';
import { SEARCHERS } from '../../src/search/server/kinds/index';
import {
  kindRank,
  SEARCH_KINDS,
  searchKindsFor,
  searcherKeyOf,
  SERVER_SEARCH_KINDS,
} from '../../src/search/kinds';

describe('the kinds and their searchers', () => {
  it('ties every searcher to exactly one kind, and every server kind to a searcher', () => {
    for (const s of SEARCHERS)
      expect(
        SEARCH_KINDS.filter((k) => k.key === s.key),
        s.key,
      ).toHaveLength(1);
    for (const k of SERVER_SEARCH_KINDS)
      expect(
        SEARCHERS.filter((s) => s.key === k.key),
        k.key,
      ).toHaveLength(1);
    expect(new Set(SEARCH_KINDS.map((k) => k.key)).size).toBe(SEARCH_KINDS.length);
  });

  it('gives each kind a permission a role can hold', () => {
    for (const k of SEARCH_KINDS)
      expect(
        WORKSPACE_ROLES.some((r) => hasWorkspacePermission(r, k.needs)),
        k.key,
      ).toBe(true);
  });

  it('keeps the gates the plan names', () => {
    const needs = Object.fromEntries(SEARCH_KINDS.map((k) => [k.key, k.needs]));
    expect(needs).toMatchObject({
      contacts: 'records.read',
      companies: 'records.read',
      leads: 'records.read',
      money: 'money.read',
      messages: 'inbox.use',
      calendar: 'workspace.read',
      tasks: 'records.read',
      notes: 'records.read',
      files: 'records.read',
      forms: 'workspace.read',
      knowledge: 'workspace.read',
      records: 'records.read',
      spam: 'inbox.use',
      bin: 'records.delete',
      close: 'records.read',
    });
  });

  it('searches Spam only when it’s picked, never as a chip, and windows the long text', () => {
    const spam = SEARCH_KINDS.find((k) => k.key === 'spam')!;
    expect(spam).toMatchObject({ picked: true, chip: false, windowed: true });
    expect(SEARCH_KINDS.filter((k) => k.picked).map((k) => k.key)).toEqual(['spam']);
    expect(SEARCH_KINDS.filter((k) => k.windowed).map((k) => k.key)).toEqual([
      'messages',
      'notes',
      'forms',
      'spam',
    ]);
    // What the phone searches with no signal (decision 11).
    expect(SEARCH_KINDS.filter((k) => k.offline).map((k) => k.key)).toEqual([
      'contacts',
      'companies',
      'leads',
      'calendar',
      'tasks',
      'notes',
      'forms',
      'settings',
      'close',
    ]);
  });

  it('lists only the kinds a person may search, and every kind under a staff view-as', () => {
    const member = searchKindsFor({ permissions: ['workspace.read', 'records.read'] }).map(
      (k) => k.key,
    );
    expect(member).toEqual([
      'contacts',
      'companies',
      'leads',
      'calendar',
      'tasks',
      'notes',
      'files',
      'forms',
      'knowledge',
      'records',
      'settings',
      'close',
    ]);
    expect(searchKindsFor({ permissions: [], viewAs: true })).toHaveLength(SEARCH_KINDS.length);
  });

  it('puts a business’s own kinds in their slot, add-ons’ after, and reads a record kind’s searcher', () => {
    expect(kindRank('contacts')).toBeLessThan(kindRank('knowledge'));
    expect(kindRank('knowledge')).toBeLessThan(kindRank('record.pets'));
    expect(kindRank('record.pets')).toBeLessThan(kindRank('realestate.listings'));
    expect(kindRank('realestate.listings')).toBeLessThan(kindRank('settings'));
    expect(searcherKeyOf('record.pets')).toBe('records');
    expect(searcherKeyOf('contacts')).toBe('contacts');
  });
});
