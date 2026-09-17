import { Schema } from '@powersync/common';

import { LOCAL_TABLES } from '@/changes/tables';

import { syncedTables } from './schema';

/**
 * The phone's database: every table the Sync Streams fill (generated in `schema.ts`), and beside them the app's own
 * tables for the changes made on the phone (`src/changes/tables.ts`): the insert-only `commands` the uploader sends,
 * the local-only `outbox` that knows where every change stands, and `photo_uploads` for the photo track. The generator
 * refuses a synced table named `commands` or `outbox`, and a test refuses one named like any local table.
 */
export const AppSchema = new Schema({
  ...syncedTables,
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
