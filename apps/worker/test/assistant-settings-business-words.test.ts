/**
 * How get_settings says the business's own parts, without a database: Your page with the link Copy the link copies,
 * the Deleted bin as its screen lists it, and who can see a part the person asking can't.
 */
import { BIN_WORDS, BUSINESS_PAGE_SETTINGS_WORDS } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { binRead, whoSees, yourPageRead } from '../src/assistant/tools-settings';

const CHI = 'America/Chicago';

describe('Your page, as Settings → Workspace shows it', () => {
  const site = { slug: 'settings-hvac', path: '/book/settings-hvac', page: true };

  it('is off, and says where it goes on, until Show your page is on', () => {
    expect(yourPageRead(null, '')).toEqual({
      yourPage: expect.stringContaining('there’s no booking site yet'),
      yourPageLink: null,
    });
    const off = yourPageRead({ ...site, page: false }, '');
    expect(off.yourPageLink).toBeNull();
    expect(off.yourPage).toContain(`${BUSINESS_PAGE_SETTINGS_WORDS.label} on Settings → Workspace`);
    expect(off.yourPage).toContain('/book/settings-hvac shows the booking page');
  });

  it('gives the booking site’s own address, or the start page of the business’s own domain once it serves', () => {
    expect(yourPageRead(site, '').yourPageLink).toBe('/book/settings-hvac');
    const own = yourPageRead(site, 'https://go.settingshvac.example');
    // Copy the link copies the domain's start page, with no /book on it.
    expect(own.yourPageLink).toBe('https://go.settingshvac.example');
    expect(own.yourPage).toContain('and at /book/settings-hvac too');
  });
});

describe('the Deleted bin, as its screen lists it', () => {
  const item = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Biscuit',
    kind: 'custom_record' as const,
    contents: { type: 'Pet', notes: 2 },
    deletedBy: { name: 'Dale Owner' },
    deletedAt: '2026-11-01T15:00:00.000Z',
    purgeAfter: '2026-12-01T15:00:00.000Z',
    emptying: false,
  };
  const now = Date.parse('2026-11-07T15:00:00.000Z');

  it('says what each thing is in the screen’s words, who deleted it, and when it goes for good', () => {
    const read = binRead({ items: [item], nextCursor: null }, CHI, now);
    expect(read.more).toBe(false);
    expect(read).not.toHaveProperty('note');
    expect(read.items).toEqual([
      expect.objectContaining({
        binItemId: item.id,
        // A record's own kind, never "custom_record".
        kind: 'Pet',
        name: 'Biscuit',
        deletedBy: 'Dale Owner',
        deleted: 'Deleted by Dale Owner on Nov 1 · Gone for good on Dec 1',
      }),
    ]);
    expect(read.items[0]).not.toHaveProperty('beingDeletedNow');
  });

  it('says one is being deleted now, and that older ones are found by name', () => {
    const read = binRead(
      {
        items: [{ ...item, kind: 'appointment' as const, contents: {}, emptying: true }],
        nextCursor: 'older',
      },
      CHI,
      now,
    );
    expect(read.items[0]).toMatchObject({ kind: 'Booking', beingDeletedNow: true });
    expect(read.items[0]!.deleted).toContain(BIN_WORDS.emptying);
    expect(read.more).toBe(true);
    expect(read.note).toContain('restore_from_bin finds an older one by its name');
  });
});

describe('who can see a part the person asking can’t', () => {
  it('names an owner alone when only owners hold it, never an admin who can’t', () => {
    expect(whoSees('workspace.update')).toBe('An owner or admin can.');
    // The Deleted bin: only owners, unless an owner gives Delete for good to someone.
    expect(whoSees('records.delete')).toBe(
      'An owner can, or someone an owner gave “Delete for good” to in Settings → Permissions.',
    );
    expect(whoSees('permissions.manage')).toBe('Only an owner can.');
  });
});
