import { Schema } from '@powersync/common';

import { syncedTables } from './schema';

/**
 * The phone's database: every table the Sync Streams fill (generated in `schema.ts`). The app's own local tables go
 * here beside them: the insert-only `commands` the uploader sends and the local-only `outbox` that knows what's held,
 * refused or waiting (M10 step 10). The generator refuses a synced table with either name.
 */
export const AppSchema = new Schema({
  ...syncedTables,
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
