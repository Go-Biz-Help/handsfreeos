import { Schema, Table, type ColumnsType, type IndexShorthand } from '@powersync/common';

import { LOCAL_TABLES } from '@/changes/tables';

import { syncedTables } from './schema';

/**
 * Indexes the screens need beyond the generated `workspace` one, keyed by table: a conversation's messages and calls in
 * order, a customer's open lead, a conversation's drafts; and for a customer's page, their timeline and notes in
 * order, their conversations, and a company's people. PowerSync makes them on the phone's own views of the synced
 * rows, so adding one never changes what syncs: a phone builds a new one the next time the app starts.
 *
 * An index is used only if the query lets it be. Where a query also says `workspace_id = ?`, the phone's SQLite, which
 * has no statistics, may go by the business and read every row of it: write that check `+x.workspace_id = ?`, which
 * keeps it and takes it out of the choice. __tests__/plans.test.ts asks each such query for its plan.
 */
export const EXTRA_INDEXES: Readonly<Record<string, IndexShorthand>> = {
  messages: { conversation: ['conversation_id', 'occurred_at'] },
  calls: { conversation: ['conversation_id', 'started_at'] },
  leads: { person: ['person_id', 'status'] },
  ai_teammate_drafts: { conversation: ['conversation_id', 'status'] },
  activities: { person: ['person_id', 'occurred_at'] },
  conversations: { person: ['person_id'] },
  people: { company: ['company_id'] },
};

/** A synced table with more indexes: the same columns and indexes, plus the extra ones. */
function withIndexes(table: Table, extra: IndexShorthand): Table {
  const columns: ColumnsType = Object.fromEntries(
    table.columns.map((c) => [c.name, { type: c.type! }]),
  );
  const indexes: IndexShorthand = Object.fromEntries(
    table.indexes.map((i) => [i.name, i.columns.map((c) => c.name)]),
  );
  return new Table(columns, { indexes: { ...indexes, ...extra } });
}

const synced = Object.fromEntries(
  Object.entries(syncedTables).map(([name, table]) => [
    name,
    EXTRA_INDEXES[name] ? withIndexes(table, EXTRA_INDEXES[name]) : table,
  ]),
) as typeof syncedTables;

/**
 * The phone's database: every table the Sync Streams fill (generated in `schema.ts`), and beside them the app's own
 * tables for the changes made on the phone (`src/changes/tables.ts`): the insert-only `commands` the uploader sends,
 * the local-only `outbox` that knows where every change stands, `photo_uploads` for the photo track, and the person's
 * recent searches (`search_recent`, never sent). The generator refuses a synced table named `commands` or `outbox`,
 * and a test refuses one named like any local table.
 */
export const AppSchema = new Schema({
  ...synced,
  ...LOCAL_TABLES,
});

/*
 * Screens read the copy with PowerSync's live queries, in plain SQL with the generated row types (no ORM on the phone):
 *
 *   const { business } = useBusiness();
 *   const { data: people } = useQuery<PeopleRow>(
 *     'SELECT * FROM people WHERE workspace_id = ? AND archived_at IS NULL ORDER BY last_name, first_name',
 *     [business.id],
 *   );
 *
 * A query runs again whenever a table it reads changes, from a sync or from a change made on the phone. Always filter
 * on `workspace_id` (it's indexed): one phone can keep several businesses. What the phone works out for itself (search
 * text, balances) is in `compute.ts`.
 */
export type * from './schema';
