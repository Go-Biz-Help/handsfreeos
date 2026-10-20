/**
 * What the file reader still has to read (Search 5): files with no words yet, or read by an older reader, by business,
 * exactly as the sweep finds them (`private.files_without_text`, 500 at most). Read-only, in a read-only transaction:
 * `pnpm --filter @hfos/worker run files:read-backlog`. It reads the worker's own .env (DATABASE_URL_WORKER), so it
 * shows whichever database the worker there uses.
 */
import { asWorker, createDb, rows, sql } from '@hfos/db/client';
import { loadEnv } from '../src/env';
import { FILE_READER } from '../src/files/file-text';

/** The finder's own most; past it, the count says "500 or more". */
const MOST = 500;

loadEnv();
const url = process.env.DATABASE_URL_WORKER ?? '';
if (!/^postgres(ql)?:\/\//.test(url))
  throw new Error('DATABASE_URL_WORKER must be a postgres:// URL for the hfos_worker role');

const handle = createDb(url, { max: 1, applicationName: 'hfos-files-read-backlog' });
try {
  // The worker reads no business's files outside it, so the finder's rows are all there is to count: by business,
  // in the order the finder gives them, oldest file first.
  const left = await asWorker(handle.db, {}, async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return rows<{ workspace_id: string; files: number }>(
      tx,
      sql`select b.workspace_id, count(*)::int as files
          from private.files_without_text(${MOST}, ${FILE_READER}::smallint) with ordinality b
          group by b.workspace_id
          order by min(b.ordinality)`,
    );
  });
  const total = left.reduce((n, b) => n + b.files, 0);
  if (!total) console.log(`Every file has its words read (reader ${FILE_READER}).`);
  else {
    console.log(
      `${total >= MOST ? `${MOST} or more files` : `${total} ${total === 1 ? 'file' : 'files'}`} to read (reader ${FILE_READER}), oldest first:`,
    );
    for (const b of left) console.log(`  ${b.workspace_id}  ${b.files}`);
  }
} finally {
  await handle.close();
}
