/**
 * 0083: the phone and RLS narrow the inbox the same way, checked where it can actually be checked.
 *
 * `private.sync_inbox_mismatches()` judges the stored lists against the policies, and needs a database.
 * This judges the *third* side — apps/sync/sync-config.yaml — against the shape those two agree on, and needs
 * nothing at all, so it runs wherever the repo does.
 *
 * The property, in one sentence: **each of the four inbox tables is sent by exactly two queries, one for the
 * people who see the whole inbox and one for the people who do not, and they send the same columns.** Get the
 * first half wrong and a member either keeps everything or loses everything; get the second half wrong and a
 * row synced by both arms arrives missing whichever columns one of them left out.
 */
import { describe, expect, it } from 'vitest';
import { readSyncConfig } from './sync-config';

// The AI teammate's pending drafts are a reply on a thread, and follow it the same way (20261012020100).
const INBOX_TABLES = [
  'conversations',
  'messages',
  'calls',
  'attention_items',
  'ai_teammate_drafts',
] as const;

// The wide arm's lookup for each table: `inbox`, except the drafts, which RLS also reads only with inbox.use
// (20261012060300), so their lookup is `inbox` asking that too.
const WIDE_LOOKUP: Record<(typeof INBOX_TABLES)[number], string> = {
  conversations: 'inbox',
  messages: 'inbox',
  calls: 'inbox',
  attention_items: 'inbox',
  ai_teammate_drafts: 'inbox_drafts',
};

// A person's own mail (M19): the wide arm skips private threads and their messages, which reach their person through
// the narrowed arm, whose list for a private thread is that person alone (20261013001200).
const PRIVATE_TABLES: readonly string[] = ['conversations', 'messages'];
const NOT_PRIVATE = 'private_to IS NULL';

/**
 * Round six: a private record's threads, messages and Home cards come back to that record's people through
 * records_v1, sealed to them (`seal_scope IN addon_use`, then its viewers or open to the add-on's key holders). That
 * is the record's rule, not the inbox's, so the inbox's own two arms are judged here without it.
 */
const RECORDS = 'records_v1';
const SEALED = 'seal_scope IN addon_use';

const { queries } = readSyncConfig();
const sending = queries.filter((q) => !q.cte);
const lookups = queries.filter((q) => q.cte);

describe('the narrowed inbox reaches a phone exactly as RLS reads it', () => {
  it('sends each inbox table from the wide arm and the narrowed arm, and nowhere else', () => {
    for (const table of INBOX_TABLES) {
      const mine = sending.filter((q) => q.table === table);
      expect(
        mine
          .filter((q) => q.stream !== RECORDS)
          .map((q) => q.stream)
          .sort(),
      ).toEqual(['business_v1', 'me_v1']);
      for (const q of mine.filter((q) => q.stream === RECORDS)) expect(q.where).toContain(SEALED);
    }
  });

  it('asks the wide arm for the businesses where this person sees the whole inbox', () => {
    for (const table of INBOX_TABLES) {
      const wide = sending.find((q) => q.table === table && q.stream === 'business_v1')!;
      // `access` is every business they can open; `inbox` is the ones where they see all of it. Reading the
      // first here is the bug this test exists for: it would leave a narrowed member's phone holding
      // everything, silently, while the web showed them their own.
      expect(wide.where).toMatch(new RegExp(`workspace_id IN ${WIDE_LOOKUP[table]}\\b`));
      expect(wide.where).not.toContain('workspace_id IN access');
    }
  });

  it('asks the narrowed arm for the threads this person is on', () => {
    for (const table of INBOX_TABLES) {
      const narrow = sending.find((q) => q.table === table && q.stream === 'me_v1')!;
      expect(narrow.where).toContain('auth.user_id() IN member_viewer_ids');
    }
  });

  it('sends the same columns from both arms, in the same order', () => {
    for (const table of INBOX_TABLES) {
      const [wide, narrow] = [
        sending.find((q) => q.table === table && q.stream === 'business_v1')!,
        sending.find((q) => q.table === table && q.stream === 'me_v1')!,
      ];
      expect([...narrow.select.keys()]).toEqual([...wide.select.keys()]);
    }
  });

  it('keeps each arm’s own window and state filter identical too', () => {
    // The column lists matching is not enough: a row inside one arm's window and outside the other's would
    // arrive and then be dropped again the moment the other arm looked at it.
    for (const table of INBOX_TABLES) {
      const strip = (where: string) =>
        where
          .replace(`workspace_id IN ${WIDE_LOOKUP[table]}`, '')
          .replace('auth.user_id() IN member_viewer_ids', '')
          .replace(`AND ${NOT_PRIVATE}`, '')
          .replace(/^\s*AND\s*/, '')
          .replace(/\s+/g, ' ')
          .trim();
      const wide = sending.find((q) => q.table === table && q.stream === 'business_v1')!;
      const narrow = sending.find((q) => q.table === table && q.stream === 'me_v1')!;
      expect(strip(narrow.where)).toEqual(strip(wide.where));
    }
  });

  it('keeps a person’s own mail out of the wide arm, and in the narrowed one', () => {
    for (const table of PRIVATE_TABLES) {
      const wide = sending.find((q) => q.table === table && q.stream === 'business_v1')!;
      const narrow = sending.find((q) => q.table === table && q.stream === 'me_v1')!;
      // Without it every owner's and admin's phone would hold everyone's private mail (M19).
      expect(wide.where).toContain(NOT_PRIVATE);
      // The narrowed arm is how a private thread reaches its person: its list is them alone.
      expect(narrow.where).not.toContain('private_to');
    }
  });

  it('decides the wide arm from the row the database keeps equal to RLS', () => {
    const inbox = lookups.find((q) => q.name === 'inbox');
    expect(inbox).toBeDefined();
    // app.workspace_access and one column on it — not a JSON setting read in the sync config, which would be
    // a second copy of the rule with nothing holding it to the first.
    expect(inbox!.table).toBe('workspace_access');
    expect(inbox!.where).toContain('sees_whole_inbox = true');
    // The drafts' lookup is the same row and the same column, and inbox.use besides.
    const drafts = lookups.find((q) => q.name === 'inbox_drafts');
    expect(drafts).toBeDefined();
    expect(drafts!.table).toBe('workspace_access');
    expect(drafts!.where).toContain('sees_whole_inbox = true');
    expect(drafts!.where).toContain('uses_inbox = true');
  });

  it('leaves the customer timeline alone, deliberately', () => {
    // app.activities is not narrowed: that is a different question about a different screen, and 0083 says so
    // in its header. If it ever is, this test should be the thing that makes somebody say so out loud.
    const activities = sending.filter((q) => q.table === 'activities');
    expect(activities.filter((q) => q.stream !== RECORDS).map((q) => q.stream)).toEqual([
      'business_v1',
    ]);
    expect(activities.find((q) => q.stream === 'business_v1')!.where).toContain(
      'workspace_id IN access',
    );
    // A private record's own timeline lines go to its people alone (round six).
    for (const q of activities.filter((q) => q.stream === RECORDS))
      expect(q.where).toContain(SEALED);
  });
});
