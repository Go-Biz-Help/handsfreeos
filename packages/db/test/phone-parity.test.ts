/**
 * What the phone is expected to have, asserted against the streams that fill it (M17).
 *
 * D3 asked for exactly this rule and it was not written — which is how `phone_numbers.is_default` sat
 * unsynced for a whole milestone while a comment in `apps/mobile/src/inbox/cell.ts` was the only thing that
 * knew. **A comment is not a rule.** The next feature that lands on the web has to say out loud whether the
 * phone gets it, in one of the two lists below.
 *
 * Two lists, and the second is the point:
 *
 * - `ON_THE_PHONE` is what a phone can already do, and the columns it needs to do it. A stream that stops
 *   sending one of them fails here rather than on somebody's phone, three weeks later, with no signal.
 * - `NOT_ON_THE_PHONE_YET` is what the web has and the phone does not, each with its reason. A column that
 *   quietly arrives fails too, because half a feature on a phone is how you get one that can queue a change
 *   it will never see the effect of.
 *
 * This reads `apps/sync/sync-config.yaml` and nothing else, so it runs wherever the repo does. The chain from
 * there to the phone's own schema is already held: `mobile-contract.test.ts` records every synced column's
 * database type, and `scripts/mobile-schema.mjs --check` (which the app's lint runs) refuses a stream column
 * the contract has not recorded.
 *
 * The narrowed inbox is deliberately absent from the lists below: `sync-inbox-config.test.ts` next door
 * already holds its four tables to both arms sending the same columns, which is a stronger rule than naming
 * a few of them here would be.
 */
import { describe, expect, it } from 'vitest';
import { readSyncConfig } from './sync-config';

/** A feature a phone has, and what each stream must send for it to work. */
const ON_THE_PHONE: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // The number a thread sends from, which the phone works out itself because a stream cannot join.
  // `conversationNumber` then `defaultNumber` in packages/core/src/messaging/store.ts is the original;
  // `useConversationNumber` in apps/mobile/src/inbox/cell.ts is the copy, and these are its inputs.
  'the number a conversation sends from': {
    'business_v1.phone_numbers': ['e164', 'status', 'is_default'],
    'business_v1.conversations': ['phone_number_id'],
  },
  // 0085. The questions reach the phone; the answers go back as one command.
  'filling in a form with no signal': {
    'business_v1.forms': ['status', 'active_version_id'],
    'business_v1.form_versions': ['definition', 'version'],
  },
};

/** What the web has and the phone does not, and why. Editing this list is how a feature reaches a phone. */
const NOT_ON_THE_PHONE_YET: readonly {
  readonly feature: string;
  readonly table: string;
  readonly column?: string;
  readonly why: string;
}[] = [
  {
    feature: 'putting a conversation away',
    table: 'business_v1.conversations',
    column: 'archived_at',
    why: '`conversation.archive` is already an offline command, so the moment this column arrives a phone can queue an archive and watch nothing happen. The screen and the stream go together.',
  },
  {
    feature: 'moving a number in from another carrier',
    table: 'business_v1.number_ports',
    why: 'The losing carrier’s account number and PIN live on that row. It is deliberately outside the `powersync` publication, so this is a rule about a table that must never be added rather than one waiting its turn.',
  },
];

const { queries } = readSyncConfig();
const sending = queries.filter((q) => !q.cte);
const sent = (key: string) => {
  const [stream, table] = key.split('.');
  return sending.find((q) => q.stream === stream && q.table === table);
};

describe('what the phone is expected to have', () => {
  for (const [feature, tables] of Object.entries(ON_THE_PHONE))
    it(`sends everything ${feature} needs`, () => {
      for (const [key, columns] of Object.entries(tables)) {
        const query = sent(key);
        expect(query, `${key} is not sent to a phone at all`).toBeDefined();
        const has = new Set(query!.select.keys());
        expect(
          columns.filter((c) => !has.has(c)),
          `${key} stopped sending what the phone reads`,
        ).toEqual([]);
      }
    });

  for (const { feature, table, column, why } of NOT_ON_THE_PHONE_YET)
    it(`still does not send ${feature}, and says why`, () => {
      const query = sent(table);
      if (!column) {
        expect(query, `${table} reached a phone: ${why}`).toBeUndefined();
        return;
      }
      expect(query, `${table} is not sent to a phone at all`).toBeDefined();
      expect([...query!.select.keys()].includes(column), `${table}.${column} arrived: ${why}`).toBe(
        false,
      );
    });
});
