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

const INBOX_TABLES = ['conversations', 'messages', 'calls', 'attention_items'] as const;

const { queries } = readSyncConfig();
const sending = queries.filter((q) => !q.cte);
const lookups = queries.filter((q) => q.cte);

describe('the narrowed inbox reaches a phone exactly as RLS reads it', () => {
  it('sends each inbox table from the wide arm and the narrowed arm, and nowhere else', () => {
    for (const table of INBOX_TABLES) {
      const mine = sending.filter((q) => q.table === table);
      expect(mine.map((q) => q.stream).sort()).toEqual(['business_v1', 'me_v1']);
    }
  });

  it('asks the wide arm for the businesses where this person sees the whole inbox', () => {
    for (const table of INBOX_TABLES) {
      const wide = sending.find((q) => q.table === table && q.stream === 'business_v1')!;
      // `access` is every business they can open; `inbox` is the ones where they see all of it. Reading the
      // first here is the bug this test exists for: it would leave a narrowed member's phone holding
      // everything, silently, while the web showed them their own.
      expect(wide.where).toContain('workspace_id IN inbox');
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
          .replace('workspace_id IN inbox', '')
          .replace('auth.user_id() IN member_viewer_ids', '')
          .replace(/^\s*AND\s*/, '')
          .trim();
      const wide = sending.find((q) => q.table === table && q.stream === 'business_v1')!;
      const narrow = sending.find((q) => q.table === table && q.stream === 'me_v1')!;
      expect(strip(narrow.where)).toEqual(strip(wide.where));
    }
  });

  it('decides the wide arm from the row the database keeps equal to RLS', () => {
    const inbox = lookups.find((q) => q.name === 'inbox');
    expect(inbox).toBeDefined();
    // app.workspace_access and one column on it — not a JSON setting read in the sync config, which would be
    // a second copy of the rule with nothing holding it to the first.
    expect(inbox!.table).toBe('workspace_access');
    expect(inbox!.where).toContain('sees_whole_inbox = true');
  });

  it('leaves the customer timeline alone, deliberately', () => {
    // app.activities is not narrowed: that is a different question about a different screen, and 0083 says so
    // in its header. If it ever is, this test should be the thing that makes somebody say so out loud.
    const activities = sending.filter((q) => q.table === 'activities');
    expect(activities.map((q) => q.stream)).toEqual(['business_v1']);
    expect(activities[0]!.where).toContain('workspace_id IN access');
  });
});
