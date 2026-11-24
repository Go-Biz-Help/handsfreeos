/**
 * What the driver does once the database has ended a transaction for sitting idle, run in a process of its own
 * because one of the two outcomes stops it (worker-limits.test.ts). `returns`: the work comes back afterwards, as a
 * slow provider call would. `never`: it doesn't.
 */
import { setTimeout as pause } from 'node:timers/promises';
import postgres from 'postgres';

const how = process.argv[2];
const sql = postgres(process.env.IDLE_DB_URL, { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql.begin(async (tx) => {
    await tx`select set_config('idle_in_transaction_session_timeout', '150ms', true)`;
    await pause(700);
    if (how === 'never') await new Promise(() => {});
  });
} catch (e) {
  console.log(`rejected ${e.code}`);
}
await pause(1500);
const [row] = await sql`select 1 as one`;
console.log(`next ${row.one}`);
await sql.end();
